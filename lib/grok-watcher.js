// Watches ~/.grok/sessions/**/chat_history.jsonl for new user messages and
// forwards them to a callback. Grok appends to JSONL files; we track per-file
// byte offsets and only parse the newly-appended tail on each fs change.
const path = require('path');
const os = require('os');
const { createJsonlTailWatcher, walkDirs } = require('./jsonl-tail-watcher');

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

  // Drop <system-reminder>...</system-reminder> blocks that xAI injects into user
  // turns (context / MCP / skill boilerplate). Many turns are reminder-only and
  // carry no typed prompt at all; those must come back null.
  let withoutReminders = text.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, ' ').trim();
  if (!withoutReminders) return null;

  // Strip the <user_info>...</user_info> preamble that Grok prepends to every user message.
  // The actual prompt follows after the closing </user_info> tag, wrapped in <user_query> tags.
  const infoEnd = withoutReminders.indexOf('</user_info>');
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
  // Session directories are named like "%2FUsers%2Fjane%2Fmy-project"
  // which is the URL-encoded workspace path. Decode it.
  const dirName = path.basename(sessionDirPath);
  try {
    const decoded = decodeURIComponent(dirName);
    // Only return if it looks like an absolute path
    if (decoded.startsWith('/')) return decoded;
  } catch {}
  return '';
}

// homeDir override exists for the Mac App Store build, where os.homedir() is
// the sandbox container — the real home arrives via a security-scoped grant.
function start(onPrompt, homeDir = os.homedir()) {
  const SESSIONS_ROOT = path.join(homeDir, '.grok', 'sessions');
  return createJsonlTailWatcher({
    name: 'grok-watcher',
    root: SESSIONS_ROOT,
    fileFilter: (rel) => rel.endsWith('chat_history.jsonl'),
    extractUserText,
    deriveMeta: (_entry, abs) => ({
      source: 'grok',
      cwd: deriveCwd(path.dirname(abs))
    }),
    seedWalk: (onFile) => {
      const fs = require('fs');
      walkDirs(SESSIONS_ROOT, dirPath => {
        const chat = path.join(dirPath, 'chat_history.jsonl');
        if (fs.existsSync(chat)) onFile(chat);
      });
    },
    onPrompt
  });
}

module.exports = { start, extractUserText };
