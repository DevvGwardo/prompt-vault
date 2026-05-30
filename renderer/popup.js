const pill = document.getElementById('pill');
const dot = document.getElementById('dot');
const scoreEl = document.getElementById('score');
const progressEl = document.getElementById('progress');
const editorEl = document.getElementById('editor');

const AUTO_DISMISS_MS = 7000;
let dismissTimer = null;
let cfg = { offsetX: 18, offsetY: 18 };
let promptData = null;   // full payload from main, used to seed the editor
let editing = false;     // when true, cursor-follow + auto-dismiss are suspended

// Cursor follow — pure GPU transform inside the renderer. No window-manager calls.
let pillX = 0, pillY = 0;       // current rendered position (window-local)
let targetX = 0, targetY = 0;   // desired position (cursor + offset, clamped)
let rafScheduled = false;
let mouseThrough = true;
let leaveDebounce = null;

function applyTransform() {
  rafScheduled = false;
  // Light easing for buttery feel — covers the 33ms IPC tick gap
  pillX += (targetX - pillX) * 0.55;
  pillY += (targetY - pillY) * 0.55;
  // Snap when close enough to avoid endless tiny updates
  if (Math.abs(targetX - pillX) < 0.5) pillX = targetX;
  if (Math.abs(targetY - pillY) < 0.5) pillY = targetY;
  pill.style.transform = `translate3d(${Math.round(pillX)}px, ${Math.round(pillY)}px, 0)`;
  if (pillX !== targetX || pillY !== targetY) {
    rafScheduled = true;
    requestAnimationFrame(applyTransform);
  }
}

function getPillSize() {
  const rect = pill.getBoundingClientRect();
  return { w: rect.width || 220, h: rect.height || 32 };
}

function setTarget(cx, cy) {
  const { w, h } = getPillSize();
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  let x = cx + cfg.offsetX;
  let y = cy + cfg.offsetY;
  if (x + w > vw)  x = cx - w - cfg.offsetX;
  if (y + h > vh) y = cy - h - cfg.offsetY;
  if (x < 4) x = 4;
  if (y < 4) y = 4;
  targetX = x; targetY = y;
  if (!rafScheduled) { rafScheduled = true; requestAnimationFrame(applyTransform); }
}

function isOverPill(cx, cy) {
  // Use target position (not eased) so detection is instant — no lag.
  // Use actual rendered pill size (not hardcoded) so the "x" button is always in range.
  const { w, h } = getPillSize();
  const pad = 6;
  return cx >= targetX - pad && cx <= targetX + w + pad
      && cy >= targetY - pad && cy <= targetY + h + pad;
}

function startAutoDismiss() {
  if (dismissTimer) clearTimeout(dismissTimer);
  progressEl.style.transition = 'none';
  progressEl.style.transform = 'scaleX(1)';
  requestAnimationFrame(() => {
    progressEl.style.transition = `transform ${AUTO_DISMISS_MS}ms linear`;
    progressEl.style.transform = 'scaleX(0)';
  });
  dismissTimer = setTimeout(() => window.popup.skip(), AUTO_DISMISS_MS);
}
function pauseAutoDismiss() {
  if (dismissTimer) { clearTimeout(dismissTimer); dismissTimer = null; }
  progressEl.style.transition = 'none';
  progressEl.style.transform = 'scaleX(1)';
}

function enableInteraction() {
  if (mouseThrough) {
    mouseThrough = false;
    window.popup.setIgnoreMouse(false);
    pauseAutoDismiss();
  }
  clearTimeout(leaveDebounce);
}

function disableInteraction() {
  // Debounce leaving: wait 200ms before restoring click-through.
  // Prevents flicker when the eased pill briefly lags behind the cursor.
  clearTimeout(leaveDebounce);
  leaveDebounce = setTimeout(() => {
    if (!mouseThrough) {
      mouseThrough = true;
      window.popup.setIgnoreMouse(true);
      startAutoDismiss();
    }
  }, 200);
}

// Windows: the OS window follows the cursor, so the pill sits at a fixed local
// spot and we skip the per-frame transform + click-through dance entirely.
let windowed = false;

window.popup.onData(data => {
  promptData = data;
  cfg = { ...cfg, ...data };
  windowed = !!data.windowed;
  if (windowed) {
    pill.style.transform = 'translate3d(6px, 8px, 0)';
  } else {
    // Seed the pill position so the first paint doesn't ease from (0,0).
    pillX = targetX; pillY = targetY;
  }
  scoreEl.textContent = String(data.analysis.score).padStart(2, '0');
  dot.className = 'dot ' + (data.analysis.verdict || 'maybe');
  pill.classList.add('in');
  startAutoDismiss();
});

window.popup.onCursor(({ x, y }) => {
  if (editing || windowed) return; // pill is parked while the editor is open
  setTarget(x, y);
  if (isOverPill(x, y)) {
    enableInteraction();
  } else {
    disableInteraction();
  }
});

// ----- Inline editor -----
function openEditor() {
  if (!promptData) return;
  editing = true;
  pauseAutoDismiss();
  window.popup.setIgnoreMouse(false); // macOS: make the whole overlay interactive for the editor
  window.popup.enterEditor();          // Windows: grow + center this window so the card fits
  pill.style.display = 'none';
  document.getElementById('ed-title').value = promptData.title || (promptData.text || '').split('\n').find(l => l.trim()) || '';
  document.getElementById('ed-text').value = promptData.text || '';
  document.getElementById('ed-tags').value = promptData.tags || '';
  editorEl.classList.add('in');
  document.getElementById('ed-title').focus();
}

document.getElementById('edit').onclick = openEditor;
document.getElementById('skip').onclick = () => window.popup.skip();
document.getElementById('ed-cancel').onclick = () => window.popup.skip();
document.getElementById('ed-save').onclick = () => {
  window.popup.save({
    title: document.getElementById('ed-title').value.trim(),
    text: document.getElementById('ed-text').value.trim(),
    tags: document.getElementById('ed-tags').value.trim()
  });
};
document.addEventListener('keydown', e => {
  if (e.key === 'Escape') window.popup.skip();
});
