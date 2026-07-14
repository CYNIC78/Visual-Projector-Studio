/**
 * @fileoverview CollageGenerator Worker — OffscreenCanvas contact sheet rendering.
 * Runs in separate thread, communicates via postMessage.
 */

self.onmessage = async (e) => {
  const { id, type, sections, layout, quality } = e.data;
  if (type !== 'build-contact-sheet') return;

  try {
    const blob = await buildContactSheet(sections, layout, quality);
    const stats = computeStats(sections, layout);
    self.postMessage({ id, ok: true, blob, stats });
  } catch (err) {
    self.postMessage({ id, ok: false, error: err.message || String(err) });
  }
};

// ─── Helpers ───
function _metricsForCell(cellSize) {
  return {
    barHeight: Math.round(Math.max(24, Math.min(44, cellSize * 0.15))),
    labelFontSize: Math.round(Math.max(11, Math.min(20, cellSize * 0.072))),
    labelMinFontSize: 7,
    imagePadding: Math.round(Math.max(4, Math.min(12, cellSize * 0.035))),
  };
}

function _rectForCover(img, boxW, boxH) {
  const ratio = Math.max(boxW / img.width, boxH / img.height);
  return { w: img.width * ratio, h: img.height * ratio, dx: (boxW - img.width * ratio) / 2, dy: (boxH - img.height * ratio) / 2 };
}

function _rectForContain(img, boxW, boxH) {
  const ratio = Math.min(boxW / img.width, boxH / img.height);
  return { w: img.width * ratio, h: img.height * ratio, dx: (boxW - img.width * ratio) / 2, dy: (boxH - img.height * ratio) / 2 };
}

function _drawSmartImage(ctx, img, x, y, w, h, metrics) {
  const imageH = Math.max(1, h - metrics.barHeight);
  ctx.save();
  ctx.beginPath(); ctx.rect(x, y, w, imageH); ctx.clip();
  ctx.fillStyle = '#11111b'; ctx.fillRect(x, y, w, imageH);
  if (img) {
    const bg = _rectForCover(img, w, imageH);
    ctx.globalAlpha = 0.28; ctx.drawImage(img, x + bg.dx, y + bg.dy, bg.w, bg.h);
    ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(x, y, w, imageH);
    const pad = metrics.imagePadding;
    const fgBoxW = Math.max(1, w - pad * 2), fgBoxH = Math.max(1, imageH - pad * 2);
    const fg = _rectForContain(img, fgBoxW, fgBoxH);
    const fx = x + pad + fg.dx, fy = y + pad + fg.dy;
    ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(fx - 2, fy - 2, fg.w + 4, fg.h + 4);
    ctx.drawImage(img, fx, fy, fg.w, fg.h);
  }
  ctx.restore();
}

function _drawFittedLabel(ctx, label, x, y, w, h, metrics, layout) {
  ctx.save();
  ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(x, y, w, h);
  ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
  const maxTextWidth = Math.max(1, w - 8);
  let fontSize = metrics.labelFontSize;
  while (fontSize > metrics.labelMinFontSize) {
    ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    if (ctx.measureText(label).width <= maxTextWidth) break;
    fontSize--;
  }
  ctx.font = `bold ${fontSize}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
  const fits = ctx.measureText(label).width <= maxTextWidth;
  if (!fits) layout.longLabelCount = (layout.longLabelCount || 0) + 1;
  ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle';
  ctx.fillText(label, x + w / 2, y + h / 2);
  ctx.restore();
  return fits;
}

async function buildContactSheet(sections, layout, quality = 0.90) {
  const { width, finalHeight, cols, cellSize, gap, margin, headerHeight, barHeight, labelFontSize, labelMinFontSize, imagePadding, sectionLayouts } = layout;
  const metrics = _metricsForCell(cellSize);
  const canvas = new OffscreenCanvas(width, finalHeight);
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050509'; ctx.fillRect(0, 0, width, finalHeight);

  // Preload all images
  const loadedImages = new Map();
  const stats = { preferred: 'mixed', originalCount: 0, thumbCount: 0, fallbackCount: 0, missingCount: 0 };
  const preloadPromises = [];

  for (const sec of sections) {
    for (const asset of sec.assets || []) {
      const { src, createdUrl, sourceKind } = selectImageSource(asset, layout);
      updateStats(stats, sourceKind);
      if (src) {
        preloadPromises.push((async () => {
          const res = await fetch(src);
          const blob = await res.blob();
          const bitmap = await createImageBitmap(blob);
          loadedImages.set(asset.tag, bitmap);
          if (createdUrl) URL.revokeObjectURL(createdUrl);
        })());
      }
    }
  }
  await Promise.all(preloadPromises);
  layout.imageSourceStats = finalizeStats(stats);

  // Draw sections
  for (const sl of sectionLayouts) {
    const { sec, yHeader, yGrid, gridX } = sl;
    // Header
    ctx.fillStyle = '#111122'; ctx.fillRect(margin, yHeader, layout.width - 2 * margin, layout.headerHeight);
    ctx.fillStyle = '#6c5fa6'; ctx.fillRect(margin, yHeader, 4, layout.headerHeight);
    ctx.strokeStyle = '#383860'; ctx.lineWidth = 1; ctx.strokeRect(margin, yHeader, layout.width - 2 * margin, layout.headerHeight);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`TAB: ${String(sec.tabName || '').toUpperCase()} (${(sec.assets || []).length} assets)`, margin + 16, yHeader + layout.headerHeight / 2, layout.width - margin * 2 - 26);

    // Assets grid
    for (let i = 0; i < (sec.assets || []).length; i++) {
      const asset = sec.assets[i];
      const col = i % layout.cols;
      const row = Math.floor(i / layout.cols);
      const x = gridX + col * (layout.cellSize + layout.gap);
      const y = yGrid + row * (layout.cellSize + layout.gap);

      ctx.fillStyle = '#1e1e2e'; ctx.fillRect(x, y, layout.cellSize, layout.cellSize);
      const img = loadedImages.get(asset.tag);
      _drawSmartImage(ctx, img, x, y, layout.cellSize, layout.cellSize, metrics);
      _drawFittedLabel(ctx, `[IMG:${asset.tag}]`, x, y + layout.cellSize - metrics.barHeight, layout.cellSize, metrics.barHeight, metrics, layout);
      ctx.strokeStyle = '#383860'; ctx.lineWidth = 1; ctx.strokeRect(x, y, layout.cellSize, layout.cellSize);
    }
  }

  const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
  return blob;
}

function selectImageSource(asset, layout) {
  if (!asset) return { src: null, createdUrl: null, sourceKind: 'missing' };
  const preferOriginal = (layout?.cellSize || 0) >= 184;
  const originalUrl = asset.url || asset.base64 || null;
  const thumbUrl = asset.thumbUrl || null;
  if (preferOriginal) {
    if (originalUrl) return { src: originalUrl, createdUrl: null, sourceKind: 'original' };
    if (asset.blob) { const src = URL.createObjectURL(asset.blob); return { src, createdUrl: src, sourceKind: 'blob-original' }; }
    if (thumbUrl) return { src: thumbUrl, createdUrl: null, sourceKind: 'thumb-fallback' };
  } else {
    if (thumbUrl) return { src: thumbUrl, createdUrl: null, sourceKind: 'thumb' };
    if (originalUrl) return { src: originalUrl, createdUrl: null, sourceKind: 'original-fallback' };
    if (asset.blob) { const src = URL.createObjectURL(asset.blob); return { src, createdUrl: src, sourceKind: 'blob-original-fallback' }; }
  }
  return { src: null, createdUrl: null, sourceKind: 'missing' };
}

function updateStats(stats, kind) {
  if (kind === 'original' || kind === 'blob-original') stats.originalCount++;
  else if (kind === 'thumb') stats.thumbCount++;
  else if (kind.includes('fallback')) stats.fallbackCount++;
  else if (kind === 'missing') stats.missingCount++;
}

function finalizeStats(stats) {
  if (stats.originalCount > 0 && stats.thumbCount === 0 && stats.fallbackCount === 0) stats.preferred = 'original';
  else if (stats.thumbCount > 0 && stats.originalCount === 0 && stats.fallbackCount === 0) stats.preferred = 'thumb';
  else stats.preferred = 'mixed';
  return stats;
}

function computeStats(sections, layout) {
  const stats = { originalCount: 0, thumbCount: 0, fallbackCount: 0, missingCount: 0, longLabelCount: layout.longLabelCount || 0 };
  for (const sec of sections) {
    for (const asset of sec.assets || []) {
      const { sourceKind } = selectImageSource(asset, layout);
      if (sourceKind === 'original' || sourceKind === 'blob-original') stats.originalCount++;
      else if (sourceKind === 'thumb') stats.thumbCount++;
      else if (sourceKind.includes('fallback')) stats.fallbackCount++;
      else if (sourceKind === 'missing') stats.missingCount++;
    }
  }
  return { preferred: stats.originalCount > 0 && stats.thumbCount === 0 && stats.fallbackCount === 0 ? 'original' : stats.thumbCount > 0 && stats.originalCount === 0 && stats.fallbackCount === 0 ? 'thumb' : 'mixed', ...stats };
}