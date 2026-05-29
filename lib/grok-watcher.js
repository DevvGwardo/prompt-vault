// Watches ~/.grok/sessions/**/chat_history.jsonl for new user messages and
// forwards them to a callback. Grok appends to JSONL files; we track per-file
// byte offsets and only parse the newly-appended tail on each fs change.
const fs = require('fs');
const path = require('path');
const os = require('os');

const SESSIONS_ROOT = path.join(os.homedir(), '.grok', 'sessions');

function extractUserText(entry) {
  // Grok shape: { type: 'user', content: [{ type: 'text', text: '...' }, ...] }
  if (entry.type !== 'user') return null;
  const parts = Array.isArray(entry.content) ? entry.content : [];
  const text = parts
    .filter(c => c && c.type === 'text' && c.text)
    .map(c => c.text)
    .join('\n')
    .trim();
  if (!text) return null;

  // Strip the <user_info>...</user_info> preamble that Grok prepends to every user message.
  // The actual prompt follows after the closing </user_info> tag, wrapped in <user_query> tags.
  const infoEnd = text.indexOf('</user_info>');
  let cleaned = infoEnd !== -1 ? text.slice(infoEnd + '</user_info>'.length).trim() : text;

  // Strip <user_query>...</user_query> wrapper if present
  const qOpen = cleaned.indexOf('<user_query>');
  const qClose = cleaned.lastIndexOf('</user_query>');
  if (qOpen !== -1 && qClose !== -1) {
    cleaned = cleaned.slice(qOpen + '<user_query>'.length, qClose).trim();
  }

  return cleaned || null;
}

function deriveCwd(sessionDirPath) {
  // Session directories are named like "%2FUsers%2Fdevgwardo%2Fprompt-vault-app"
  // which is the URL-encoded workspace path. Decode it.
  const dirName = path.basename(sessionDirPath);
  try {
    const decoded = decodeURIComponent(dirName);
    // Only return if it looks like an absolute path
    if (decoded.startsWith('/')) return decoded;
  } catch {}
  return '';
}

function start(onPrompt) {
  if (!fs.existsSync(SESSIONS_ROOT)) {
    console.log('[grok-watcher] sessions dir missing, skipping:', SESSIONS_ROOT);
    return () => {};
  }

  const offsets = new Map(); // absPath -> byteOffset

  // Seed offsets with the current end-of-file for every existing session,
  // so we only capture NEW messages going forward.
  function seedExisting() {
    walkDirs(SESSIONS_ROOT, dirPath => {
      const chatFile = path.join(dirPath, 'chat_history.jsonl');
      if (!fs.existsSync(chatFile)) return;
      try { offsets.set(chatFile, fs.statSync(chatFile).size); } catch {}
    });
  }

  function walkDirs(root, cb) {
    let entries;
    try { entries = fs.readdirSync(root, { withFileTypes: true }); } catch { return; }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      const abs = path.join(root, e.name);
      // A session directory contains chat_history.jsonl
      if (fs.existsSync(path.join(abs, 'chat_history.jsonl'))) {
        cb(abs);
      }
      // Recurse into subdirectories (some session dirs are nested)
      walkDirs(abs, cb);
    }
  }

  function processChatFile(absPath, sessionDir) {
    let stat;
    try { stat = fs.statSync(absPath); } catch { return; }
    const prev = offsets.get(absPath) ?? 0;
    if (stat.size <= prev) {
      if (stat.size < prev) offsets.set(absPath, stat.size); // truncated
      return;
    }
    const fd = fs.openSync(absPath, 'r');
    const len = stat.size - prev;
    const buf = Buffer.alloc(len);
    try { fs.readSync(fd, buf, 0, len, prev); } finally { fs.closeSync(fd); }
    offsets.set(absPath, stat.size);
    const text = buf.toString('utf8');

    // Only process complete lines
    const lastNl = text.lastIndexOf('\n');
    const complete = lastNl < 0 ? '' : text.slice(0, lastNl);
    if (lastNl >= 0 && lastNl < text.length - 1) {
      offsets.set(absPath, prev + Buffer.byteLength(complete) + 1);
    }

    const cwd = deriveCwd(sessionDir);

    for (const line of complete.split('\n')) {
      const s = line.trim();
      if (!s) continue;
      let entry;
      try { entry = JSON.parse(s); } catch { continue; }
      const userText = extractUserText(entry);
      if (userText) {
        onPrompt(userText, { source: 'grok', cwd });
      }
    }
  }

  seedExisting();

  // Watch the sessions root recursively for new/modified chat_history.jsonl files.
  let watcher;
  try {
    watcher = fs.watch(SESSIONS_ROOT, { recursive: true }, (_evt, relPath) => {
      if (!relPath) return;
      // Only care about chat_history.jsonl files
      if (!relPath.endsWith('chat_history.jsonl')) return;
      const absPath = path.join(SESSIONS_ROOT, relPath);
      const sessionDir = path.dirname(absPath);
      processChatFile(absPath, sessionDir);
    });
  } catch (err) {
    console.error('[grok-watcher] watch failed:', err.message);
    return () => {};
  }

  console.log('[grok-watcher] watching', SESSIONS_ROOT);
  return () => { try { watcher.close(); } catch {} };
}

module.exports = { start };
