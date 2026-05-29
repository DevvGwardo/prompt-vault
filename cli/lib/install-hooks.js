const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');

const HOOK_SCRIPT = path.join(__dirname, '..', 'bin', 'pv.js');

function ask(q) {
  return new Promise(resolve => {
    const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
    rl.question(q, ans => { rl.close(); resolve(ans.trim().toLowerCase()); });
  });
}

function which(bin) {
  for (const dir of (process.env.PATH || '').split(':')) {
    const p = path.join(dir, bin);
    try { if (fs.statSync(p).isFile()) return p; } catch {}
  }
  return null;
}

async function wireClaudeCode() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) {
    console.log('  · Claude Code settings not found at', settingsPath, '— skipping.');
    return;
  }
  const raw = fs.readFileSync(settingsPath, 'utf8');
  let cfg;
  try { cfg = JSON.parse(raw); } catch { console.log('  · settings.json is not valid JSON, skipping.'); return; }
  cfg.hooks = cfg.hooks || {};
  const list = cfg.hooks.UserPromptSubmit = cfg.hooks.UserPromptSubmit || [];
  const cmd = `node "${HOOK_SCRIPT}" capture --source claude-code --stdin-json`;
  const alreadyWired = list.some(h => (h.hooks || []).some(x => x.command && x.command.includes('pv.js')));
  if (alreadyWired) { console.log('  · already wired for Claude Code.'); return; }
  list.push({ matcher: '', hooks: [{ type: 'command', command: cmd, timeout: 2 }] });
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  console.log('  ✓ Claude Code UserPromptSubmit hook wired.');
}

function wireBinaryWrapper(name, realPathHint) {
  const target = path.join(os.homedir(), '.local', 'bin', name);
  const realPath = realPathHint || fs.realpathSync(which(name) || '');
  if (!realPath || realPath === target) {
    console.log(`  · ${name} not found or already a wrapper — skipping.`);
    return;
  }
  const script = `#!/usr/bin/env bash
# Prompt Vault wrapper for ${name} — captures -p prompts then exec's real binary.
set -u
REAL="${realPath}"
PV_PROMPT=""
next_is_prompt=false
for arg in "$@"; do
    if [[ "$next_is_prompt" == true ]]; then PV_PROMPT="$arg"; break; fi
    if [[ "$arg" == "-p" || "$arg" == "--prompt" ]]; then next_is_prompt=true; fi
done
if [[ -n "$PV_PROMPT" ]]; then
    node "${HOOK_SCRIPT}" capture --source ${name} --text "$PV_PROMPT" &
fi
exec "$REAL" "$@"
`;
  fs.mkdirSync(path.dirname(target), { recursive: true });
  if (fs.existsSync(target)) fs.unlinkSync(target);
  fs.writeFileSync(target, script, { mode: 0o755 });
  console.log(`  ✓ ${name} wrapper installed at ${target}`);
}

async function installHooks() {
  console.log('pv install-hooks — wiring capture for detected CLIs');
  console.log('');
  const tools = [
    { name: 'Claude Code', detected: !!which('claude'), wire: wireClaudeCode },
    { name: 'Codex CLI',   detected: !!which('codex'), wire: () => console.log('  · Codex is captured automatically by the running Prompt Vault app (watches ~/.codex/sessions).') },
    { name: 'Grok CLI',    detected: !!which('grok'),  wire: () => console.log('  · Grok is captured automatically by the running Prompt Vault app (watches ~/.grok/sessions).') },
    { name: 'cursor-agent',detected: !!which('cursor-agent'), wire: () => wireBinaryWrapper('cursor-agent') }
  ];
  for (const t of tools) {
    if (!t.detected) { console.log(`  · ${t.name}: not installed.`); continue; }
    const ans = await ask(`  ${t.name}: install hook? [Y/n] `);
    if (ans === 'n' || ans === 'no') continue;
    try { await t.wire(); } catch (err) { console.log(`  ✗ ${t.name}: ${err.message}`); }
  }
  console.log('');
  console.log('Done. Make sure the Prompt Vault app is running (download from your site).');
}

function unwireClaudeCode() {
  const settingsPath = path.join(os.homedir(), '.claude', 'settings.json');
  if (!fs.existsSync(settingsPath)) { console.log('  · Claude Code settings not found — nothing to remove.'); return; }
  let cfg;
  try { cfg = JSON.parse(fs.readFileSync(settingsPath, 'utf8')); } catch { console.log('  · settings.json is not valid JSON, skipping.'); return; }
  const list = cfg.hooks && cfg.hooks.UserPromptSubmit;
  if (!Array.isArray(list)) { console.log('  · no Claude Code hooks present.'); return; }
  const before = list.length;
  cfg.hooks.UserPromptSubmit = list.filter(h =>
    !(h.hooks || []).some(x => x.command && (x.command.includes('pv.js') || x.command.includes('prompt-vault-hook.sh'))));
  if (cfg.hooks.UserPromptSubmit.length === before) { console.log('  · no Prompt Vault hook found.'); return; }
  fs.writeFileSync(settingsPath, JSON.stringify(cfg, null, 2));
  console.log('  ✓ Claude Code hook removed.');
}

function removeBinaryWrapper(name) {
  const target = path.join(os.homedir(), '.local', 'bin', name);
  if (!fs.existsSync(target)) return;
  let contents = '';
  try { contents = fs.readFileSync(target, 'utf8'); } catch { return; }
  if (!contents.includes('Prompt Vault wrapper')) {
    console.log(`  · ${name} at ${target} is not a Prompt Vault wrapper — leaving it.`);
    return;
  }
  fs.unlinkSync(target);
  console.log(`  ✓ removed ${name} wrapper at ${target}`);
}

async function uninstallHooks() {
  console.log('pv uninstall-hooks — removing Prompt Vault capture hooks');
  console.log('');
  unwireClaudeCode();
  for (const name of ['grok', 'cursor-agent']) removeBinaryWrapper(name);
  console.log('');
  console.log('Done. Codex/Grok watchers stop automatically when you quit the Prompt Vault app.');
}

module.exports = { installHooks, uninstallHooks };
