// Watches ~/.codex/sessions/**/*.jsonl for new user messages and forwards them
// to a callback. Codex appends to JSONL files; we track per-file byte offsets
// and only parse the newly-appended tail on each fs change.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_ROOT = path.join(os.homedir(), '.codex', 'sessions');

function extractUserText(entry) {
  // Codex shape: { type: 'response_item', payload: { role, content: [{type:'input_text',text}, ...] } }
  if (entry.type !== 'response_item') return null;
  const p = entry.payload;
  if (!p || p.role !== 'user') return null;
  const parts = Array.isArray(p.content) ? p.content : [];
  const text = parts
    .map(c => (typeof c === 'string' ? c : (c && (c.text || c.input_text)) || ''))
    .filter(Boolean)
    .join('\n')
    .trim();
  return text || null;
}

function start(onPrompt) {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log('[codex-watcher] sessions dir missing, skipping:', SESSIONS_ROOT);
    return () => {};
  }
  const offsets = new Map(); // absPath -> byteOffset

  // Seed offsets with the current end-of-file for every existing session, so we only
  // capture NEW messages going forward — not the entire backlog on first run.
  function seedExisting() {
    walk(SESSIONS_ROOT, abs => {
      if (!abs.endsWith('.jsonl')) return;
      try { offsets.set(abs, fs.statSync(abs).size); } catch {}
    });
  }

  function walk(dir, cb) {
    let entries;
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      const abs = path.join(dir, e.name);
      if (e.isDirectory()) walk(abs, cb);
      else cb(abs);
    }
  }

  function processFile(abs) {
    let stat;
    try { stat = fs.statSync(abs); } catch { return; }
    const prev = offsets.get(abs) ?? 0;
    if (stat.size <= prev) {
      if (stat.size < prev) offsets.set(abs, stat.size); // truncated
      return;
    }
    const fd = fs.openSync(abs, 'r');
    const len = stat.size - prev;
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, prev); } finally { fs.closeSync(fd); }
    offsets.set(abs, stat.size);
    const text = buf.toString('utf8');
    // Only process complete lines; if last line lacks \n, rewind offset to its start.
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl < 0 ? '' : text.slice(0, lastNl);
    if (lastNl >= 0 && lastNl < text.length - 1) {
      offsets.set(abs, prev + Buffer.byteLength(complete) + 1);
    }
    for (const line of complete.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let entry;
      try { entry = JSON.parse(s); } catch { continue; }
      const userText = extractUserText(entry);
      if (userText) onPrompt(userText, { source: 'codex', cwd: path.dirname(abs) });
    }
  }

  seedExisting();

  // fs.watch with { recursive: true } on macOS catches new files + appends in subdirs.
  let watcher;
  try {
    watcher = fs.watch(SESSIONS_ROOT, { recursive: true }, (_evt, rel) => {
      if (!rel || !rel.endsWith('.jsonl')) return;
      processFile(path.join(SESSIONS_ROOT, rel));
    });
  } catch (err) {
    console.error('[codex-watcher] watch failed:', err.message);
    return () => {};
  }
  console.log('[codex-watcher] watching', SESSIONS_ROOT);
  return () => { try { watcher.close(); } catch {} };
}

module.exports = { start };
