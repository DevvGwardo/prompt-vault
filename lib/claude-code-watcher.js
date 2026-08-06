// Watches ~/.claude/projects/**/*.jsonl for new user prompts and forwards them
// to a callback. Both the Claude Code CLI and the Claude desktop app write their
// transcripts here, so this watcher captures prompts from BOTH surfaces — unlike
// the UserPromptSubmit hook, which only reliably fires for the terminal CLI.
//
// The CLI path also captures via that hook (high fidelity), so main.js dedups by
// hash of normalized text: whichever of hook/watcher sees a prompt first wins.
const path = require('path');
const os = require('os');
const { createJsonlTailWatcher, walkFiles } = require('./jsonl-tail-watcher');

// User-line text that is really a slash-command / local-command artifact, not a
// genuine typed prompt. We skip anything whose content starts with these tags.
const ARTIFACT_PREFIXES = ['<command-name>', '<command-message>', '<local-command-stdout>', '<bash-input>', '<bash-stdout>'];

function extractUserText(entry) {
  // Claude Code shape: { type: 'user', message: { role, content }, isMeta, isSidechain, toolUseResult? }
  if (!entry || entry.type !== 'user') return null;
  // Skip injected context (hook output, system reminders) and subagent turns.
  if (entry.isMeta || entry.isSidechain) return null;
  // Skip tool results (also role:user in this format).
  if (entry.toolUseResult) return null;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return null;
  const content = msg.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    if (content.some(c => c && c.type === 'tool_result')) return null;
    text = content.filter(c => c && c.type === 'text' && c.text).map(c => c.text).join('\n');
  }
  text = text.trim();
  if (!text) return null;
  if (ARTIFACT_PREFIXES.some(p => text.startsWith(p))) return null;
  return text;
}

// homeDir override exists for the Mac App Store build, where os.homedir() is
// the sandbox container — the real home arrives via a security-scoped grant.
function start(onPrompt, homeDir = os.homedir()) {
  const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(homeDir, '.claude');
  const PROJECTS_ROOT = path.join(CONFIG_DIR, 'projects');
  return createJsonlTailWatcher({
    name: 'claude-code-watcher',
    root: PROJECTS_ROOT,
    fileFilter: (rel) => rel.endsWith('.jsonl'),
    extractUserText,
    deriveMeta: (entry) => ({ source: 'claude-code', cwd: (entry && entry.cwd) || '' }),
    seedWalk: (onFile) => {
      walkFiles(PROJECTS_ROOT, abs => {
        if (abs.endsWith('.jsonl')) onFile(abs);
      });
    },
    onPrompt
  });
}

module.exports = { start, extractUserText };
