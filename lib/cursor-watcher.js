// Watches ~/.cursor/projects/**/agent-transcripts/**/*.jsonl for new user
// prompts from the Cursor IDE agent. Cursor appends JSONL lines as the chat
// progresses; we only parse newly-appended tails (same pattern as Claude Code).
//
// The cursor-agent CLI wrapper (install-hooks) only covers `cursor-agent -p …`.
// This watcher covers the desktop IDE, which is where most prompts happen.
const path = require('path');
const os = require('os');
const { createJsonlTailWatcher, walkFiles } = require('./jsonl-tail-watcher');

// Cursor injects these as synthetic user turns after subagent completions.
// They are not real typed prompts — skip them.
const SYSTEM_FOLLOWUP_SNIPPETS = [
  'Briefly inform the user about the task result',
  'Perform any necessary follow-up actions in response to the subagent completion'
];

function stripWrappers(text) {
  let cleaned = (text || '').trim();
  // Drop leading <timestamp>…</timestamp> preamble Cursor prepends.
  const tsEnd = cleaned.indexOf('</timestamp>');
  if (cleaned.startsWith('<timestamp>') && tsEnd !== -1) {
    cleaned = cleaned.slice(tsEnd + '</timestamp>'.length).trim();
  }
  const qOpen = cleaned.indexOf('<user_query>');
  const qClose = cleaned.lastIndexOf('</user_query>');
  if (qOpen !== -1 && qClose !== -1 && qClose > qOpen) {
    cleaned = cleaned.slice(qOpen + '<user_query>'.length, qClose).trim();
  }
  return cleaned;
}

function extractUserText(entry) {
  // Cursor shape: { role: 'user'|'assistant', message: { content: [{type:'text', text}] } }
  if (!entry || entry.role !== 'user') return null;
  const msg = entry.message;
  if (!msg || typeof msg !== 'object') return null;
  const content = msg.content;
  let text = '';
  if (typeof content === 'string') {
    text = content;
  } else if (Array.isArray(content)) {
    // Skip tool-result-only user turns if they ever appear.
    if (content.some(c => c && c.type === 'tool_result')) return null;
    text = content
      .filter(c => c && c.type === 'text' && c.text)
      .map(c => c.text)
      .join('\n');
  }
  text = stripWrappers(text);
  if (!text) return null;
  if (SYSTEM_FOLLOWUP_SNIPPETS.some(s => text.includes(s))) return null;
  // Skip bridge-injected persona/system turns (e.g. Hermes personas or
  // OpenAI-compatible bridge context) — those are not typed prompts.
  if (text.startsWith('[system]')) return null;
  return text;
}

function isAgentTranscript(rel) {
  // rel is POSIX-normalized by the shared watcher.
  // Keep main session transcripts; skip subagent side-chats.
  if (!rel.endsWith('.jsonl')) return false;
  if (!rel.includes('/agent-transcripts/')) return false;
  if (rel.includes('/subagents/')) return false;
  return true;
}

function projectSlugFromAbs(abs, projectsRoot) {
  // abs: <projectsRoot>/<slug>/agent-transcripts/<uuid>/<uuid>.jsonl
  const rel = path.relative(projectsRoot, abs);
  if (!rel || rel.startsWith('..')) return '';
  return rel.split(path.sep)[0] || '';
}

// homeDir override exists for the Mac App Store build, where os.homedir() is
// the sandbox container — the real home arrives via a security-scoped grant.
function start(onPrompt, homeDir = os.homedir()) {
  const PROJECTS_ROOT = path.join(homeDir, '.cursor', 'projects');
  return createJsonlTailWatcher({
    name: 'cursor-watcher',
    root: PROJECTS_ROOT,
    fileFilter: isAgentTranscript,
    extractUserText,
    deriveMeta: (_entry, abs) => ({
      source: 'cursor',
      // Slug is lossy (hyphens collide with path separators); still useful as a tag.
      cwd: projectSlugFromAbs(abs, PROJECTS_ROOT)
    }),
    seedWalk: (onFile) => {
      walkFiles(PROJECTS_ROOT, abs => {
        const rel = path.relative(PROJECTS_ROOT, abs).split(path.sep).join('/');
        if (isAgentTranscript(rel)) onFile(abs);
      });
    },
    onPrompt
  });
}

module.exports = { start, extractUserText, stripWrappers };
