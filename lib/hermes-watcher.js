// Watches ~/.hermes-chat/sessions/*.jsonl for new user messages and forwards
// them to a callback. The hermes-chat skill appends one JSON object per turn,
// shaped { ts, role, content }; we track per-file byte offsets and only parse
// the newly-appended tail on each fs change.
const path = require('path');
const os = require('os');
const { createJsonlTailWatcher, walkFiles } = require('./jsonl-tail-watcher');

function extractUserText(entry) {
  // hermes-chat shape: { ts, role: 'user'|'assistant', content: '...' }
  if (!entry || entry.role !== 'user') return null;
  const content = entry.content;
  const text = (typeof content === 'string' ? content : '').trim();
  return text || null;
}

// homeDir override exists for the Mac App Store build, where os.homedir() is
// the sandbox container — the real home arrives via a security-scoped grant.
function start(onPrompt, homeDir = os.homedir()) {
  const STATE_DIR = process.env.HERMES_CHAT_DIR || path.join(homeDir, '.hermes-chat');
  const SESSIONS_ROOT = path.join(STATE_DIR, 'sessions');
  return createJsonlTailWatcher({
    name: 'hermes-watcher',
    root: SESSIONS_ROOT,
    fileFilter: (rel) => rel.endsWith('.jsonl'),
    extractUserText,
    deriveMeta: () => ({ source: 'hermes', cwd: '' }),
    seedWalk: (onFile) => {
      walkFiles(SESSIONS_ROOT, abs => {
        if (abs.endsWith('.jsonl')) onFile(abs);
      });
    },
    onPrompt
  });
}

module.exports = { start };
