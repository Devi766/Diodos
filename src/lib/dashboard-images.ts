// 图片卡片的图片存取：原图经系统文件对话框选取，在前端压缩到长边 1600 后
// 交给后端保存到应用数据目录，按卡片 id 区分。读取结果在内存中缓存。

const MAX_EDGE = 1600;
const QUALITY = 0.86;

const imageCache = new Map<string, string | null>();

const api = () => (typeof window !== 'undefined' ? window.electronAPI : undefined);

export const getCachedDashboardImage = (cardId: string) => imageCache.get(cardId);

const loadImageElement = (src: string) =>
  new Promise<HTMLImageElement>((resolve, reject) => {
    const image = new Image();
    image.onload = () => resolve(image);
    image.onerror = () => reject(new Error('image decode failed'));
    image.src = src;
  });

// 等比缩放到长边不超过 1600，优先 WebP（保留透明），不支持时退回 JPEG
async function compressImage(dataUrl: string) {
  const image = await loadImageElement(dataUrl);
  const ratio = Math.min(1, MAX_EDGE / Math.max(image.naturalWidth, image.naturalHeight));
  const width = Math.max(1, Math.round(image.naturalWidth * ratio));
  const height = Math.max(1, Math.round(image.naturalHeight * ratio));
  const canvas = document.createElement('canvas');
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext('2d');
  if (!ctx) throw new Error('canvas unavailable');
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(image, 0, 0, width, height);

  const webp = canvas.toDataURL('image/webp', QUALITY);
  if (webp.startsWith('data:image/webp')) return { dataUrl: webp, extension: 'webp' };

  // JPEG 没有透明通道，先铺白底
  ctx.globalCompositeOperation = 'destination-over';
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  return { dataUrl: canvas.toDataURL('image/jpeg', QUALITY), extension: 'jpg' };
}

export async function loadDashboardImage(cardId: string): Promise<string | null> {
  const loader = api()?.loadDashboardImage;
  if (!loader) return imageCache.get(cardId) ?? null;
  const result = await loader(cardId);
  if (!result?.success) throw new Error(result?.error || 'load failed');
  const dataUrl = result.dataUrl ?? null;
  imageCache.set(cardId, dataUrl);
  return dataUrl;
}

// 选图并保存；用户取消时返回 undefined
export async function pickDashboardImage(cardId: string): Promise<string | undefined> {
  const bridge = api();
  if (!bridge?.pickDashboardImage || !bridge.saveDashboardImage) {
    throw new Error('dashboard image bridge unavailable');
  }
  const picked = await bridge.pickDashboardImage();
  if (!picked?.success) {
    if (picked?.canceled) return undefined;
    throw new Error(picked?.error || 'pick failed');
  }
  if (!picked.dataUrl) return undefined;
  const compressed = await compressImage(picked.dataUrl);
  const saved = await bridge.saveDashboardImage(cardId, compressed.dataUrl, compressed.extension);
  if (!saved?.success) throw new Error(saved?.error || 'save failed');
  imageCache.set(cardId, compressed.dataUrl);
  return compressed.dataUrl;
}

export async function removeDashboardImage(cardId: string) {
  imageCache.delete(cardId);
  const remover = api()?.removeDashboardImage;
  if (remover) await remover(cardId);
}
