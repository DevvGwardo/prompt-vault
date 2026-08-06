// Shared JSONL tail watcher used by Codex / Grok / Hermes / Claude Code / Cursor.
// Fixes incomplete-line loss, new-file backlog replay, fs.watch bursts,
// UTF-8 boundary splits, unbounded tail reads, map leaks on deleted files,
// and missed events via a light poll fallback.
const fs = require('fs');
const path = require('path');

const DEFAULT_DEBOUNCE_MS = 100;
const DEFAULT_MAX_READ = 2 * 1024 * 1024;
const DEFAULT_POLL_MS = 8000;
const MAP_PRUNE_EVERY = 64; // prune stale map entries every N processFile calls
const NEW_FILE_SCAN_EVERY = 3; // full seedWalk every N poll ticks

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
 * @param {number} [opts.pollMs]  — 0 disables poll fallback
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
    pollMs = DEFAULT_POLL_MS,
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
  const inFlight = new Set(); // absPath currently being processed (chunked)
  let lastWarnAt = 0;
  let closed = false;
  let processCount = 0;
  let pollTimer = null;

  function warn(msg, err) {
    const now = Date.now();
    if (now - lastWarnAt < 2000) return;
    lastWarnAt = now;
    console.warn(`[${name}] ${msg}`, err && err.message ? err.message : err || '');
  }

  function clearFileState(abs) {
    offsets.delete(abs);
    lineCarry.delete(abs);
    utf8Carry.delete(abs);
    const t = debounceTimers.get(abs);
    if (t) {
      clearTimeout(t);
      debounceTimers.delete(abs);
    }
    inFlight.delete(abs);
  }

  function seedFile(abs) {
    try {
      offsets.set(abs, fs.statSync(abs).size);
      lineCarry.delete(abs);
      utf8Carry.delete(abs);
    } catch (err) {
      if (err && err.code === 'ENOENT') clearFileState(abs);
      else warn(`seed failed ${abs}`, err);
    }
  }

  function seedExisting() {
    if (typeof seedWalk !== 'function') return;
    seedWalk(abs => seedFile(abs));
  }

  function pruneMissingMaps() {
    for (const abs of [...offsets.keys()]) {
      try {
        fs.accessSync(abs, fs.constants.F_OK);
      } catch {
        clearFileState(abs);
      }
    }
  }

  function emitLines(abs, complete) {
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

  function readChunkSync(abs, offset, length) {
    const fd = fs.openSync(abs, 'r');
    try {
      const chunk = Buffer.alloc(length);
      const n = fs.readSync(fd, chunk, 0, length, offset);
      return n < length ? chunk.subarray(0, n) : chunk;
    } finally {
      fs.closeSync(fd);
    }
  }

  /**
   * Process newly appended bytes. Yields to the event loop between maxRead
   * chunks so a multi-MB append does not stall the Electron main process.
   */
  function processFile(abs) {
    if (closed || inFlight.has(abs)) return;
    inFlight.add(abs);

    const step = () => {
      if (closed) {
        inFlight.delete(abs);
        return;
      }

      let stat;
      try {
        stat = fs.statSync(abs);
      } catch (err) {
        if (err && err.code === 'ENOENT') clearFileState(abs);
        else warn(`stat failed ${abs}`, err);
        inFlight.delete(abs);
        return;
      }

      // First sight after startup: seed to EOF — do not replay history.
      if (!offsets.has(abs)) {
        seedFile(abs);
        inFlight.delete(abs);
        return;
      }

      let prev = offsets.get(abs);
      if (stat.size < prev) {
        // Truncation / rotation
        seedFile(abs);
        inFlight.delete(abs);
        return;
      }
      if (stat.size === prev && !lineCarry.has(abs) && !utf8Carry.has(abs)) {
        inFlight.delete(abs);
        return;
      }

      if (prev >= stat.size) {
        inFlight.delete(abs);
        return;
      }

      const readLen = Math.min(stat.size - prev, maxReadBytes);
      let chunk;
      try {
        chunk = readChunkSync(abs, prev, readLen);
      } catch (err) {
        if (err && err.code === 'ENOENT') clearFileState(abs);
        else warn(`read failed ${abs}`, err);
        inFlight.delete(abs);
        return;
      }

      const priorUtf8 = utf8Carry.get(abs);
      const buf = priorUtf8 && priorUtf8.length
        ? Buffer.concat([priorUtf8, chunk])
        : chunk;
      const { text, remainder } = decodeUtf8Safe(buf);
      if (remainder.length) utf8Carry.set(abs, remainder);
      else utf8Carry.delete(abs);

      prev += chunk.length;
      offsets.set(abs, prev);

      const combined = (lineCarry.get(abs) || '') + text;
      const lastNl = combined.lastIndexOf('\n');
      if (lastNl < 0) {
        lineCarry.set(abs, combined);
      } else {
        const complete = combined.slice(0, lastNl);
        const trailing = combined.slice(lastNl + 1);
        if (trailing) lineCarry.set(abs, trailing);
        else lineCarry.delete(abs);
        emitLines(abs, complete);
      }

      processCount++;
      if (processCount % MAP_PRUNE_EVERY === 0) pruneMissingMaps();

      if (prev < stat.size) {
        // More bytes waiting — yield so IPC/UI stay responsive
        setImmediate(step);
      } else {
        inFlight.delete(abs);
        // Race: file grew while we were finishing — schedule another pass
        try {
          const again = fs.statSync(abs);
          if (again.size > prev || lineCarry.has(abs) || utf8Carry.has(abs)) {
            schedule(abs);
          }
        } catch (err) {
          if (err && err.code === 'ENOENT') clearFileState(abs);
        }
      }
    };

    setImmediate(step);
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

  function relMatches(rel) {
    if (!rel) return false;
    const relNorm = String(rel).split(path.sep).join('/');
    return fileFilter(relNorm);
  }

  seedExisting();

  let watcher;
  try {
    watcher = fs.watch(root, { recursive: true }, (_evt, rel) => {
      if (closed || !rel) return;
      if (!relMatches(rel)) return;
      schedule(path.join(root, rel));
    });
  } catch (err) {
    console.error(`[${name}] watch failed:`, err.message);
    return () => {};
  }

  // Poll fallback: catch appends fs.watch missed, and discover new session files.
  // Size-check known files each tick; full seedWalk only every N ticks (cheaper).
  if (pollMs > 0) {
    let pollTick = 0;
    pollTimer = setInterval(() => {
      if (closed) return;
      pollTick++;
      for (const abs of offsets.keys()) {
        try {
          const size = fs.statSync(abs).size;
          if (size !== offsets.get(abs)) schedule(abs);
        } catch (err) {
          if (err && err.code === 'ENOENT') clearFileState(abs);
        }
      }
      if (pollTick % NEW_FILE_SCAN_EVERY === 0 && typeof seedWalk === 'function') {
        seedWalk(abs => {
          if (!offsets.has(abs)) schedule(abs);
        });
      }
    }, pollMs);
    if (typeof pollTimer.unref === 'function') pollTimer.unref();
  }

  console.log(`[${name}] watching`, root);

  return () => {
    closed = true;
    for (const t of debounceTimers.values()) clearTimeout(t);
    debounceTimers.clear();
    inFlight.clear();
    if (pollTimer) {
      clearInterval(pollTimer);
      pollTimer = null;
    }
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
