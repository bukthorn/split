// Сплит — коллажи для Instagram. Всё считается в браузере: фото не покидают устройство.
import { ctx2d, decodeFile, disposePhoto, fitView, clampView, freeCanvas, loadPhoto, makeCanvas, paintCell } from './imaging.js';

// Итоговые размеры — те, в которых Instagram показывает публикации.
const FRAMES = {
  story: { w: 1080, h: 1920 },
  post: { w: 1080, h: 1350 },
};

// Ячейки в долях фрейма: [x, y, ширина, высота].
const LAYOUTS = {
  cols: [[0, 0, 0.5, 1], [0.5, 0, 0.5, 1]],
  rows: [[0, 0, 1, 0.5], [0, 0.5, 1, 0.5]],
};

const state = { frame: 'story', layout: 'cols', photos: [] };
// Ячейки на экране: размеры в CSS-пикселях (w, h) и в пикселях устройства (dw, dh).
let cells = [];

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const frameEl = $('#frame');
const picker = $('#picker');
const saveBtn = $('#save');

// ---------- Геометрия ----------

function cellRects(fw, fh) {
  return LAYOUTS[state.layout].map(([x, y, w, h]) => {
    const x0 = Math.round(x * fw), y0 = Math.round(y * fh);
    const x1 = Math.round((x + w) * fw), y1 = Math.round((y + h) * fh);
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  });
}

function layoutFrame() {
  const f = FRAMES[state.frame];
  const s = Math.min(stage.clientWidth / f.w, stage.clientHeight / f.h);
  if (!(s > 0)) return;
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const fw = Math.round(f.w * s * dpr);
  const fh = Math.round(f.h * s * dpr);
  frameEl.style.width = `${fw / dpr}px`;
  frameEl.style.height = `${fh / dpr}px`;

  const rects = cellRects(fw, fh);
  if (cells.length !== rects.length) buildCells(rects.length);
  rects.forEach((r, i) => {
    const c = cells[i];
    Object.assign(c, { dw: r.w, dh: r.h, w: r.w / dpr, h: r.h / dpr });
    Object.assign(c.el.style, {
      left: `${r.x / dpr}px`, top: `${r.y / dpr}px`, width: `${c.w}px`, height: `${c.h}px`,
    });
    if (c.canvas.width !== r.w || c.canvas.height !== r.h) {
      c.canvas.width = r.w;
      c.canvas.height = r.h;
    }
    renderCell(i);
    if (state.photos[i]) schedulePatch(i);
  });
}

function buildCells(n) {
  frameEl.replaceChildren();
  cells = Array.from({ length: n }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'cell';
    el.innerHTML = `
      <canvas></canvas>
      <div class="cell-empty">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        <span>Фото</span>
      </div>
      <button class="cell-replace" type="button" aria-label="Заменить фото">
        <svg viewBox="0 0 24 24"><path d="M4 12a8 8 0 0 1 13.7-5.6L20 8.7M20 4v4.7h-4.7M20 12a8 8 0 0 1-13.7 5.6L4 15.3M4 20v-4.7h4.7"/></svg>
      </button>
      <div class="cell-busy"></div>`;
    frameEl.append(el);
    const c = { el, canvas: el.querySelector('canvas'), w: 0, h: 0, dw: 0, dh: 0 };
    el.querySelector('.cell-replace').addEventListener('click', () => openPicker(i));
    attachGestures(c, i);
    return c;
  });
  state.photos.slice(n).forEach(disposePhoto);
  state.photos.length = n;
}

// ---------- Отрисовка ----------

const viewKey = (p, c) => `${c.dw}x${c.dh}|${p.view.z}|${p.view.px}|${p.view.py}`;

function renderCell(i) {
  const c = cells[i];
  const p = state.photos[i];
  c.el.toggleAttribute('data-empty', !p);
  const ctx = ctx2d(c.canvas);
  ctx.clearRect(0, 0, c.dw, c.dh);
  if (!p) return;
  if (p.patch?.key === viewKey(p, c)) ctx.drawImage(p.patch.canvas, 0, 0);
  else paintCell(ctx, p, p.preview, 0, 0, c.dw, c.dh, false);
}

const pendingRender = new Set();
function requestRender(i) {
  if (!pendingRender.size) {
    requestAnimationFrame(() => {
      pendingRender.forEach(renderCell);
      pendingRender.clear();
    });
  }
  pendingRender.add(i);
}

// Во время жестов рисуем из облегчённого превью, а когда пальцы отпущены —
// перерисовываем ячейку из оригинала. Так при любом зуме на экране та же чёткость, что и в файле.
const patchTimers = new Map();
let patchChain = Promise.resolve();

function schedulePatch(i, delay = 200) {
  clearTimeout(patchTimers.get(i));
  patchTimers.set(i, setTimeout(() => {
    patchChain = patchChain.then(() => buildPatch(i)).catch((e) => console.warn(e));
  }, delay));
}

async function buildPatch(i) {
  const p = state.photos[i];
  const c = cells[i];
  if (!p || !c) return;
  const key = viewKey(p, c);
  if (p.patch?.key === key) return;
  const img = await getOriginal(p);
  if (state.photos[i] !== p || cells[i] !== c || viewKey(p, c) !== key) return;
  const canvas = makeCanvas(c.dw, c.dh);
  paintCell(ctx2d(canvas), p, img, 0, 0, c.dw, c.dh, true);
  freeCanvas(p.patch?.canvas);
  p.patch = { key, canvas };
  renderCell(i);
}

// Раскодированный оригинал занимает до ~200 МБ, поэтому в памяти держим только один.
let original = { photo: null, promise: null };

function getOriginal(photo) {
  if (original.photo !== photo) original = { photo, promise: decodeFile(photo.file) };
  return original.promise;
}

function dropOriginal() {
  original.promise?.then((img) => img.removeAttribute('src'), () => {});
  original = { photo: null, promise: null };
}

// ---------- Жесты ----------

function attachGestures(c, i) {
  const pts = new Map();
  let moved = false;
  let origin = null;
  const local = (e) => {
    const b = c.el.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));

  c.el.addEventListener('pointerdown', (e) => {
    if (!state.photos[i] || e.target.closest('.cell-replace')) return;
    c.el.setPointerCapture(e.pointerId);
    const pt = local(e);
    pts.set(e.pointerId, pt);
    if (pts.size === 1) {
      moved = false;
      origin = pt;
    }
    clearTimeout(patchTimers.get(i));
  });

  c.el.addEventListener('pointermove', (e) => {
    if (!pts.has(e.pointerId)) return;
    const prev = [...pts.values()];
    const cur = local(e);
    pts.set(e.pointerId, cur);
    if (Math.hypot(cur.x - origin.x, cur.y - origin.y) > 4) moved = true;
    if (pts.size === 1) {
      transform(i, prev[0], cur, 1);
    } else {
      const next = [...pts.values()];
      transform(i, mid(prev[0], prev[1]), mid(next[0], next[1]), dist(next[0], next[1]) / dist(prev[0], prev[1]));
    }
  });

  const end = (e) => {
    if (pts.delete(e.pointerId) && pts.size === 0) schedulePatch(i);
  };
  c.el.addEventListener('pointerup', end);
  c.el.addEventListener('pointercancel', end);

  c.el.addEventListener('click', (e) => {
    if (e.target.closest('.cell-replace')) return;
    if (moved) {
      moved = false;
      return;
    }
    if (!state.photos[i]) openPicker(i);
  });

  // Колёсико — для проверки на компьютере.
  c.el.addEventListener('wheel', (e) => {
    if (!state.photos[i]) return;
    e.preventDefault();
    const m = local(e);
    transform(i, m, m, Math.exp(-e.deltaY * 0.0015));
    schedulePatch(i);
  }, { passive: false });
}

// Точка фото под `from` переезжает в `to`, масштаб умножается на f.
function transform(i, from, to, f) {
  const p = state.photos[i];
  const c = cells[i];
  const v = p.view;
  const z = Math.max(1, v.z * f);
  const k = z / v.z;
  p.view = clampView(c.w, c.h, p.iw, p.ih, {
    z,
    px: (to.x + (v.px * c.w - from.x) * k) / c.w,
    py: (to.y + (v.py * c.h - from.y) * k) / c.h,
  });
  requestRender(i);
}

// ---------- Выбор фото ----------

let pickTarget = -1;

function openPicker(i) {
  pickTarget = i;
  picker.value = '';
  picker.click();
}

picker.addEventListener('change', async () => {
  const file = picker.files?.[0];
  const i = pickTarget;
  picker.value = '';
  if (!file || !cells[i]) return;
  cells[i].el.setAttribute('data-busy', '');
  dropOriginal();
  try {
    const photo = await loadPhoto(file);
    disposePhoto(state.photos[i]);
    state.photos[i] = photo;
    renderCell(i);
    schedulePatch(i, 0);
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть фото');
  } finally {
    cells[i]?.el.removeAttribute('data-busy');
  }
});

// ---------- Формат и раскладка ----------

function resetViews() {
  state.photos.forEach((p) => {
    if (!p) return;
    p.view = fitView();
    freeCanvas(p.patch?.canvas);
    p.patch = null;
  });
}

function bindChoice(attr, key) {
  const buttons = document.querySelectorAll(`[data-${attr}]`);
  const sync = () => buttons.forEach((b) => b.setAttribute('aria-pressed', String(b.dataset[attr] === state[key])));
  buttons.forEach((b) => b.addEventListener('click', () => {
    if (state[key] === b.dataset[attr]) return;
    state[key] = b.dataset[attr];
    sync();
    resetViews();
    layoutFrame();
  }));
  sync();
}

bindChoice('frame', 'frame');
bindChoice('layout', 'layout');

// ---------- Сохранение ----------

async function renderCollage() {
  const f = FRAMES[state.frame];
  const out = makeCanvas(f.w, f.h);
  const ctx = ctx2d(out);
  const rects = cellRects(f.w, f.h);
  for (let i = 0; i < rects.length; i++) {
    const r = rects[i];
    const p = state.photos[i];
    paintCell(ctx, p, await getOriginal(p), r.x, r.y, r.w, r.h, true);
  }
  // PNG — без потерь; пережимать будет уже сам Instagram.
  const blob = await new Promise((resolve, reject) =>
    out.toBlob((b) => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png'));
  freeCanvas(out);
  return blob;
}

function fileName() {
  const d = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  return `split-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}${pad(d.getSeconds())}.png`;
}

const canShare = (file) => matchMedia('(pointer: coarse)').matches && navigator.canShare?.({ files: [file] });

saveBtn.addEventListener('click', async () => {
  if (cells.some((_, i) => !state.photos[i])) {
    toast('Добавь фото во все части');
    return;
  }
  saveBtn.disabled = true;
  saveBtn.textContent = 'Готовлю…';
  try {
    const blob = await renderCollage();
    const file = new File([blob], fileName(), { type: 'image/png' });
    if (!canShare(file)) {
      download(file);
      return;
    }
    try {
      await navigator.share({ files: [file] });
    } catch (e) {
      // Safari может не открыть меню после долгой подготовки — тогда нужен ещё один тап.
      if (e.name !== 'AbortError') showSheet(file);
    }
  } catch (e) {
    console.error(e);
    toast('Не получилось сохранить');
  } finally {
    saveBtn.disabled = false;
    saveBtn.textContent = 'Сохранить';
  }
});

function download(file) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(file);
  a.download = file.name;
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 10_000);
}

const sheet = $('#sheet');
const sheetImg = $('#sheet-img');
let sheetFile = null;

function showSheet(file) {
  sheetFile = file;
  sheetImg.src = URL.createObjectURL(file);
  sheet.hidden = false;
}

function hideSheet() {
  sheet.hidden = true;
  URL.revokeObjectURL(sheetImg.src);
  sheetImg.removeAttribute('src');
  sheetFile = null;
}

$('#sheet-save').addEventListener('click', () => {
  navigator.share({ files: [sheetFile] }).then(hideSheet, (e) => {
    if (e.name !== 'AbortError') toast('Зажми картинку и выбери «Сохранить в Фото»');
  });
});
$('#sheet-close').addEventListener('click', hideSheet);

// ---------- Прочее ----------

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.textContent = text;
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2400);
}

// Не даём Safari масштабировать всю страницу щипком.
document.addEventListener('gesturestart', (e) => e.preventDefault());

new ResizeObserver(() => layoutFrame()).observe(stage);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
}
