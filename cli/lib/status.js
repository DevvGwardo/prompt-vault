const http = require('http');

async function get(path) {
  return new Promise((resolve, reject) => {
    const req = http.request({
      host: '127.0.0.1', port: 8765, path, method: 'GET', timeout: 1000
    }, res => {
      let buf = '';
      res.on('data', c => buf += c);
      res.on('end', () => resolve({ status: res.statusCode, body: buf }));
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(); reject(new Error('timeout')); });
    req.end();
  });
}

async function status() {
  try {
    const r = await get('/status');
    if (r.status === 200) {
      const data = JSON.parse(r.body);
      console.log(`Prompt Vault: running (pid ${data.pid || '?'})`);
      console.log(`  saved:  ${data.count}`);
      console.log(`  recent:`);
      for (const p of data.recent || []) {
        console.log(`    [${p.score ?? '--'}] ${p.title || p.text.slice(0, 70)}`);
      }
    } else {
      console.log(`Prompt Vault responded with HTTP ${r.status}.`);
    }
  } catch (err) {
    console.log('Prompt Vault is not running.');
    console.log('Start the desktop app, or run `npm start` from the repo.');
  }
}

function printResults(results) {
  if (!results.length) { console.log('  (no matching prompts)'); return; }
  for (const p of results) {
    const src = p.source ? ` (${p.source})` : '';
    console.log(`  [${p.score ?? '--'}] ${p.title || p.text.slice(0, 70)}${src}`);
  }
}

async function query(q, limit) {
  const path = `/search?q=${encodeURIComponent(q || '')}&limit=${limit}`;
  try {
    const r = await get(path);
    if (r.status !== 200) { console.log(`Prompt Vault responded with HTTP ${r.status}.`); return; }
    printResults(JSON.parse(r.body).results || []);
  } catch {
    console.log('Prompt Vault is not running. Start the desktop app, or run `npm start` from the repo.');
  }
}

async function list(args) {
  await query('', Math.min(parseInt(args.limit, 10) || 20, 100));
}

async function search(args) {
  const q = (args._ && args._.join(' ')) || args.query || '';
  if (!q.trim()) { console.log('Usage: pv search <query>'); return; }
  await query(q, Math.min(parseInt(args.limit, 10) || 20, 100));
}

module.exports = { status, list, search };
