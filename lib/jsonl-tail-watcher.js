// Shared JSONL tail watcher used by Codex / Grok / Hermes / Claude Code.
// Fixes incomplete-line loss, new-file backlog replay, fs.watch bursts,
// UTF-8 boundary splits, and unbounded tail reads.
const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_MAX_READ = 2 * 1024 * 1024;

/**
 * @param {object} opts
 * @param {string} opts.name
 * @param {string} opts.root
 * @param {(rel: string) => boolean} opts.fileFilter  — relative path from root
 * @param {(entry: object, absPath: string) => string|null} opts.extractUserText
 * @param {(entry: object, absPath: string) => object} [opts.deriveMeta]
 * @param {(onFile: (abs: string) => void) => void} [opts.seedWalk]
 * @param {number} [opts.debounceMs]
 * @param {number} [opts.maxReadBytes]
 * @param {(text: string, meta: object) => void} opts.onPrompt
 */
function createJsonlTailWatcher(opts) {
  const {
    name,
    root,
    fileFilter,
    extractUserText,
    deriveMeta = () => ({}),
    seedWalk,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    maxReadBytes = DEFAULT_MAX_READ,
    onPrompt
  } = opts;

  if (!fs.existsSync(root)) {
    console.log(`[${name}] sessions dir missing, skipping:`, root);
    return () => {};
  }

  const offsets = new Map(); // absPath -> byteOffset (last fully consumed disk position)
  const lineCarry = new Map(); // absPath -> string (incomplete trailing line)
  const utf8Carry = new Map(); // absPath -> Buffer (incomplete UTF-8 sequence)
  const debounceTimers = new Map();
  let lastWarnAt = 0;
  let closed = false;

  function warn(msg, err) {
    const now = Date.now();
    if (now - lastWarnAt < 2000) return;
    lastWarnAt = now;
    console.warn(`[${name}] ${msg}`, err && err.message ? err.message : err || '');
  }

  function seedFile(abs) {
    try {
      offsets.set(abs, fs.statSync(abs).size);
      lineCarry.delete(abs);
      utf8Carry.delete(abs);
    } catch (err) {
      warn(`seed failed ${abs}`, err);
    }
  }

  function seedExisting() {
    if (typeof seedWalk !== 'function') return;
    seedWalk(abs => seedFile(abs));
  }

  function processFile(abs) {
    if (closed) return;
    let stat;
    try {
      stat = fs.statSync(abs);
    } catch (err) {
      if (err && err.code !== 'ENOENT') warn(`stat failed ${abs}`, err);
      return;
    }

    // First sight after startup: seed to EOF — do not replay history.
    if (!offsets.has(abs)) {
      seedFile(abs);
      return;
    }

    let prev = offsets.get(abs);
    if (stat.size < prev) {
      seedFile(abs);
      return;
    }
    if (stat.size === prev && !lineCarry.has(abs) && !utf8Carry.has(abs)) return;

    while (prev < stat.size) {
      const readLen = Math.min(stat.size - prev, maxReadBytes);
      let chunk;
      try {
        const fd = fs.openSync(abs, 'r');
        try {
          chunk = Buffer.alloc(readLen);
          fs.readSync(fd, chunk, 0, readLen, prev);
        } finally {
          fs.closeSync(fd);
        }
      } catch (err) {
        warn(`read failed ${abs}`, err);
        return;
      }

      const priorUtf8 = utf8Carry.get(abs);
      const buf = priorUtf8 && priorUtf8.length
        ? Buffer.concat([priorUtf8, chunk])
        : chunk;
      const { text, remainder } = decodeUtf8Safe(buf);
      if (remainder.length) utf8Carry.set(abs, remainder);
      else utf8Carry.delete(abs);

      prev += readLen;
      offsets.set(abs, prev);

      const combined = (lineCarry.get(abs) || '') + text;
      const lastNl = combined.lastIndexOf('\n');
      if (lastNl < 0) {
        lineCarry.set(abs, combined);
        continue;
      }

      const complete = combined.slice(0, lastNl);
      const trailing = combined.slice(lastNl + 1);
      if (trailing) lineCarry.set(abs, trailing);
      else lineCarry.delete(abs);

      for (const line of complete.split('\n')) {
        const s = line.trim();
        if (!s) continue;
        let entry;
        try {
          entry = JSON.parse(s);
        } catch {
          continue;
        }
        let userText;
        try {
          userText = extractUserText(entry, abs);
        } catch (err) {
          warn(`extract failed ${abs}`, err);
          continue;
        }
        if (!userText) continue;
        const meta = deriveMeta(entry, abs) || {};
        try {
          onPrompt(userText, meta);
        } catch (err) {
          warn('onPrompt failed', err);
        }
      }
    }
  }

  function schedule(abs) {
    if (closed) return;
    const existing = debounceTimers.get(abs);
    if (existing) clearTimeout(existing);
    debounceTimers.set(abs, setTimeout(() => {
      debounceTimers.delete(abs);
      processFile(abs);
    }, debounceMs));
  }

  seedExisting();

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, rel) => {
      if (closed || !rel) return;
      const relNorm = String(rel).split(path.sep).join('/');
      if (!fileFilter(relNorm)) return;
      schedule(path.join(root, rel));
    });
  } catch (err) {
    console.error(`[${name}] watch failed:`, err.message);
    return () => {};
  }

  console.log(`[${name}] watching`, root);

  return () => {
    closed = true;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    try { watcher.close(); } catch {}
  };
}

function decodeUtf8Safe(buf) {
  if (!buf.length) return { text: '', remainder: Buffer.alloc(0) };
  let end = buf.length;
  let i = buf.length - 1;
  let cont = 0;
  while (i >= 0 && (buf[i] & 0xc0) === 0x80) {
    cont++;
    i--;
  }
  if (i >= 0) {
    const lead = buf[i];
    let need = 1;
    if ((lead & 0x80) === 0) need = 1;
    else if ((lead & 0xe0) === 0xc0) need = 2;
    else if ((lead & 0xf0) === 0xe0) need = 3;
    else if ((lead & 0xf8) === 0xf0) need = 4;
    if (cont + 1 < need) end = i;
  }
  return {
    text: buf.subarray(0, end).toString('utf8'),
    remainder: end < buf.length ? Buffer.from(buf.subarray(end)) : Buffer.alloc(0)
  };
}

function walkFiles(dir, cb) {
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    if (e.isDirectory()) walkFiles(abs, cb);
    else cb(abs);
  }
}

function walkDirs(root, cb) {
  let entries;
  try {
    entries = fs.readdirSync(root, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    const abs = path.join(root, e.name);
    cb(abs);
    walkDirs(abs, cb);
  }
}

module.exports = { createJsonlTailWatcher, walkFiles, walkDirs };
