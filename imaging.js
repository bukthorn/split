// Работа с изображениями. Одни и те же функции рисуют и превью на экране, и итоговый файл,
// поэтому то, что видно в ячейке, совпадает с тем, что сохранится.

// Превью держим не больше этого размера по длинной стороне — оригинал хранится отдельно, файлом.
const PREVIEW_MAX = 2048;
// iOS Safari не создаёт canvas больше ~16.7 Мп.
const MAX_CANVAS_AREA = 16_000_000;
// Размытый фон считаем в маленьком canvas: при сильном размытии детали всё равно не нужны.
const BLUR_LONG_SIDE = 160;
const BLUR_RADIUS = 8;
const BLUR_PASSES = 3;

export function makeCanvas(w, h) {
  const c = document.createElement('canvas');
  c.width = Math.max(1, Math.round(w));
  c.height = Math.max(1, Math.round(h));
  return c;
}

// Display P3 — чтобы не терять насыщенные цвета с камеры iPhone. Где не поддерживается, опция игнорируется.
export function ctx2d(canvas) {
  const ctx = canvas.getContext('2d', { colorSpace: 'display-p3' });
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';
  return ctx;
}

// Safari держит память canvas до сборки мусора; обнуление размера освобождает её сразу.
export function freeCanvas(canvas) {
  if (canvas) {
    canvas.width = 0;
    canvas.height = 0;
  }
}

export async function decodeFile(file) {
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.decoding = 'async';
  img.src = url;
  try {
    await img.decode();
  } finally {
    URL.revokeObjectURL(url);
  }
  return img;
}

export async function loadPhoto(file) {
  const img = await decodeFile(file);
  const iw = img.naturalWidth;
  const ih = img.naturalHeight;
  const k = Math.min(1, PREVIEW_MAX / Math.max(iw, ih));
  const preview = makeCanvas(iw * k, ih * k);
  drawHQ(ctx2d(preview), img, 0, 0, iw, ih, 0, 0, preview.width, preview.height);
  img.removeAttribute('src');
  return { file, iw, ih, rot: 0, preview, view: fitView(), blur: null, patch: null };
}

// Размер фото с учётом поворота; rot — число четвертей оборота по часовой.
export function photoSize(photo) {
  return photo.rot % 2 ? [photo.ih, photo.iw] : [photo.iw, photo.ih];
}

export function disposePhoto(photo) {
  if (!photo) return;
  freeCanvas(photo.preview);
  freeCanvas(photo.blur?.canvas);
  freeCanvas(photo.patch?.canvas);
}

// Положение фото в ячейке: z — зум относительно «вписать целиком» (не меньше 1),
// px/py — центр фото в долях ячейки. Доли не зависят от размера ячейки в пикселях,
// поэтому одинаково работают на экране и в итоговом 1080×1920.
export function fitView() {
  return { z: 1, px: 0.5, py: 0.5 };
}

function photoRect(W, H, iw, ih, view) {
  const s = Math.min(W / iw, H / ih) * view.z;
  const w = iw * s;
  const h = ih * s;
  return { x: view.px * W - w / 2, y: view.py * H - h / 2, w, h };
}

// По каждой оси: фото меньше ячейки — не выходит за её края; больше — не открывает пустоту.
function clampAxis(center, size, len) {
  const a = len / 2;
  const b = size - len / 2;
  return Math.min(Math.max(center, Math.min(a, b)), Math.max(a, b));
}

export function clampView(W, H, iw, ih, view) {
  const z = Math.max(1, view.z);
  const s = Math.min(W / iw, H / ih) * z;
  return {
    z,
    px: clampAxis(view.px * W, W, iw * s) / W,
    py: clampAxis(view.py * H, H, ih * s) / H,
  };
}

// Сильное уменьшение за один шаг даёт «лесенку» и муар — уменьшаем ступенями по 2 раза.
function drawHQ(ctx, src, sx, sy, sw, sh, dx, dy, dw, dh) {
  let cur = src;
  let x = sx, y = sy, w = sw, h = sh;
  while (w >= dw * 2 && h >= dh * 2) {
    let nw = Math.ceil(w / 2);
    let nh = Math.ceil(h / 2);
    if (nw * nh > MAX_CANVAS_AREA) {
      const k = Math.sqrt(MAX_CANVAS_AREA / (nw * nh));
      nw = Math.floor(nw * k);
      nh = Math.floor(nh * k);
    }
    const next = makeCanvas(nw, nh);
    ctx2d(next).drawImage(cur, x, y, w, h, 0, 0, next.width, next.height);
    if (cur !== src) freeCanvas(cur);
    cur = next;
    x = 0; y = 0; w = next.width; h = next.height;
  }
  ctx.drawImage(cur, x, y, w, h, dx, dy, dw, dh);
  if (cur !== src) freeCanvas(cur);
}

function drawPhoto(ctx, src, photo, x, y, W, H, hq) {
  const srcW = src.naturalWidth || src.width;
  const srcH = src.naturalHeight || src.height;
  const [pw, ph] = photoSize(photo);
  const r = photoRect(W, H, pw, ph, clampView(W, H, pw, ph, photo.view));
  const x0 = Math.max(0, r.x), x1 = Math.min(W, r.x + r.w);
  const y0 = Math.max(0, r.y), y1 = Math.min(H, r.y + r.h);
  if (x1 <= x0 || y1 <= y0) return;

  // Видимая часть в долях повёрнутого фото → тот же кусок в исходном, неповёрнутом.
  const u0 = (x0 - r.x) / r.w, u1 = (x1 - r.x) / r.w;
  const v0 = (y0 - r.y) / r.h, v1 = (y1 - r.y) / r.h;
  const [s0, s1, t0, t1] = [
    [u0, u1, v0, v1],
    [v0, v1, 1 - u1, 1 - u0],
    [1 - u1, 1 - u0, 1 - v1, 1 - v0],
    [1 - v1, 1 - v0, u0, u1],
  ][photo.rot];
  const sx = s0 * srcW;
  const sy = t0 * srcH;
  const sw = Math.min((s1 - s0) * srcW, srcW - sx);
  const sh = Math.min((t1 - t0) * srcH, srcH - sy);

  const dw = x1 - x0, dh = y1 - y0;
  const [w, h] = photo.rot % 2 ? [dh, dw] : [dw, dh];
  const draw = hq ? drawHQ : (c, ...args) => c.drawImage(...args);
  ctx.save();
  ctx.translate(x + (x0 + x1) / 2, y + (y0 + y1) / 2);
  ctx.rotate((photo.rot * Math.PI) / 2);
  draw(ctx, src, sx, sy, sw, sh, -w / 2, -h / 2, w, h);
  ctx.restore();
}

// Ячейка целиком: размытая копия фото на фон, сверху само фото.
export function paintCell(ctx, photo, src, x, y, w, h, hq) {
  ctx.save();
  ctx.beginPath();
  ctx.rect(x, y, w, h);
  ctx.clip();
  ctx.drawImage(blurFor(photo, w / h), x, y, w, h);
  drawPhoto(ctx, src, photo, x, y, w, h, hq);
  ctx.restore();
}

function blurFor(photo, aspect) {
  const key = `${aspect.toFixed(3)}|${photo.rot}`;
  if (photo.blur?.key !== key) {
    freeCanvas(photo.blur?.canvas);
    photo.blur = { key, canvas: makeBlur(photo.preview, aspect, photo.rot) };
  }
  return photo.blur.canvas;
}

function makeBlur(src, aspect, rot) {
  const bw = aspect >= 1 ? BLUR_LONG_SIDE : Math.round(BLUR_LONG_SIDE * aspect);
  const bh = aspect >= 1 ? Math.round(BLUR_LONG_SIDE / aspect) : BLUR_LONG_SIDE;
  const c = makeCanvas(bw, bh);
  const ctx = ctx2d(c);
  const [rw, rh] = rot % 2 ? [src.height, src.width] : [src.width, src.height];
  const s = Math.max(c.width / rw, c.height / rh);
  const w = src.width * s;
  const h = src.height * s;
  ctx.translate(c.width / 2, c.height / 2);
  ctx.rotate((rot * Math.PI) / 2);
  drawHQ(ctx, src, 0, 0, src.width, src.height, -w / 2, -h / 2, w, h);
  ctx.setTransform(1, 0, 0, 1, 0, 0);

  const img = ctx.getImageData(0, 0, c.width, c.height, { colorSpace: 'display-p3' });
  const a = img.data;
  const b = new Uint8ClampedArray(a.length);
  const W = c.width, H = c.height;
  for (let i = 0; i < BLUR_PASSES; i++) {
    blurAxis(a, b, H, W, W * 4, 4, BLUR_RADIUS);
    blurAxis(b, a, W, H, 4, W * 4, BLUR_RADIUS);
  }
  ctx.putImageData(img, 0, 0);
  return c;
}

// Скользящее среднее вдоль одной оси; края продолжаются крайним пикселем.
function blurAxis(src, dst, lines, len, lineStride, step, r) {
  const d = 2 * r + 1;
  const at = (i) => (i < 0 ? 0 : i >= len ? len - 1 : i) * step;
  for (let l = 0; l < lines; l++) {
    const base = l * lineStride;
    for (let ch = 0; ch < 4; ch++) {
      let sum = 0;
      for (let k = -r; k <= r; k++) sum += src[base + at(k) + ch];
      for (let i = 0; i < len; i++) {
        dst[base + i * step + ch] = sum / d;
        sum += src[base + at(i + r + 1) + ch] - src[base + at(i - r) + ch];
      }
    }
  }
}
