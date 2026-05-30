// Watches ~/.claude/projects/**/*.jsonl for new user prompts and forwards them
// to a callback. Both the Claude Code CLI and the Claude desktop app write their
// transcripts here, so this watcher captures prompts from BOTH surfaces — unlike
// the UserPromptSubmit hook, which only reliably fires for the terminal CLI.
//
// The CLI path also captures via that hook (high fidelity), so main.js dedups by
// text: whichever of hook/watcher sees a prompt first wins, the other is dropped.
// We track per-file byte offsets and only parse the newly-appended tail on change.
const fs = require('fs');
const path = require('path');
const os = require('os');

const CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');
const PROJECTS_ROOT = path.join(CONFIG_DIR, 'projects');

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

function start(onPrompt) {
  if (!fs.existsSync(PROJECTS_ROOT)) {
    console.log('[claude-code-watcher] projects dir missing, skipping:', PROJECTS_ROOT);
    return () => {};
  }
  const offsets = new Map(); // absPath -> byteOffset

  // Seed offsets with the current end-of-file for every existing transcript, so we
  // only capture NEW prompts going forward — not the entire backlog on first run.
  function seedExisting() {
    walk(PROJECTS_ROOT, abs => {
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
      if (userText) onPrompt(userText, { source: 'claude-code', cwd: entry.cwd || '' });
    }
  }

  seedExisting();

  let watcher;
  try {
    watcher = fs.watch(PROJECTS_ROOT, { recursive: true }, (_evt, rel) => {
      if (!rel || !rel.endsWith('.jsonl')) return;
      processFile(path.join(PROJECTS_ROOT, rel));
    });
  } catch (err) {
    console.error('[claude-code-watcher] watch failed:', err.message);
    return () => {};
  }
  console.log('[claude-code-watcher] watching', PROJECTS_ROOT);
  return () => { try { watcher.close(); } catch {} };
}

module.exports = { start };
