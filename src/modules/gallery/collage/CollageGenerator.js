/**
 * @fileoverview CollageGenerator — Contact sheet / Gallery View generation.
 * Worker-based (OffscreenCanvas) with main-thread fallback.
 */

'use strict';

const COLLAGE_TAG = '__SCENERY_COLLAGE__';
const COLLAGE_LAYOUT_VERSION = 'contact-sheet-v2.1-adaptive-square-quality';
const COLLAGE_FILENAME = 'scenery_collage.jpg';

const _generationState = {
  running: false,
  queued: false,
  promise: null,
  activeSignature: null,
  seq: 0,
};

function _hashString(str) {
  let h = 0x811c9dc5;
  const s = String(str || '');
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return (h >>> 0).toString(36);
}

function _clamp(value, min, max, fallback = min) {
  const n = Number(value);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(min, Math.min(max, n));
}

function _getHeightBudget(config) {
  const maxLongSide = _clamp(config?.maxLongSide, 1024, 4096, 1024);
  return maxLongSide >= 1536 ? 2048 : 1024;
}

function _countAssets(sections) {
  return (sections || []).reduce((sum, sec) => sum + ((sec.assets || []).length), 0);
}

function _choosePreset(totalAssets) {
  if (totalAssets <= 1) return { cols: 1, cellSize: 480 };
  if (totalAssets <= 4) return { cols: 2, cellSize: 340 };
  if (totalAssets <= 9) return { cols: 3, cellSize: 292 };
  if (totalAssets <= 16) return { cols: 4, cellSize: 228 };
  if (totalAssets <= 25) return { cols: 5, cellSize: 184 };
  return { cols: 6, cellSize: 160 };
}

function _metricsForCell(cellSize) {
  return {
    barHeight: Math.round(_clamp(cellSize * 0.15, 24, 44, 24)),
    labelFontSize: Math.round(_clamp(cellSize * 0.072, 11, 20, 11)),
    labelMinFontSize: 7,
    imagePadding: Math.round(_clamp(cellSize * 0.035, 4, 12, 6)),
  };
}

function _selectImageSource(asset, layout) {
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

function _makeStats() { return { preferred: 'mixed', originalCount: 0, thumbCount: 0, fallbackCount: 0, missingCount: 0 }; }
function _updateStats(stats, kind) {
  if (!stats) return;
  if (kind === 'original' || kind === 'blob-original') stats.originalCount++;
  else if (kind === 'thumb') stats.thumbCount++;
  else if (kind.includes('fallback')) stats.fallbackCount++;
  else if (kind === 'missing') stats.missingCount++;
}
function _finalizeStats(stats) {
  if (!stats) return null;
  if (stats.originalCount > 0 && stats.thumbCount === 0 && stats.fallbackCount === 0) stats.preferred = 'original';
  else if (stats.thumbCount > 0 && stats.originalCount === 0 && stats.fallbackCount === 0) stats.preferred = 'thumb';
  else stats.preferred = 'mixed';
  return stats;
}

function _measureLayout(sections, base) {
  const { width, cols, cellSize, gap, margin, headerHeight, sectionSpacing, metrics } = base;
  const gridWidth = cols * cellSize + (cols - 1) * gap;
  const gridX = Math.max(margin, Math.floor((width - gridWidth) / 2));
  let currentY = margin;
  const sectionLayouts = [];
  for (const sec of sections || []) {
    const count = (sec.assets || []).length;
    if (count === 0) continue;
    const rows = Math.ceil(count / cols);
    const gridHeight = rows * cellSize + (rows - 1) * gap;
    sectionLayouts.push({ sec, yHeader: currentY, yGrid: currentY + headerHeight + gap, rows, gridHeight, gridX, gridWidth });
    currentY += headerHeight + gap + gridHeight + sectionSpacing;
  }
  const finalHeight = sectionLayouts.length ? Math.ceil(currentY - sectionSpacing + margin) : 0;
  return { ...base, gridWidth, gridX, sectionLayouts, finalHeight, overflow: finalHeight > base.maxHeight, longLabelCount: 0, totalAssets: _countAssets(sections) };
}

function _calculateLayout(sections, options = {}) {
  const totalAssets = _countAssets(sections);
  const width = _clamp(options.width, 768, 1024, 1024);
  const maxHeight = _clamp(options.maxHeight, 1024, 4096, _getHeightBudget(options.config));
  const margin = 12, gap = totalAssets <= 4 ? 10 : 8, headerHeight = 36, sectionSpacing = 24, minCellSize = 144, maxCols = 6;
  const preset = _choosePreset(totalAssets);
  let cols = Math.min(maxCols, Math.max(1, preset.cols));
  let cellSize = preset.cellSize;
  let layout = null;
  for (let attempt = 0; attempt < 48; attempt++) {
    const maxCellForCols = Math.floor((width - 2 * margin - gap * (cols - 1)) / cols);
    cellSize = Math.max(minCellSize, Math.min(cellSize, maxCellForCols));
    layout = _measureLayout(sections, { version: COLLAGE_LAYOUT_VERSION, width, maxHeight, cols, cellSize, minCellSize, maxCols, gap, margin, headerHeight, sectionSpacing, metrics: _metricsForCell(cellSize) });
    if (!layout.overflow) break;
    if (cols < maxCols) { cols++; cellSize = Math.min(cellSize, Math.floor((width - 2 * margin - gap * (cols - 1)) / cols)); }
    else if (cellSize > minCellSize) cellSize = Math.max(minCellSize, cellSize - 8);
    else break;
  }
  if (layout?.overflow) console.warn('[CollageGenerator] Exceeds height budget', { finalHeight: layout.finalHeight, maxHeight: layout.maxHeight, totalAssets });
  return layout;
}

function _buildSignature(sections, layout) {
  const payload = {
    layout: { version: COLLAGE_LAYOUT_VERSION, width: layout?.width, maxHeight: layout?.maxHeight, cols: layout?.cols, cellSize: layout?.cellSize },
    sections: (sections || []).map(sec => ({ tabId: sec.tabId || null, tabName: sec.tabName || '', assets: (sec.assets || []).map(a => ({ tag: a.tag, filename: a.filename || a.path || a.tag, size: a.blob?.size || 0, mime: a.blob?.type || a.mime || '' })) })),
  };
  return `${COLLAGE_LAYOUT_VERSION}:${_hashString(JSON.stringify(payload))}`;
}

function _collectPlan(state) {
  const markedTabs = (state.tabs || []).filter(t => t.markedForCollage === true);
  if (markedTabs.length === 0 && state.activeTabId && state.activeTabId !== 'effects') {
    const activeTab = (state.tabs || []).find(t => t.id === state.activeTabId);
    if (activeTab) markedTabs.push(activeTab);
  }
  if (markedTabs.length === 0) return { ok: false, reason: 'Нет выбранных вкладок для Gallery View!' };
  const allAssets = Array.from(state.assets.values());
  const sections = []; let totalAssetsCount = 0;
  for (const tab of markedTabs) {
    const tabAssets = allAssets.filter(a => a.tabId === tab.id && a.tag !== '__SCENERY_COLLAGE__');
    if (tabAssets.length > 0) { sections.push({ tabId: tab.id, tabName: tab.name, assets: tabAssets }); totalAssetsCount += tabAssets.length; }
  }
  if (totalAssetsCount === 0) return { ok: false, reason: 'В выбранных вкладках нет ассетов!' };
  const layout = _calculateLayout(sections, { config: { maxLongSide: state.config?.maxLongSide } });
  const signature = _buildSignature(sections, layout);
  return { ok: true, markedTabs, sections, totalAssetsCount, layout, signature };
}

function _isFresh(state, signature) {
  const existing = state.assets.get(COLLAGE_TAG);
  return !!(existing && existing.blob && existing.collageMeta?.signature === signature);
}

function _createMeta(plan, blob) {
  const layout = plan.layout || {};
  return {
    kind: 'contact-sheet', layoutVersion: COLLAGE_LAYOUT_VERSION, signature: plan.signature, generatedAt: Date.now(),
    sectionCount: plan.sections.length, assetsCount: plan.totalAssetsCount, byteSize: blob?.size || 0, mime: blob?.type || 'image/jpeg',
    canvas: { width: layout.width || 1024, height: layout.finalHeight || null, maxHeight: layout.maxHeight || null, overflow: !!layout.overflow },
    grid: { cols: layout.cols || null, cellSize: layout.cellSize || null, barHeight: layout.barHeight || null, labelFontSize: layout.labelFontSize || null, longLabelCount: layout.longLabelCount || 0 },
    imageSources: layout.imageSourceStats || null,
    tabs: plan.sections.map(sec => ({ id: sec.tabId || null, name: sec.tabName || '', count: sec.assets.length, assetTags: sec.assets.map(a => a.tag) })),
  };
}

// ─── Main-thread Canvas Renderer ───
async function _renderOnMainThread(sections, layout) {
  const { width, finalHeight, cols, cellSize, gap, margin, headerHeight, barHeight, labelFontSize, labelMinFontSize, imagePadding, sectionLayouts } = layout;
  const canvas = document.createElement('canvas');
  canvas.width = width; canvas.height = finalHeight;
  const ctx = canvas.getContext('2d');
  ctx.fillStyle = '#050509'; ctx.fillRect(0, 0, width, finalHeight);

  // Preload images
  const loadImage = (src) => new Promise(res => { const img = new Image(); img.crossOrigin = 'anonymous'; img.onload = () => res(img); img.onerror = () => res(null); img.src = src; });
  const loaded = new Map(); const stats = _makeStats();
  const preloads = [];
  for (const sec of sections) for (const asset of sec.assets || []) {
    const { src, createdUrl, sourceKind } = _selectImageSource(asset, layout);
    _updateStats(stats, sourceKind);
    if (src) preloads.push((async () => { const img = await loadImage(src); if (img) loaded.set(asset.tag, img); if (createdUrl) URL.revokeObjectURL(createdUrl); })());
  }
  await Promise.all(preloads);
  layout.imageSourceStats = _finalizeStats(stats);

  const _rectForCover = (img, boxW, boxH) => { const ratio = Math.max(boxW / img.width, boxH / img.height); return { w: img.width * ratio, h: img.height * ratio, dx: (boxW - img.width * ratio) / 2, dy: (boxH - img.height * ratio) / 2 }; };
  const _rectForContain = (img, boxW, boxH) => { const ratio = Math.min(boxW / img.width, boxH / img.height); return { w: img.width * ratio, h: img.height * ratio, dx: (boxW - img.width * ratio) / 2, dy: (boxH - img.height * ratio) / 2 }; };

  function _drawSmart(img, x, y, w, h) {
    const imageH = Math.max(1, h - barHeight);
    ctx.save(); ctx.beginPath(); ctx.rect(x, y, w, imageH); ctx.clip();
    ctx.fillStyle = '#11111b'; ctx.fillRect(x, y, w, imageH);
    if (img) {
      const bg = _rectForCover(img, w, imageH);
      ctx.globalAlpha = 0.28; ctx.drawImage(img, x + bg.dx, y + bg.dy, bg.w, bg.h);
      ctx.globalAlpha = 1; ctx.fillStyle = 'rgba(0,0,0,0.28)'; ctx.fillRect(x, y, w, imageH);
      const pad = imagePadding; const fgBoxW = Math.max(1, w - pad * 2), fgBoxH = Math.max(1, imageH - pad * 2);
      const fg = _rectForContain(img, fgBoxW, fgBoxH);
      const fx = x + pad + fg.dx, fy = y + pad + fg.dy;
      ctx.fillStyle = 'rgba(0,0,0,0.22)'; ctx.fillRect(fx - 2, fy - 2, fg.w + 4, fg.h + 4);
      ctx.drawImage(img, fx, fy, fg.w, fg.h);
    }
    ctx.restore();
  }

  function _drawLabel(label, x, y, w, h) {
    ctx.save(); ctx.fillStyle = 'rgba(0,0,0,0.88)'; ctx.fillRect(x, y, w, h);
    ctx.beginPath(); ctx.rect(x, y, w, h); ctx.clip();
    const maxW = Math.max(1, w - 8); let fs = labelFontSize;
    while (fs > labelMinFontSize) { ctx.font = `bold ${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`; if (ctx.measureText(label).width <= maxW) break; fs--; }
    ctx.font = `bold ${fs}px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace`;
    if (ctx.measureText(label).width > maxW) layout.longLabelCount = (layout.longLabelCount || 0) + 1;
    ctx.fillStyle = '#fff'; ctx.textAlign = 'center'; ctx.textBaseline = 'middle'; ctx.fillText(label, x + w / 2, y + h / 2);
    ctx.restore(); return ctx.measureText(label).width <= maxW;
  }

  for (const sl of sectionLayouts) {
    const { sec, yHeader, yGrid, gridX } = sl;
    ctx.fillStyle = '#111122'; ctx.fillRect(margin, yHeader, width - 2 * margin, headerHeight);
    ctx.fillStyle = '#6c5fa6'; ctx.fillRect(margin, yHeader, 4, headerHeight);
    ctx.strokeStyle = '#383860'; ctx.lineWidth = 1; ctx.strokeRect(margin, yHeader, width - 2 * margin, headerHeight);
    ctx.fillStyle = '#fff'; ctx.font = 'bold 15px sans-serif'; ctx.textAlign = 'left'; ctx.textBaseline = 'middle';
    ctx.fillText(`TAB: ${String(sec.tabName || '').toUpperCase()} (${(sec.assets || []).length} assets)`, margin + 16, yHeader + headerHeight / 2, width - margin * 2 - 26);
    for (let i = 0; i < (sec.assets || []).length; i++) {
      const asset = sec.assets[i]; const col = i % cols, row = Math.floor(i / cols);
      const x = gridX + col * (cellSize + gap), y = yGrid + row * (cellSize + gap);
      ctx.fillStyle = '#1e1e2e'; ctx.fillRect(x, y, cellSize, cellSize);
      const img = loaded.get(asset.tag); _drawSmart(img, x, y, cellSize, cellSize);
      _drawLabel(`[IMG:${asset.tag}]`, x, y + cellSize - barHeight, cellSize, barHeight);
      ctx.strokeStyle = '#383860'; ctx.lineWidth = 1; ctx.strokeRect(x, y, cellSize, cellSize);
    }
  }
  return new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.90));
}

// ─── Worker Renderer ───
const WORKER_TIMEOUT = 60000;
function _canUseWorker(sections, layout) {
  if (!window.Worker || !layout) return false;
  if (typeof OffscreenCanvas === 'undefined' || typeof createImageBitmap !== 'function') return false;
  if (!Array.isArray(sections) || sections.length === 0) return false;
  return sections.every(sec => (sec.assets || []).every(a => a?.blob && typeof a.blob.arrayBuffer === 'function'));
}

function _serializeSections(sections) {
  return (sections || []).map(sec => ({
    tabId: sec.tabId || null, tabName: sec.tabName || '',
    assets: (sec.assets || []).map(a => ({ tag: a.tag, blob: a.blob, mime: a.blob?.type || a.mime || 'image/jpeg' })),
  }));
}

function _serializeLayout(layout) {
  return { version: layout.version, width: layout.width, maxHeight: layout.maxHeight, finalHeight: layout.finalHeight, cols: layout.cols, cellSize: layout.cellSize, minCellSize: layout.minCellSize, maxCols: layout.maxCols, gap: layout.gap, margin: layout.margin, headerHeight: layout.headerHeight, sectionSpacing: layout.sectionSpacing, barHeight: layout.barHeight, labelFontSize: layout.labelFontSize, labelMinFontSize: layout.labelMinFontSize, imagePadding: layout.imagePadding, totalAssets: layout.totalAssets };
}

function _getWorkerUrl() {
  const script = document.querySelector('script[src*="CollageGenerator.js"]');
  if (script?.src) return new URL('CollageGenerator.worker.js', script.src).href;
  return 'src/modules/gallery/collage/CollageGenerator.worker.js';
}

async function _renderInWorker(sections, layout) {
  if (!_canUseWorker(sections, layout)) return null;
  const workerSections = _serializeSections(sections); if (!workerSections) return null;
  const id = `collage_${Date.now().toString(36)}_${Math.random().toString(36).slice(2)}`;
  const workerUrl = _getWorkerUrl();
  return await new Promise((resolve, reject) => {
    let worker = null, settled = false;
    const timer = setTimeout(() => { if (settled) return; settled = true; try { worker?.terminate(); } catch {} reject(new Error('Worker timeout')); }, WORKER_TIMEOUT);
    const cleanup = () => { clearTimeout(timer); try { worker?.terminate(); } catch {} };
    try { worker = new Worker(workerUrl); } catch (err) { cleanup(); reject(err); return; }
    worker.onmessage = (e) => {
      const msg = e.data || {}; if (msg.id !== id) return; if (settled) return; settled = true; cleanup();
      if (!msg.ok || !msg.blob) { reject(new Error(msg.error || 'Worker failed')); return; }
      if (msg.stats) { layout.longLabelCount = msg.stats.longLabelCount || 0; layout.imageSourceStats = { preferred: msg.stats.preferred || 'original', originalCount: msg.stats.originalCount || 0, thumbCount: msg.stats.thumbCount || 0, fallbackCount: msg.stats.fallbackCount || 0, missingCount: msg.stats.missingCount || 0 }; }
      resolve(msg.blob);
    };
    worker.onerror = (e) => { if (settled) return; settled = true; cleanup(); reject(new Error(e.message || 'Worker error')); };
    worker.postMessage({ id, type: 'build-contact-sheet', sections: workerSections, layout: _serializeLayout(layout), quality: 0.90 });
  });
}

// ─── Public API ───
export const CollageGenerator = {
  COLLAGE_TAG,
  COLLAGE_FILENAME,

  /**
   * @param {Object} state - GalleryState
   * @param {Object} options
   * @param {boolean} [options.force]
   * @param {string} [options.reason]
   * @returns {Promise<AssetRecord | null>}
   */
  async generate(state, options = {}) {
    if (!options || typeof options !== 'object' || typeof options.preventDefault === 'function') options = {};
    const force = !!options.force; const reason = options.reason || 'manual';

    const plan = _collectPlan(state);
    console.log('[CollageGenerator] Requested', { reason, force, signature: plan.signature || null });
    if (!plan.ok) { state._ctx?.eventBus?.emit?.('toast', { message: plan.reason, type: 'warning' }); return null; }

    if (_generationState.running) {
      if (plan.signature !== _generationState.activeSignature) { _generationState.queued = true; state._ctx?.eventBus?.emit?.('toast', { message: 'Gallery View уже собирается — новая версия в очереди.', type: 'info' }); }
      else { state._ctx?.eventBus?.emit?.('toast', { message: 'Gallery View уже собирается…', type: 'info' }); }
      return _generationState.promise;
    }

    if (!force && _isFresh(state, plan.signature)) {
      const existing = state.assets.get(COLLAGE_TAG);
      state._ctx?.eventBus?.emit?.('toast', { message: 'Gallery View уже актуален.', type: 'info' });
      return existing;
    }

    const seq = ++_generationState.seq;
    _generationState.running = true; _generationState.queued = false; _generationState.activeSignature = plan.signature;

    const task = (async () => {
      state._ctx?.eventBus?.emit?.('toast', { message: `Собираю Gallery View: ${plan.totalAssetsCount} ассет(ов), ${plan.sections.length} таб(ов)…`, type: 'info' });
      try {
        let blob = await _renderInWorker(plan.sections, plan.layout);
        if (!blob) blob = await _renderOnMainThread(plan.sections, plan.layout);
        if (!blob) { state._ctx?.eventBus?.emit?.('toast', { message: 'Не удалось собрать Gallery View', type: 'error' }); return null; }

        const latest = _collectPlan(state);
        if (!latest.ok || latest.signature !== plan.signature) { _generationState.queued = true; state._ctx?.eventBus?.emit?.('toast', { message: 'Данные изменились — пересоберу.', type: 'info' }); return null; }

        const existing = state.assets.get(COLLAGE_TAG);
        if (existing?.url) URL.revokeObjectURL(existing.url);
        if (existing?.thumbUrl) URL.revokeObjectURL(existing.thumbUrl);

        const url = URL.createObjectURL(blob);
        const thumbUrl = await state._assetPipeline?.generateThumbUrl?.(blob);
        const meta = _createMeta(plan, blob);

        const collageAsset = {
          tag: COLLAGE_TAG, filename: COLLAGE_FILENAME, path: COLLAGE_FILENAME,
          blob, url, thumbUrl, description: existing?.description || 'Automatic scenery assets collage',
          source: 'generated', hidden: false, tabId: null, collageMeta: meta,
        };
        state.assets.set(COLLAGE_TAG, collageAsset);
        state._ctx?.eventBus?.emit?.('toast', { message: `Gallery View обновлён: ${plan.totalAssetsCount} ассет(ов).`, type: 'success' });
        return collageAsset;
      } catch (err) {
        console.error('[CollageGenerator] Failed:', err);
        state._ctx?.eventBus?.emit?.('toast', { message: 'Ошибка при сборке Gallery View', type: 'error' });
        return null;
      } finally {
        if (_generationState.seq === seq) {
          const runQueued = _generationState.queued;
          _generationState.running = false; _generationState.queued = false; _generationState.promise = null; _generationState.activeSignature = null;
          if (runQueued) setTimeout(() => { CollageGenerator.generate(state, { reason: 'queued' }).catch(e => console.warn('[CollageGenerator] queued failed:', e)); }, 0);
        }
      }
    })();
    _generationState.promise = task;
    return task;
  },

  // Expose internals for testing/debug
  _collectPlan,
  _calculateLayout: _calculateLayout,
  _buildSignature,
  _renderOnMainThread,
  _renderInWorker,
};

export { CollageGenerator };