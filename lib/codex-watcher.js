// Watches ~/.codex/sessions/**/*.jsonl for new user messages and forwards them
// to a callback. Codex appends to JSONL files; we track per-file byte offsets
// and only parse the newly-appended tail on each fs change.
const path = require('path');
const os = require('os');
const { createJsonlTailWatcher, walkFiles } = require('./jsonl-tail-watcher');

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

// homeDir override exists for the Mac App Store build, where os.homedir() is
// the sandbox container — the real home arrives via a security-scoped grant.
function start(onPrompt, homeDir = os.homedir()) {
  const SESSIONS_ROOT = path.join(homeDir, '.codex', 'sessions');
  return createJsonlTailWatcher({
    name: 'codex-watcher',
    root: SESSIONS_ROOT,
    fileFilter: (rel) => rel.endsWith('.jsonl'),
    extractUserText,
    deriveMeta: (_entry, abs) => ({ source: 'codex', cwd: path.dirname(abs) }),
    seedWalk: (onFile) => {
      walkFiles(SESSIONS_ROOT, abs => {
        if (abs.endsWith('.jsonl')) onFile(abs);
      });
    },
    onPrompt
  });
}

module.exports = { start };
