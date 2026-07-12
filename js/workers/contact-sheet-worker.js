// Visual Projector — Contact Sheet Worker
// Builds collage/contact-sheet images off the main UI thread when supported.
// Receives: { id, type:'build-contact-sheet', sections, layout, quality }
// Sends:    { id, ok:true, blob, stats } or { id, ok:false, error }

(function () {
    'use strict';

    function makeStats() {
        return {
            preferred: 'original',
            originalCount: 0,
            thumbCount: 0,
            fallbackCount: 0,
            missingCount: 0,
        };
    }

    function rectForCover(img, boxW, boxH) {
        const ratio = Math.max(boxW / img.width, boxH / img.height);
        const w = img.width * ratio;
        const h = img.height * ratio;
        return { w, h, dx: (boxW - w) / 2, dy: (boxH - h) / 2 };
    }

    function rectForContain(img, boxW, boxH) {
        const ratio = Math.min(boxW / img.width, boxH / img.height);
        const w = img.width * ratio;
        const h = img.height * ratio;
        return { w, h, dx: (boxW - w) / 2, dy: (boxH - h) / 2 };
    }

    function buildSectionLayouts(sections, layout) {
        const cols = layout.cols;
        const cellSize = layout.cellSize;
        const gap = layout.gap;
        const margin = layout.margin;
        const headerHeight = layout.headerHeight;
        const sectionSpacing = layout.sectionSpacing;
        const width = layout.width;
        const gridWidth = cols * cellSize + (cols - 1) * gap;
        const gridX = Math.max(margin, Math.floor((width - gridWidth) / 2));

        let currentY = margin;
        const out = [];
        for (const sec of sections || []) {
            const count = (sec.assets || []).length;
            if (count === 0) continue;
            const rows = Math.ceil(count / cols);
            const gridHeight = rows * cellSize + (rows - 1) * gap;
            out.push({ sec, yHeader: currentY, yGrid: currentY + headerHeight + gap, rows, gridHeight, gridX, gridWidth });
            currentY += headerHeight + gap + gridHeight + sectionSpacing;
        }
        return out;
    }

    async function decodeAsset(asset, stats) {
        if (!asset || !asset.blob) {
            stats.missingCount++;
            return null;
        }
        try {
            const bitmap = await createImageBitmap(asset.blob);
            stats.originalCount++;
            return bitmap;
        } catch (err) {
            stats.missingCount++;
            return null;
        }
    }

    async function buildContactSheet(payload) {
        if (typeof OffscreenCanvas === 'undefined') throw new Error('OffscreenCanvas is not available in worker');
        if (typeof createImageBitmap !== 'function') throw new Error('createImageBitmap is not available in worker');

        const sections = payload.sections || [];
        const layout = payload.layout || {};
        const width = layout.width || 1024;
        const finalHeight = layout.finalHeight || 1024;
        const cols = layout.cols || 6;
        const cellSize = layout.cellSize || 160;
        const gap = layout.gap ?? 8;
        const margin = layout.margin ?? 12;
        const headerHeight = layout.headerHeight ?? 36;
        const barHeight = layout.barHeight ?? 24;
        const labelFontSize = layout.labelFontSize ?? 11;
        const labelMinFontSize = layout.labelMinFontSize ?? 7;
        const imagePadding = layout.imagePadding ?? 6;
        const quality = Number.isFinite(payload.quality) ? payload.quality : 0.90;

        const canvas = new OffscreenCanvas(width, finalHeight);
        const ctx = canvas.getContext('2d');
        if (!ctx) throw new Error('2D canvas context is unavailable in worker');

        ctx.fillStyle = '#050509';
        ctx.fillRect(0, 0, width, finalHeight);

        const stats = makeStats();
        const bitmaps = new Map();
        const decodeJobs = [];
        for (const sec of sections) {
            for (const asset of sec.assets || []) {
                decodeJobs.push((async () => {
                    const bitmap = await decodeAsset(asset, stats);
                    if (bitmap) bitmaps.set(asset.tag, bitmap);
                })());
            }
        }
        await Promise.all(decodeJobs);

        let longLabelCount = 0;

        function drawSmartImage(img, x, y, w, h) {
            const imageH = Math.max(1, h - barHeight);
            ctx.save();
            ctx.beginPath();
            ctx.rect(x, y, w, imageH);
            ctx.clip();

            ctx.fillStyle = '#11111b';
            ctx.fillRect(x, y, w, imageH);

            if (img) {
                const bg = rectForCover(img, w, imageH);
                ctx.globalAlpha = 0.28;
                ctx.drawImage(img, x + bg.dx, y + bg.dy, bg.w, bg.h);
                ctx.globalAlpha = 1;
                ctx.fillStyle = 'rgba(0,0,0,0.28)';
                ctx.fillRect(x, y, w, imageH);

                const pad = imagePadding;
                const fgBoxW = Math.max(1, w - pad * 2);
                const fgBoxH = Math.max(1, imageH - pad * 2);
                const fg = rectForContain(img, fgBoxW, fgBoxH);
                const fx = x + pad + fg.dx;
                const fy = y + pad + fg.dy;

                ctx.fillStyle = 'rgba(0,0,0,0.22)';
                ctx.fillRect(fx - 2, fy - 2, fg.w + 4, fg.h + 4);
                ctx.drawImage(img, fx, fy, fg.w, fg.h);
            }

            ctx.restore();
        }

        function drawFittedLabel(label, x, y, w, h) {
            ctx.save();
            ctx.fillStyle = 'rgba(0, 0, 0, 0.88)';
            ctx.fillRect(x, y, w, h);
            ctx.beginPath();
            ctx.rect(x, y, w, h);
            ctx.clip();

            const maxTextWidth = Math.max(1, w - 8);
            let fontSize = labelFontSize;
            while (fontSize > labelMinFontSize) {
                ctx.font = `bold ${fontSize}px monospace`;
                if (ctx.measureText(label).width <= maxTextWidth) break;
                fontSize -= 1;
            }
            ctx.font = `bold ${fontSize}px monospace`;
            if (ctx.measureText(label).width > maxTextWidth) longLabelCount++;

            ctx.fillStyle = '#ffffff';
            ctx.textAlign = 'center';
            ctx.textBaseline = 'middle';
            ctx.fillText(label, x + w / 2, y + h / 2);
            ctx.restore();
        }

        const sectionLayouts = buildSectionLayouts(sections, layout);
        for (const sectionLayout of sectionLayouts) {
            const { sec, yHeader, yGrid, gridX } = sectionLayout;

            ctx.fillStyle = '#111122';
            ctx.fillRect(margin, yHeader, width - 2 * margin, headerHeight);
            ctx.fillStyle = '#6c5fa6';
            ctx.fillRect(margin, yHeader, 4, headerHeight);
            ctx.strokeStyle = '#383860';
            ctx.lineWidth = 1;
            ctx.strokeRect(margin, yHeader, width - 2 * margin, headerHeight);

            ctx.fillStyle = '#ffffff';
            ctx.font = 'bold 15px sans-serif';
            ctx.textAlign = 'left';
            ctx.textBaseline = 'middle';
            const headerText = `TAB: ${String(sec.tabName || '').toUpperCase()} (${(sec.assets || []).length} assets)`;
            ctx.fillText(headerText, margin + 16, yHeader + headerHeight / 2, width - margin * 2 - 26);

            for (let i = 0; i < (sec.assets || []).length; i++) {
                const asset = sec.assets[i];
                const col = i % cols;
                const row = Math.floor(i / cols);
                const x = gridX + col * (cellSize + gap);
                const y = yGrid + row * (cellSize + gap);

                ctx.fillStyle = '#1e1e2e';
                ctx.fillRect(x, y, cellSize, cellSize);
                drawSmartImage(bitmaps.get(asset.tag), x, y, cellSize, cellSize);
                drawFittedLabel(`[IMG:${asset.tag}]`, x, y + cellSize - barHeight, cellSize, barHeight);

                ctx.strokeStyle = '#383860';
                ctx.lineWidth = 1;
                ctx.strokeRect(x, y, cellSize, cellSize);
            }
        }

        for (const bitmap of bitmaps.values()) {
            try { bitmap.close?.(); } catch {}
        }

        stats.preferred = stats.originalCount > 0 && stats.missingCount === 0 ? 'original' : 'mixed';
        stats.longLabelCount = longLabelCount;

        const blob = await canvas.convertToBlob({ type: 'image/jpeg', quality });
        return { blob, stats };
    }

    self.onmessage = async (event) => {
        const data = event.data || {};
        if (data.type !== 'build-contact-sheet') return;
        try {
            const result = await buildContactSheet(data);
            self.postMessage({ id: data.id, ok: true, blob: result.blob, stats: result.stats });
        } catch (err) {
            self.postMessage({ id: data.id, ok: false, error: err?.message || String(err) });
        }
    };
})();
