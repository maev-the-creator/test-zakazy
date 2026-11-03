// Фото для каталога: кадр 4:3 с выбранной точкой фокуса → 480 и 900 px.
// WebP, если браузер умеет его сохранять (Chrome, Firefox, Android); иначе JPEG (Safari).

export const RATIO = 4 / 3;
export const MAX_SOURCE_MB = 15;

export async function loadImage(file) {
  if (!file || !/^image\//.test(file.type || 'image/')) throw new Error('Это не фото. Выберите JPG, PNG, WebP или HEIC.');
  if (file.size > MAX_SOURCE_MB * 1024 * 1024) throw new Error(`Фото больше ${MAX_SOURCE_MB} МБ — выберите поменьше.`);
  try {
    if ('createImageBitmap' in window) return await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch { /* попробуем через <img> */ }
  const url = URL.createObjectURL(file);
  const img = new Image();
  img.src = url;
  try {
    await img.decode();
  } catch {
    throw new Error('Не получилось открыть фото. Попробуйте JPG или PNG.');
  }
  return img;
}

/** Прямоугольник 4:3 внутри исходника с центром в точке фокуса (fx, fy в долях 0..1). */
export function cropBox(w, h, fx = 0.5, fy = 0.5) {
  let cw = w;
  let ch = w / RATIO;
  if (ch > h) { ch = h; cw = h * RATIO; }
  const x = Math.min(Math.max(fx * w - cw / 2, 0), w - cw);
  const y = Math.min(Math.max(fy * h - ch / 2, 0), h - ch);
  return { x, y, w: cw, h: ch };
}

function render(src, box, width) {
  const c = document.createElement('canvas');
  c.width = width;
  c.height = Math.round(width / RATIO);
  const ctx = c.getContext('2d');
  ctx.fillStyle = '#fff';
  ctx.fillRect(0, 0, c.width, c.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(src, box.x, box.y, box.w, box.h, 0, 0, c.width, c.height);
  return c;
}

let webpOk = null;
function supportsWebp() {
  if (webpOk === null) {
    const c = document.createElement('canvas');
    c.width = c.height = 2;
    webpOk = c.toDataURL('image/webp').startsWith('data:image/webp');
  }
  return webpOk;
}

/** → { type, w480, w900 (base64 без префикса), preview (dataURL 900) } */
export function encodeCrop(src, fx, fy) {
  const w = src.width || src.naturalWidth;
  const h = src.height || src.naturalHeight;
  const box = cropBox(w, h, fx, fy);
  const type = supportsWebp() ? 'image/webp' : 'image/jpeg';
  const q = type === 'image/webp' ? 0.8 : 0.82;
  const big = render(src, box, Math.min(900, Math.round(box.w))).toDataURL(type, q);
  const small = render(src, box, Math.min(480, Math.round(box.w))).toDataURL(type, q);
  const strip = (d) => d.slice(d.indexOf(',') + 1);
  return { type, w480: strip(small), w900: strip(big), preview: big };
}
