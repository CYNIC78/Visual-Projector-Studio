// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-focus.js                                              ║
// ║  Visual Projector — Engine satellite: FOCUS MODE                 ║
// ║  (camera viewport · depth layer · focal lock · focus controls)   ║
// ║                                                                  ║
// ║  Owns: the focus/camera viewport state machine (pan/zoom/glide), ║
// ║        the WebGL depth-parallax layer (via projector-depth-      ║
// ║        renderer.js), click-to-focal-lock depth targeting, and    ║
// ║        the on-screen focus controls (drag, arrows, glide loop).  ║
// ║                                                                  ║
// ║  Extracted from visual-projector.js (v05 refactor) — body is     ║
// ║  byte-identical; engine helpers arrive via VP facade aliases.    ║
// ║                                                                  ║
// ║  Load order: visual-projector.js → projector-focus.js            ║
// ║  (the VP facade is assembled at the end of visual-projector.js;  ║
// ║   this module captures it and registers window.VP_FOCUS. The     ║
// ║   engine keeps name-preserving delegates, so VP.* focus API and  ║
// ║   every internal call-site behave exactly as before.)            ║
// ║                                                                  ║
// ║  FOCUS AS THE DEFAULT MODE (implemented in v10):                 ║
// ║  set config flag `focusModeDefault: true` and the engine calls   ║
// ║    VP.setProjectorViewport({ enabled: true }, 'boot-default')    ║
// ║  at the end of init (applyFocusModeBootDefault in the engine).   ║
// ║  Enabled-but-NOT-dirty: camera starts at the wide default view.  ║
// ║  All further behavior lives here — no extra wiring needed.       ║
// ║                                                                  ║
// ║  v14 TECH PASS (HUD honesty after own shader audit):             ║
// ║  · vignette REMOVED everywhere (owner call: flat screen          ║
// ║    effects belong to the FX engine; the renderer keeps its       ║
// ║    u_vignette uniform dormant — unfed, i.e. free).               ║
// ║  · pivot slider REMOVED from the HUD: on the WebGL2 shader       ║
// ║    pivot only feeds DoF, which is never enabled (dofStrength     ║
// ║    stays 0) — the control was a mock. The pivot VALUE stays      ║
// ║    in state/persist: it is live in the WebGL1 fallback shader    ║
// ║    and is the semantic "gaze depth" of focal-lock clicks.        ║
// ║  · FOV slider kept and made honest: renderer strength clamp      ║
// ║    raised 0.1→0.2 (projector-depth-renderer.js v3.2, plain JS    ║
// ║    line, no GLSL touched) so the slider stops saturating         ║
// ║    mid-travel.                                                   ║
// ║  · dead nearThreshold render option + dead ternary removed;      ║
// ║    ensureAssetFocusViewport() helper replaces the 6 inline       ║
// ║    copies of the focusViewport bootstrap block.                  ║
// ║                                                                  ║
// ║  v15 GAZE ATTENTION LAYER (creative, additive):                  ║
// ║  the camera becomes a *computable* attention channel — gaze      ║
// ║  state (x/y/zoom/region/depth), a dwell accumulator ("keeps      ║
// ║  staring at R") and a 50-point gaze trail, all read-only for     ║
// ║  FSM/games (VP_FOCUS.getGazeState/getGazeDwell/getGazeTrail      ║
// ║  and hub events projector:gaze-changed / projector:gaze-lock).   ║
// ║  Points pin on glide-settle and focal-lock. Renders NOTHING.     ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP Focus] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE projector-focus.js.'
        );
        return;
    }

    const State = VP.state;       // shared engine state (by reference)

    // ── ENGINE FACADE ALIASES (byte-verbatim body below) ────────────────────
    // These three live in visual-projector.js (image-capture + UI layers) and
    // are exported on the facade; all other dependencies of this module are
    // runtime globals (State, window.VP_HUB, window.VPDepthRenderer, Neutralino).
    const captureFocusViewportDataUrl = (...a) => VP.captureFocusViewportDataUrl(...a);
    const showToast = (...a) => VP.showToast?.(...a);
    const updatePlayerBar = (...a) => VP.updatePlayerBar?.(...a);

    // ════════════════════════════════════════════════════════════════
    //  FOCUS MODE / VIEWPORT ATTENTION  (4:3 visual focus foundation)
    // ════════════════════════════════════════════════════════════════

    function clamp01(value, fallback = 0) {
        const n = Number(value);
        if (!Number.isFinite(n)) return fallback;
        return Math.max(0, Math.min(1, n));
    }

    function getDefaultProjectorViewport() {
        return { x: 0.5, y: 0 };
    }

    // ── v14 helper: one home for the focusViewport bootstrap block that ─────
    // used to be copy-pasted inline 6 times across this module (3 HUD sliders
    // + focal lock) and director-bus.js (FOCUS handler pivot/strength arms).
    function ensureAssetFocusViewport(asset) {
        if (!asset) return null;
        if (!asset.focusViewport) {
            asset.focusViewport = {
                x: State.projectorViewport?.x ?? 0.5,
                y: State.projectorViewport?.y ?? 0,
                zoom: State.projectorViewport?.zoom ?? 1,
            };
        }
        return asset.focusViewport;
    }

    // ════════════════════════════════════════════════════════════════
    //  GAZE ATTENTION LAYER (v15 creative; additive, zero risk to MVP)
    //  Turns the camera into a *computable* attention channel:
    //  · gaze state on the viewport (x/y/zoom/depth/anchor + settle flag)
    //  · a small dwell accumulator ("user keeps staring at region R")
    //  · a ring trail of recent gaze points for FSM/gameplay queries
    //  Nothing here changes rendering; it only *describes* attention.
    // ════════════════════════════════════════════════════════════════

    const GAZE_TRAIL_LIMIT = 50;

    // Name of the 3×3 screen region ("center", "top-left", ...) for a gaze
    // point; zoom is reported separately. Cheap, model-legible, FSM-friendly.
    function getGazeRegionName(x = 0.5, y = 0) {
        const col = x <= 1 / 3 ? 'left' : (x >= 2 / 3 ? 'right' : 'center');
        const row = y <= 1 / 3 ? 'top' : (y >= 2 / 3 ? 'bottom' : 'middle');
        if (col === 'center' && row === 'middle') return 'center';
        if (col === 'center') return row;
        if (row === 'middle') return col;
        return `${row}-${col}`;
    }

    // Dwell accumulator lives on State (survives delegate round-trips,
    // readable by games/FSM without importing this module).
    function _ensureGazeAttention() {
        if (!State.gazeAttention || typeof State.gazeAttention !== 'object') {
            State.gazeAttention = { region: null, since: 0, dwellMs: 0, lastReason: null };
        }
        return State.gazeAttention;
    }

    function getGazeState() {
        const vp = getProjectorViewportState();
        return {
            enabled: vp.enabled,
            x: vp.x, y: vp.y, zoom: vp.zoom,
            region: getGazeRegionName(vp.x, vp.y),
            depth: State.current?.focusViewport?.pivot ?? State.projectorDepth?.pivot ?? 1.0,
            anchor: State.projectorViewport?.gaze?.anchor ?? null,
            settled: !(State.ui.screen?.classList?.contains('vp-focus-dragging')),
            tag: vp.currentTag,
            at: State.projectorViewport?.gaze?.at ?? vp.updatedAt ?? null,
        };
    }

    function getGazeDwell() {
        const a = _ensureGazeAttention();
        // Live value: past dwell + the on-going stretch in the same region.
        if (a.since && a.region) return a.dwellMs + (Date.now() - a.since);
        return a.dwellMs || 0;
    }

    function getGazeTrail(limit = GAZE_TRAIL_LIMIT) {
        const trail = Array.isArray(State.gazeTrail) ? State.gazeTrail : [];
        return trail.slice(-Math.max(1, limit)).map(p => ({ ...p }));
    }

    function clearGazeTrail() {
        State.gazeTrail = [];
        const a = _ensureGazeAttention();
        a.region = null; a.since = 0; a.dwellMs = 0; a.lastReason = null;
    }

    // Single funnel: called on glide-settle, explicit user pans/zooms and on
    // focal lock. Writes the label + trail + dwell bookkeeping, then emits
    // `projector:gaze-changed` (and a special `projector:gaze-lock` on lock).
    function recordGazePoint(vpState, { reason = 'gaze', locked = false } = {}) {
        if (!vpState || vpState.enabled !== true) return getGazeState();
        const now = Date.now();
        const region = getGazeRegionName(vpState.x, vpState.y);
        const prev = _ensureGazeAttention();

        // dwell bookkeeping: same region keeps accumulating, region switch resets
        if (prev.region === region && prev.since) {
            prev.dwellMs += now - prev.since;
            prev.since = now;
        } else {
            const prevRegion = prev.region; void prevRegion;
            prev.region = region;
            prev.since = now;
            prev.dwellMs = 0;
        }
        prev.lastReason = reason;
        try { updateGazeChip(); } catch { /* HUD readout is cosmetic */ }

        const point = {
            x: vpState.x, y: vpState.y, zoom: vpState.zoom,
            region, reason,
            anchor: State.projectorViewport?.gaze?.anchor ?? null,
            depth: State.current?.focusViewport?.pivot ?? State.projectorDepth?.pivot ?? 1.0,
            tag: vpState.currentTag ?? State.current?.tag ?? null,
            at: now,
        };
        if (!Array.isArray(State.gazeTrail)) State.gazeTrail = [];
        State.gazeTrail.push(point);
        if (State.gazeTrail.length > GAZE_TRAIL_LIMIT) State.gazeTrail.splice(0, State.gazeTrail.length - GAZE_TRAIL_LIMIT);

        State.projectorViewport = { ...(State.projectorViewport || {}), gaze: { x: point.x, y: point.y, zoom: point.zoom, depth: point.depth, anchor: point.anchor, at: now } };

        try {
            window.VP_HUB?.emit?.(locked ? 'projector:gaze-lock' : 'projector:gaze-changed', { gaze: getGazeState(), reason }, { moduleId: 'projector' });
        } catch (err) {
            console.warn('[VP Focus] hub emit gaze event failed:', err);
        }
        return getGazeState();
    }

    function isDefaultProjectorViewport(x, y, zoom = 1) {
        const d = getDefaultProjectorViewport();
        const xAtDefault = Math.abs(clamp01(x, d.x) - d.x) < 0.001;
        const yAtDefault = Math.abs(clamp01(y, d.y) - d.y) < 0.001;
        const zoomAtDefault = Math.abs((Number(zoom) || 1) - 1) < 0.001;
        if (!zoomAtDefault) return false;

        // At 1x only the overflowing axis carries gaze meaning. Ignore the
        // locked perpendicular axis for dirty/default purposes, but still keep
        // it visually snapped by the drag engine. With zoom enabled both axes
        // become meaningful and the full check above applies.
        const axis = getCurrentImageOverflowAxis();
        if (axis === 'y') return yAtDefault;
        if (axis === 'x') return xAtDefault;
        if (axis === 'none') return true;
        return xAtDefault && yAtDefault;
    }

    function getProjectorViewportState() {
        const vp = State.projectorViewport || {};
        return {
            enabled: !!vp.enabled,
            aspect: vp.aspect || '4:3',
            x: clamp01(vp.x, 0.5),
            y: clamp01(vp.y, 0),
            step: Math.max(0.05, Math.min(1, Number(vp.step) || 0.5)),
            zoom: Math.max(1, Math.min(Math.max(1.01, Number(vp.focusZoom) || 1.5), Number(vp.zoom) || 1)),
            focusZoom: Math.max(1.3, Math.min(1.7, Number(vp.focusZoom) || 1.5)),
            zoomStep: Math.max(0.03, Math.min(0.25, Number(vp.zoomStep) || 0.10)),
            dirty: !!vp.dirty,
            touchedAt: vp.touchedAt || null,
            updatedAt: vp.updatedAt || null,
            currentTag: State.current?.tag || null,
        };
    }

    function emitProjectorViewportChanged(reason = 'viewport-changed') {
        const viewport = getProjectorViewportState();
        try {
            window.VP_HUB?.emit?.('projector:viewport-changed', { viewport, reason }, { moduleId: 'projector' });
        } catch (err) {
            console.warn('[VP Projector] hub emit projector:viewport-changed failed:', err);
        }
    }

    function setProjectorViewport(patch = {}, reason = 'set-viewport') {
        const current = getProjectorViewportState();
        const nextX = patch.x != null ? clamp01(patch.x, current.x) : current.x;
        const nextY = patch.y != null ? clamp01(patch.y, current.y) : current.y;
        const nextFocusZoom = patch.focusZoom != null ? Math.max(1.3, Math.min(1.7, Number(patch.focusZoom) || current.focusZoom || 1.5)) : current.focusZoom;
        const nextZoom = patch.zoom != null ? Math.max(1, Math.min(nextFocusZoom, Number(patch.zoom) || current.zoom || 1)) : Math.max(1, Math.min(nextFocusZoom, current.zoom || 1));
        const nextEnabled = patch.enabled != null ? !!patch.enabled : current.enabled;
        const touched = patch.touched === true || patch.dirty === true;
        const atDefault = isDefaultProjectorViewport(nextX, nextY, nextZoom);
        const nextDirty = nextEnabled && (patch.dirty != null ? !!patch.dirty : (touched || current.dirty || nextZoom > 1.001) && !atDefault);
        const next = {
            enabled: nextEnabled,
            aspect: patch.aspect || current.aspect || '4:3',
            x: nextX,
            y: nextY,
            step: patch.step != null ? Math.max(0.05, Math.min(1, Number(patch.step) || current.step)) : current.step,
            zoom: nextEnabled ? nextZoom : 1,
            focusZoom: nextFocusZoom,
            zoomStep: patch.zoomStep != null ? Math.max(0.03, Math.min(0.25, Number(patch.zoomStep) || current.zoomStep)) : current.zoomStep,
            dirty: nextDirty,
            touchedAt: nextDirty ? Date.now() : null,
            updatedAt: Date.now(),
        };
        State.projectorViewport = next;

        // Auto-save user's viewport settings to the current asset's metadata
        if (State.current && nextEnabled) {
            const isDefault = isDefaultProjectorViewport(next.x, next.y, next.zoom);
            if (isDefault) {
                const existingPivot = State.current.focusViewport?.pivot;
                const existingMultiplier = State.current.focusViewport?.strengthMultiplier;
                if (existingPivot != null || existingMultiplier != null) {
                    State.current.focusViewport = {
                        x: next.x,
                        y: next.y,
                        zoom: next.zoom,
                        pivot: existingPivot != null ? existingPivot : 1.0,
                        strengthMultiplier: existingMultiplier != null ? existingMultiplier : 1.0
                    };
                } else {
                    State.current.focusViewport = null;
                }
            } else {
                State.current.focusViewport = {
                    x: next.x,
                    y: next.y,
                    zoom: next.zoom,
                    pivot: State.current.focusViewport?.pivot != null ? State.current.focusViewport.pivot : (State.projectorDepth.pivot || 1.0),
                    strengthMultiplier: State.current.focusViewport?.strengthMultiplier != null ? State.current.focusViewport.strengthMultiplier : (State.projectorDepth.strengthMultiplier || 1.0)
                };
            }
            if (patch.silent !== true) {
                window.VisualProjector?.gallery?.persistAsset?.(State.current);
            }
        }

        applyProjectorViewportUI();
        updatePlayerBar();
        if (patch.silent !== true) emitProjectorViewportChanged(reason);
        return getProjectorViewportState();
    }

    function panProjectorViewport(dx = 0, dy = 0, reason = 'pan-viewport') {
        const current = getProjectorViewportState();
        const step = current.step || 0.5;
        return setProjectorViewport({
            x: current.x + (Number(dx) || 0) * step,
            y: current.y + (Number(dy) || 0) * step,
            touched: true,
        }, reason);
    }

    function resetProjectorViewport(reason = 'reset-viewport') {
        _targetViewportX = null;
        _targetViewportY = null;
        _targetViewportZoom = null;
        const d = getDefaultProjectorViewport();
        return setProjectorViewport({ x: d.x, y: d.y, zoom: 1, dirty: false }, reason);
    }

    function setProjectorViewportMode(payload = {}) {
        const enabled = payload.enabled != null ? !!payload.enabled : true;
        return setProjectorViewport({
            enabled,
            aspect: payload.aspect || '4:3',
            step: payload.step,
            zoom: enabled ? (payload.zoom != null ? payload.zoom : getProjectorViewportState().zoom) : 1,
            focusZoom: payload.focusZoom,
            x: payload.x != null ? payload.x : (enabled ? getProjectorViewportState().x : getDefaultProjectorViewport().x),
            y: payload.y != null ? payload.y : (enabled ? getProjectorViewportState().y : getDefaultProjectorViewport().y),
            dirty: enabled ? (payload.dirty === true ? true : getProjectorViewportState().dirty) : false,
        }, 'set-viewport-mode');
    }

    function setProjectorViewportZoom(zoom = 1, reason = 'set-viewport-zoom') {
        const current = getProjectorViewportState();
        _targetViewportZoom = Math.max(1, Math.min(current.focusZoom || 1.5, Number(zoom) || 1));
        if (_targetViewportX === null) _targetViewportX = current.x;
        if (_targetViewportY === null) _targetViewportY = current.y;
        ensureViewportGlideLoopActive();
        return getProjectorViewportState();
    }

    function toggleProjectorViewportZoom(reason = 'toggle-viewport-zoom') {
        const current = getProjectorViewportState();
        return setProjectorViewportZoom(current.zoom > 1.001 ? 1 : current.focusZoom, reason);
    }

    function getCurrentImageOverflowAxis() {
        const img = State.ui.screen?.querySelector('img:not([data-outgoing])');
        const vp = getProjectorViewportState();
        // v14: was `vp.zoom > 1.001 ? 'both' : 'both'` — a dead ternary with
        // both arms identical (pre-existing quirk), simplified, no behavior change.
        if (!img || !img.naturalWidth || !img.naturalHeight) return 'both';
        if (vp.zoom > 1.001) return 'both';
        const imageRatio = img.naturalWidth / img.naturalHeight;
        const viewportRatio = 4 / 3;
        if (Math.abs(imageRatio - viewportRatio) < 0.03) return 'none';
        return imageRatio > viewportRatio ? 'x' : 'y';
    }

    function updateFocusArrowState() {
        const screen = State.ui.screen;
        if (!screen) return;
        const vp = getProjectorViewportState();
        const axis = getCurrentImageOverflowAxis();
        screen.querySelectorAll('[data-focus-pan]').forEach(btn => {
            const dir = btn.dataset.focusPan;
            let visible = vp.enabled;
            if (axis === 'x') visible = visible && (dir === 'left' || dir === 'right');
            else if (axis === 'y') visible = visible && (dir === 'up' || dir === 'down');
            else if (axis === 'none') visible = false;
            if (dir === 'left' && vp.x <= 0.001) visible = false;
            if (dir === 'right' && vp.x >= 0.999) visible = false;
            if (dir === 'up' && vp.y <= 0.001) visible = false;
            if (dir === 'down' && vp.y >= 0.999) visible = false;
            btn.hidden = !visible;
        });
    }

    function applyProjectorViewportUI() {
        const screen = State.ui.screen;
        if (!screen) return;
        const vp = getProjectorViewportState();
        const enabled = !!vp.enabled;
        screen.classList.toggle('vp-focus-mode', enabled);

        const snapshotOverlay = screen.querySelector('.vp-focus-snapshot-overlay');
        if (snapshotOverlay) {
            snapshotOverlay.style.display = enabled ? 'block' : 'none';
            if (enabled) {
                // (pivot slider removed from the HUD in v14 — no sync needed here)
                const strengthSlider = snapshotOverlay.querySelector('#vp-focus-strength-slider');
                const strengthVal = snapshotOverlay.querySelector('#vp-focus-strength-val');
                if (strengthSlider && strengthVal) {
                    const currentStrength = State.current?.focusViewport?.strengthMultiplier != null 
                        ? Number(State.current.focusViewport.strengthMultiplier) 
                        : (State.projectorDepth.strengthMultiplier || 1.0);
                    strengthSlider.value = String(currentStrength);
                    strengthVal.textContent = currentStrength.toFixed(1) + 'x';
                }
            }
        }

        const focusX = `${Math.round(vp.x * 10000) / 100}%`;
        const focusY = `${Math.round(vp.y * 10000) / 100}%`;
        const focusZoom = Math.max(1, Number(vp.zoom) || 1);
        screen.style.setProperty('--vp-focus-x', focusX);
        screen.style.setProperty('--vp-focus-y', focusY);
        screen.style.setProperty('--vp-focus-zoom', String(focusZoom));

        // Force the Focus Mode geometry inline as well as in CSS. The normal
        // projector uses contain/max-size rules; inline overrides make sure the
        // active image really becomes a 4:3 cover crop even if old transition
        // styles or later stylesheet order try to keep it contained.
        //
        // NOTE (intentional soft 4:3, not a bug): width stays pinned to the
        // panel while max-height caps the vertical extent, so on a wide+short
        // panel the box can end up wider than a true 4:3 — no letterbox bars,
        // the screen always fills the panel width. See the matching comment
        // in css/visual-projector.css (.vp-screen.vp-focus-mode) for the full
        // rationale and what to change if a hard, input-stable 4:3 is needed
        // later for mouse/keyboard input on the screen.
        if (enabled) {
            screen.style.aspectRatio = '4 / 3';
            screen.style.flex = '0 1 auto';
            screen.style.width = 'calc(100% - 16px)';
            screen.style.maxHeight = 'calc(100% - 16px)';
            screen.style.alignSelf = 'center';
        } else {
            screen.style.aspectRatio = '';
            screen.style.flex = '';
            screen.style.width = '';
            screen.style.maxHeight = '';
            screen.style.alignSelf = '';
        }

        screen.querySelectorAll('img').forEach(img => {
            if (enabled) {
                img.style.setProperty('width', '100%', 'important');
                img.style.setProperty('height', '100%', 'important');
                img.style.setProperty('max-width', 'none', 'important');
                img.style.setProperty('max-height', 'none', 'important');
                img.style.setProperty('object-fit', 'cover', 'important');
                // Use direct computed values instead of CSS variables here. Some
                // engines don't interpolate object-position smoothly when only a
                // parent CSS variable changes, especially on the secondary axis.
                img.style.setProperty('object-position', `${focusX} ${focusY}`, 'important');
                img.style.setProperty('transform', `scale(${focusZoom})`, 'important');
                img.style.setProperty('transform-origin', `${focusX} ${focusY}`, 'important');
            } else {
                img.style.removeProperty('width');
                img.style.removeProperty('height');
                img.style.removeProperty('max-width');
                img.style.removeProperty('max-height');
                img.style.removeProperty('object-fit');
                img.style.removeProperty('object-position');
                img.style.removeProperty('transform');
                img.style.removeProperty('transform-origin');
            }
            img.onload = () => updateFocusArrowState();
        });
        updateFocusArrowState();
        try { updateGazeChip(); } catch { /* HUD readout is cosmetic */ }
        updateProjectorDepthLayer().catch(err => {
            State.projectorDepth = { ...State.projectorDepth, status: 'error', error: err?.message || String(err) };
            console.warn('[VP Depth] layer update failed:', err);
        });
    }

    const _depthRuntime = {
        renderer: null,
        imageSrc: '',
        depthSrc: '',
        depthObjectUrl: null,
        imageObjectUrl: null,
        loadingKey: '',
        promise: null,
    };

    let _targetViewportX = null;
    let _targetViewportY = null;
    let _targetViewportZoom = null;
    let _glideLoopActive = false;
    let _focusPanelCollapsed = false;

    function ensureViewportGlideLoopActive() {
        if (_glideLoopActive) return;
        _glideLoopActive = true;
        
        const lerpFactor = 0.12; // light, responsive glide inertia
        
        function loop() {
            if (_targetViewportX === null || _targetViewportY === null) {
                _glideLoopActive = false;
                return;
            }
            
            const current = getProjectorViewportState();
            const dx = _targetViewportX - current.x;
            const dy = _targetViewportY - current.y;
            const dZoom = _targetViewportZoom !== null ? (_targetViewportZoom - current.zoom) : 0;
            
            if (Math.abs(dx) < 0.0005 && Math.abs(dy) < 0.0005 && Math.abs(dZoom) < 0.0005) {
                const settledVp = setProjectorViewport({
                    x: _targetViewportX,
                    y: _targetViewportY,
                    zoom: _targetViewportZoom !== null ? _targetViewportZoom : current.zoom,
                    touched: true
                }, 'focus-drag-snap-final');
                // The camera *landed*: this is the one moment attention is
                // unambiguous — pin the gaze label here (v15 attention layer).
                if (settledVp?.enabled) recordGazePoint(settledVp, { reason: 'glide-settle' });
                
                _targetViewportX = null;
                _targetViewportY = null;
                _targetViewportZoom = null;
                _glideLoopActive = false;
                return;
            }
            
            const nextX = current.x + dx * lerpFactor;
            const nextY = current.y + dy * lerpFactor;
            const nextZoom = _targetViewportZoom !== null ? (current.zoom + dZoom * lerpFactor) : current.zoom;
            
            setProjectorViewport({
                x: nextX,
                y: nextY,
                zoom: nextZoom,
                touched: true,
                silent: true
            }, 'focus-drag-glide');
            
            requestAnimationFrame(loop);
        }
        
        requestAnimationFrame(loop);
    }

    function computeDepthEffectiveStrength() {
        const d = State.projectorDepth || {};
        const vp = getProjectorViewportState();
        const base = Math.max(0, Math.min(0.2, Number(d.strength) || 0.045));
        const boost = Math.max(0, Math.min(0.12, Number(d.zoomBoost) || 0.035));
        const curve = Math.max(0.5, Math.min(3, Number(d.zoomCurve) || 1.2));
        const denom = Math.max(0.001, (vp.focusZoom || 1.5) - 1);
        const t = Math.max(0, Math.min(1, ((vp.zoom || 1) - 1) / denom));
        return Math.max(0, Math.min(0.2, base + boost * Math.pow(t, curve)));
    }

    function getProjectorDepthState() {
        const d = State.projectorDepth || {};
        return {
            enabled: d.enabled !== false,
            strength: Math.max(0, Math.min(0.2, Number(d.strength) || 0.045)),
            zoomBoost: Math.max(0, Math.min(0.12, Number(d.zoomBoost) || 0.035)),
            zoomCurve: Math.max(0.5, Math.min(3, Number(d.zoomCurve) || 1.2)),
            effectiveStrength: computeDepthEffectiveStrength(),
            status: d.status || 'idle',
            activeTag: d.activeTag || null,
            depthFile: d.depthFile || null,
            error: d.error || null,
            webglAvailable: !!window.VPDepthRenderer,
        };
    }

    function setProjectorDepthMode(payload = {}) {
        State.projectorDepth = {
            ...State.projectorDepth,
            enabled: payload.enabled != null ? !!payload.enabled : true,
            status: State.projectorDepth?.status || 'idle',
            error: null,
        };
        updateProjectorDepthLayer().catch(err => console.warn('[VP Depth] update failed:', err));
        return getProjectorDepthState();
    }

    function setProjectorDepthStrength(strength = 0.045) {
        State.projectorDepth = {
            ...State.projectorDepth,
            strength: Math.max(0, Math.min(0.2, Number(strength) || 0.045)),
        };
        updateProjectorDepthLayer().catch(err => console.warn('[VP Depth] render failed:', err));
        return getProjectorDepthState();
    }

    function setProjectorDepthZoomBoost(zoomBoost = 0.035) {
        State.projectorDepth = {
            ...State.projectorDepth,
            zoomBoost: Math.max(0, Math.min(0.12, Number(zoomBoost) || 0.035)),
        };
        updateProjectorDepthLayer().catch(err => console.warn('[VP Depth] render failed:', err));
        return getProjectorDepthState();
    }

    function ensureDepthCanvas() {
        const screen = State.ui.screen;
        if (!screen) return null;
        let canvas = screen.querySelector('.vp-depth-canvas');
        if (!canvas) {
            canvas = document.createElement('canvas');
            canvas.className = 'vp-depth-canvas';
            canvas.setAttribute('aria-hidden', 'true');
            screen.appendChild(canvas);
        }
        return canvas;
    }

    function revokeDepthRuntimeUrls({ keepImage = false, keepDepth = false } = {}) {
        if (!keepImage && _depthRuntime.imageObjectUrl) {
            try { URL.revokeObjectURL(_depthRuntime.imageObjectUrl); } catch {}
            _depthRuntime.imageObjectUrl = null;
        }
        if (!keepDepth && _depthRuntime.depthObjectUrl) {
            try { URL.revokeObjectURL(_depthRuntime.depthObjectUrl); } catch {}
            _depthRuntime.depthObjectUrl = null;
        }
    }

    async function getCurrentImageSourceForDepth(asset) {
        if (!asset) return { src: '', objectUrl: null };
        if (asset.url || asset.base64) return { src: asset.url || asset.base64, objectUrl: null };
        if (asset.blob) {
            const url = URL.createObjectURL(asset.blob);
            return { src: url, objectUrl: url };
        }
        return { src: '', objectUrl: null };
    }

    async function getDepthSidecarObjectUrl(asset) {
        const file = asset?.depthMap?.file;
        if (!file || asset.depthMap?.status !== 'ready') return { src: '', objectUrl: null };
        const info = window.VP_DB?.getBackendInfo?.();
        const worldRoot = info?.worldRoot;
        if (!worldRoot || !window.Neutralino?.filesystem?.readBinaryFile) return { src: '', objectUrl: null };
        const path = `${worldRoot}/assets/depth/${file}`;
        const bin = await Neutralino.filesystem.readBinaryFile(path);
        const blob = new Blob([bin], { type: 'image/png' });
        const url = URL.createObjectURL(blob);
        return { src: url, objectUrl: url, path };
    }

    function deactivateProjectorDepthLayer(reason = 'inactive') {
        const screen = State.ui.screen;
        if (screen) screen.classList.remove('vp-depth-active');
        const canvas = screen?.querySelector('.vp-depth-canvas');
        if (canvas) canvas.style.display = 'none';
        State.projectorDepth = {
            ...State.projectorDepth,
            status: reason,
            activeTag: null,
            depthFile: null,
        };
    }

    async function updateProjectorDepthLayer() {
        const screen = State.ui.screen;
        const asset = State.current;
        const viewport = getProjectorViewportState();
        const depthState = getProjectorDepthState();
        if (!screen || !asset || !viewport.enabled || !depthState.enabled || asset.depthMap?.status !== 'ready' || !window.VPDepthRenderer) {
            deactivateProjectorDepthLayer(!viewport.enabled ? 'focus-disabled' : 'inactive');
            return false;
        }

        const canvas = ensureDepthCanvas();
        if (!canvas) return false;
        canvas.style.display = 'block';

        const key = `${asset.tag}|${asset.url || asset.base64 || asset.file || ''}|${asset.depthMap.file}`;
        if (_depthRuntime.loadingKey === key && _depthRuntime.promise) {
            await _depthRuntime.promise;
        } else if (_depthRuntime.loadingKey !== key || !_depthRuntime.renderer?.ready) {
            _depthRuntime.loadingKey = key;
            _depthRuntime.promise = (async () => {
                State.projectorDepth = { ...State.projectorDepth, status: 'loading', activeTag: asset.tag, depthFile: asset.depthMap.file, error: null };
                const image = await getCurrentImageSourceForDepth(asset);
                const depth = await getDepthSidecarObjectUrl(asset);
                if (!image.src || !depth.src) throw new Error('Depth renderer source is unavailable');
                revokeDepthRuntimeUrls({ keepImage: false, keepDepth: false });
                _depthRuntime.imageObjectUrl = image.objectUrl;
                _depthRuntime.depthObjectUrl = depth.objectUrl;
                if (!_depthRuntime.renderer) _depthRuntime.renderer = new window.VPDepthRenderer(canvas);
                await _depthRuntime.renderer.setSources(image.src, depth.src);
                _depthRuntime.imageSrc = image.src;
                _depthRuntime.depthSrc = depth.src;
            })();
            await _depthRuntime.promise;
        }

	 const ok = _depthRuntime.renderer.render(viewport, {
		 strength: computeDepthEffectiveStrength() * (asset.focusViewport?.strengthMultiplier != null ? Number(asset.focusViewport.strengthMultiplier) : (State.projectorDepth.strengthMultiplier || 1.0)),
		 inverted: !!asset.depthMap?.inverted,
		 pivot: asset.focusViewport?.pivot != null ? Number(asset.focusViewport.pivot) : (State.projectorDepth.pivot || 1.0),
		 // v14: `vignette` option removed (cut by owner; renderer uniform stays
		 // dormant) and `nearThreshold: 0.8` removed — dead option the renderer
		 // never read (its comment was stale too). dofStrength/aberration stay
		 // as dormant knobs for the possible "dramatic shader" comeback.
		 dofStrength: State.projectorDepth.dofStrength || 0.0,
		 aberration: State.projectorDepth.aberration || 0.0,
	 });
        screen.classList.toggle('vp-depth-active', !!ok);
        State.projectorDepth = { ...State.projectorDepth, status: ok ? 'ready' : 'error', activeTag: asset.tag, depthFile: asset.depthMap.file, error: ok ? null : 'render-failed' };
        return ok;
    }

    async function performFocalLockAtClick(event) {
        const screen = State.ui.screen;
        const renderer = _depthRuntime.renderer;
        if (!screen || !renderer || !renderer.ready || !State.current) return;
        
        try {
            const rect = screen.getBoundingClientRect();
            const rx = Math.max(0, Math.min(1, (event.clientX - rect.left) / rect.width));
            const ry = Math.max(0, Math.min(1, (event.clientY - rect.top) / rect.height));
            
            // Get current viewport UV origin and size
            const uv = renderer.computeUv(getProjectorViewportState());
            const uvX = uv.origin[0] + rx * uv.size[0];
            const uvY = uv.origin[1] + ry * uv.size[1];
            
            // Read depth value
            let depthVal = renderer.getDepthAt(uvX, uvY);
            if (State.current.depthMap?.inverted) {
                depthVal = 1.0 - depthVal;
            }
            
            // Update pivot state = semantic "gaze depth" of the click.
            // (Inert on the WebGL2 shader while DoF sleeps; live on WebGL1.)
            ensureAssetFocusViewport(State.current).pivot = depthVal;
            State.projectorDepth.pivot = depthVal;
            
            // Focal lock = an explicit "I am looking HERE" statement →
            // the strongest gaze marker we have (v15 attention layer).
            recordGazePoint(getProjectorViewportState(), { reason: 'focal-lock', locked: true });
            
            // Persist asset RAM changes
            window.VisualProjector?.gallery?.persistAsset?.(State.current);
            
            // (HUD pivot slider removed in v14 — nothing to sync here)
            
            // Render the depth layer with the new focal plane
            await updateProjectorDepthLayer();
            
            showToast(`Фокус заблокирован на глубине ${depthVal.toFixed(2)}`, 'success');
        } catch (err) {
            console.warn('[VP Focus Mode] Focal lock failed:', err);
        }
    }

    function ensureFocusControls() {
        const screen = State.ui.screen;
        if (!screen) return;
        ensureDepthCanvas();
        if (screen.querySelector('.vp-focus-snapshot-overlay')) return;
        const controls = document.createElement('div');
        controls.className = 'vp-focus-snapshot-overlay';
        controls.style.cssText = `
            position: absolute;
            inset: 0;
            z-index: 31; /* above depth canvas and other layers */
            pointer-events: none;
            display: none; /* controlled by applyProjectorViewportUI */
        `;
        
        // Render a beautiful, balanced Camera HUD overlay:
        // Left side: Focus controls panel (anchored left, stacked vertically, collapsible via left-side anchored arrow)
        // Right side: Snapshot Focus button (anchored right)
        // Both on the same bottom-aligned baseline and made more compact.
        controls.innerHTML = `
            <!-- LEFT SIDE: FOCUS HUD CONTROLS (COLLAPSIBLE WITH ANCHORED TOGGLE) -->
            <div style="position: absolute; left: 12px; bottom: 12px; pointer-events: none; display: flex; align-items: center; gap: 8px; z-index: 100;">
                
                <!-- ANCHORED TOGGLE BUTTON -->
                <button id="vp-focus-pivot-toggle-btn" style="pointer-events: auto; width: 24px; height: 24px; display: flex; align-items: center; justify-content: center; background: rgba(20,20,32,0.76); border: 1px solid rgba(255,255,255,0.16); border-radius: 6px; color: #cdd6f4; backdrop-filter: blur(6px); box-shadow: 0 4px 12px rgba(0,0,0,0.3); cursor: pointer; outline: none; padding: 0; transition: background 0.15s ease, transform 0.1s ease;" title="Свернуть настройки камеры">◀</button>

                <!-- SLIDERS PANEL -->
                <div id="vp-focus-pivot-panel" style="pointer-events: auto; display: flex; flex-direction: column; gap: 6px; background: rgba(20,20,32,0.76); border: 1px solid rgba(255,255,255,0.16); border-radius: 10px; padding: 6px 10px; color: #cdd6f4; backdrop-filter: blur(6px); box-shadow: 0 4px 16px rgba(0,0,0,0.4); transition: width 0.15s ease, padding 0.15s ease, opacity 0.15s ease, border-color 0.15s ease, gap 0.15s ease;">
                    <!-- STRENGTH/FOV SLIDER (v14: the only honest slider left —
                         pivot plane was a mock on the WebGL2 shader, vignette
                         was cut by owner as FX-engine territory) -->
                    <div class="vp-focus-row" style="display: flex; align-items: center; gap: 6px; font-size: 10px; font-weight: 600;">
                        <span style="min-width: 48px;">🔍 FOV Scale:</span>
                        <input type="range" id="vp-focus-strength-slider" min="0.0" max="2.5" step="0.05" style="width: 65px; height: 3px; accent-color: #6c5fa6; cursor: pointer; background: rgba(255,255,255,0.12); border-radius: 2px; outline: none; margin: 0; padding: 0;">
                        <span id="vp-focus-strength-val" style="min-width: 22px; font-family: monospace; text-align: right;">1.0x</span>
                    </div>
                </div>
            </div>

            <!-- RIGHT SIDE: SNAPSHOT BUTTON -->
            <div style="position: absolute; right: 12px; bottom: 12px; pointer-events: auto; z-index: 100;">
                <button class="vp-btn" id="vp-focus-capture-btn" title="Сделать снимок угла обзора и прикрепить его как взгляд персонажа к следующему сообщению" style="height: 28px; padding: 0 10px; display: inline-flex; align-items: center; gap: 5px; font-weight: 600; font-size: 11px; border-radius: 999px; background: rgba(20,20,32,0.76); border: 1px solid rgba(255,255,255,0.16); color: #cdd6f4; backdrop-filter: blur(6px); box-shadow: 0 4px 16px rgba(0,0,0,0.4); cursor: pointer; transition: transform 0.1s ease, background 0.15s ease;">
                    <span style="font-size: 11px;">📷</span>
                    <span>Snapshot Focus</span>
                </button>
            </div>
        `;

        const btn = controls.querySelector('#vp-focus-pivot-toggle-btn');
        const panel = controls.querySelector('#vp-focus-pivot-panel');
        const rows = panel.querySelectorAll('.vp-focus-row');
        
        if (btn && panel) {
            const togglePanel = (collapse) => {
                _focusPanelCollapsed = collapse;
                if (_focusPanelCollapsed) {
                    rows.forEach(r => { r.style.display = 'none'; r.style.opacity = '0'; });
                    panel.style.width = '0px';
                    panel.style.padding = '0px';
                    panel.style.gap = '0px';
                    panel.style.border = 'none';
                    panel.style.background = 'transparent';
                    panel.style.boxShadow = 'none';
                    panel.style.backdropFilter = 'none';
                    btn.innerHTML = '▶';
                    btn.title = 'Развернуть настройки камеры';
                } else {
                    rows.forEach(r => { r.style.display = 'flex'; r.style.opacity = '1'; });
                    panel.style.width = '';
                    panel.style.padding = '6px 10px';
                    panel.style.gap = '6px';
                    panel.style.border = '1px solid rgba(255,255,255,0.16)';
                    panel.style.background = 'rgba(20,20,32,0.76)';
                    panel.style.boxShadow = '0 4px 16px rgba(0,0,0,0.4)';
                    panel.style.backdropFilter = 'blur(6px)';
                    btn.innerHTML = '◀';
                    btn.title = 'Свернуть настройки камеры';
                }
            };

            // Restore previous state if any
            togglePanel(_focusPanelCollapsed);

            btn.addEventListener('mouseenter', () => { btn.style.background = 'rgba(108,95,166,0.85)'; });
            btn.addEventListener('mouseleave', () => { btn.style.background = 'rgba(20,20,32,0.76)'; });

            btn.addEventListener('click', (e) => {
                e.preventDefault(); e.stopPropagation();
                togglePanel(!_focusPanelCollapsed);
                // Trigger slider updates just in case
                applyProjectorViewportUI();
            });

        const strengthSlider = controls.querySelector('#vp-focus-strength-slider');
        const strengthVal = controls.querySelector('#vp-focus-strength-val');
        
        if (strengthSlider && strengthVal) {
            const initialStrength = State.current?.focusViewport?.strengthMultiplier != null 
                ? Number(State.current.focusViewport.strengthMultiplier) 
                : (State.projectorDepth.strengthMultiplier || 1.0);
            
            strengthSlider.value = String(initialStrength);
            strengthVal.textContent = initialStrength.toFixed(1) + 'x';

            const updateStrengthValue = (val) => {
                const num = Number(val);
                strengthVal.textContent = num.toFixed(1) + 'x';
                
                const fv = ensureAssetFocusViewport(State.current);
                if (fv) fv.strengthMultiplier = num;
                State.projectorDepth.strengthMultiplier = num;
                updateProjectorDepthLayer().catch(() => {});
            };

            strengthSlider.addEventListener('input', (e) => {
                updateStrengthValue(e.target.value);
            });

            strengthSlider.addEventListener('change', (e) => {
                updateStrengthValue(e.target.value);
                if (State.current) {
                    window.VisualProjector?.gallery?.persistAsset?.(State.current);
                }
            });
        }

        // (v14: pivot + vignette slider wiring removed together with their
        //  HUD rows — pivot was a mock on the WebGL2 shader, vignette is cut)

        const captureBtn = controls.querySelector('#vp-focus-capture-btn');
        if (captureBtn) {
            captureBtn.addEventListener('mouseenter', () => { captureBtn.style.background = 'rgba(108,95,166,0.85)'; });
            captureBtn.addEventListener('mouseleave', () => { captureBtn.style.background = 'rgba(20,20,32,0.76)'; });
            captureBtn.addEventListener('click', async (e) => {
                e.preventDefault(); e.stopPropagation();
                captureBtn.style.transform = 'scale(0.92)';
                setTimeout(() => { captureBtn.style.transform = ''; }, 100);

                try {
                    const focus = await captureFocusViewportDataUrl();
                    if (!focus || !focus.dataUrl) {
                        showToast('Не удалось сделать снимок фокуса', 'error');
                        return;
                    }

                    const tag = focus.sourceTag || State.current?.tag || 'current';
                    const manifestText = `[GAZE FOCUS ATTACHMENT: ${tag}]\nThe user is looking at this specific cropped area of the active image [${tag}] right now. This is their character's direct point-of-view, gaze focus, and zoom level. Treat this as their active attention target during your response.`;
                    
                    if (window.VisualProjector?.session?.queueManifest) {
                        window.VisualProjector.session.queueManifest(manifestText, { source: 'user-gaze', ttl: 1 });
                    }
                    
                    // Trigger input panel re-render
                    window.VisualProjector?.session?.renderRegisteredPanels?.(['input']);

                    showToast('Снимок фокуса прикреплен к следующему сообщению!', 'success');
                } catch (err) {
                    console.error('[VP Focus Mode] Snapshot capture failed:', err);
                    showToast('Ошибка снимка: ' + (err.message || err), 'error');
                }
            });
        }

        screen.appendChild(controls);
    }

    if (screen.dataset.focusDragWired !== '1') {
            screen.dataset.focusDragWired = '1';

            // Hard stop native HTML5 drag on the projector's <img>. Without this,
            // dragging the pixel content itself (not just our custom pointer-based
            // pan/zoom) can start a native OS-level image drag; releasing it back
            // over the same window makes the browser hand the drop handler a
            // synthesized image File, which was being misread as an external drop
            // and duplicated the asset into the gallery + screen. The projector
            // screen must only ever react to pointerdown/move/up (see below) so
            // that future mouse+keyboard input on this surface stays predictable.
            screen.addEventListener('dragstart', (event) => { event.preventDefault(); });

            let dragging = false;
            let startX = 0;
            let startY = 0;
            let startViewport = null;
            let moved = false;
            let dragOriginX = 0;
            let dragOriginY = 0;
            let totalDx = 0;
            let totalDy = 0;
            let lastDragAxis = 'none';

            const snapToStep = (value, step) => {
                const s = Math.max(0.05, Math.min(1, Number(step) || 0.5));
                return clamp01(Math.round(clamp01(value) / s) * s, 0);
            };

            const directionalSnap = (startValue, currentValue, mouseDelta, step, axisSize) => {
                const s = Math.max(0.05, Math.min(1, Number(step) || 0.5));
                const intentPx = Math.max(14, Math.min(42, axisSize * 0.045));
                if (Math.abs(mouseDelta) < intentPx) return snapToStep(currentValue, s);
                const direction = mouseDelta < 0 ? 1 : -1;
                return clamp01(snapToStep(startValue, s) + direction * s, startValue);
            };

            const applySmoothDrag = (event) => {
                if (!dragging || !startViewport) return;
                const axis = getCurrentImageOverflowAxis();
                const rect = screen.getBoundingClientRect();
                totalDx = event.clientX - dragOriginX;
                totalDy = event.clientY - dragOriginY;
                const dragW = Math.max(120, rect.width * 0.65);
                const dragH = Math.max(120, rect.height * 0.65);

                let tx = startViewport.x;
                let ty = startViewport.y;

                if (axis === 'x' || axis === 'both') tx = clamp01(startViewport.x - totalDx / dragW, startViewport.x);
                if (axis === 'y' || axis === 'both') ty = clamp01(startViewport.y - totalDy / dragH, startViewport.y);
                if (axis === 'none') return;

                if (Math.abs(totalDx) > 3 || Math.abs(totalDy) > 3) moved = true;
                if (Math.abs(totalDx) > Math.abs(totalDy)) lastDragAxis = 'x';
                else if (Math.abs(totalDy) > Math.abs(totalDx)) lastDragAxis = 'y';
                else lastDragAxis = axis;

                // Update gliding targets and ensure the loop runs!
                _targetViewportX = tx;
                _targetViewportY = ty;
                ensureViewportGlideLoopActive();
            };

            screen.addEventListener('wheel', (event) => {
                const vp = getProjectorViewportState();
                if (!vp.enabled) return;
                // Wheel over the focused projector toggles the single balanced zoom
                // level. If the browser reports mouse buttons, RMB+wheel also works;
                // plain wheel is accepted because the projector surface itself does
                // not need page scrolling.
                event.preventDefault();
                const delta = Math.max(-0.12, Math.min(0.12, -event.deltaY * 0.0015));
                const nextZoom = Math.max(1, Math.min(vp.focusZoom || 1.5, vp.zoom + delta));
                setProjectorViewportZoom(nextZoom, delta >= 0 ? 'focus-wheel-zoom-in' : 'focus-wheel-zoom-out');
            }, { passive: false });
            screen.addEventListener('contextmenu', (event) => {
                if (!getProjectorViewportState().enabled) return;
                event.preventDefault();
            });

            screen.addEventListener('pointerdown', (event) => {
                if (!getProjectorViewportState().enabled) return;
                if (event.target.closest('button, input, select, textarea, .vp-screen-actions, .vp-focus-controls')) return;
                dragging = true;
                moved = false;
                totalDx = 0;
                totalDy = 0;
                lastDragAxis = 'none';
                startX = event.clientX;
                startY = event.clientY;
                dragOriginX = event.clientX;
                dragOriginY = event.clientY;
                startViewport = getProjectorViewportState();
                screen.classList.add('vp-focus-dragging');
                screen.setPointerCapture?.(event.pointerId);
                event.preventDefault();
            });
            screen.addEventListener('pointermove', (event) => {
                if (!dragging) return;
                applySmoothDrag(event);
            });

            const finishFreeDrag = () => {
                updateFocusArrowState();
            };

            const finishDrag = (event) => {
                if (!dragging) return;
                dragging = false;
                screen.classList.remove('vp-focus-dragging');
                try { screen.releasePointerCapture?.(event.pointerId); } catch {}
                if (!moved) {
                    performFocalLockAtClick(event);
                } else {
                    finishFreeDrag();
                }
                startViewport = null;
            };
            screen.addEventListener('pointerup', finishDrag);
            screen.addEventListener('pointercancel', finishDrag);
            screen.addEventListener('lostpointercapture', () => {
                if (!dragging) return;
                dragging = false;
                screen.classList.remove('vp-focus-dragging');
                finishFreeDrag();
                startViewport = null;
            });
        }
        updateFocusArrowState();
    }

    // ── GAZE DECK CHIP (v15) ────────────────────────────────────────────────
    // Tiny live attention readout mounted right under the image (above the
    // player bar), hydrated dynamically like the rest of the focus HUD.
    // Default ON; kill-switch: config.gazeDeckChip = false.
    const GAZE_CHIP_CSS = `
#vp-deck-gaze-chip{display:none;align-items:center;justify-content:center;gap:8px;padding:3px 10px;margin:2px auto 4px;max-width:calc(100% - 24px);box-sizing:border-box;font-size:10px;letter-spacing:.02em;color:#8f9bbd;background:rgba(20,20,32,0.55);border:1px solid rgba(255,255,255,0.10);border-radius:999px;backdrop-filter:blur(6px);}
#vp-deck-gaze-chip.on{display:inline-flex;}
#vp-deck-gaze-region{color:#cdd6f4;font-weight:600;}
#vp-deck-gaze-xy{font-family:monospace;opacity:.85;}
#vp-deck-gaze-dwell{color:#a89aff;font-weight:700;}
#vp-deck-gaze-chip.vp-gaze-locked #vp-deck-gaze-region{color:#a6e3a1;}
    `.trim();

    function ensureGazeChip() {
        const host = State.ui.vpWindow;
        if (!host) return null;
        try {
            // v18 micro-fix: the style lives in <head>, so the guard must look
            // there too — the old host-scope check re-injected the stylesheet
            // into the DOM on every ensure (silent DOM leak on the 2s ticker).
            const head = document.head || host;
            if (!head.querySelector('#vp-gaze-chip-style')) {
                const style = document.createElement('style');
                style.id = 'vp-gaze-chip-style';
                style.textContent = GAZE_CHIP_CSS;
                head.appendChild(style);
            }
            let chip = host.querySelector('#vp-deck-gaze-chip');
            if (!chip) {
                chip = document.createElement('div');
                chip.id = 'vp-deck-gaze-chip';
                chip.setAttribute('role', 'status');
                chip.title = 'Gaze attention: куда на кадре сейчас смотрит пользователь (регион · x/y/zoom · dwell)';
                chip.innerHTML = `<span>👁</span><span id="vp-deck-gaze-region">—</span><span id="vp-deck-gaze-xy"></span><span id="vp-deck-gaze-dwell"></span>`;
                const playerBar = host.querySelector('#vp-player-bar');
                if (playerBar && playerBar.parentNode === host) host.insertBefore(chip, playerBar);
                else host.appendChild(chip);
            }
            return chip;
        } catch (err) {
            console.warn('[VP Focus] gaze chip mount failed (degrading silently):', err);
            return null;
        }
    }

    function updateGazeChip() {
        const chip = ensureGazeChip();
        if (!chip) return;
        const enabled = !!getProjectorViewportState().enabled && State.config?.gazeDeckChip !== false;
        chip.classList.toggle('on', enabled);
        if (!enabled) return;
        const g = getGazeState();
        const dwellMs = getGazeDwell();
        const dwellSec = Math.round(dwellMs / 1000);
        const regionEl = chip.querySelector('#vp-deck-gaze-region');
        const xyEl = chip.querySelector('#vp-deck-gaze-xy');
        const dwellEl = chip.querySelector('#vp-deck-gaze-dwell');
        if (regionEl) regionEl.textContent = g.anchor ? `${g.region} · ⚓${g.anchor}` : g.region;
        if (xyEl) xyEl.textContent = `x=${g.x.toFixed(2)} y=${g.y.toFixed(2)} ×${g.zoom.toFixed(2)}`;
        if (dwellEl) dwellEl.textContent = dwellSec >= 4 ? `dwell ${dwellSec}s` : '';
        const last = Array.isArray(State.gazeTrail) && State.gazeTrail.length ? State.gazeTrail[State.gazeTrail.length - 1] : null;
        chip.classList.toggle('vp-gaze-locked', last?.reason === 'focal-lock');
    }

    // Dwell is time-based: refresh the chip's clock even when the camera is idle.
    // 2s cadence, no-ops when the chip is hidden — cost ≈ zero.
    if (typeof setInterval === 'function') {
        // `.unref?.()` — in Node (smoke tests) an interval would otherwise
        // keep the process alive forever; browsers return a numeric id (no-op).
        setInterval(() => {
            try {
                const host = State.ui.vpWindow;
                const chip = host?.querySelector?.('#vp-deck-gaze-chip');
                if (chip && chip.classList.contains('on')) updateGazeChip();
            } catch { /* never let the clock break the module */ }
        }, 2000)?.unref?.();
    }

    // ── GLIDE TARGET BRIDGE ──────────────────────────────────────────────────
    // The engine's command bus and setCurrent() steer the same glide targets
    // this module animates toward; these two ops replace the bare `let`
    // references that existed before the v05 extraction.
    function setGlideTarget(axis, value) {
        if (axis === 'x') _targetViewportX = value;
        else if (axis === 'y') _targetViewportY = value;
        else if (axis === 'zoom') _targetViewportZoom = value;
        else console.warn('[VP Focus] setGlideTarget: unknown axis', axis);
    }
    function clearGlideTargets() {
        _targetViewportX = null;
        _targetViewportY = null;
        _targetViewportZoom = null;
    }

    // ── PUBLIC API ───────────────────────────────────────────────────────────
    // Full surface, including internals that used to be file-private: exposed
    // deliberately so future focus-mode features (default mode, auto contexts,
    // gameplay built on focal attention) can build on them without refactoring.
    window.VP_FOCUS = {
        clamp01, ensureAssetFocusViewport,
        getDefaultProjectorViewport, isDefaultProjectorViewport,
        getProjectorViewportState, emitProjectorViewportChanged,
        setProjectorViewport, panProjectorViewport, resetProjectorViewport,
        setProjectorViewportMode, setProjectorViewportZoom, toggleProjectorViewportZoom,
        getCurrentImageOverflowAxis, updateFocusArrowState,
        applyProjectorViewportUI, ensureViewportGlideLoopActive,
        computeDepthEffectiveStrength, getProjectorDepthState,
        setProjectorDepthMode, setProjectorDepthStrength, setProjectorDepthZoomBoost,
        ensureDepthCanvas, revokeDepthRuntimeUrls,
        getCurrentImageSourceForDepth, getDepthSidecarObjectUrl,
        deactivateProjectorDepthLayer, updateProjectorDepthLayer,
        performFocalLockAtClick, ensureFocusControls,
        setGlideTarget, clearGlideTargets,
        // v15 Gaze Attention Layer (read-only attention channel for FSM/games)
        getGazeRegionName, getGazeState, getGazeDwell,
        getGazeTrail, clearGazeTrail, recordGazePoint,
        ensureGazeChip, updateGazeChip,
    };

    console.log('[VP Focus] Module initialized (focus mode / depth layer / focal lock).');

})();
