// Деление фрейма линиями. Линия — горизонтальная (h) или вертикальная (v), лежит на pos
// (доля высоты или ширины фрейма) и тянется между двумя опорами a и b: краями фрейма
// или перпендикулярными линиями. Опоры — ссылки, поэтому если линию подвинуть, концы
// опирающихся на неё линий поедут вместе с ней. Ячейки получаются из линий сами.

// Самая узкая ячейка — в долях соответствующей стороны фрейма.
export const MIN_CELL = 0.05;
const EPS = 1e-9;
const EDGES = { h: ['L', 'R'], v: ['T', 'B'] };
const EDGE_POS = { L: 0, T: 0, R: 1, B: 1 };

let nextId = 1;

function newLine(dir, pos) {
  return { id: `l${nextId++}`, dir, pos, a: EDGES[dir][0], b: EDGES[dir][1] };
}

export const cloneLines = (lines) => lines.map((l) => ({ ...l }));

const byId = (lines, id) => lines.find((l) => l.id === id);

function anchorPos(lines, anchor) {
  if (anchor in EDGE_POS) return EDGE_POS[anchor];
  return byId(lines, anchor)?.pos ?? NaN;
}

export function extent(lines, l) {
  return [anchorPos(lines, l.a), anchorPos(lines, l.b)];
}

// Линия m проходит через координату p строго внутри себя (а не кончается на ней).
function covers(lines, m, p) {
  const [s, e] = extent(lines, m);
  return s < p - EPS && e > p + EPS;
}

// Перпендикулярные линии, которые пересекают l насквозь, — по порядку вдоль l.
export function crossings(lines, l) {
  return lines
    .filter((m) => m.dir !== l.dir && covers(lines, m, l.pos) && covers(lines, l, m.pos))
    .sort((m, n) => m.pos - n.pos);
}

// Перпендикулярные линии, которые упираются в l концом.
export function junctions(lines, l) {
  return lines.filter((m) => m.dir !== l.dir && (m.a === l.id || m.b === l.id));
}

// Ячейки: делим фрейм сеткой по всем линиям и склеиваем соседние клетки, между которыми нет линии.
export function computeFaces(lines) {
  const uniq = (vals) => [...new Set(vals)].sort((p, q) => p - q);
  const xs = uniq([0, 1, ...lines.filter((l) => l.dir === 'v').map((l) => l.pos)]);
  const ys = uniq([0, 1, ...lines.filter((l) => l.dir === 'h').map((l) => l.pos)]);
  const nx = xs.length - 1;
  const ny = ys.length - 1;
  const parent = Array.from({ length: nx * ny }, (_, k) => k);
  const find = (k) => (parent[k] === k ? k : (parent[k] = find(parent[k])));
  const union = (p, q) => { parent[find(p)] = find(q); };
  const wall = (dir, pos, s, e) => lines.some((l) => {
    if (l.dir !== dir || Math.abs(l.pos - pos) > EPS) return false;
    const [ls, le] = extent(lines, l);
    return ls <= s + EPS && le >= e - EPS;
  });

  for (let j = 0; j < ny; j++) {
    for (let i = 1; i < nx; i++) {
      if (!wall('v', xs[i], ys[j], ys[j + 1])) union(j * nx + i - 1, j * nx + i);
    }
  }
  for (let i = 0; i < nx; i++) {
    for (let j = 1; j < ny; j++) {
      if (!wall('h', ys[j], xs[i], xs[i + 1])) union((j - 1) * nx + i, j * nx + i);
    }
  }

  const groups = new Map();
  for (let j = 0; j < ny; j++) {
    for (let i = 0; i < nx; i++) {
      const root = find(j * nx + i);
      const g = groups.get(root);
      if (!g) groups.set(root, { x0: xs[i], y0: ys[j], x1: xs[i + 1], y1: ys[j + 1] });
      else Object.assign(g, { x0: Math.min(g.x0, xs[i]), y0: Math.min(g.y0, ys[j]), x1: Math.max(g.x1, xs[i + 1]), y1: Math.max(g.y1, ys[j + 1]) });
    }
  }
  return [...groups.values()].sort((f, g) => f.y0 - g.y0 || f.x0 - g.x0);
}

export const facesOk = (faces) => faces.every((f) => f.x1 - f.x0 >= MIN_CELL - EPS && f.y1 - f.y0 >= MIN_CELL - EPS);

// Часть фрейма, которую делит линия: от ближайших границ соседних с ней ячеек с одной стороны до другой.
export function dividedSpan(lines, faces, l) {
  const [s, e] = extent(lines, l);
  const [lo, hi, from, to] = l.dir === 'h' ? ['y0', 'y1', 'x0', 'x1'] : ['x0', 'x1', 'y0', 'y1'];
  let min = 0, max = 1;
  for (const f of faces) {
    if (Math.min(f[to], e) - Math.max(f[from], s) <= EPS) continue;
    if (Math.abs(f[hi] - l.pos) < EPS) min = Math.max(min, f[lo]);
    if (Math.abs(f[lo] - l.pos) < EPS) max = Math.min(max, f[hi]);
  }
  return [min, max];
}

// Куда можно тянуть линию: не дальше, чем ужмутся до минимума соседние с ней ячейки.
export function dragRange(lines, faces, l) {
  const [min, max] = dividedSpan(lines, faces, l);
  return [min + MIN_CELL, max - MIN_CELL];
}

// Правка с починкой: если у линии пропала опора (опорную линию удалили или обрезали),
// линия продлевается до следующей перпендикулярной линии или до края фрейма.
function mutate(lines, fn) {
  const before = new Map(lines.map((l) => [l.id, extent(lines, l)]));
  const next = cloneLines(lines);
  fn(next);
  for (let pass = 0; pass < 20; pass++) {
    let changed = false;
    for (const l of next) {
      ['a', 'b'].forEach((end, k) => {
        const anchor = l[end];
        if (anchor in EDGE_POS) return;
        const m = byId(next, anchor);
        if (m && m.dir !== l.dir && covers(next, m, l.pos)) return;
        const start = before.get(l.id)?.[k] ?? anchorPos(lines, anchor);
        l[end] = findStop(next, l, start, k === 0 ? -1 : 1);
        changed = true;
      });
    }
    if (!changed) break;
  }
  return next;
}

function findStop(lines, l, from, dir) {
  let best = null;
  for (const m of lines) {
    if (m.dir === l.dir || !covers(lines, m, l.pos)) continue;
    const beyond = dir < 0 ? m.pos < from - EPS : m.pos > from + EPS;
    if (beyond && (!best || (dir < 0 ? m.pos > best.pos : m.pos < best.pos))) best = m;
  }
  return best ? best.id : EDGES[l.dir][dir < 0 ? 0 : 1];
}

export function addLine(lines, dir, pos) {
  const l = newLine(dir, pos);
  return { lines: [...cloneLines(lines), l], id: l.id };
}

export function removeLine(lines, id) {
  return mutate(lines, (ls) => ls.splice(ls.findIndex((l) => l.id === id), 1));
}

// Отрезать у линии плечо за пересечением с crossId: end 'a' — левое/верхнее, 'b' — правое/нижнее.
export function trimLine(lines, id, crossId, end) {
  return mutate(lines, (ls) => { byId(ls, id)[end] = crossId; });
}
