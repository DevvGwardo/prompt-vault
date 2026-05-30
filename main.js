const { app, BrowserWindow, Tray, Menu, screen, clipboard,
        globalShortcut, ipcMain, nativeImage, shell } = require('electron');
const path = require('path');
const os = require('os');
const fs = require('fs');
const http = require('http');
const { analyzePrompt, train, modelInfo, findRepetitivePhrases, generateOptimalPrompt } = require('./analyzer');
const dbApi = require('./db');
const codexWatcher = require('./lib/codex-watcher');
const grokWatcher = require('./lib/grok-watcher');
const hermesWatcher = require('./lib/hermes-watcher');
const claudeCodeWatcher = require('./lib/claude-code-watcher');

const HTTP_PORT = 8765;
const HOTKEY = 'CommandOrControl+Shift+P';
const SAVE_PENDING_HOTKEY = 'CommandOrControl+Shift+S';

// Pill size — kept small + non-intrusive (clicky-style)
const PILL_W = 220;
const PILL_H = 38;
const CURSOR_OFFSET_X = 18;
const CURSOR_OFFSET_Y = 18;
const FOLLOW_INTERVAL_MS = 33; // ~30fps cursor poll — smooth without thrashing the window manager
const FOLLOW_PAUSE_PROXIMITY = 6; // px — if cursor enters pill+pad, stop following so user can click
const FOLLOW_DEADBAND_PX = 2; // skip setPosition when delta is sub-2px — kills micro-jitter
const PICKER_W = 380;
const PICKER_H = 220;
const PICKER_HOTKEY = 'CommandOrControl+Shift+K';

// Windows popup — a small topmost window moved to the cursor each tick. Avoids the
// fullscreen transparent overlay used on macOS, which composites unreliably on Windows.
const WIN_POPUP_W = 260;
const WIN_POPUP_H = 48;
const WIN_EDITOR_W = 580;
const WIN_EDITOR_H = 380;

let tray = null;
let searchWindow = null;
let popupWindow = null;
let pickerWindow = null;
let pending = null; // { text, source, cwd, analysis }
let lastClipboard = '';
let clipboardWatcher = null;
let clipboardEnabled = false;

const DEV = !!process.env.PV_DEV || !app.isPackaged;

// Forward renderer console + errors to the main-process log so they appear in the terminal.
function wireDiagnostics(win, label) {
  const levels = ['debug', 'info', 'warning', 'error'];
  win.webContents.on('console-message', (_e, level, message, line, sourceId) => {
    console.log(`[${label}:${levels[level] || level}] ${message}  (${sourceId}:${line})`);
  });
  win.webContents.on('render-process-gone', (_e, details) => {
    console.error(`[${label}] render-process-gone:`, details);
  });
  win.webContents.on('preload-error', (_e, preloadPath, err) => {
    console.error(`[${label}] preload-error in ${preloadPath}:`, err);
  });
  win.webContents.on('did-fail-load', (_e, code, desc, url) => {
    console.error(`[${label}] did-fail-load ${code} ${desc} ${url}`);
  });
  if (DEV && !process.env.PV_NO_DEVTOOLS) win.webContents.openDevTools({ mode: 'detach' });
}

function createSearchWindow() {
  if (searchWindow) { searchWindow.show(); searchWindow.focus(); return; }
  searchWindow = new BrowserWindow({
    width: 1280, height: 860, minWidth: 900, minHeight: 680,
    show: false, title: 'Prompt Vault',
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    backgroundColor: '#0b0b0f',
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  wireDiagnostics(searchWindow, 'vault');
  searchWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'));
  searchWindow.once('ready-to-show', () => searchWindow.show());
  searchWindow.on('close', e => { if (!app.isQuitting) { e.preventDefault(); searchWindow.hide(); } });
}

// Full-screen transparent overlay window. The pill is a DIV inside the renderer,
// translated via GPU transform — no setPosition() calls per frame. This is the
// pattern from farzaa/clicky's OverlayWindow.swift: NSWindow at screenSaver level,
// click-through, with cursor-following done as a paint inside the window.
let followStream = null; // setInterval handle for posting cursor positions to the renderer

function showPopup(promptData) {
  if (popupWindow) popupWindow.close();
  stopCursorStream();

  if (process.platform === 'win32') return showPopupWindowed(promptData);

  // Cover the entire display the cursor is currently on. We don't span multiple
  // displays because Electron transparent windows + multi-monitor get glitchy.
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const b = display.bounds;

  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, alwaysOnTop: true, resizable: false, movable: false,
    skipTaskbar: true, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', show: false,
    focusable: false,
    enableLargerThanScreen: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  popupWindow = win;
  win.setAlwaysOnTop(true, 'floating');
  win.setVisibleOnAllWorkspaces(true);
  // Click-through everywhere by default; forward mousemove to the renderer so it can
  // re-enable interaction when the cursor is over the pill itself.
  win.setIgnoreMouseEvents(true, { forward: true });
  wireDiagnostics(win, 'popup');
  win.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('popup:data', { ...promptData, pillW: PILL_W, pillH: PILL_H, offsetX: CURSOR_OFFSET_X, offsetY: CURSOR_OFFSET_Y, bounds: b });
    win.showInactive();
    startCursorStream(win);
  });
  win.on('closed', () => {
    if (popupWindow === win) popupWindow = null;
    stopCursorStream();
  });
}

function startCursorStream(win) {
  stopCursorStream();
  let lastDisplayId = -1;
  followStream = setInterval(() => {
    if (!win || win.isDestroyed()) { stopCursorStream(); return; }
    const c = screen.getCursorScreenPoint();
    const display = screen.getDisplayNearestPoint(c);
    const b = display.bounds;

    // If cursor moved to a different display (e.g. user swiped spaces),
    // reposition the overlay window to cover the new display.
    if (display.id !== lastDisplayId) {
      lastDisplayId = display.id;
      win.setBounds({ x: b.x, y: b.y, width: b.width, height: b.height });
      // Re-assert workspace visibility after moving — can be lost on some macOS versions.
      win.setVisibleOnAllWorkspaces(true);
      if (!win.isVisible()) win.showInactive();
    }

    // Convert global screen coords → window-local for the renderer.
    win.webContents.send('popup:cursor', { x: c.x - b.x, y: c.y - b.y });
  }, FOLLOW_INTERVAL_MS);
}
function stopCursorStream() {
  if (followStream) { clearInterval(followStream); followStream = null; }
}

// Windows path: a small topmost window that the OS moves to the cursor each tick.
// The renderer pins the pill at a fixed local spot (no per-frame transform) and the
// editor is shown by resizing this same window — see the popup:enterEditor handler.
function showPopupWindowed(promptData) {
  const cursor = screen.getCursorScreenPoint();
  const win = new BrowserWindow({
    width: WIN_POPUP_W, height: WIN_POPUP_H,
    x: cursor.x + CURSOR_OFFSET_X, y: cursor.y + CURSOR_OFFSET_Y,
    frame: false, alwaysOnTop: true, resizable: false, movable: false,
    skipTaskbar: true, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', show: false, focusable: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      backgroundThrottling: false
    }
  });
  popupWindow = win;
  win.setAlwaysOnTop(true, 'screen-saver');
  wireDiagnostics(win, 'popup');
  win.loadFile(path.join(__dirname, 'renderer', 'popup.html'));
  win.once('ready-to-show', () => {
    if (win.isDestroyed()) return;
    win.webContents.send('popup:data', { ...promptData, pillW: PILL_W, pillH: PILL_H, windowed: true });
    win.showInactive();
    startWindowFollow(win);
  });
  win.on('closed', () => {
    if (popupWindow === win) popupWindow = null;
    stopCursorStream();
  });
}

function startWindowFollow(win) {
  stopCursorStream();
  followStream = setInterval(() => {
    if (!win || win.isDestroyed()) { stopCursorStream(); return; }
    if (win.__editing) return; // parked while the editor is open
    const c = screen.getCursorScreenPoint();
    const b = win.getBounds();
    // Stop chasing once the cursor is over the pill so the user can click it.
    const pad = 6;
    if (c.x >= b.x - pad && c.x <= b.x + b.width + pad &&
        c.y >= b.y - pad && c.y <= b.y + b.height + pad) return;

    const wa = screen.getDisplayNearestPoint(c).workArea;
    let x = c.x + CURSOR_OFFSET_X;
    let y = c.y + CURSOR_OFFSET_Y;
    if (x + WIN_POPUP_W > wa.x + wa.width)  x = c.x - WIN_POPUP_W - CURSOR_OFFSET_X;
    if (y + WIN_POPUP_H > wa.y + wa.height) y = c.y - WIN_POPUP_H - CURSOR_OFFSET_Y;
    x = Math.max(wa.x, Math.min(x, wa.x + wa.width  - WIN_POPUP_W));
    y = Math.max(wa.y, Math.min(y, wa.y + wa.height - WIN_POPUP_H));
    win.setBounds({ x: Math.round(x), y: Math.round(y), width: WIN_POPUP_W, height: WIN_POPUP_H });
  }, FOLLOW_INTERVAL_MS);
}

function showPicker() {
  if (pickerWindow && !pickerWindow.isDestroyed()) {
    pickerWindow.show(); pickerWindow.focus(); return;
  }
  const cursor = screen.getCursorScreenPoint();
  const display = screen.getDisplayNearestPoint(cursor);
  const wa = display.workArea;
  let x = cursor.x - PICKER_W / 2;
  let y = cursor.y + 20;
  if (y + PICKER_H > wa.y + wa.height) y = cursor.y - PICKER_H - 20;
  x = Math.max(wa.x + 8, Math.min(x, wa.x + wa.width  - PICKER_W - 8));
  y = Math.max(wa.y + 8, Math.min(y, wa.y + wa.height - PICKER_H - 8));

  pickerWindow = new BrowserWindow({
    width: PICKER_W, height: PICKER_H, x: Math.round(x), y: Math.round(y),
    frame: false, alwaysOnTop: true, resizable: false,
    skipTaskbar: true, transparent: true, hasShadow: false,
    backgroundColor: '#00000000', show: false,
    webPreferences: { preload: path.join(__dirname, 'preload.js'), contextIsolation: true }
  });
  pickerWindow.setAlwaysOnTop(true, 'floating');
  pickerWindow.setVisibleOnAllWorkspaces(true);
  wireDiagnostics(pickerWindow, 'picker');
  pickerWindow.loadFile(path.join(__dirname, 'renderer', 'picker.html'));
  let canCloseOnBlur = false;
  pickerWindow.once('ready-to-show', () => {
    // macOS: when spawned from a global hotkey, the originating app keeps key-window
    // status. We must explicitly steal focus or the picker shows blurred and dies.
    if (process.platform === 'darwin') app.focus({ steal: true });
    pickerWindow.show();
    pickerWindow.focus();
    // Give the WM a beat to settle before treating blur as "user clicked away".
    setTimeout(() => { canCloseOnBlur = true; }, 250);
  });
  pickerWindow.on('blur', () => {
    if (!canCloseOnBlur) return;
    if (pickerWindow && !pickerWindow.isDestroyed()) pickerWindow.close();
  });
  pickerWindow.on('closed', () => { pickerWindow = null; });
}

// Claude Code prompts can arrive twice — once from the UserPromptSubmit hook
// (CLI) and once from the transcript watcher (which also covers the desktop app).
// Drop a capture if identical text landed within this window from any source.
const DEDUP_WINDOW_MS = 15_000;
const recentlyCaptured = new Map(); // trimmedText -> timestampMs

function isDuplicateCapture(trimmed) {
  const now = Date.now();
  for (const [t, ts] of recentlyCaptured) {
    if (now - ts > DEDUP_WINDOW_MS) recentlyCaptured.delete(t);
  }
  if (recentlyCaptured.has(trimmed)) return true;
  recentlyCaptured.set(trimmed, now);
  return false;
}

function offerToSave(text, source, cwd) {
  const trimmed = (text || '').trim();
  if (!trimmed) return;
  if (isDuplicateCapture(trimmed)) return;
  const analysis = analyzePrompt(trimmed);
  pending = { text: trimmed, source, cwd: cwd || '', analysis };

  if (analysis.verdict === 'skip') {
    // Still save to recent captures so the user can find it later
    dbApi.saveRecentCapture({
      text: trimmed,
      title: trimmed.slice(0, 80),
      source, cwd: cwd || '',
      score: analysis.score,
      verdict: analysis.verdict,
      reasons: analysis.reasons
    });
    pending = null;
    return;
  }

  showPopup(pending);
}

function saveCurrentPending(overrides = {}) {
  if (!pending) return null;
  const id = dbApi.createPrompt({
    text: overrides.text ?? pending.text,
    title: overrides.title,
    tags: overrides.tags,
    source: pending.source,
    cwd: pending.cwd,
    score: pending.analysis.score,
    verdict: pending.analysis.verdict,
    reasons: pending.analysis.reasons,
    dimensions: pending.analysis.dimensions
  }).id;
  // Implicit training: saving from popup = good signal
  dbApi.saveTrainingLabel(id, 'implicit_good');
  pending = null;
  refreshTrayMenu();
  // Bubble confirmation via tray title
  if (tray) { tray.setTitle('✓ Saved'); setTimeout(() => tray && tray.setTitle('PV'), 1200); }
  return id;
}

// ----- HTTP server: receives prompts from the Claude Code hook -----
function startHttpServer() {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/status') {
      const recent = dbApi.search('').slice(0, 5).map(p => ({
        score: p.score, title: p.title, text: p.text
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ pid: process.pid, count: dbApi.count(), recent }));
    }
    if (req.method === 'GET' && req.url.startsWith('/search')) {
      const u = new URL(req.url, 'http://127.0.0.1');
      const q = u.searchParams.get('q') || '';
      const limit = Math.min(parseInt(u.searchParams.get('limit') || '20', 10) || 20, 100);
      const results = dbApi.search(q, limit).map(p => ({
        id: p.id, score: p.score, title: p.title, source: p.source, text: p.text
      }));
      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ count: results.length, results }));
    }
    if (req.method !== 'POST' || req.url !== '/prompt') {
      res.writeHead(404); return res.end();
    }
    let body = '';
    req.on('data', c => { body += c; if (body.length > 200_000) req.destroy(); });
    req.on('end', () => {
      try {
        const payload = JSON.parse(body || '{}');
        const text = payload.prompt || payload.text || '';
        offerToSave(text, payload.source || 'claude-code', payload.cwd);
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ ok: true }));
      } catch (err) {
        res.writeHead(400); res.end(JSON.stringify({ error: String(err) }));
      }
    });
  });
  server.listen(HTTP_PORT, '127.0.0.1', () => {
    console.log(`[prompt-vault] listening on http://127.0.0.1:${HTTP_PORT}`);
  });
}

// ----- Clipboard monitor (off by default) -----
function setClipboardMonitor(enabled) {
  clipboardEnabled = enabled;
  if (clipboardWatcher) { clearInterval(clipboardWatcher); clipboardWatcher = null; }
  if (!enabled) return;
  lastClipboard = clipboard.readText();
  clipboardWatcher = setInterval(() => {
    const cur = clipboard.readText();
    if (cur && cur !== lastClipboard && cur.length > 40) {
      lastClipboard = cur;
      offerToSave(cur, 'clipboard');
    } else { lastClipboard = cur; }
  }, 1500);
  refreshTrayMenu();
}

// ----- Tray + menu -----
function refreshTrayMenu() {
  if (!tray) return;
  const menu = Menu.buildFromTemplate([
    { label: `Vault: ${dbApi.count()} prompts`, enabled: false },
    { type: 'separator' },
    { label: 'Open Vault…', accelerator: 'CommandOrControl+Shift+V', click: createSearchWindow },
    { label: `Save clipboard (${HOTKEY})`, click: saveClipboardManual },
    { label: `Quick-save pending (${SAVE_PENDING_HOTKEY})`, click: () => {
      if (!pending) return;
      saveCurrentPending();
      if (popupWindow) popupWindow.close();
    }},
    { type: 'separator' },
    { label: 'Quick Pick…', accelerator: PICKER_HOTKEY, click: showPicker },
    { label: 'Watch clipboard', type: 'checkbox', checked: clipboardEnabled,
      click: i => setClipboardMonitor(i.checked) },
    { label: 'Reanalyze all prompts', click: () => {
      const result = dbApi.reanalyzeAll(analyzePrompt);
      if (tray) tray.setTitle(`✓ ${result.changed} upd`);
      setTimeout(() => tray && tray.setTitle('PV'), 1500);
      refreshTrayMenu();
    }},
    { label: 'Reveal DB in Finder', click: () => shell.showItemInFolder(dbApi.DB_PATH) },
    { type: 'separator' },
    { label: 'Quit Prompt Vault', click: () => { app.isQuitting = true; app.quit(); } }
  ]);
  tray.setContextMenu(menu);
  tray.setToolTip(`Prompt Vault — ${dbApi.count()} saved`);
}

function saveClipboardManual() {
  const t = clipboard.readText();
  if (!t || !t.trim()) return;
  offerToSave(t, 'hotkey');
}

// ----- IPC from renderer -----
ipcMain.handle('vault:search', (_e, q) => dbApi.search(q));
ipcMain.handle('vault:all', () => dbApi.allPrompts());
ipcMain.handle('vault:get', (_e, id) => dbApi.getById(id));
ipcMain.handle('vault:delete', (_e, id) => { dbApi.deletePrompt(id); refreshTrayMenu(); return true; });
ipcMain.handle('vault:pin', (_e, id) => dbApi.togglePin(id));
ipcMain.handle('vault:update', (_e, id, fields) => dbApi.updatePrompt(id, fields));
ipcMain.handle('vault:versions', (_e, id) => dbApi.getVersions(id));
ipcMain.handle('vault:restore-version', (_e, versionId) => {
  if (!versionId || !Number.isInteger(versionId)) return null;
  return dbApi.restoreVersion(versionId);
});
ipcMain.handle('vault:delete-version', (_e, versionId) => {
  if (!versionId || !Number.isInteger(versionId)) return null;
  return dbApi.deleteVersion(versionId);
});
ipcMain.handle('vault:count', () => dbApi.count());
ipcMain.handle('vault:copy', (_e, text) => { clipboard.writeText(text); return true; });
ipcMain.handle('popup:save', (_e, overrides) => { const id = saveCurrentPending(overrides); if (popupWindow) popupWindow.close(); return id; });
ipcMain.handle('popup:skip', () => {
  // Save skipped prompt to recent captures so the user can save it later
  if (pending) {
    dbApi.saveRecentCapture({
      text: pending.text,
      title: pending.text.slice(0, 80),
      source: pending.source,
      cwd: pending.cwd,
      score: pending.analysis.score,
      verdict: pending.analysis.verdict,
      reasons: pending.analysis.reasons
    });
  }
  pending = null;
  if (popupWindow) popupWindow.close();
});
ipcMain.handle('popup:openVault', () => { if (popupWindow) popupWindow.close(); createSearchWindow(); });
ipcMain.handle('picker:search', (_e, q) => {
  // Float pinned prompts to the top so go-to prompts are always one keystroke
  // away. sort() is stable, so relevance (rank) / recency order is preserved
  // within the pinned and unpinned groups.
  const rows = dbApi.search(q || '');
  rows.sort((a, b) => (b.pinned ? 1 : 0) - (a.pinned ? 1 : 0));
  return rows.slice(0, 30);
});
ipcMain.handle('picker:copy', (_e, id, _paste) => {
  const row = dbApi.getById(id);
  if (!row) return false;
  clipboard.writeText(row.text);
  if (pickerWindow) pickerWindow.close();
  // Flash the tray title as confirmation
  if (tray) { tray.setTitle('✓'); setTimeout(() => tray && tray.setTitle('PV'), 800); }
  return true;
});
ipcMain.handle('picker:close', () => { if (pickerWindow) pickerWindow.close(); });
ipcMain.handle('popup:setIgnoreMouse', (_e, ignore) => {
  if (popupWindow && !popupWindow.isDestroyed()) {
    popupWindow.setIgnoreMouseEvents(!!ignore, ignore ? { forward: true } : undefined);
  }
});
// Windows-only: the pill window is tiny, so opening the inline editor means
// growing + centering this same window and making it focusable for typing.
ipcMain.handle('popup:enterEditor', () => {
  if (process.platform !== 'win32') return;
  const win = popupWindow;
  if (!win || win.isDestroyed()) return;
  win.__editing = true;
  const wa = screen.getDisplayNearestPoint(screen.getCursorScreenPoint()).workArea;
  win.setBounds({
    x: Math.round(wa.x + (wa.width  - WIN_EDITOR_W) / 2),
    y: Math.round(wa.y + (wa.height - WIN_EDITOR_H) / 2),
    width: WIN_EDITOR_W, height: WIN_EDITOR_H
  });
  win.setFocusable(true);
  win.focus();
});

// ----- Training IPC -----
ipcMain.handle('vault:train', (_e, id, label) => {
  if (!label || label.trim() === '') {
    dbApi.deleteTrainingLabel(id);
  } else {
    dbApi.saveTrainingLabel(id, label);
  }
  rebuildModel();
  return true;
});
ipcMain.handle('vault:train-stats', () => {
  const labels = dbApi.getTrainingLabels();
  const model = modelInfo();
  return { labels: labels.length, tokens: model ? model.tokens : 0, good: model ? model.totalGood : 0, bad: model ? model.totalBad : 0 };
});
ipcMain.handle('vault:train-labels', () => {
  const labels = dbApi.getTrainingLabels();
  return labels.map(l => ({ prompt_id: l.id || l.prompt_id, label: l.label }));
});
ipcMain.handle('vault:phrases', () => {
  const texts = dbApi.allTexts();
  return findRepetitivePhrases(texts);
});
ipcMain.handle('vault:optimal-prompt', () => {
  const prompts = dbApi.allPrompts();
  return generateOptimalPrompt(prompts);
});
ipcMain.handle('vault:share-image', async (_e, base64, promptId) => {
  const tmpDir = os.tmpdir();
  const filename = `prompt-vault-${promptId || 'share'}-${Date.now()}.png`;
  const filepath = path.join(tmpDir, filename);
  const buf = Buffer.from(base64, 'base64');
  fs.writeFileSync(filepath, buf);
  shell.showItemInFolder(filepath);
  return filepath;
});
ipcMain.handle('vault:recent-captures', (_e, limit) => dbApi.getRecentCaptures(limit || 500));
ipcMain.handle('vault:save-recent', (_e, id) => {
  const row = dbApi.getRecentCaptures(100).find(r => r.id === id);
  if (!row) return null;
  const newId = dbApi.createPrompt({
    text: row.text, title: row.title, source: row.source, cwd: row.cwd,
    score: row.score, verdict: row.verdict, reasons: row.reasons
  }).id;
  dbApi.deleteRecentCapture(id);
  refreshTrayMenu();
  return newId;
});
ipcMain.handle('vault:delete-recent', (_e, id) => {
  dbApi.deleteRecentCapture(id);
  return true;
});
ipcMain.handle('vault:reanalyze', () => {
  const result = dbApi.reanalyzeAll(analyzePrompt);
  return result;
});
ipcMain.handle('vault:training-status', () => {
  const labels = dbApi.getTrainingLabels();
  const model = modelInfo();
  return {
    labeled: labels.length,
    good: model ? model.totalGood : 0,
    bad: model ? model.totalBad : 0,
    tokens: model ? model.tokens : 0,
    bigrams: model ? model.bigrams : 0,
    modelVersion: model ? model.version : 0
  };
});

// ----- Training loop -----

function rebuildModel() {
  const labels = dbApi.getTrainingLabels();
  if (!labels.length) return null;
  const examples = labels.map(l => ({ text: l.text, label: l.label }));
  const m = train(examples);
  dbApi.saveTrainModel({
    tokenBias: m.tokenBias,
    bigramBias: m.bigramBias,
    totalGood: m.totalGood,
    totalBad: m.totalBad,
    version: m.version
  });
  // Re-score all prompts so stats reflect the latest training immediately
  dbApi.reanalyzeAll(analyzePrompt);
  return m;
}

function startTrainingLoop() {
  // Load persisted model into analyzer on startup, then re-score everything
  const saved = dbApi.getTrainModel();
  if (saved) {
    rebuildModel();
  }
  // No polling — rebuildModel is called on every label action via vault:train IPC.
  // The model stays continuously fresh without wasteful timer-based rebuilds.
}

app.whenReady().then(() => {
  // Hide from dock on macOS — this is a menu-bar app
  if (process.platform === 'darwin' && app.dock) app.dock.hide();

  // macOS uses a template named image for the menu bar; Windows/Linux need a real
  // icon file or the tray is invisible.
  let trayIcon;
  if (process.platform === 'darwin') {
    trayIcon = nativeImage.createFromNamedImage('NSStatusAvailable', [-1, 0, 1]) ||
               nativeImage.createEmpty();
  } else {
    trayIcon = nativeImage.createFromPath(path.join(__dirname, 'assets', 'tray', 'tray-icon.png'));
    if (trayIcon.isEmpty()) trayIcon = nativeImage.createEmpty();
  }
  tray = new Tray(trayIcon);
  tray.setTitle('PV');
  refreshTrayMenu();
  tray.on('click', () => createSearchWindow());

  globalShortcut.register(HOTKEY, saveClipboardManual);
  globalShortcut.register('CommandOrControl+Shift+V', createSearchWindow);
  globalShortcut.register(PICKER_HOTKEY, showPicker);
  // Quick-save whatever's currently pending — works without touching the pill.
  globalShortcut.register(SAVE_PENDING_HOTKEY, () => {
    if (!pending) return;
    const id = saveCurrentPending();
    if (popupWindow) popupWindow.close();
  });

  startHttpServer();
  codexWatcher.start((text, meta) => offerToSave(text, meta.source, meta.cwd));
  grokWatcher.start((text, meta) => offerToSave(text, meta.source, meta.cwd));
  hermesWatcher.start((text, meta) => offerToSave(text, meta.source, meta.cwd));
  claudeCodeWatcher.start((text, meta) => offerToSave(text, meta.source, meta.cwd));
  startTrainingLoop();

  if (DEV) createSearchWindow();
});

app.on('window-all-closed', e => { /* keep running in tray */ });
app.on('will-quit', () => globalShortcut.unregisterAll());
