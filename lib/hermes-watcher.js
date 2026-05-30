// Watches ~/.hermes-chat/sessions/*.jsonl for new user messages and forwards
// them to a callback. The hermes-chat skill appends one JSON object per turn,
// shaped { ts, role, content }; we track per-file byte offsets and only parse
// the newly-appended tail on each fs change.
const fs = require('fs');
const path = require('path');
const os = require('os');

const STATE_DIR = process.env.HERMES_CHAT_DIR || path.join(os.homedir(), '.hermes-chat');
const SESSIONS_ROOT = path.join(STATE_DIR, 'sessions');

function extractUserText(entry) {
  // hermes-chat shape: { ts, role: 'user'|'assistant', content: '...' }
  if (!entry || entry.role !== 'user') return null;
  const content = entry.content;
  const text = (typeof content === 'string' ? content : '').trim();
  return text || null;
}

function start(onPrompt) {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log('[hermes-watcher] sessions dir missing, skipping:', SESSIONS_ROOT);
    return () => {};
  }
  const offsets = new Map(); // absPath -> byteOffset

  // Seed offsets with the current end-of-file for every existing session, so we
  // only capture NEW messages going forward — not the entire backlog on first run.
  function seedExisting() {
    let entries;
    try { entries = fs.readdirSync(SESSIONS_ROOT, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isFile() || !e.name.endsWith('.jsonl')) continue;
      const abs = path.join(SESSIONS_ROOT, e.name);
      try { offsets.set(abs, fs.statSync(abs).size); } catch {}
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
      if (userText) onPrompt(userText, { source: 'hermes', cwd: '' });
    }
  }

  seedExisting();

  let watcher;
  try {
    watcher = fs.watch(SESSIONS_ROOT, { recursive: true }, (_evt, rel) => {
      if (!rel || !rel.endsWith('.jsonl')) return;
      processFile(path.join(SESSIONS_ROOT, rel));
    });
  } catch (err) {
    console.error('[hermes-watcher] watch failed:', err.message);
    return () => {};
  }
  console.log('[hermes-watcher] watching', SESSIONS_ROOT);
  return () => { try { watcher.close(); } catch {} };
}

module.exports = { start };
