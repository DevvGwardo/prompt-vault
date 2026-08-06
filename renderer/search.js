const q = document.getElementById('q');
const list = document.getElementById('list');
const detail = document.getElementById('detail');

let current = null;
let rows = [];
let allRows = [];
let vaultStats = null;
let recentCaps = [];
let trainedIds = {}; // promptId -> 'good' | 'bad' | 'implicit_good' | 'implicit_bad'
let _lastRevision = null;
let _lastRenderedRevision = null;
let _lastQuery = '';
let _dimById = new Map();
let _listIds = '';
let _lastDetailKey = '';

function esc(s) {
  return (s || '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

function relTime(ts) {
  const s = (Date.now() - ts) / 1000;
  if (s < 60) return 'just now';
  if (s < 3600) return `${Math.floor(s/60)}m ago`;
  if (s < 86400) return `${Math.floor(s/3600)}h ago`;
  const d = Math.floor(s / 86400);
  if (d < 7) return `${d}d ago`;
  return new Date(ts).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
}

function verdictColor(v) {
  if (v === 'save') return 'good';
  if (v === 'skip') return 'bad';
  return 'warn';
}

function sourceLabel(s) {
  return ({ 'claude-code': 'Claude Code', 'cursor': 'Cursor', 'grok': 'Grok', 'codex': 'Codex', 'hermes': 'Hermes', clipboard: 'Clipboard', hotkey: 'Hotkey', manual: 'Manual' }[s]) || s || 'unknown';
}

function sourceShort(s) {
  return ({ 'claude-code': 'CC', 'cursor': 'CU', 'grok': 'GR', 'codex': 'CX', 'hermes': 'HM', clipboard: 'CB', hotkey: 'HK', manual: 'MN' }[s]) || s || '??';
}

// ---- LCS line-level diff (pure JS, no deps) ----
const DIFF_MAX_LINES = 1000;
function computeDiff(oldText, newText) {
  const oldLines = oldText.split('\n');
  const newLines = newText.split('\n');
  if (oldLines.length > DIFF_MAX_LINES || newLines.length > DIFF_MAX_LINES) {
    return [{ type: 'same', text: 'Diff too large to display (' + oldLines.length + ' old / ' + newLines.length + ' new lines).' }];
  }
  const m = oldLines.length, n = newLines.length;

  // Guard: if line product exceeds ~500x500 (~250K DP cells), skip O(m*n) LCS
  // and use a simple prefix/suffix scan to avoid freezing the renderer
  if (m * n > 250000) {
    const result = [];
    let i = 0;
    while (i < m && i < n && oldLines[i] === newLines[i]) {
      result.push({ type: 'same', text: oldLines[i] });
      i++;
    }
    let j = 0;
    while (j < m - i && j < n - i && oldLines[m - 1 - j] === newLines[n - 1 - j]) {
      j++;
    }
    for (let k = i; k < m - j; k++) {
      result.push({ type: 'rem', text: oldLines[k] });
    }
    for (let k = i; k < n - j; k++) {
      result.push({ type: 'add', text: newLines[k] });
    }
    return result;
  }

  const dp = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (oldLines[i - 1] === newLines[j - 1]) dp[i][j] = dp[i - 1][j - 1] + 1;
      else dp[i][j] = Math.max(dp[i - 1][j], dp[i][j - 1]);
    }
  }
  const result = [];
  let i = m, j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldLines[i - 1] === newLines[j - 1]) {
      result.unshift({ type: 'same', text: oldLines[i - 1] });
      i--; j--;
    } else if (j > 0 && (i === 0 || dp[i][j - 1] >= dp[i - 1][j])) {
      result.unshift({ type: 'add', text: newLines[j - 1] });
      j--;
    } else {
      result.unshift({ type: 'rem', text: oldLines[i - 1] });
      i--;
    }
  }
  return result;
}

// ---- Score hover tooltip ----
const scoreTip = document.getElementById('score-tip');
let scoreTipTimeout = null;
let _tipActive = null; // element whose tooltip is currently showing

const DIM_LABELS = {
  length: 'Length', specificity: 'Specificity', constraints: 'Constraints',
  context: 'Context', examples: 'Examples', structure: 'Structure',
  precision: 'Precision', ambiguity: 'Ambiguity', redundancy: 'Redundancy',
  training: 'Training bias'
};

function valClass(v) {
  if (v > 0) return 'pos';
  if (v < 0) return 'neg';
  return 'neutral';
}

function fmtVal(v) {
  if (v == null) return '—';
  return (v > 0 ? '+' : '') + v;
}

// ---- Share card renderer (social-media optimized) ----
function renderShareCard(row) {
  const W = 1200, H = 630;
  const gap = 18;
  const pad = 24;
  const r = 20;

  const canvas = document.createElement('canvas');
  canvas.width = W; canvas.height = H;
  const ctx = canvas.getContext('2d');

  const verdict = row.verdict || 'maybe';
  const badgeColors = { save: '#50e3a4', maybe: '#f0b450', skip: '#ff6464' };
  const accent = badgeColors[verdict] || '#7a7a7a';
  const score = row.score ?? '—';

  const BG     = '#000000';
  const MODULE = '#141414';
  const BORDER = '#232323';
  const TEXT   = '#fafafa';
  const MUTED  = '#7a7a7a';
  const BODY   = '#e0e0e0'; // brighter for readability

  function drawModule(x, y, w, h) {
    ctx.fillStyle = MODULE;
    ctx.beginPath(); ctx.roundRect(x, y, w, h, r); ctx.fill();
    ctx.strokeStyle = BORDER;
    ctx.lineWidth = 1;
    ctx.beginPath(); ctx.roundRect(x + 0.5, y + 0.5, w - 1, h - 1, r); ctx.stroke();
  }

  // --- Black background ---
  ctx.fillStyle = BG;
  ctx.fillRect(0, 0, W, H);

  // --- Layout: compact header + large content module ---
  const headerH = 58;
  const headerW = W - pad * 2;
  const headerX = pad;
  const headerY = pad;

  const contentW = W - pad * 2;
  const contentX = pad;
  const contentY = headerY + headerH + gap;
  const contentH = H - contentY - pad;

  // ========== HEADER BAR (thin branded strip) ==========
  drawModule(headerX, headerY, headerW, headerH);

  // Wordmark
  ctx.fillStyle = TEXT;
  ctx.font = '700 22px "Geist", ui-sans-serif, -apple-system, sans-serif';
  ctx.fillText('Prompt Vault', headerX + 18, headerY + 36);

  // Right side: score badge
  const scoreText = String(score);
  ctx.font = '700 20px "Geist Mono", ui-monospace, monospace';
  const scoreW = ctx.measureText(scoreText).width;
  const badgeX = headerX + headerW - 18 - scoreW - 28;
  const badgeY = headerY + 14;
  const badgeW = scoreW + 28;
  const badgeH = 30;

  ctx.fillStyle = accent;
  ctx.beginPath(); ctx.roundRect(badgeX, badgeY, badgeW, badgeH, 9); ctx.fill();
  ctx.fillStyle = BG;
  ctx.fillText(scoreText, badgeX + 14, badgeY + 22);

  // Verdict label left of badge
  ctx.fillStyle = accent;
  ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(verdict.toUpperCase(), badgeX - 10, badgeY + 22);
  ctx.textAlign = 'left';

  // ========== CONTENT MODULE (prompt front and center) ==========
  drawModule(contentX, contentY, contentW, contentH);

  // Caption row + meta
  const source = sourceLabel(row.source);
  const date = new Date(row.created_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' });
  ctx.fillStyle = MUTED;
  ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
  ctx.fillText('DETAIL', contentX + 18, contentY + 28);

  ctx.fillStyle = MUTED;
  ctx.font = '11px "Geist Mono", ui-monospace, monospace';
  ctx.textAlign = 'right';
  ctx.fillText(`${source}  ·  ${date}`, contentX + contentW - 18, contentY + 28);
  ctx.textAlign = 'left';

  // Divider
  const divY = contentY + 42;
  ctx.strokeStyle = BORDER;
  ctx.lineWidth = 1;
  ctx.beginPath(); ctx.moveTo(contentX + 18, divY); ctx.lineTo(contentX + contentW - 18, divY); ctx.stroke();

  // --- PROMPT CONTENT (large, readable) ---
  const cx = contentX + 28;
  const cw = contentW - 56;
  let y = divY + 32;

  // Title
  const title = row.title || row.text.slice(0, 100);
  ctx.fillStyle = TEXT;
  ctx.font = '600 26px "Geist", ui-sans-serif, -apple-system, sans-serif';
  const titleLines = wrapText(ctx, title, cw);
  for (const line of titleLines.slice(0, 2)) {
    ctx.fillText(line, cx, y);
    y += 36;
  }

  y += 12;

  // Body — larger font for social media readability
  const body = row.text || '';
  // Skip title duplication if body starts with the same text
  let displayBody = body;
  if (title && body.startsWith(title)) {
    displayBody = body.slice(title.length).trim();
  }
  if (!displayBody && title) displayBody = title;

  ctx.fillStyle = BODY;
  ctx.font = '18px "Geist Mono", ui-monospace, monospace';
  const bodyLines = wrapText(ctx, displayBody, cw);
  const maxBody = Math.floor((contentY + contentH - y - 20) / 25);
  for (const line of bodyLines.slice(0, maxBody)) {
    ctx.fillText(line, cx, y);
    y += 25;
  }
  if (bodyLines.length > maxBody) {
    ctx.fillStyle = MUTED;
    ctx.font = '16px "Geist Mono", ui-monospace, monospace';
    ctx.fillText('…', cx, y);
  }

  // --- Footer chips ---
  const footY = contentY + contentH - 20;
  let chipX = cx;
  function drawFooterChip(text, color) {
    ctx.font = '500 11px "Geist Mono", ui-monospace, monospace';
    const tw = ctx.measureText(text).width;
    const cw = tw + 18;
    const ch = 24;
    const cy = footY - 17;
    ctx.fillStyle = color + '1a';
    ctx.beginPath(); ctx.roundRect(chipX, cy, cw, ch, 12); ctx.fill();
    ctx.strokeStyle = color + '33';
    ctx.lineWidth = 0.5;
    ctx.beginPath(); ctx.roundRect(chipX + 0.25, cy + 0.25, cw - 0.5, ch - 0.5, 12); ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, chipX + 9, footY);
    chipX += cw + 8;
  }
  drawFooterChip(verdict + ' · ' + score, accent);
  if (row.pinned) drawFooterChip('pinned', TEXT);
  drawFooterChip(source, MUTED);

  return canvas;
}

function wrapText(ctx, text, maxWidth) {
  const words = text.split(/\s+/);
  const lines = [];
  let current = '';
  for (const w of words) {
    const test = current ? current + ' ' + w : w;
    if (ctx.measureText(test).width > maxWidth && current) {
      lines.push(current);
      current = w;
    } else {
      current = test;
    }
  }
  if (current) lines.push(current);
  return lines.length ? lines : [text.slice(0, 100)];
}

async function sharePrompt(row) {
  if (!row) return;
  try {
    const canvas = renderShareCard(row);
    const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/png'));
    if (!blob) return;
    const bytes = new Uint8Array(await blob.arrayBuffer());
    // Chunked conversion — spreading a large buffer into String.fromCharCode
    // throws "Maximum call stack size exceeded" on big share cards.
    let bin = '';
    const CHUNK = 0x8000;
    for (let i = 0; i < bytes.length; i += CHUNK) {
      bin += String.fromCharCode(...bytes.subarray(i, i + CHUNK));
    }
    const base64 = btoa(bin);
    const result = await window.vault.shareImage(base64, row.id);
    if (result) {
      const btn = document.getElementById('a-share');
      if (btn) { btn.innerHTML = `<svg viewBox="0 0 20 20" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75"><path d="M6 11l3 3 6-8"/></svg> Saved`; setTimeout(() => { if (btn) btn.innerHTML = `<svg viewBox="0 0 20 20" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75"><path d="M17 3l-4 4M7 13l-3 3M17 3h-4v4M7 13v4H3"/></svg> Share`; }, 1500); }
    }
  } catch (e) { console.error('[share] error:', e); }
}

function showScoreTip(evt, dimensions) {
  if (!dimensions) return;
  let d;
  try { d = typeof dimensions === 'string' ? JSON.parse(dimensions) : dimensions; } catch { return; }
  if (!d || !Object.keys(d).length) return;

  const el = evt.target.closest?.('.score-hover');
  if (el === _tipActive) return;
  _tipActive = el;

  // --- Histogram mode (has _range field) ---
  if (d._range) {
    const pctBar = d._pct ? Math.min(100, Math.max(2, d._pct)) : 0;
    scoreTip.innerHTML = `
      <div class="score-tip-section">
        <div class="score-tip-head">Score range</div>
        <div class="score-tip-row"><span class="st-label">Range</span><span class="st-val neutral">${d._range}</span></div>
        <div class="score-tip-row"><span class="st-label">Prompts</span><span class="st-val neutral">${d._count ?? 0}</span></div>
        <div class="score-tip-row"><span class="st-label">Share</span><span class="st-val neutral">${d._pct ?? 0}%</span></div>
        <div class="score-tip-bar"><span class="score-tip-bar-fill" style="width:${pctBar}%"></span></div>
      </div>
      <div class="score-tip-section">
        <div class="score-tip-head">Verdicts</div>
        <div class="score-tip-row"><span class="st-label"><span class="st-dot good"></span>Save</span><span class="st-val pos">${d._save ?? 0}</span></div>
        <div class="score-tip-row"><span class="st-label"><span class="st-dot warn"></span>Maybe</span><span class="st-val neutral">${d._maybe ?? 0}</span></div>
        <div class="score-tip-row"><span class="st-label"><span class="st-dot bad"></span>Skip</span><span class="st-val neg">${d._skip ?? 0}</span></div>
      </div>
    `;
  } else if (d._type) {
    // --- Generic component tooltip ---
    const pctBar = d._pct ? Math.min(100, Math.max(2, d._pct)) : 0;
    const rows = [];
    if (d._label) rows.push(`<div class="score-tip-row"><span class="st-label">${esc(d._label)}</span><span class="st-val neutral">${esc(d._value ?? '')}</span></div>`);
    if (d._detail) rows.push(`<div class="score-tip-row"><span class="st-label">${esc(d._detail)}</span></div>`);
    if (d._extra) rows.push(`<div class="score-tip-row"><span class="st-label">${esc(d._extra)}</span></div>`);
    if (d._pct != null) {
      rows.push(`<div class="score-tip-row"><span class="st-label">Share</span><span class="st-val neutral">${d._pct}%</span></div>`);
      rows.push(`<div class="score-tip-bar"><span class="score-tip-bar-fill" style="width:${pctBar}%"></span></div>`);
    }
    scoreTip.innerHTML = `
      <div class="score-tip-section">
        <div class="score-tip-head">${esc(d._head ?? 'Detail')}</div>
        ${rows.join('')}
      </div>
    `;
  } else {
    // --- Prompt score mode ---
    const dimRows = Object.entries(DIM_LABELS).map(([k, label]) => {
      const v = d[k];
      return `<div class="score-tip-row"><span class="st-label">${label}</span><span class="st-val ${valClass(v)}">${fmtVal(v)}</span></div>`;
    }).join('');

    const words = d._words, lines = d._lines, chars = d._chars;
    let statsHtml = '';
    if (words != null || chars != null) {
      const feats = [];
      if (d._code) feats.push('code');
      if (d._list) feats.push('list');
      if (d._question) feats.push('question');
      statsHtml = `<div class="score-tip-section">
        <div class="score-tip-head">Text</div>
        <div class="score-tip-row"><span class="st-label">Words</span><span class="st-val neutral">${words ?? '—'}</span></div>
        <div class="score-tip-row"><span class="st-label">Lines</span><span class="st-val neutral">${lines ?? '—'}</span></div>
        <div class="score-tip-row"><span class="st-label">Chars</span><span class="st-val neutral">${chars ?? '—'}</span></div>
        ${feats.length ? `<div class="score-tip-row"><span class="st-label">Features</span><span class="st-val neutral">${feats.join(', ')}</span></div>` : ''}
      </div>`;
    }

    const dimTotal = Object.entries(DIM_LABELS).reduce((s, [k]) => s + (typeof d[k] === 'number' ? d[k] : 0), 0);
    const finalScore = 35 + dimTotal;

    scoreTip.innerHTML = `
      <div class="score-tip-section">
        <div class="score-tip-head">Scoring</div>
        ${dimRows}
      </div>
      ${statsHtml}
      <hr class="score-tip-div">
      <div class="score-tip-formula">
        <span class="tf-base">35</span>
        <span class="tf-eq"> + </span>
        <span class="tf-dims">${dimTotal > 0 ? '+' : ''}${dimTotal}</span>
        <span class="tf-eq"> = </span>
        <span class="tf-total">${finalScore}</span>
      </div>
    `;
  }

  // Position responsively — smart edge detection
  const rect = el.getBoundingClientRect();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const gap = 10;

  // Read actual max-width from computed style
  const tipStyle = getComputedStyle(scoreTip);
  const maxTipW = Math.min(parseFloat(tipStyle.maxWidth) || 280, vw - 16);

  // Measure actual tooltip dimensions after content is set
  const tipRect = scoreTip.getBoundingClientRect();
  const tipH = tipRect.height || 100;

  // Try above first
  let targetX = rect.left + rect.width / 2;
  let targetY = rect.top - gap;
  let below = false;

  // If not enough room above, flip below
  if (targetY - tipH < 8) {
    targetY = rect.bottom + gap;
    below = true;
    // If not enough room below either, stay above but clamp to top edge
    if (targetY + tipH > vh - 8) {
      targetY = rect.top - gap;
      below = false;
    }
  }

  // Horizontal — keep caret aligned with target, clamp tooltip body within viewport
  const halfW = maxTipW / 2;
  let tipX = targetX;
  let caretShift = 0;

  if (targetX - halfW < 8) {
    tipX = halfW + 8;
    caretShift = targetX - tipX; // caret offset from center
  } else if (targetX + halfW > vw - 8) {
    tipX = vw - halfW - 8;
    caretShift = targetX - tipX;
  }

  // Apply caret shift via CSS custom property
  scoreTip.style.setProperty('--caret-shift', caretShift + 'px');

  scoreTip.classList.remove('below');
  scoreTip.style.left = tipX + 'px';
  scoreTip.style.top = targetY + 'px';
  scoreTip.style.transform = below ? 'translate(-50%, 6px)' : 'translate(-50%, -100%)';
  if (below) scoreTip.classList.add('below');
  scoreTip.classList.add('visible');

  clearTimeout(scoreTipTimeout);
}

// Hide tooltip on window resize — prevents stale positioning
window.addEventListener('resize', () => {
  scoreTip.classList.remove('visible');
  _tipActive = null;
});

function hideScoreTip() {
  _tipActive = null;
  scoreTipTimeout = setTimeout(() => {
    scoreTip.classList.remove('visible');
  }, 100);
}

// ---- Module 5: ACTIVITY ----
function updateActivity() {
  const stats = vaultStats || {};
  const cap = recentCaps[0];
  const row = rows[0];
  const recent = (row && cap)
    ? (row.created_at >= cap.created_at ? row : cap)
    : (row || cap || null);
  if (!recent) {
    document.getElementById('activity-last').textContent = 'No prompts yet';
    document.getElementById('activity-streak').textContent = '';
    return;
  }
  const secs = (Date.now() - recent.created_at) / 1000;
  const lastStr = secs < 60 ? 'just now' : secs < 3600 ? `${Math.floor(secs / 60)}m ago` : secs < 86400 ? `${Math.floor(secs / 3600)}h ago` : `${Math.floor(secs / 86400)}d ago`;
  document.getElementById('activity-last').textContent = `${lastStr}  ·  ${sourceLabel(recent.source)}`;

  const streak = stats.streak || 0;
  const streakEl = document.getElementById('activity-streak');
  if (streak > 0) {
    streakEl.textContent = `${streak} day${streak === 1 ? '' : 's'} streak`;
  } else {
    streakEl.textContent = 'No activity today';
  }

  const elMain = document.getElementById('activity-last');
  const elStreak = document.getElementById('activity-streak');
  elMain.className = 'activity-main score-hover';
  elMain.dataset.dimensions = JSON.stringify({ _type:'activity', _head:'Last capture', _label:lastStr, _detail:sourceLabel(recent.source), _extra:recent.title ? esc(recent.title).slice(0, 40) : '' });
  elStreak.className = 'activity-sub mono score-hover';
  elStreak.dataset.dimensions = JSON.stringify({ _type:'activity', _head:'Streak', _label:streakEl.textContent, _detail:`${stats.total || 0} prompts total` });
}

// ---- Module 3: STATS ----
function updateStats() {
  const stats = vaultStats || {};
  const total = stats.total || 0;
  const avg = stats.avgScore != null ? Math.round(stats.avgScore) : 0;
  const weekCount = stats.week || 0;

  document.getElementById('stat-total').textContent = total;
  document.getElementById('stat-avg').textContent = avg + '/100';
  document.getElementById('stat-week').textContent = String(weekCount);

  const elTotal = document.getElementById('stat-total');
  const elAvg = document.getElementById('stat-avg');
  const elWeek = document.getElementById('stat-week');
  const scored = total > 0 && stats.minScore != null;

  elTotal.className = 'stat-value tnum score-hover';
  elTotal.dataset.dimensions = JSON.stringify({ _type:'stat', _head:'Total prompts', _label:'All time', _value:String(total), _detail:scored ? 'All scored' : 'None scored' });
  elAvg.className = 'stat-value tnum score-hover';
  elAvg.dataset.dimensions = JSON.stringify({ _type:'stat', _head:'Average score', _label:'Mean', _value:avg + '/100', _detail:scored ? 'Vault average' : 'No scores yet', _extra:scored ? `Range: ${stats.minScore}–${stats.maxScore}` : '' });
  elWeek.className = 'stat-value tnum score-hover';
  elWeek.dataset.dimensions = JSON.stringify({ _type:'stat', _head:'Last 7 days', _label:'Captured', _value:String(weekCount), _detail:'This week' });
}

// ---- Module 1: VAULT ----
function updateVault() {
  const stats = vaultStats || {};
  const total = stats.total || 0;
  const pinned = stats.pinned || 0;
  const week = stats.week || 0;
  document.getElementById('vault-subhead').textContent =
    `${total} prompts · ${pinned} pinned · ${week} this week`;
}

let _trainingStatus = null;

async function updateTrainingStatus(version) {
  if (version != null && version !== _refreshVersion) return;
  try { _trainingStatus = await window.vault.trainingStatus(); } catch { _trainingStatus = null; }
  if (version != null && version !== _refreshVersion) return;
  const el = document.getElementById('vault-subhead');
  if (!el || !_trainingStatus || _trainingStatus.labeled < 1) return;
  el.textContent = el.textContent + `  |  model: ${_trainingStatus.labeled} labeled · ${_trainingStatus.tokens}t/${_trainingStatus.bigrams}b`;
}

// ---- Module 4: VERDICTS ----
function updateVerdicts() {
  const bv = vaultStats?.byVerdict || {};
  const save = bv.save || 0;
  const maybe = bv.maybe || 0;
  const skip = bv.skip || 0;
  const total = vaultStats?.total || (save + maybe + skip) || 1;

  const elSave = document.getElementById('v-save');
  const elMaybe = document.getElementById('v-maybe');
  const elSkip = document.getElementById('v-skip');

  elSave.textContent = save || '';
  elMaybe.textContent = maybe || '';
  elSkip.textContent = skip || '';

  elSave.className = 'verdict-circle good score-hover';
  elSave.dataset.dimensions = JSON.stringify({ _type:'verdict', _head:'Verdict', _label:'Save', _value:String(save), _pct:Math.round(save/total*100) });
  elMaybe.className = 'verdict-circle warn score-hover';
  elMaybe.dataset.dimensions = JSON.stringify({ _type:'verdict', _head:'Verdict', _label:'Maybe', _value:String(maybe), _pct:Math.round(maybe/total*100) });
  elSkip.className = 'verdict-circle bad score-hover';
  elSkip.dataset.dimensions = JSON.stringify({ _type:'verdict', _head:'Verdict', _label:'Skip', _value:String(skip), _pct:Math.round(skip/total*100) });
}

// ---- Module 8: SOURCES ----
function updateSources() {
  const sources = ['claude-code', 'cursor', 'grok', 'codex', 'hermes', 'clipboard', 'hotkey', 'manual'];
  const bySource = vaultStats?.bySource || {};
  const counts = sources.map(s => bySource[s] || 0);
  const max = Math.max(...counts, 1);
  const total = vaultStats?.total || counts.reduce((a, b) => a + b, 0) || 1;
  document.getElementById('sources-list').innerHTML = sources.map((s, i) => {
    const dims = JSON.stringify({ _type:'source', _head:'Source', _label:sourceLabel(s), _value:String(counts[i]), _pct:Math.round(counts[i]/total*100) });
    return `<div class="source-item score-hover" data-dimensions='${esc(dims)}'>
      <span class="source-label">${sourceLabel(s)}</span>
      <div class="source-bar-wrap"><div class="source-bar-fill" style="width:${(counts[i]/max*100).toFixed(0)}%"></div></div>
      <span class="source-count">${counts[i]}</span>
    </div>`;
  }).join('');
}

// ---- Module 9: TAGS ----
function updateTags() {
  const freq = vaultStats?.tags || {};
  const sorted = Object.entries(freq).sort((a, b) => b[1] - a[1]).slice(0, 8);
  const maxFreq = sorted.length ? sorted[0][1] : 1;
  const cloud = document.getElementById('tags-cloud');
  if (!sorted.length) {
    cloud.innerHTML = '<span style="color:var(--muted);font-size:11px">No tags yet.</span>';
    return;
  }
  cloud.innerHTML = sorted.map(([tag, count]) => {
    const size = 11 + Math.round((count / maxFreq) * 4);
    return `<span class="tag-pill" data-tag="${esc(tag)}" style="font-size:${size}px"><span class="tlabel">${esc(tag)}</span><span class="tnum">${count}</span></span>`;
  }).join('');
  cloud.querySelectorAll('.tag-pill').forEach(el => {
    el.addEventListener('click', () => {
      const tag = el.dataset.tag;
      if (q.value === tag) { q.value = ''; }
      else { q.value = tag; }
      refresh();
    });
  });
}

// ---- Module 10: SCORE histogram ----
function updateHistogram() {
  const raw = vaultStats?.histogram || Array(11).fill(0);
  const buckets = raw.slice(0, 9).concat([(raw[9] || 0) + (raw[10] || 0)]);
  const max = Math.max(...buckets, 1);
  const total = buckets.reduce((a, b) => a + b, 0);
  const el = document.getElementById('histogram');
  el.innerHTML = buckets.map((c, i) => {
    const pct = total ? Math.round((c / total) * 100) : 0;
    const rangeEnd = i < 9 ? (i + 1) * 10 : 100;
    const dims = JSON.stringify({
      _range: `${i * 10}–${rangeEnd}`,
      _count: c,
      _pct: pct,
      _save: 0,
      _maybe: 0,
      _skip: 0
    });
    return `<div class="hist-bar score-hover" style="height:${Math.max(4, (c/max) * 100)}%" data-dimensions='${esc(dims)}'></div>`;
  }).join('');
}

// ---- Module 13: PHRASES ----
let _phrasesCache = null;

async function updatePhrases(version) {
  if (version != null && version !== _refreshVersion) return;
  if (!_phrasesCache) {
    try { _phrasesCache = await window.vault.optimalPrompt(); } catch { _phrasesCache = null; }
  }
  if (version != null && version !== _refreshVersion) return;
  const data = _phrasesCache;

  const templateEl = document.getElementById('phrases-template');
  const insightsEl = document.getElementById('phrases-insights');
  const pillsEl = document.getElementById('phrases-pills');
  const copyBtn = document.getElementById('a-copy-template');

  if (!templateEl) return;

  if (!data || !data.template) {
    templateEl.textContent = data?.insights?.[0] || 'Label more prompts as "save" to generate your optimal prompt template.';
    if (insightsEl) insightsEl.innerHTML = '';
    if (pillsEl) pillsEl.innerHTML = '';
    if (copyBtn) copyBtn.style.display = 'none';
    return;
  }

  templateEl.textContent = data.template;

  // Insights
  insightsEl.innerHTML = (data.insights || []).map(i =>
    `<div class="phrases-insight"><span class="pi-bulb">&#x25C9;</span>${esc(i)}</div>`
  ).join('');

  // Top phrase pills
  const pills = (data.topPhrases || []).slice(0, 6);
  pillsEl.innerHTML = pills.map(p =>
    `<span class="phrases-pill" title="avg score ${p.avgScore}">${esc(p.phrase)}<span class="pp-score">${p.avgScore}</span></span>`
  ).join('');

  // Copy button
  if (copyBtn) {
    copyBtn.style.display = '';
    copyBtn.onclick = () => {
      window.vault.copy(data.template).then(() => {
        copyBtn.innerHTML = `<svg viewBox="0 0 20 20" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75"><path d="M6 11l3 3 6-8"/></svg> Copied!`;
        setTimeout(() => {
          copyBtn.innerHTML = `<svg viewBox="0 0 20 20" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75"><rect x="6" y="6" width="11" height="11" rx="2"/><path d="M4 13V5a1 1 0 0 1 1-1h8"/></svg> Copy template`;
        }, 1500);
      });
    };
  }
}

// ---- Module 7: DETAIL rendering ----
function renderDetail(row) {
  if (!row) {
    detail.innerHTML = `
      <div class="detail-empty">
        <svg viewBox="0 0 20 20"><rect x="3" y="3" width="14" height="14" rx="3"/><path d="M7 9h6M7 12h4"/></svg>
        <div>Pick a prompt on the left.</div>
        <div class="de-hint">Capture clipboard <span class="kbd">⇧⌘P</span></div>
      </div>`;
    return;
  }
  const cwdShort = row.cwd
    ? row.cwd
        .replace(/^\/Users\/[^/]+/, '~')
        .replace(/^[A-Za-z]:\\Users\\[^\\]+/, '~')
        .split(/[/\\]/).filter(Boolean).slice(-2).join('/')
    : '';
  const r = row.reasons ? row.reasons.split(',').map(t => t.trim()).filter(Boolean) : [];
  const tags = row.tags ? row.tags.split(',').map(t => t.trim()).filter(Boolean) : [];
  const trained = trainedIds[row.id];
  const isGood = trained && (trained === 'good' || trained === 'implicit_good');
  const isBad = trained && (trained === 'bad' || trained === 'implicit_bad');

  detail.innerHTML = `
    <div class="detail-title">${esc(row.title || row.text.slice(0, 80))}</div>
    <div class="detail-meta">
      ${row.verdict ? `<span class="dm-chip ${verdictColor(row.verdict)}">${row.verdict} <span class="tnum${row.dimensions ? ' score-hover' : ''}"${row.dimensions ? ` data-dimensions='${esc(row.dimensions)}'` : ''}>${row.score}</span></span>` : ''}
      ${row.pinned ? `<span class="dm-chip pinned"><svg viewBox="0 0 20 20" style="width:11px;height:11px;stroke:currentColor;fill:none;stroke-width:1.75"><path d="M8 3h4l-.7 4 3.7 3-5 1v5l-2 1-1-6-4-1 2-3z"/></svg>PINNED</span>` : ''}
      ${trained ? `<span class="dm-chip ${isGood ? 'trained-good' : 'trained-bad'}">TRAINED ${isGood ? '✓' : '✗'}</span>` : ''}
      <span class="dm-crumb"><svg viewBox="0 0 20 20"><rect x="3" y="4" width="14" height="12" rx="2"/><path d="M7 9l-2 1 2 1M13 9l2 1-2 1"/></svg>${sourceLabel(row.source)}</span>
      ${cwdShort ? `<span class="dm-crumb"><svg viewBox="0 0 20 20"><path d="M3 6a2 2 0 0 1 2-2h3l2 2h5a2 2 0 0 1 2 2v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2z"/></svg>${esc(cwdShort)}</span>` : ''}
      <span class="dm-crumb"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg>${relTime(row.created_at)}</span>
    </div>
    <div class="detail-action-bar">
      <button class="dab-btn primary" id="a-copy">
        <svg viewBox="0 0 20 20"><rect x="6" y="6" width="11" height="11" rx="2"/><path d="M4 13V5a1 1 0 0 1 1-1h8"/></svg>
        Copy
      </button>
      <button class="dab-btn" id="a-edit">
        <svg viewBox="0 0 20 20"><path d="M4 16l1.5-1.5L13 7l-1.5-1.5L4 13zM13 5l2 2"/></svg>
        Edit
      </button>
      <button class="dab-btn" id="a-pin">
        <svg viewBox="0 0 20 20"><path d="M8 3h4l-.7 4 3.7 3-5 1v5l-2 1-1-6-4-1 2-3z"/></svg>
        ${row.pinned ? 'Unpin' : 'Pin'}
      </button>
      <button class="dab-btn ghost" id="a-title">
        <svg viewBox="0 0 20 20"><path d="M4 16l1.5-1.5L13 7l-1.5-1.5L4 13zM13 5l2 2"/></svg>
        Rename
      </button>
      <button class="dab-btn ghost" id="a-tags">
        <svg viewBox="0 0 20 20"><path d="M10 3H4v6l9 9 6-6z"/><circle cx="7" cy="7" r="1"/></svg>
        Tags
      </button>
      <button class="dab-btn ghost" id="a-share">
        <svg viewBox="0 0 20 20" style="width:12px;height:12px;stroke:currentColor;fill:none;stroke-width:1.75"><path d="M17 3l-4 4M7 13l-3 3M17 3h-4v4M7 13v4H3"/></svg>
        Share
      </button>
      <span class="grow"></span>
      <button class="dab-btn ${trained ? (isGood ? 'trainee active' : 'trainee') : 'trainee'}" id="a-train-good">
        <svg viewBox="0 0 20 20"><path d="M6 11l3 3 6-8"/></svg>
        Good
      </button>
      <button class="dab-btn ghost ${trained ? (isBad ? 'trainee-bad active' : 'trainee-bad') : 'trainee-bad'}" id="a-train-bad">
        <svg viewBox="0 0 20 20"><path d="M6 14l8-8M14 14l-8-8"/></svg>
        Bad
      </button>
      <button class="dab-btn danger" id="a-del">
        <svg viewBox="0 0 20 20"><path d="M4 6h12M8 6V4h4v2M6 6l1 11h6l1-11"/></svg>
        Delete
      </button>
    </div>
    <div class="detail-prompt-body">${esc(row.text)}</div>
    ${tags.length ? `<div class="detail-section"><span class="ds-label">TAGS</span>${tags.map(t => `<span class="ds-tag">${esc(t)}</span>`).join('')}</div>` : ''}
    ${r.length ? `<div class="detail-section"><span class="ds-label">ANALYSIS</span>${r.map(t => `<span class="ds-pill">${esc(t)}</span>`).join('')}</div>` : ''}
    <div class="versions-section">
      <div class="versions-header">
        <span class="ds-label">VERSIONS</span>
        <button class="versions-toggle" id="versions-toggle">Show</button>
      </div>
      <div id="versions-list" class="versions-list" style="display:none"></div>
    </div>
  `;

  document.getElementById('a-copy').onclick = () => window.vault.copy(row.text).then(() => {
    const btn = document.getElementById('a-copy');
    btn.textContent = 'Copied!';
    setTimeout(() => { btn.innerHTML = `<svg viewBox="0 0 20 20"><rect x="6" y="6" width="11" height="11" rx="2"/><path d="M4 13V5a1 1 0 0 1 1-1h8"/></svg> Copy`; }, 1200);
  });
  document.getElementById('a-share').onclick = () => sharePrompt(row);
  // Mutations notify via vault:changed — skip a second full refresh here
  document.getElementById('a-pin').onclick = async () => { await window.vault.pin(row.id); };
  document.getElementById('a-del').onclick = async () => {
    if (confirm(`Delete "${row.title || row.text.slice(0, 50)}"?`)) {
      await window.vault.delete(row.id); current = null;
    }
  };
  document.getElementById('a-tags').onclick = async () => {
    const tags = prompt('Tags (comma separated):', row.tags || '');
    if (tags !== null) await window.vault.update(row.id, { tags });
  };
  document.getElementById('a-title').onclick = async () => {
    const title = prompt('Title:', row.title || '');
    if (title !== null) await window.vault.update(row.id, { title });
  };
  document.getElementById('a-train-good').onclick = async () => {
    const cur = trainedIds[row.id];
    if (cur === 'good' || cur === 'implicit_good') {
      await window.vault.train(row.id, '');
      delete trainedIds[row.id];
    } else {
      await window.vault.train(row.id, 'good');
      trainedIds[row.id] = 'good';
    }
  };
  document.getElementById('a-train-bad').onclick = async () => {
    const cur = trainedIds[row.id];
    if (cur === 'bad' || cur === 'implicit_bad') {
      await window.vault.train(row.id, '');
      delete trainedIds[row.id];
    } else {
      await window.vault.train(row.id, 'bad');
      trainedIds[row.id] = 'bad';
    }
  };

  // Edit / Save toggle
  const editBtn = document.getElementById('a-edit');
  if (editBtn) {
    editBtn.onclick = () => {
      const body = document.querySelector('.detail-prompt-body');
      const btn = document.getElementById('a-edit');
      if (btn.dataset.mode === 'save') {
        const ta = body.querySelector('textarea');
        if (ta) {
          const savedId = row.id;
          window.vault.update(savedId, { text: ta.value }).then(() => {
            // vault:changed handles list/detail; restore versions panel after paint
            setTimeout(() => {
              const vlist = document.getElementById('versions-list');
              const vbtn = document.getElementById('versions-toggle');
              if (vlist && vbtn) {
                vlist.style.display = 'block';
                vbtn.textContent = 'Hide';
                renderVersions(savedId);
              }
            }, 80);
          });
        }
      } else {
        const text = body.textContent;
        body.innerHTML = '<textarea class="edit-textarea" spellcheck="false"></textarea>';
        btn.innerHTML = '<svg viewBox="0 0 20 20"><path d="M6 11l3 3 6-8"/></svg> Save';
        btn.className = 'dab-btn primary';
        btn.dataset.mode = 'save';
        const ta = body.querySelector('textarea');
        if (ta) { ta.value = text; ta.focus(); ta.setSelectionRange(ta.value.length, ta.value.length); }
      }
    };
  }

  // Versions toggle
  const vt = document.getElementById('versions-toggle');
  if (vt) {
    vt.onclick = () => {
      const el = document.getElementById('versions-list');
      const btn = document.getElementById('versions-toggle');
      if (el.style.display === 'none') {
        el.style.display = '';
        btn.textContent = 'Hide';
        renderVersions(row.id);
      } else {
        el.style.display = 'none';
        btn.textContent = 'Show';
      }
    };
  }
}

// ---- Version rendering ----
async function renderVersions(promptId) {
  const versionsEl = document.getElementById('versions-list');
  if (!versionsEl) return;
  if (!promptId) { versionsEl.innerHTML = ''; return; }
  try {
    const versions = await window.vault.versions(promptId);
    const currentRow = rows.find(r => r.id === promptId);
    if (!versions || !versions.length || !currentRow) {
      versionsEl.innerHTML = '<div class="versions-empty">No previous versions.</div>';
      return;
    }
    const currentText = currentRow.text;
    versionsEl.innerHTML = versions.map(v => {
      // Use char-count delta for badge instead of O(m*n) LCS —
      // full diff is computed on-demand when the user clicks Diff
      const charDelta = [...currentText].length - [...v.text].length;
      const absDelta = Math.abs(charDelta);
      const badgeClass = charDelta > 0 ? 'delta-pos' : (charDelta < 0 ? 'delta-neg' : 'delta-zero');
      const badgeText = charDelta >= 0 ? '+' + absDelta : '−' + absDelta;
      return '<div class="version-item" data-vid="' + v.id + '">' +
        '<div class="version-header">' +
          '<span class="version-time">' + relTime(v.created_at) + '</span>' +
          '<span class="version-delta ' + badgeClass + '">' + badgeText + '</span>' +
          '<span class="grow"></span>' +
          '<button class="version-btn version-diff-btn">Diff</button>' +
          '<button class="version-btn version-restore-btn">Restore</button>' +
          '<button class="version-btn version-del-btn">×</button>' +
        '</div>' +
        '<div class="version-diff" style="display:none"></div>' +
      '</div>';
    }).join('');

    versionsEl.querySelectorAll('.version-item').forEach(item => {
      const vid = Number(item.dataset.vid);
      const diffBtn = item.querySelector('.version-diff-btn');
      const restoreBtn = item.querySelector('.version-restore-btn');
      const delBtn = item.querySelector('.version-del-btn');

      diffBtn.onclick = () => {
        const diffEl = item.querySelector('.version-diff');
        if (diffEl.style.display !== 'none') {
          diffEl.style.display = 'none';
          diffBtn.textContent = 'Diff';
          return;
        }
        const version = versions.find(v => v.id === vid);
        if (!version) return;
        const diff = computeDiff(version.text, currentText);
        diffEl.innerHTML = diff.map(d => {
          if (d.type === 'same') return '<div class="diff-line diff-same"><span class="diff-gutter"> </span>' + esc(d.text) + '</div>';
          if (d.type === 'add') return '<div class="diff-line diff-add"><span class="diff-gutter">+</span>' + esc(d.text) + '</div>';
          return '<div class="diff-line diff-rem"><span class="diff-gutter">−</span>' + esc(d.text) + '</div>';
        }).join('');
        diffEl.style.display = '';
        diffBtn.textContent = 'Hide';
      };

      restoreBtn.onclick = async () => {
        if (!confirm('Restore this version? Current text will be saved as a new version before overwriting.')) return;
        try {
          const result = await window.vault.restoreVersion(vid);
          if (!result) { alert('Version not found.'); return; }
        } catch (e) { console.error('[versions] restore error:', e); }
      };

      delBtn.onclick = async () => {
        if (!confirm('Delete this version permanently?')) return;
        try {
          await window.vault.deleteVersion(vid);
          renderVersions(promptId);
        } catch (e) { console.error('[versions] delete error:', e); }
      };
    });
  } catch (e) { console.error('[versions] error:', e); }
}

function listSnippet(r) {
  const text = (r.text || '').replace(/\n+/g, ' ');
  return text.length <= 220 ? text : text.slice(0, 200);
}

function buildListItemHtml(r, i, cutoff) {
  if (r.dimensions) _dimById.set(r.id, r.dimensions);
  const scoreAttr = r.dimensions
    ? ` class="score-hover" data-dim-id="${r.id}"`
    : '';
  return `
    <li data-id="${r.id}" class="${current === r.id ? 'active' : ''}">
      <div class="pl-row1">
        <span class="pl-verdict-dot ${verdictColor(r.verdict)}"></span>
        <span class="pl-title">${esc(r.title || (r.text || '').slice(0, 60))}</span>
        ${r.pinned ? `<svg class="pl-pin-icon" viewBox="0 0 20 20"><path d="M8 3h4l-.7 4 3.7 3-5 1v5l-2 1-1-6-4-1 2-3z"/></svg>` : ''}
      </div>
      <div class="pl-snippet">${esc(listSnippet(r))}</div>
      <div class="pl-row3 ${i === 0 && r.created_at > cutoff ? 'pl-row-new' : ''}">
        <span>${sourceShort(r.source)}</span>
        <span class="pl-sep"></span>
        <span>${relTime(r.created_at)}</span>
        <span class="pl-sep"></span>
        <span style="font-family:'Geist Mono',monospace"${scoreAttr}>${r.score != null ? r.score + '' : '—'}</span>
      </div>
    </li>`;
}

function applyListItem(li, r, i, cutoff) {
  li.className = current === r.id ? 'active' : '';
  const dot = li.querySelector('.pl-verdict-dot');
  if (dot) dot.className = `pl-verdict-dot ${verdictColor(r.verdict)}`;
  const title = li.querySelector('.pl-title');
  if (title) title.textContent = r.title || (r.text || '').slice(0, 60);
  let pin = li.querySelector('.pl-pin-icon');
  const row1 = li.querySelector('.pl-row1');
  if (r.pinned) {
    if (!pin && row1) {
      row1.insertAdjacentHTML('beforeend', `<svg class="pl-pin-icon" viewBox="0 0 20 20"><path d="M8 3h4l-.7 4 3.7 3-5 1v5l-2 1-1-6-4-1 2-3z"/></svg>`);
    }
  } else if (pin) {
    pin.remove();
  }
  const snippet = li.querySelector('.pl-snippet');
  if (snippet) snippet.textContent = listSnippet(r);
  const row3 = li.querySelector('.pl-row3');
  if (row3) {
    row3.className = `pl-row3 ${i === 0 && r.created_at > cutoff ? 'pl-row-new' : ''}`;
    const spans = row3.children;
    if (spans[0]) spans[0].textContent = sourceShort(r.source);
    if (spans[2]) spans[2].textContent = relTime(r.created_at);
    const scoreSpan = spans[4];
    if (scoreSpan) {
      scoreSpan.textContent = r.score != null ? r.score + '' : '—';
      if (r.dimensions) {
        _dimById.set(r.id, r.dimensions);
        scoreSpan.className = 'score-hover';
        scoreSpan.dataset.dimId = r.id;
        delete scoreSpan.dataset.dimensions;
      } else {
        scoreSpan.className = '';
        scoreSpan.removeAttribute('data-dim-id');
      }
    }
  }
}

function renderList({ append = false } = {}) {
  if (!rows.length) {
    _listIds = '';
    _listHasMore = false;
    list.innerHTML = `<li style="cursor:default;padding:20px 12px;color:var(--muted);font-size:13px">
      ${q.value
        ? 'Nothing matches that query. Try a tag or a file path.'
        : 'No prompts yet. Send one from Claude Code, Grok, or Codex — or press <span class="kbd" style="display:inline-flex;align-items:center;justify-content:center;min-width:18px;height:18px;padding:0 5px;font-family:Geist Mono,ui-monospace,monospace;font-size:10.5px;color:var(--muted);background:var(--module);border-radius:4px;line-height:1;margin:0 1px">⇧⌘P</span> to capture the clipboard.'}
    </li>`;
    return;
  }
  const cutoff = Date.now() - 60000;
  const ids = rows.map(r => r.id).join(',');

  if (!append && ids === _listIds) {
    const liMap = new Map([...list.querySelectorAll('li[data-id]')].map(li => [Number(li.dataset.id), li]));
    rows.forEach((r, i) => {
      const li = liMap.get(r.id);
      if (li) applyListItem(li, r, i, cutoff);
    });
    syncLoadMoreSentinel();
    return;
  }

  if (append) {
    const start = list.querySelectorAll('li[data-id]').length;
    const fresh = rows.slice(start);
    list.insertAdjacentHTML('beforeend', fresh.map((r, i) => buildListItemHtml(r, start + i, cutoff)).join(''));
    _listIds = ids;
    syncLoadMoreSentinel();
    return;
  }

  const scrollTop = list.scrollTop;
  _listIds = ids;
  list.innerHTML = rows.map((r, i) => buildListItemHtml(r, i, cutoff)).join('');
  list.scrollTop = scrollTop;
  syncLoadMoreSentinel();
}

function syncLoadMoreSentinel() {
  let sentinel = list.querySelector('.list-load-more');
  if (!_listHasMore) {
    if (sentinel) sentinel.remove();
    return;
  }
  if (!sentinel) {
    list.insertAdjacentHTML('beforeend',
      `<li class="list-load-more" style="cursor:default;padding:10px;text-align:center;color:var(--muted);font-size:11px">Scroll for more…</li>`);
  }
}

// ---- Main refresh ----
const PAGE_SIZE = 80;
let _refreshVersion = 0;
let _listTotal = 0;
let _listHasMore = false;
let _loadingMore = false;

/** What each vault:changed reason needs. Full refresh = all true. */
const REASON_SCOPE = {
  recent:    { list: false, stats: false, labels: false, recent: true, phrases: false, training: false },
  pin:       { list: true,  stats: true, labels: false, recent: false, phrases: false, training: false },
  train:     { list: true,  stats: true, labels: true,  recent: false, phrases: true,  training: true },
  create:    { list: true,  stats: true, labels: false, recent: false, phrases: true,  training: false },
  delete:    { list: true,  stats: true, labels: true,  recent: false, phrases: true,  training: false },
  update:    { list: true,  stats: true, labels: false, recent: false, phrases: true,  training: false },
  reanalyze: { list: true,  stats: true, labels: false, recent: false, phrases: true,  training: false },
  scores:    { list: true,  stats: true, labels: false, recent: false, phrases: true,  training: false }
};
const FULL_SCOPE = { list: true, stats: true, labels: true, recent: true, phrases: true, training: true };

function detailKey(row) {
  if (!row) return '';
  return [row.id, row.text, row.title || '', row.tags || '', row.score, row.pinned, row.verdict].join('\0');
}

function isUserEditing() {
  const editBtn = document.getElementById('a-edit');
  return (editBtn && editBtn.dataset.mode === 'save') || !!document.querySelector('.edit-textarea');
}

function isTextTruncated(text) {
  if (!text) return false;
  return text.replace(/\n+/g, ' ').length >= 220;
}

function applyDashboardFromStats() {
  updateVault();
  updateStats();
  updateVerdicts();
  updateSources();
  updateTags();
  updateHistogram();
  updateActivity();
}

async function syncDetailPane(version) {
  if (current) {
    if (!isUserEditing()) {
      let row = rows.find(r => r.id === current);
      if (row) {
        if (isTextTruncated(row.text)) {
          try {
            const full = await window.vault.get(current);
            if (version !== _refreshVersion) return;
            if (full) row = full;
          } catch {}
        }
        const key = detailKey(row);
        if (key !== _lastDetailKey) {
          renderDetail(row);
          _lastDetailKey = key;
        }
      } else {
        renderDetail(null);
        _lastDetailKey = '';
      }
    }
  } else {
    renderDetail(null);
    _lastDetailKey = '';
  }
}

async function refresh(opts = {}) {
  const { force = false, reason = null, append = false } = opts;
  const query = q.value;
  let scope = reason ? (REASON_SCOPE[reason] || FULL_SCOPE) : FULL_SCOPE;
  if (append) {
    scope = { list: true, stats: false, labels: false, recent: false, phrases: false, training: false };
  }
  // Query changes / first load always need list
  const needList = scope.list || append || query !== _lastQuery;
  const version = ++_refreshVersion;

  if (needList && !append) list.classList.add('loading');
  try {
    const fetches = [];
    const keys = [];

    if (needList) {
      keys.push('list');
      const keep = append ? PAGE_SIZE : Math.max(PAGE_SIZE, rows.length || 0);
      fetches.push(window.vault.list({
        q: query,
        limit: keep,
        offset: append ? rows.length : 0
      }));
    }
    if (scope.stats) {
      keys.push('stats');
      fetches.push(window.vault.stats());
    }
    if (scope.labels) {
      keys.push('labels');
      fetches.push(window.vault.trainLabels());
    }
    if (scope.recent) {
      keys.push('recent');
      fetches.push(window.vault.recentCaptures(50));
    }

    const results = await Promise.all(fetches);
    if (version !== _refreshVersion) return;

    const got = {};
    keys.forEach((k, i) => { got[k] = results[i]; });

    if (got.stats) {
      if (!force && !append && !reason && got.stats.revision === _lastRenderedRevision && query === _lastQuery) {
        _lastRevision = got.stats.revision;
        return;
      }
      vaultStats = got.stats;
      window._vaultStats = got.stats;
      _lastRevision = got.stats.revision;
    }

    if (got.labels) trainedIds = got.labels || {};
    if (got.recent) recentCaps = got.recent || [];

    if (got.list) {
      const listRes = got.list;
      const page = listRes.rows || [];
      if (append) {
        const seen = new Set(rows.map(r => r.id));
        for (const r of page) {
          if (!seen.has(r.id)) rows.push(r);
        }
      } else {
        rows = page;
      }
      _listTotal = listRes.total || rows.length;
      _listHasMore = !!listRes.hasMore;
      if (!query) allRows = rows;
    }

    if (scope.stats || got.stats) applyDashboardFromStats();
    else if (got.recent) updateActivity();

    if (scope.training || (!reason && scope.stats)) {
      await updateTrainingStatus(version);
      if (version !== _refreshVersion) return;
    }

    if (scope.phrases) {
      await updatePhrases(version);
      if (version !== _refreshVersion) return;
    }

    if (got.list) {
      renderList({ append });
      await syncDetailPane(version);
      if (version !== _refreshVersion) return;
    } else if (reason === 'pin' || reason === 'update') {
      await syncDetailPane(version);
    }

    if (got.stats) _lastRenderedRevision = got.stats.revision;
    if (needList || !reason) _lastQuery = query;

    if (_activeTab === 'recent' && (scope.recent || got.recent)) renderRecentCaptures();

    if (_tipActive && !document.contains(_tipActive)) {
      _tipActive = null;
      scoreTip.classList.remove('visible');
    }
  } catch (e) {
    console.error('[vault] refresh error:', e);
  } finally {
    if (version === _refreshVersion) list.classList.remove('loading');
    _loadingMore = false;
  }
}

async function loadMore() {
  if (_loadingMore || !_listHasMore) return;
  _loadingMore = true;
  await refresh({ append: true, force: true });
}

// ---- Recent captures tab ----
let _activeTab = 'detail';

async function renderRecentCaptures() {
  const el = document.getElementById('recent-captures');
  if (!el) return;
  try {
    const items = recentCaps.length ? recentCaps : await window.vault.recentCaptures(50);
    if (!items || !items.length) {
      el.innerHTML = `<div class="detail-empty"><svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="7"/><path d="M10 6v4l3 2"/></svg><div>No recent captures yet.</div><div class="de-hint">Skipped prompts will appear here.</div></div>`;
      return;
    }
    el.innerHTML = items.map(r => {
      const verdict = r.verdict || 'maybe';
      const label = (r.title || r.text || '').replace(/\s+/g, ' ').slice(0, 100);
      const fullText = esc(r.text || '');
      return `<div class="recent-item" data-id="${r.id}">
        <div class="ri-header">
          <span class="ri-dot ${verdictColor(verdict)}"></span>
          <span class="ri-text">${esc(label)}</span>
          <span class="ri-meta">${sourceShort(r.source)} · ${relTime(r.created_at)} · ${r.score ?? '—'}</span>
          <button class="ri-save" data-action="save">Save</button>
          <button class="ri-del" data-action="delete" title="Dismiss">×</button>
        </div>
        <div class="ri-body" style="display:none">
          <pre class="ri-fulltext">${fullText}</pre>
        </div>
      </div>`;
    }).join('');

    // Click to expand/collapse
    el.querySelectorAll('.recent-item').forEach(item => {
      item.querySelector('.ri-header').onclick = () => {
        const body = item.querySelector('.ri-body');
        const isOpen = body.style.display !== 'none';
        body.style.display = isOpen ? 'none' : '';
        item.classList.toggle('expanded', !isOpen);
      };
    });

    // Save / delete handlers — vault:changed drives the refresh
    el.querySelectorAll('.ri-save').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = Number(btn.closest('.recent-item').dataset.id);
        btn.textContent = '...';
        await window.vault.saveRecent(id);
      };
    });
    el.querySelectorAll('.ri-del').forEach(btn => {
      btn.onclick = async (e) => {
        e.stopPropagation();
        const id = Number(btn.closest('.recent-item').dataset.id);
        await window.vault.deleteRecent(id);
      };
    });
  } catch (e) { console.error('[recent] error:', e); }
}

function switchTab(tab) {
  _activeTab = tab;
  document.querySelectorAll('.detail-tab').forEach(t => t.classList.toggle('active', t.dataset.tab === tab));
  const detailEl = document.getElementById('detail');
  const recentEl = document.getElementById('recent-captures');
  if (tab === 'recent') {
    detailEl.style.display = 'none';
    recentEl.style.display = '';
    renderRecentCaptures();
  } else {
    detailEl.style.display = '';
    recentEl.style.display = 'none';
  }
}

// Tab bar clicks
document.querySelector('.detail-tabs')?.addEventListener('click', e => {
  const tab = e.target.closest?.('.detail-tab');
  if (!tab) return;
  switchTab(tab.dataset.tab);
});

// ---- Events ----
list.addEventListener('click', async e => {
  const li = e.target.closest('li[data-id]');
  if (!li) return;
  current = Number(li.dataset.id);
  document.querySelectorAll('#list li').forEach(x =>
    x.classList.toggle('active', Number(x.dataset.id) === current));
  li.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
  let row = rows.find(r => r.id === current);
  if (row && isTextTruncated(row.text)) {
    try {
      const full = await window.vault.get(current);
      if (full) row = full;
    } catch (err) { console.error('[vault] get error:', err); }
  }
  renderDetail(row);
  _lastDetailKey = detailKey(row);
});

// Score hover tooltips — event delegation on the whole document
document.addEventListener('mouseenter', e => {
  const el = e.target.closest?.('.score-hover');
  if (!el) return;
  let dims = el.dataset.dimensions;
  if (!dims && el.dataset.dimId) dims = _dimById.get(Number(el.dataset.dimId));
  if (dims) showScoreTip(e, dims);
}, true);

document.addEventListener('mouseleave', e => {
  const el = e.target.closest?.('.score-hover');
  if (!el) return;
  // Moving between children of the same anchor isn't a real leave — ignore.
  if (e.relatedTarget && el.contains(e.relatedTarget)) return;
  hideScoreTip();
}, true);

let t;
q.addEventListener('input', () => { clearTimeout(t); t = setTimeout(refresh, 180); });

document.addEventListener('keydown', e => {
  if (e.key === '/' && document.activeElement !== q) { e.preventDefault(); q.focus(); q.select(); }
  if (e.key === 'Escape' && document.activeElement === q) { q.value = ''; refresh(); }
  if ((e.metaKey || e.ctrlKey) && e.key === 'c' && current && window.getSelection().toString() === '') {
    e.preventDefault();
    (async () => {
      let row = rows.find(r => r.id === current);
      if (row && isTextTruncated(row.text)) {
        try {
          const full = await window.vault.get(current);
          if (full) row = full;
        } catch {}
      }
      if (row) window.vault.copy(row.text);
    })();
  }
});

// ---- Initial load + push updates + visibility-aware fallback probe ----
let _fallbackTimer = null;
let _unsubscribeChanged = null;

function invalidatePhrasesForReason(reason) {
  if (reason === 'train' || reason === 'reanalyze' || reason === 'scores'
      || reason === 'create' || reason === 'update' || reason === 'delete') {
    _phrasesCache = null;
  }
}

function startFallbackProbe() {
  stopFallbackProbe();
  _fallbackTimer = setInterval(async () => {
    try {
      const rev = await window.vault.revision();
      if (rev !== _lastRevision) refresh({ force: true });
    } catch (e) { /* ignore probe errors */ }
  }, 30000);
}

function stopFallbackProbe() {
  if (_fallbackTimer) { clearInterval(_fallbackTimer); _fallbackTimer = null; }
}

if (!_unsubscribeChanged) {
  _unsubscribeChanged = window.vault.onChanged(({ reason, revision }) => {
    invalidatePhrasesForReason(reason);
    if (revision) _lastRevision = revision;
    refresh({ force: true, reason: reason || null });
  });
}

list.addEventListener('scroll', () => {
  if (!_listHasMore || _loadingMore) return;
  const remaining = list.scrollHeight - list.scrollTop - list.clientHeight;
  if (remaining < 120) loadMore();
});

document.addEventListener('visibilitychange', () => {
  if (document.hidden) stopFallbackProbe();
  else startFallbackProbe();
});

window.addEventListener('blur', stopFallbackProbe);
window.addEventListener('focus', startFallbackProbe);

startFallbackProbe();
refresh({ force: true });
