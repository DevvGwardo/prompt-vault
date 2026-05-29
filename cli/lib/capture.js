const http = require('http');

const VAULT_HOST = process.env.PV_HOST || '127.0.0.1';
const VAULT_PORT = parseInt(process.env.PV_PORT || '8765', 10);

function readStdin() {
  return new Promise(resolve => {
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', c => { buf += c; });
    process.stdin.on('end', () => resolve(buf));
  });
}

async function capture(args) {
  const source = args.source || 'manual';
  let text = args.text;
  let cwd = process.cwd();
  if (!text && args['stdin-json']) {
    // Claude Code UserPromptSubmit hook pipes a JSON payload on stdin.
    try {
      const payload = JSON.parse(await readStdin() || '{}');
      text = payload.prompt || payload.user_prompt || payload.text || '';
      if (payload.cwd) cwd = payload.cwd;
    } catch { return; }
  } else if (!text && args.stdin) {
    text = await readStdin();
  }
  if (!text || !text.trim()) return; // silently drop empty

  const body = JSON.stringify({ prompt: text, source, cwd });

  await new Promise(resolve => {
    const req = http.request({
      host: VAULT_HOST, port: VAULT_PORT, path: '/prompt', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 1000
    }, res => { res.resume(); res.on('end', resolve); });
    req.on('error', () => resolve()); // never block the caller
    req.on('timeout', () => { req.destroy(); resolve(); });
    req.write(body);
    req.end();
  });
}

module.exports = { capture };
