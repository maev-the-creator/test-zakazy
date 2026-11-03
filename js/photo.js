// Сжатие фото-референса в браузере: до 1600px по длинной стороне, JPEG 0.8.

export const MAX_SIDE = 1600;
export const QUALITY = 0.8;

async function decode(file) {
  if ('createImageBitmap' in window) {
    try {
      return await createImageBitmap(file, { imageOrientation: 'from-image' });
    } catch {
      /* попробуем через <img> */
    }
  }
  const url = URL.createObjectURL(file);
  try {
    const img = new Image();
    img.decoding = 'async';
    img.src = url;
    await img.decode();
    return img;
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
}

/**
 * Возвращает { data (base64 без префикса), type, dataUrl, bytes, width, height }.
 * Бросает Error с понятным текстом.
 */
export async function compressPhoto(file, { maxMb = 5 } = {}) {
  if (!file) throw new Error('Файл не выбран');
  if (file.type && !/^image\//.test(file.type)) throw new Error('Это не похоже на фото. Выберите JPG, PNG или WebP.');
  if (file.size > maxMb * 1024 * 1024) throw new Error(`Фото больше ${maxMb} МБ. Выберите поменьше или сделайте скриншот.`);
  let src;
  try {
    src = await decode(file);
  } catch {
    throw new Error('Не получилось открыть фото. Попробуйте JPG или PNG.');
  }
  const w0 = src.width || src.naturalWidth;
  const h0 = src.height || src.naturalHeight;
  const scale = Math.min(1, MAX_SIDE / Math.max(w0, h0));
  const w = Math.max(1, Math.round(w0 * scale));
  const h = Math.max(1, Math.round(h0 * scale));
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#fff'; // прозрачный PNG → белый фон в JPEG
  ctx.fillRect(0, 0, w, h);
  ctx.drawImage(src, 0, 0, w, h);
  if (src.close) src.close();
  const dataUrl = canvas.toDataURL('image/jpeg', QUALITY);
  const data = dataUrl.slice(dataUrl.indexOf(',') + 1);
  return { data, type: 'image/jpeg', dataUrl, bytes: Math.round((data.length * 3) / 4), width: w, height: h };
}

export function formatBytes(n) {
  if (n < 1024 * 1024) return `${Math.max(1, Math.round(n / 1024))} КБ`;
  return `${(n / 1024 / 1024).toFixed(1).replace('.', ',')} МБ`;
}
