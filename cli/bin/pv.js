#!/usr/bin/env node
const { capture } = require('../lib/capture');
const { installHooks, uninstallHooks } = require('../lib/install-hooks');
const { status, list, search } = require('../lib/status');

const HELP = `pv — Prompt Vault CLI

USAGE
  pv capture --source <name> [--text "..." | --stdin]
  pv install-hooks                  install capture hooks for installed CLIs
  pv uninstall-hooks                remove Prompt Vault capture hooks
  pv status                         show vault status (running? counts? recent prompts)
  pv list [--limit N]               list most recent saved prompts
  pv search <query>                 search saved prompts
  pv help                           show this message

EXAMPLES
  echo "refactor this" | pv capture --source manual --stdin
  pv capture --source grok --text "explain quicksort"
  pv install-hooks                  walks you through wiring Claude Code, Codex, Grok, cursor-agent
  pv search "auth refactor"
`;

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = argv[i + 1];
      if (next === undefined || next.startsWith('--')) { out[key] = true; }
      else { out[key] = next; i++; }
    } else { out._.push(a); }
  }
  return out;
}

const [cmd, ...rest] = process.argv.slice(2);
const args = parseArgs(rest);

(async () => {
  switch (cmd) {
    case 'capture':         return capture(args);
    case 'install-hooks':   return installHooks(args);
    case 'uninstall-hooks': return uninstallHooks(args);
    case 'status':          return status(args);
    case 'list':            return list(args);
    case 'search':          return search(args);
    case 'help':
    case '--help':
    case '-h':
    case undefined:       process.stdout.write(HELP); return;
    default:
      process.stderr.write(`pv: unknown command "${cmd}"\n\n${HELP}`);
      process.exit(1);
  }
})().catch(err => {
  process.stderr.write(`pv: ${err.message}\n`);
  process.exit(1);
});
