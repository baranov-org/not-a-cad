import type { Page } from "@playwright/test";

export const centerBlock = (page: Page, half = 20, dx = 0, dy = 0) => page.evaluate(({ half, dx, dy }) => {
  const src = document.querySelector("canvas")!;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(Math.floor(c.width / 2) - half + dx, Math.floor(c.height / 2) - half + dy, half * 2, half * 2).data;
  const px: number[][] = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  return px;
}, { half, dx, dy });
export const lum = ([r, g, b]: number[]) => 0.299 * r + 0.587 * g + 0.114 * b;
// Hatch lines crossed by the block's middle row and column (a plain face crosses at most an edge or two)
export const stripes = (px: number[][]) => {
  const n = Math.round(Math.sqrt(px.length));
  const max = Math.max(...px.map(lum));
  const isLine = (p: number[]) => lum(p) < max * 0.8;
  const count = (line: number[][]) => line.filter((p, i) => i > 0 && isLine(p) && !isLine(line[i - 1])).length;
  const row = px.slice(Math.floor(n / 2) * n, Math.floor(n / 2) * n + n);
  const col = Array.from({ length: n }, (_, i) => px[i * n + Math.floor(n / 2)]);
  return Math.min(count(row), count(col));
};


// Centre-block pixels of a PNG (base64), decoded in the page
export const pngCenterBlock = (page: Page, png: string, half = 20) => page.evaluate(async ({ png, half }) => {
  const img = new Image();
  img.src = `data:image/png;base64,${png}`;
  await img.decode();
  const c = document.createElement("canvas");
  c.width = img.width;
  c.height = img.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(img, 0, 0);
  const d = ctx.getImageData(Math.floor(c.width / 2) - half, Math.floor(c.height / 2) - half, half * 2, half * 2).data;
  const px: number[][] = [];
  for (let i = 0; i < d.length; i += 4) px.push([d[i], d[i + 1], d[i + 2]]);
  return px;
}, { png, half });

// Pixels in the exact (unlit) cap colour, as a mask over the canvas
export const capMask = (page: Page, rgb: [number, number, number], tol = 3) => page.evaluate(({ rgb, tol }) => {
  const src = document.querySelector("canvas")!;
  const c = document.createElement("canvas");
  c.width = src.width;
  c.height = src.height;
  const ctx = c.getContext("2d")!;
  ctx.drawImage(src, 0, 0);
  const d = ctx.getImageData(0, 0, c.width, c.height).data;
  const m: number[] = [];
  for (let i = 0; i < d.length; i += 4) {
    if (Math.abs(d[i] - rgb[0]) <= tol && Math.abs(d[i + 1] - rgb[1]) <= tol && Math.abs(d[i + 2] - rgb[2]) <= tol) m.push(i / 4);
  }
  return m;
}, { rgb, tol });
