// Split — коллажи для Instagram. Всё считается в браузере: фото не покидают устройство.
import { ctx2d, decodeFile, disposePhoto, fitView, clampView, freeCanvas, loadPhoto, makeCanvas, paintCell, photoSize } from './imaging.js';
import { addLine, cloneLines, computeFaces, crossings, dividedSpan, dragRange, extent, facesOk, junctions, removeLine, trimLine } from './layout.js';

// Итоговые размеры — те, в которых Instagram показывает публикации.
const FRAMES = {
  story: { w: 1080, h: 1920 },
  post: { w: 1080, h: 1350 },
};

const MAX_HISTORY = 50;

// photos[i] лежит в ячейке faces[i]; ячейки пересчитываются из линий.
const state = { frame: 'story', lines: [], photos: [] };
let faces = computeFaces(state.lines);
// Режим линий: null — обычный, 'h' / 'v' — тап по фрейму проводит линию.
let editMode = null;
// Предпросмотр: прячем все кнопки и не реагируем на жесты.
let preview = false;
let selected = null;
// Ячейки на экране: размеры в CSS-пикселях (w, h) и в пикселях устройства (dw, dh).
let cells = [];
let frameSize = { w: 0, h: 0 };

const $ = (sel) => document.querySelector(sel);
const stage = $('#stage');
const frameEl = $('#frame');
const cellsEl = $('#cells');
const layer = $('#edit-layer');
const delLayer = $('#line-dels');
const picker = $('#picker');
const saveBtn = $('#save');
const undoBtn = $('#undo');
const redoBtn = $('#redo');

// ---------- Геометрия ----------

function faceRects(fw, fh) {
  return faces.map((f) => {
    const x0 = Math.round(f.x0 * fw), y0 = Math.round(f.y0 * fh);
    const x1 = Math.round(f.x1 * fw), y1 = Math.round(f.y1 * fh);
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
  frameSize = { w: fw / dpr, h: fh / dpr };
  frameEl.style.width = `${frameSize.w}px`;
  frameEl.style.height = `${frameSize.h}px`;

  const rects = faceRects(fw, fh);
  if (cells.length !== rects.length) buildCells(rects.length);
  rects.forEach((r, i) => {
    const c = cells[i];
    Object.assign(c, { dw: r.w, dh: r.h, w: r.w / dpr, h: r.h / dpr });
    Object.assign(c.el.style, {
      left: `${r.x / dpr}px`, top: `${r.y / dpr}px`, width: `${c.w}px`, height: `${c.h}px`,
    });
    c.el.toggleAttribute('data-narrow', c.w < 96);
    if (c.canvas.width !== r.w || c.canvas.height !== r.h) {
      c.canvas.width = r.w;
      c.canvas.height = r.h;
    }
    renderCell(i);
    if (state.photos[i]) schedulePatch(i);
  });
  renderOverlay();
}

let layoutQueued = false;
function requestLayout() {
  if (layoutQueued) return;
  layoutQueued = true;
  requestAnimationFrame(() => {
    layoutQueued = false;
    layoutFrame();
  });
}

function buildCells(n) {
  cells.forEach((c) => freeCanvas(c.canvas));
  cellsEl.replaceChildren();
  cells = Array.from({ length: n }, (_, i) => {
    const el = document.createElement('div');
    el.className = 'cell';
    el.innerHTML = `
      <canvas></canvas>
      <div class="cell-empty">
        <svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>
        <span>Фото</span>
      </div>
      <div class="cell-tools">
        <button class="cell-tool" type="button" data-act="rotate" aria-label="Повернуть на 90°">
          <svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-8-8c2.24 0 4.38.9 5.99 2.44L20 8.4"/><path d="M20 3.5v4.9h-4.9"/></svg>
        </button>
        <button class="cell-tool" type="button" data-act="replace" aria-label="Заменить фото">
          <svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9" r="1.8"/><path d="m20.5 15-3.6-3.6a1.8 1.8 0 0 0-2.5 0L6 19.8"/></svg>
        </button>
      </div>
      <div class="cell-busy"></div>`;
    cellsEl.append(el);
    const c = { el, canvas: el.querySelector('canvas'), w: 0, h: 0, dw: 0, dh: 0 };
    el.querySelector('[data-act="rotate"]').addEventListener('click', () => rotate(i));
    el.querySelector('[data-act="replace"]').addEventListener('click', () => openPicker(i));
    attachGestures(c, i);
    return c;
  });
}

// Ячейки поменялись — фото переезжают туда, где у старой и новой ячейки больше общая площадь.
// Если две ячейки слились, остаётся фото той, что занимала большую часть; второе можно вернуть отменой.
function remapPhotos(oldFaces, oldPhotos, newFaces) {
  const area = (f, g) => Math.max(0, Math.min(f.x1, g.x1) - Math.max(f.x0, g.x0))
    * Math.max(0, Math.min(f.y1, g.y1) - Math.max(f.y0, g.y0));
  const pairs = [];
  oldFaces.forEach((f, i) => {
    if (oldPhotos[i]) newFaces.forEach((g, j) => pairs.push([area(f, g), i, j]));
  });
  pairs.sort((p, q) => q[0] - p[0]);
  const out = newFaces.map(() => undefined);
  const used = new Set();
  for (const [a, i, j] of pairs) {
    if (a > 0 && !used.has(i) && !out[j]) {
      out[j] = oldPhotos[i];
      used.add(i);
    }
  }
  return out;
}

function setLines(next) {
  const nextFaces = computeFaces(next);
  state.photos = remapPhotos(faces, state.photos, nextFaces);
  state.lines = next;
  faces = nextFaces;
  if (!state.lines.some((l) => l.id === selected)) selected = null;
  syncChoices();
  layoutFrame();
}

// ---------- Отрисовка ----------

const viewKey = (p, c) => `${c.dw}x${c.dh}|${p.rot}|${p.view.z}|${p.view.px}|${p.view.py}`;

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

// ---------- Линии: режим деления ----------

const ICON_DRAG = {
  h: '<svg viewBox="0 0 24 24"><path d="M12 4v16M8 8l4-4 4 4M8 16l4 4 4-4"/></svg>',
  v: '<svg viewBox="0 0 24 24"><path d="M4 12h16M8 8l-4 4 4 4M16 8l4 4-4 4"/></svg>',
};
const ICON_TRIM = '<svg viewBox="0 0 24 24"><circle cx="6" cy="6" r="3"/><circle cx="6" cy="18" r="3"/><path d="M20 4 8.1 15.9M14.5 14.5 20 20M8.1 8.1 12 12"/></svg>';
const ICON_ROTATE = '<svg viewBox="0 0 24 24"><path d="M20 12a8 8 0 1 1-8-8c2.24 0 4.38.9 5.99 2.44L20 8.4"/><path d="M20 3.5v4.9h-4.9"/></svg>';
const ICON_ADD = '<svg viewBox="0 0 24 24"><path d="M12 5v14M5 12h14"/></svg>';
const ICON_PHOTO = '<svg viewBox="0 0 24 24"><rect x="3.5" y="3.5" width="17" height="17" rx="2.5"/><circle cx="9" cy="9" r="1.8"/><path d="m20.5 15-3.6-3.6a1.8 1.8 0 0 0-2.5 0L6 19.8"/></svg>';
const ICON_DELETE = '<svg viewBox="0 0 24 24"><path d="M4 7h16M10 11v6M14 11v6M5.5 7l1 12a2 2 0 0 0 2 2h7a2 2 0 0 0 2-2l1-12M9 7V4h6v3"/></svg>';
const HANDLE_INSET = 22;
const TRIM_OFFSET = 26;
// Насколько близко (в точках экрана) линия прилипает к центру.
const SNAP_PX = 10;
// Палец при тапе всегда чуть сдвигается; меньше этого — тап, а не перетаскивание.
const TAP_SLOP = 10;
// Минимальное расстояние между центрами кнопки фото и кнопок линий.
const PICK_CLEARANCE = 44;

// Точка на линии l: t — доля вдоль линии.
function linePoint(l, t) {
  return l.dir === 'h'
    ? { x: t * frameSize.w, y: l.pos * frameSize.h }
    : { x: l.pos * frameSize.w, y: t * frameSize.h };
}

const at = ({ x, y }) => `left:${x}px;top:${y}px`;

function renderOverlay() {
  frameEl.toggleAttribute('data-edit', !!editMode);
  layer.hidden = !editMode;
  // Вне режима линий от них остаётся только удаление.
  delLayer.innerHTML = editMode ? '' : state.lines.map((l) =>
    `<button class="line-del" type="button" data-line="${l.id}" aria-label="Удалить линию" style="${at(deletePoint(l))}">${ICON_DELETE}</button>`).join('');
  if (!editMode) return;
  const parts = [];
  // Центры кнопок на линиях — чтобы кнопки фото их обходили.
  const taken = [];
  const snap = drag?.snap;
  if (snap?.frame) {
    const l = drag.line;
    const size = l.dir === 'h' ? `width:${frameSize.w}px` : `height:${frameSize.h}px`;
    parts.push(`<div class="guide guide-${l.dir}" style="${at(linePoint(l, 0))};${size}"></div>`);
  }
  for (const l of state.lines) {
    const [s, e] = extent(state.lines, l);
    const len = (e - s) * (l.dir === 'h' ? frameSize.w : frameSize.h);
    const sel = (l.id === selected ? ' sel' : '') + (snap && drag.line === l ? ' snap' : '');
    const p0 = linePoint(l, s);
    const size = l.dir === 'h' ? `width:${len}px` : `height:${len}px`;
    parts.push(`<div class="seg seg-${l.dir}${sel}" data-line="${l.id}" style="${at(p0)};${size}"></div>`);
    // Ручки чуть внутри от концов, чтобы не наезжать на края фрейма и соседние линии.
    const inset = Math.min(HANDLE_INSET, len / 4) / (len || 1);
    const ts = len > 4 * HANDLE_INSET ? [s + (e - s) * inset, e - (e - s) * inset] : [(s + e) / 2];
    for (const t of ts) {
      const p = linePoint(l, t);
      taken.push(p);
      parts.push(`<div class="handle${sel}" data-line="${l.id}" style="${at(p)}">${ICON_DRAG[l.dir]}</div>`);
    }
  }
  const l = state.lines.find((m) => m.id === selected);
  if (l) parts.push(...selectionControls(l, taken));
  // Кнопки ячеек работают и в режиме линий: у пустой — добавить фото, у заполненной — повернуть и заменить.
  // Идут первыми, чтобы линии и их кнопки лежали поверх.
  const picks = faces.flatMap((f, i) => {
    const icons = state.photos[i]
      ? [['rotate', 'Повернуть на 90°', ICON_ROTATE], ['photo', 'Заменить фото', ICON_PHOTO]]
      : [['photo', 'Добавить фото', ICON_ADD]];
    const narrow = (f.x1 - f.x0) * frameSize.w < 2 * PICK_CLEARANCE + 16;
    const step = PICK_CLEARANCE / 2;
    const offsets = icons.length === 1 ? [{ x: 0, y: 0 }]
      : narrow ? [{ x: 0, y: -step }, { x: 0, y: step }] : [{ x: -step, y: 0 }, { x: step, y: 0 }];
    const c = pickPoint(f, taken, offsets);
    return icons.map(([act, label, icon], k) => {
      const p = { x: c.x + offsets[k].x, y: c.y + offsets[k].y };
      return `<button class="cell-pick" type="button" data-cell="${i}" data-act="${act}" aria-label="${label}" style="${at(p)}">${icon}</button>`;
    });
  });
  layer.innerHTML = picks.join('') + parts.join('');
}

// Центр ячейки, а если там уже кнопки линий — сдвиг вдоль длинной стороны ячейки.
// offsets — где стоят кнопки группы относительно её центра.
function pickPoint(f, taken, offsets) {
  const x0 = f.x0 * frameSize.w, x1 = f.x1 * frameSize.w;
  const y0 = f.y0 * frameSize.h, y1 = f.y1 * frameSize.h;
  const c = { x: (x0 + x1) / 2, y: (y0 + y1) / 2 };
  const tall = y1 - y0 >= x1 - x0;
  for (const k of [0, 1, -1, 2, -2, 3, -3]) {
    const d = k * PICK_CLEARANCE;
    const base = tall ? { x: c.x, y: c.y + d } : { x: c.x + d, y: c.y };
    const pts = offsets.map((o) => ({ x: base.x + o.x, y: base.y + o.y }));
    const inside = pts.every((p) => p.x > x0 + 20 && p.x < x1 - 20 && p.y > y0 + 20 && p.y < y1 - 20);
    const free = pts.every((p) => taken.every((q) => Math.hypot(p.x - q.x, p.y - q.y) >= PICK_CLEARANCE));
    if (inside && free) return base;
  }
  return c;
}

// У выделенной линии: ножницы на плечах у каждого пересечения и кнопка удаления.
function selectionControls(l, taken) {
  const [s, e] = extent(state.lines, l);
  const px = l.dir === 'h' ? frameSize.w : frameSize.h;
  const cross = crossings(state.lines, l);
  const stops = [s, ...cross.map((m) => m.pos), e];
  const parts = [];
  cross.forEach((m, k) => {
    const before = (m.pos - stops[k]) * px;
    const after = (stops[k + 2] - m.pos) * px;
    const pb = linePoint(l, m.pos - Math.min(TRIM_OFFSET, before / 2) / px);
    const pa = linePoint(l, m.pos + Math.min(TRIM_OFFSET, after / 2) / px);
    taken.push(pb, pa);
    parts.push(`<button class="trim" type="button" data-line="${l.id}" data-cross="${m.id}" data-end="a" aria-label="Отрезать до пересечения" style="${at(pb)}">${ICON_TRIM}</button>`);
    parts.push(`<button class="trim" type="button" data-line="${l.id}" data-cross="${m.id}" data-end="b" aria-label="Отрезать после пересечения" style="${at(pa)}">${ICON_TRIM}</button>`);
  });
  const pd = deletePoint(l);
  taken.push(pd);
  parts.push(`<button class="del" type="button" data-line="${l.id}" aria-label="Удалить линию" style="${at(pd)}">${ICON_DELETE}</button>`);
  return parts;
}

// Кнопка удаления — посередине самого длинного куска линии, свободного от пересечений и примыканий.
function deletePoint(l) {
  const [s, e] = extent(state.lines, l);
  const touching = [...crossings(state.lines, l), ...junctions(state.lines, l)].map((m) => m.pos);
  const points = [...new Set([s, ...touching, e])].sort((p, q) => p - q);
  let best = [points[0], points[1]];
  for (let k = 2; k < points.length; k++) {
    if (points[k] - points[k - 1] > best[1] - best[0]) best = [points[k - 1], points[k]];
  }
  return linePoint(l, (best[0] + best[1]) / 2);
}

function setPreview(on) {
  preview = on;
  frameEl.toggleAttribute('data-preview', on);
  if (on) $('#toast').classList.remove('show');
  if (on && editMode) setEditMode(null);
  else syncChoices();
}

$('#preview').addEventListener('click', () => setPreview(!preview));

function setEditMode(mode) {
  if (mode && preview) setPreview(false);
  editMode = mode;
  if (!mode) selected = null;
  syncChoices();
  // Первая линия ставится сама, по центру.
  if (mode && !state.lines.length) {
    const { lines, id } = addLine([], mode, 0.5);
    selected = id;
    setLines(lines);
    commit();
    toast('Тяни линию за ручки, тап по фрейму добавит ещё');
    return;
  }
  renderOverlay();
  if (mode) {
    const add = mode === 'h' ? 'Тап по фрейму — новая горизонтальная линия' : 'Тап по фрейму — новая вертикальная линия';
    toast(`${add}. Тап по линии — обрезать или удалить`);
  }
}

let drag = null;

const layerPoint = (e) => {
  const b = layer.getBoundingClientRect();
  return { x: e.clientX - b.left, y: e.clientY - b.top };
};

const faceAt = (p) => faces.findIndex((f) =>
  p.x >= f.x0 * frameSize.w && p.x <= f.x1 * frameSize.w && p.y >= f.y0 * frameSize.h && p.y <= f.y1 * frameSize.h);

// Касание мимо линий: отпустили на месте — новая линия; повели или добавили палец — жест с фото.
// Жест с фото начинается только после порога, чтобы дрожание пальца при тапе не двигало фото.
function startPhotoGesture(d) {
  if (d.gesture || !state.photos[d.cell]) return;
  d.gesture = cells[d.cell].gesture;
  for (const ev of d.pointers.values()) d.gesture.down(ev);
}

layer.addEventListener('pointerdown', (e) => {
  if (e.target.closest('.trim, .del, .cell-pick')) return;
  if (drag && !drag.line) {
    layer.setPointerCapture(e.pointerId);
    drag.pointers.set(e.pointerId, e);
    drag.moved = true;
    if (drag.gesture) drag.gesture.down(e);
    else startPhotoGesture(drag);
    return;
  }
  if (drag) return;
  layer.setPointerCapture(e.pointerId);
  const id = e.target.closest('[data-line]')?.dataset.line ?? null;
  const line = state.lines.find((l) => l.id === id);
  const start = layerPoint(e);
  drag = {
    pointerId: e.pointerId,
    pointers: new Map([[e.pointerId, e]]),
    start,
    moved: false,
    line,
    startPos: line?.pos,
    range: line ? dragRange(state.lines, faces, line) : null,
    snaps: line ? snapTargets(line) : [],
    snap: null,
    cell: line ? -1 : faceAt(start),
    gesture: null,
  };
});

// Центр всего фрейма и центр части, которую линия делит.
function snapTargets(l) {
  const [lo, hi] = dividedSpan(state.lines, faces, l);
  const [min, max] = dragRange(state.lines, faces, l);
  const targets = [{ pos: 0.5, frame: true }];
  if (Math.abs((lo + hi) / 2 - 0.5) > 1e-9) targets.push({ pos: (lo + hi) / 2, frame: false });
  return targets.filter((t) => t.pos >= min && t.pos <= max);
}

layer.addEventListener('pointermove', (e) => {
  if (!drag || !drag.pointers.has(e.pointerId)) return;
  drag.pointers.set(e.pointerId, e);
  const p = layerPoint(e);
  const dx = p.x - drag.start.x;
  const dy = p.y - drag.start.y;
  if (!drag.line) {
    if (drag.gesture) drag.gesture.move(e);
    else if (Math.hypot(dx, dy) > TAP_SLOP) {
      drag.moved = true;
      startPhotoGesture(drag);
    }
    return;
  }
  if (e.pointerId !== drag.pointerId) return;
  if (!drag.moved && Math.hypot(dx, dy) > TAP_SLOP) drag.moved = true;
  if (!drag.moved) return;
  const l = drag.line;
  const delta = l.dir === 'h' ? dy / frameSize.h : dx / frameSize.w;
  const [min, max] = drag.range;
  const px = l.dir === 'h' ? frameSize.h : frameSize.w;
  let pos = Math.min(max, Math.max(min, drag.startPos + delta));
  drag.snap = null;
  for (const t of drag.snaps) {
    const d = Math.abs(pos - t.pos) * px;
    if (d < SNAP_PX && (!drag.snap || d < Math.abs(pos - drag.snap.pos) * px)) drag.snap = t;
  }
  if (drag.snap) pos = drag.snap.pos;
  l.pos = pos;
  const nextFaces = computeFaces(state.lines);
  state.photos = remapPhotos(faces, state.photos, nextFaces);
  faces = nextFaces;
  requestLayout();
});

const endDrag = (e, cancelled) => {
  if (!drag || !drag.pointers.has(e.pointerId)) return;
  drag.pointers.delete(e.pointerId);
  drag.gesture?.up(e);
  if (drag.pointers.size) return;
  const d = drag;
  drag = null;
  if (d.moved) {
    if (d.line) {
      // Потянутая линия становится выделенной — сразу видны ножницы и удаление.
      selected = d.line.id;
      renderOverlay();
      commit();
    }
    return;
  }
  if (cancelled) return;
  if (d.line) {
    selected = selected === d.line.id ? null : d.line.id;
    renderOverlay();
  } else {
    placeLine(d.start);
  }
};
layer.addEventListener('pointerup', (e) => endDrag(e, false));
layer.addEventListener('pointercancel', (e) => endDrag(e, true));

layer.addEventListener('wheel', (e) => {
  const i = faceAt(layerPoint(e));
  if (i < 0 || !state.photos[i]) return;
  e.preventDefault();
  cells[i].gesture.wheel(e);
}, { passive: false });

// Новая линия идёт через весь фрейм; лишнее потом отрезается ножницами на пересечениях.
function placeLine(p) {
  const fx = p.x / frameSize.w;
  const fy = p.y / frameSize.h;
  const [lo, hi, px] = editMode === 'h' ? ['y0', 'y1', frameSize.h] : ['x0', 'x1', frameSize.w];
  let pos = editMode === 'h' ? fy : fx;
  // Прилипает к центру ячейки, по которой тапнули, и к центру фрейма.
  const face = faces.find((f) => fx >= f.x0 && fx <= f.x1 && fy >= f.y0 && fy <= f.y1);
  const targets = [0.5, ...(face ? [(face[lo] + face[hi]) / 2] : [])];
  const near = targets.filter((t) => Math.abs(t - pos) * px < SNAP_PX * 2).sort((a, b) => Math.abs(a - pos) - Math.abs(b - pos));
  if (near.length) pos = near[0];
  const { lines, id } = addLine(state.lines, editMode, pos);
  if (!facesOk(computeFaces(lines))) {
    toast('Слишком близко к краю или к другой линии');
    return;
  }
  selected = id;
  setLines(lines);
  commit();
}

layer.addEventListener('click', (e) => {
  const pick = e.target.closest('.cell-pick');
  if (pick) {
    const i = Number(pick.dataset.cell);
    if (pick.dataset.act === 'rotate') rotate(i);
    else openPicker(i);
    return;
  }
  const b = e.target.closest('.trim, .del');
  if (!b) return;
  const { line, cross, end } = b.dataset;
  setLines(b.classList.contains('del') ? removeLine(state.lines, line) : trimLine(state.lines, line, cross, end));
  commit();
});

delLayer.addEventListener('click', (e) => {
  const b = e.target.closest('.line-del');
  if (!b) return;
  setLines(removeLine(state.lines, b.dataset.line));
  commit();
});

// ---------- История: отмена и возврат ----------

// Снимок — формат, линии и что лежит в каждой ячейке. Сами фото не копируются, только ссылки на них.
const history = { undo: [], redo: [], current: null };
const knownPhotos = new Set();

function snapshot() {
  return {
    frame: state.frame,
    lines: cloneLines(state.lines),
    cells: faces.map((_, i) => {
      const p = state.photos[i];
      return p ? { photo: p, rot: p.rot, view: { ...p.view } } : null;
    }),
  };
}

function sameSnapshot(a, b) {
  return a.frame === b.frame && JSON.stringify(a.lines) === JSON.stringify(b.lines)
    && a.cells.length === b.cells.length
    && a.cells.every((x, i) => {
      const y = b.cells[i];
      if (!x || !y) return x === y;
      return x.photo === y.photo && x.rot === y.rot
        && x.view.z === y.view.z && x.view.px === y.view.px && x.view.py === y.view.py;
    });
}

function commit() {
  const snap = snapshot();
  if (sameSnapshot(snap, history.current)) return;
  history.undo.push(history.current);
  if (history.undo.length > MAX_HISTORY) history.undo.shift();
  history.redo = [];
  history.current = snap;
  collectPhotos();
  syncHistory();
}

function step(from, to) {
  if (!from.length) return;
  to.push(history.current);
  history.current = from.pop();
  const snap = history.current;
  state.frame = snap.frame;
  state.lines = cloneLines(snap.lines);
  faces = computeFaces(state.lines);
  state.photos = snap.cells.map((c) => {
    if (!c) return undefined;
    c.photo.rot = c.rot;
    c.photo.view = { ...c.view };
    return c.photo;
  });
  selected = null;
  syncChoices();
  layoutFrame();
  collectPhotos();
  syncHistory();
}

// Фото, которых нет ни на экране, ни в истории, освобождаем. Тем, что остались
// только в истории, хватит превью — остальное пересчитается, если к ним вернуться.
function collectPhotos() {
  const inHistory = new Set();
  for (const snap of [history.current, ...history.undo, ...history.redo]) {
    snap.cells.forEach((c) => c && inHistory.add(c.photo));
  }
  for (const p of knownPhotos) {
    if (state.photos.includes(p)) continue;
    if (original.photo === p) dropOriginal();
    if (inHistory.has(p)) {
      freeCanvas(p.patch?.canvas);
      p.patch = null;
    } else {
      disposePhoto(p);
      knownPhotos.delete(p);
    }
  }
}

function syncHistory() {
  undoBtn.disabled = !history.undo.length;
  redoBtn.disabled = !history.redo.length;
}

undoBtn.addEventListener('click', () => step(history.undo, history.redo));
redoBtn.addEventListener('click', () => step(history.redo, history.undo));

document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape' && editMode) setEditMode(null);
  if (!(e.ctrlKey || e.metaKey) || e.code !== 'KeyZ') return;
  e.preventDefault();
  if (e.shiftKey) step(history.redo, history.undo);
  else step(history.undo, history.redo);
});

// ---------- Жесты с фото ----------

// Сдвиг одним пальцем и щипок двумя. События приходят либо от самой ячейки,
// либо от слоя линий — координаты считаются от ячейки по clientX/clientY.
function makeGesture(c, i) {
  const pts = new Map();
  let wheelTimer;
  const local = (e) => {
    const b = c.el.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  };
  const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });
  const dist = (a, b) => Math.max(1, Math.hypot(a.x - b.x, a.y - b.y));

  return {
    moved: false,
    origin: null,
    has: (id) => pts.has(id),
    down(e) {
      const pt = local(e);
      pts.set(e.pointerId, pt);
      if (pts.size === 1) {
        this.moved = false;
        this.origin = pt;
      }
      clearTimeout(patchTimers.get(i));
    },
    move(e) {
      if (!pts.has(e.pointerId) || !state.photos[i]) return;
      const prev = [...pts.values()];
      const cur = local(e);
      pts.set(e.pointerId, cur);
      if (Math.hypot(cur.x - this.origin.x, cur.y - this.origin.y) > 4) this.moved = true;
      if (pts.size === 1) {
        transform(i, prev[0], cur, 1);
      } else {
        const next = [...pts.values()];
        transform(i, mid(prev[0], prev[1]), mid(next[0], next[1]), dist(next[0], next[1]) / dist(prev[0], prev[1]));
      }
    },
    // Один жест — от первого касания до последнего отпущенного пальца — один шаг истории.
    up(e) {
      if (pts.delete(e.pointerId) && pts.size === 0) {
        schedulePatch(i);
        commit();
      }
    },
    // Колёсико — для проверки на компьютере.
    wheel(e) {
      const m = local(e);
      transform(i, m, m, Math.exp(-e.deltaY * 0.0015));
      schedulePatch(i);
      clearTimeout(wheelTimer);
      wheelTimer = setTimeout(commit, 400);
    },
  };
}

function attachGestures(c, i) {
  const g = makeGesture(c, i);
  c.gesture = g;

  c.el.addEventListener('pointerdown', (e) => {
    if (!state.photos[i] || e.target.closest('.cell-tools')) return;
    c.el.setPointerCapture(e.pointerId);
    g.down(e);
  });
  c.el.addEventListener('pointermove', (e) => g.move(e));
  c.el.addEventListener('pointerup', (e) => g.up(e));
  c.el.addEventListener('pointercancel', (e) => g.up(e));

  c.el.addEventListener('click', (e) => {
    if (e.target.closest('.cell-tools')) return;
    if (g.moved) {
      g.moved = false;
      return;
    }
    if (!state.photos[i]) openPicker(i);
  });

  c.el.addEventListener('wheel', (e) => {
    if (!state.photos[i]) return;
    e.preventDefault();
    g.wheel(e);
  }, { passive: false });
}

// Точка фото под `from` переезжает в `to`, масштаб умножается на f.
function transform(i, from, to, f) {
  const p = state.photos[i];
  const c = cells[i];
  const v = p.view;
  const z = Math.max(1, v.z * f);
  const k = z / v.z;
  const [pw, ph] = photoSize(p);
  p.view = clampView(c.w, c.h, pw, ph, {
    z,
    px: (to.x + (v.px * c.w - from.x) * k) / c.w,
    py: (to.y + (v.py * c.h - from.y) * k) / c.h,
  });
  requestRender(i);
}

function rotate(i) {
  const p = state.photos[i];
  if (!p) return;
  p.rot = (p.rot + 1) % 4;
  p.view = fitView();
  renderCell(i);
  schedulePatch(i, 0);
  commit();
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
  const cell = cells[i];
  cell.el.setAttribute('data-busy', '');
  dropOriginal();
  try {
    const photo = await loadPhoto(file);
    // Пока фото грузилось, ячейки могли поменяться — тогда вставлять уже некуда.
    if (cells[i] !== cell) return;
    knownPhotos.add(photo);
    state.photos[i] = photo;
    renderCell(i);
    renderOverlay();
    schedulePatch(i, 0);
    commit();
  } catch (e) {
    console.error(e);
    toast('Не удалось открыть фото');
  } finally {
    cell.el.removeAttribute('data-busy');
  }
});

// ---------- Формат и инструменты ----------

function resetViews() {
  state.photos.forEach((p) => {
    if (!p) return;
    p.view = fitView();
    freeCanvas(p.patch?.canvas);
    p.patch = null;
  });
}

function syncChoices() {
  document.querySelectorAll('[data-frame]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.frame === state.frame)));
  document.querySelectorAll('[data-tool]').forEach((b) => b.setAttribute('aria-pressed', String(b.dataset.tool === editMode)));
  $('#preview').setAttribute('aria-pressed', String(preview));
}

document.querySelectorAll('[data-frame]').forEach((b) => b.addEventListener('click', () => {
  if (state.frame === b.dataset.frame) return;
  state.frame = b.dataset.frame;
  resetViews();
  syncChoices();
  layoutFrame();
  commit();
}));

document.querySelectorAll('[data-tool]').forEach((b) => b.addEventListener('click', () => {
  setEditMode(editMode === b.dataset.tool ? null : b.dataset.tool);
}));

// ---------- Сохранение ----------

async function renderCollage() {
  const f = FRAMES[state.frame];
  const out = makeCanvas(f.w, f.h);
  const ctx = ctx2d(out);
  const rects = faceRects(f.w, f.h);
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
  if (faces.some((_, i) => !state.photos[i])) {
    toast('Добавь фото во все части');
    return;
  }
  if (editMode) setEditMode(null);
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
  toastTimer = setTimeout(() => el.classList.remove('show'), Math.max(2400, text.length * 50));
}

// Не даём Safari масштабировать всю страницу щипком.
document.addEventListener('gesturestart', (e) => e.preventDefault());

syncChoices();
history.current = snapshot();
syncHistory();
new ResizeObserver(() => layoutFrame()).observe(stage);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').catch((e) => console.warn('SW:', e));
}
