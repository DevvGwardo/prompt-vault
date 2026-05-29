const q = document.getElementById('q');
const list = document.getElementById('list');
const countEl = document.getElementById('count');

let items = [];
let cursor = 0;

function render() {
  countEl.textContent = String(items.length);
  if (!items.length) {
    list.innerHTML = `<div class="empty">no prompts match</div>`;
    return;
  }
  list.innerHTML = items.map((p, i) => {
    const verdict = p.verdict || 'maybe';
    const label = (p.title || p.text || '').replace(/\s+/g, ' ').trim();
    return `<div class="item ${i === cursor ? 'active' : ''}" data-i="${i}">
      <span class="dot ${verdict}"></span>
      <span class="score">${p.score ?? '--'}</span>
      <span class="label">${escapeHtml(label)}</span>
    </div>`;
  }).join('');
  const active = list.querySelector('.item.active');
  if (active) active.scrollIntoView({ block: 'nearest' });
}

function escapeHtml(s) {
  return s.replace(/[&<>"]/g, c => ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;' }[c]));
}

async function search(query) {
  items = await window.picker.search(query);
  cursor = 0;
  render();
}

async function copyAndClose(autoPaste) {
  if (!items[cursor]) return;
  await window.picker.copy(items[cursor].id, !!autoPaste);
}

q.addEventListener('input', () => search(q.value));

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') return window.picker.close();
  if (e.key === 'ArrowDown') { cursor = Math.min(items.length - 1, cursor + 1); render(); e.preventDefault(); }
  if (e.key === 'ArrowUp')   { cursor = Math.max(0, cursor - 1); render(); e.preventDefault(); }
  if (e.key === 'Enter')     { copyAndClose(e.shiftKey); e.preventDefault(); }
});

list.addEventListener('click', e => {
  const el = e.target.closest('.item');
  if (!el) return;
  cursor = Number(el.dataset.i);
  render();
  copyAndClose(false);
});

search('');
