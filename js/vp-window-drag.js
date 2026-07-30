// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-window-drag.js                                               ║
// ║  Visual Projector — Engine satellite: WINDOW DRAG / RESIZE       ║
// ║  (projector window placement + geometry persistence)             ║
// ║                                                                  ║
// ║  Owns: setupDragAndResize (header drag + corner-handle resize,   ║
// ║        with shell-dock and BUTTON guards, scale-corrected for    ║
// ║        the zoom transform), saveWindowState / loadWindowState    ║
// ║        (VP_DB geometry first, localStorage fallback).            ║
// ║                                                                  ║
// ║  Drag/resize state itself (State.drag / State.resize) stays on   ║
// ║  the shared engine State — the shell and other modules read it.  ║
// ║                                                                  ║
// ║  Extracted from visual-projector.js (v09 refactor) — the block   ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent / "beautify": it must stay diff-verifiable      ║
// ║  against backups/08-extract-vp-dialogs.zip.                      ║
// ║                                                                  ║
// ║  Load order: after visual-projector.js (grouped with the other   ║
// ║  engine satellites). The engine calls these only from init; the  ║
// ║  delegates no-op safely if this file is missing.                 ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP WindowDrag] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE vp-window-drag.js.'
        );
        return;
    }

    const State = VP.state;       // shared engine state (by reference)

    // ── ENGINE FACADE ALIAS (byte-verbatim body below) ──────────────────────
    // Geometry normalization lives in visual-projector.js (exported on the
    // facade); window.VP_DB / localStorage are runtime globals.
    const getNormalizedElementPlacement = (...a) => VP.getNormalizedElementPlacement(...a);


    function setupDragAndResize(vpWindow, opts = {}) {
        const headerSel = opts.headerSel || '#vp-header';
        const handleSel = opts.handleSel || '#vp-resize-handle';
        const storageKey = opts.storageKey || 'vp-state';
        const header = vpWindow.querySelector(headerSel);
        const handle = vpWindow.querySelector(handleSel);

        header.addEventListener('mousedown', e => {
            if (vpWindow.classList.contains('vp-shell-docked')) return;
            if (e.target.tagName === 'BUTTON') return;
            e.preventDefault();
            const { rect, css } = getNormalizedElementPlacement(vpWindow);
            vpWindow.style.left = `${css.left}px`; vpWindow.style.top = `${css.top}px`; vpWindow.style.right = 'auto';
            State.drag = { isDragging: true, offsetX: e.clientX - rect.left, offsetY: e.clientY - rect.top, scaleX: css.scaleX, scaleY: css.scaleY };
            document.body.classList.add('vp-dragging');
        });
        handle.addEventListener('mousedown', e => {
            if (vpWindow.classList.contains('vp-shell-docked')) return;
            e.preventDefault(); e.stopPropagation();
            const { css } = getNormalizedElementPlacement(vpWindow);
            State.resize = { isResizing: true, startX: e.clientX, startY: e.clientY, startWidth: vpWindow.offsetWidth, startHeight: vpWindow.offsetHeight, scaleX: css.scaleX, scaleY: css.scaleY };
            document.body.classList.add('vp-resizing');
        });
        document.addEventListener('mousemove', e => {
            if (State.drag?.isDragging) {
                vpWindow.style.left = `${(e.clientX - State.drag.offsetX) / State.drag.scaleX}px`;
                vpWindow.style.top  = `${(e.clientY - State.drag.offsetY) / State.drag.scaleY}px`;
            }
            if (State.resize?.isResizing) {
                const deltaX = (e.clientX - State.resize.startX) / State.resize.scaleX;
                const deltaY = (e.clientY - State.resize.startY) / State.resize.scaleY;
                vpWindow.style.width  = `${Math.max(400, State.resize.startWidth  + deltaX)}px`;
                vpWindow.style.height = `${Math.max(340, State.resize.startHeight + deltaY)}px`;
            }
        });
        document.addEventListener('mouseup', () => {
            if (State.drag?.isDragging) { State.drag.isDragging = false; document.body.classList.remove('vp-dragging'); saveWindowState(vpWindow, storageKey); }
            if (State.resize?.isResizing) { State.resize.isResizing = false; document.body.classList.remove('vp-resizing'); saveWindowState(vpWindow, storageKey); }
        });
    }

    function saveWindowState(vpWindow, storageKey) {
        const key = storageKey || 'vp-state';
        const { css } = getNormalizedElementPlacement(vpWindow);
        const geom = { left: css.left, top: css.top, width: vpWindow.offsetWidth, height: vpWindow.offsetHeight };
        const db = window.VP_DB;
        if (db?.setWinGeom) db.setWinGeom(geom).catch(() => {});
        else {
            try { localStorage.setItem(key, JSON.stringify(geom)); } catch {}
        }
    }

    function loadWindowState(vpWindow, storageKey) {
        const key = storageKey || 'vp-state';
        const applyGeom = (s) => {
            if (!s) return;
            vpWindow.style.left = `${s.left}px`; vpWindow.style.top = `${s.top}px`;
            vpWindow.style.right = 'auto'; vpWindow.style.width = `${s.width}px`;
            if (s.height) vpWindow.style.height = `${s.height}px`;
        };

        const applyLocalFallback = () => {
            try { applyGeom(JSON.parse(localStorage.getItem(key) || 'null')); } catch {}
        };

        const db = window.VP_DB;
        if (db?.getWinGeom) {
            return db.getWinGeom().then((s) => {
                if (s) applyGeom(s);
                else applyLocalFallback();
            }).catch(() => {
                applyLocalFallback();
            });
        }

        applyLocalFallback();
        return Promise.resolve();
    }

    // ── Public registration (engine delegates consume) ──────────────────────
    window.VP_WINDOW_DRAG = { setupDragAndResize, saveWindowState, loadWindowState };
})();
