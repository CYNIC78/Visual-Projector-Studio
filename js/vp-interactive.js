// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-interactive.js                                                ║
// ║  Interactive Regions — universal touch input for 2D assets.       ║
// ║                                                                    ║
// ║  Design (see project chat log around 2026-07-27 for the full      ║
// ║  rationale): the CORE only ever knows a small, universal physical  ║
// ║  vocabulary — WHERE (a region on the asset), WHAT KIND (tap vs     ║
// ║  stroke), and four cheap-to-compute axes (direction / amplitude /  ║
// ║  tempo / repeats). It does NOT know what "stroking hair" or        ║
// ║  "pulling a lever" MEANS — that semantic mapping belongs entirely  ║
// ║  to whichever game/FSM is mounted (see projector-games.js), via    ║
// ║  the region's own `label` (shown to the model) and the game's own  ║
// ║  interpretation of the physical event.                             ║
// ║                                                                    ║
// ║  Symmetry: the exact same [TOUCH:...] vocabulary a user's gesture  ║
// ║  produces is also what the model is taught to emit via the        ║
// ║  registered VPCommandBus 'TOUCH' command — one shared format both  ║
// ║  directions, not two parallel systems that can drift apart.        ║
// ║                                                                    ║
// ║  The tag never encodes an "instrument" (hand, lips, an object...)  ║
// ║  either — same reasoning as the verb question above: the space of  ║
// ║  possible instruments is unbounded, and the model already narrates ║
// ║  that detail in prose around the tag (confirmed in practice — see  ║
// ║  the Emily test log). If a specific game ever needs a structured   ║
// ║  instrument field for its own FSM, that's a per-game extension on  ║
// ║  top of this shared vocabulary, not something the core should      ║
// ║  standardize.                                                      ║
// ║                                                                    ║
// ║  Storage: regions live on the asset itself, alongside the already  ║
// ║  established `depthMap` / `focusViewport` sidecar fields (see      ║
// ║  vp-storage-native.js / vp-storage.js sanitizeAssetForStorage()):  ║
// ║    asset.interactive = {                                          ║
// ║      regions: [{                                                  ║
// ║        id, shape: 'rect', x, y, w, h,   // normalized 0..1         ║
// ║        label,                            // human text for model   ║
// ║        allowedInputs: ['tap','stroke'],  // which gesture kinds    ║
// ║      }, ...]                                                       ║
// ║    }                                                                ║
// ║                                                                    ║
// ║  A visual region editor (draw/move/resize rectangles) is included —  ║
// ║  see openRegionEditor() below, opened from the 🖐 button on each     ║
// ║  gallery card. It calls gallery.setInteractiveRegions() to persist,  ║
// ║  the exact same entry point the manual/console workflow used before ║
// ║  the editor existed — no separate code path to keep in sync.        ║
// ╚══════════════════════════════════════════════════════════════════╝
(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Interactive] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const State = VP.state;

    // ════════════════════════════════════════════════════════════════
    //  GESTURE CLASSIFICATION — the universal 4-axis vocabulary.
    //  Deliberately small and reused everywhere; see the module header.
    // ════════════════════════════════════════════════════════════════

    const TAP_MOVE_THRESHOLD_PX = 6;      // below this, it's a tap not a stroke
    const FAST_TEMPO_MS_PER_PX = 6;       // ms-per-px faster than this => 'fast'
    const FIRM_AMPLITUDE_FRACTION = 0.35; // drag distance / region size => 'firm'

    /** Classify a finished pointer gesture against a region's own box (region
     *  size in CSS px), returning the small universal vocabulary described
     *  in the module header. Kept as a pure function so it's easy to reason
     *  about/unit-test independent of DOM wiring. */
    function classifyGesture({ dx, dy, durationMs, regionWidthPx, regionHeightPx, reversals }) {
        const dist = Math.hypot(dx, dy);
        const type = dist < TAP_MOVE_THRESHOLD_PX ? 'tap' : 'stroke';

        let direction = null;
        if (type === 'stroke') {
            direction = Math.abs(dx) >= Math.abs(dy)
                ? (dx >= 0 ? 'right' : 'left')
                : (dy >= 0 ? 'down' : 'up');
        }

        const regionSize = Math.max(1, direction === 'left' || direction === 'right' ? regionWidthPx : regionHeightPx);
        const amplitude = (dist / regionSize) >= FIRM_AMPLITUDE_FRACTION ? 'firm' : 'light';

        const msPerPx = durationMs / Math.max(1, dist);
        const tempo = type === 'tap'
            ? (durationMs <= 180 ? 'fast' : 'slow')
            : (msPerPx <= FAST_TEMPO_MS_PER_PX ? 'fast' : 'slow');

        const repeats = Math.max(1, Number(reversals) || 1);

        return { type, direction, amplitude, tempo, repeats };
    }

    /** Build the compact [TOUCH:...] tag both the user's gesture and the
     *  model's own commands use — see VPCommandBus.register('TOUCH', ...)
     *  below for the parser mirroring this exact shape. */
    function buildTouchTag(regionId, gesture) {
        const parts = [regionId, gesture.type];
        if (gesture.direction) parts.push(gesture.direction);
        parts.push(gesture.amplitude, gesture.tempo);
        if (gesture.repeats > 1) parts.push(`x${gesture.repeats}`);
        return `[TOUCH:${parts.join(':')}]`;
    }

    function humanizeGesture(region, gesture) {
        const bits = [gesture.type];
        if (gesture.direction) bits.push(gesture.direction);
        bits.push(gesture.amplitude, gesture.tempo);
        if (gesture.repeats > 1) bits.push(`×${gesture.repeats}`);
        return `${region.label || region.id} — ${bits.join(' ')}`;
    }

    /** Per-region marker emoji, distinct from the hand-drag cursors Focus
     *  Mode already reserves (grab/grabbing for pan). tap-only regions get
     *  a poke, stroke-only regions get a caress, and regions that accept
     *  both get the general "touch" hand — same three icons used both for
     *  the on-screen marker and the CSS cursor below. */
    function regionIcon(region) {
        const allowed = region.allowedInputs && region.allowedInputs.length ? region.allowedInputs : ['tap', 'stroke'];
        const hasTap = allowed.includes('tap');
        const hasStroke = allowed.includes('stroke');
        if (hasTap && !hasStroke) return '👉';
        if (hasStroke && !hasTap) return '🫳';
        return '🖐️';
    }

    const _cursorCache = new Map();

    /** CSS cursor value showing the region's own emoji marker (see
     *  regionIcon()) instead of the browser's default arrow, so hovering a
     *  region gives the same at-a-glance "what kind of touch this expects"
     *  hint as the on-screen marker — without colliding with Focus Mode's
     *  own grab/grabbing hand cursors, which stay reserved for panning. */
    function regionCursor(region) {
        const icon = regionIcon(region);
        if (_cursorCache.has(icon)) return _cursorCache.get(icon);
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"><text x="16" y="24" font-size="26" text-anchor="middle">${icon}</text></svg>`;
        const url = `url("data:image/svg+xml,${encodeURIComponent(svg)}") 16 16, pointer`;
        _cursorCache.set(icon, url);
        return url;
    }

    // ════════════════════════════════════════════════════════════════
    //  PENDING TOUCH QUEUE — up to 3 slots, snapshot-style like manifests.
    // ════════════════════════════════════════════════════════════════

    const MAX_PENDING_TOUCHES = 3;

    function sessionApi() { return VP.session || null; }

    function queueTouchInteraction(region, gesture, tag) {
        const session = sessionApi();
        if (!session?.queueManifest || !session?.getPendingManifests) return null;

        // Enforce the cap by dropping the oldest pending touch first — the
        // MVP rule agreed on: "one activity per message" scales up to N
        // slots by FIFO eviction, never silently growing unbounded. Always
        // derived fresh from the session's real pending queue (rather than
        // a locally-tracked counter) so this stays correct even after a
        // message send drains the whole queue out from under us.
        const touchOnly = session.getPendingManifests().filter(m => m.source === 'user-touch');
        while (touchOnly.length >= MAX_PENDING_TOUCHES) {
            const oldest = touchOnly.shift();
            session.removePendingManifest?.(oldest.id);
        }

        const tag2 = String(State.current?.tag || 'current');
        const manifestText = `[SCREEN TOUCH: ${tag2}]\n${tag}\nThe user just touched the region "${region.label || region.id}" on the current frame. Interpret this gesture (type/direction/amplitude/tempo/repeat-count encoded above) in the context of the current scene and react accordingly.`;
        const mnf = session.queueManifest(manifestText, {
            source: 'user-touch',
            ttl: 1,
            touchSummary: humanizeGesture(region, gesture),
        });
        // queueManifest() only updates state — it does not itself repaint the
        // input panel (see the Snapshot Focus button in visual-projector.js,
        // which explicitly re-renders after queuing for the same reason).
        // Without this, the pill silently existed in state but never showed
        // up until something else happened to trigger a re-render.
        session.renderRegisteredPanels?.(['input']);
        return { manifestText, mnf };
    }

    // ════════════════════════════════════════════════════════════════
    //  TOUCH MODE TOGGLE — single-shot "I want to touch the asset now"
    //  button. See the module header: this is the deliberate-intent gate
    //  that both (a) tells the user which regions exist, and (b) keeps
    //  Focus Mode's pan/zoom drag from ever fighting a region drag, since
    //  the two are mutually exclusive by mode rather than by pixel-level
    //  hit-testing races.
    // ════════════════════════════════════════════════════════════════

    let touchModeArmed = false;

    function currentRegions() {
        return Array.isArray(State.current?.interactive?.regions) ? State.current.interactive.regions : [];
    }

    function hasInteractiveAsset() {
        return currentRegions().length > 0;
    }

    /** Currently-visible <img> on the screen (mirrors the selector used
     *  elsewhere in visual-projector.js to skip the outgoing transition
     *  frame during a crossfade). */
    function currentScreenImage() {
        return State.ui.screen?.querySelector('img:not([data-outgoing])') || null;
    }

    /**
     * Region coordinates are authored normalized (0..1) against the WHOLE
     * source image. But the screen almost never shows a 1:1, unclipped,
     * edge-to-edge rendering of that image, for two independent reasons
     * this function accounts for together:
     *
     *  1. Outside Focus Mode, the <img> uses natural max-width/max-height
     *     sizing (object-fit: contain behavior) — if the image's aspect
     *     ratio doesn't match the screen's, it's letterboxed: centered,
     *     with empty space on two sides. The image's own on-screen box is
     *     smaller than #vp-screen's box.
     *  2. Inside Focus Mode, applyProjectorViewportUI() (visual-projector.js)
     *     forces the <img> to 100%/100% of the screen via object-fit:
     *     cover + object-position, then applies an additional CSS
     *     transform: scale(zoom) around that SAME anchor point. Because
     *     both stages share one anchor, this two-stage CSS transform is
     *     mathematically identical to a single "cover-fit scaled by zoom"
     *     source crop — the same math VPDepthRenderer.computeUv() already
     *     uses for its WebGL UV lookup (projector-depth-renderer.js). We
     *     reuse that exact formula here so both paths agree on "which part
     *     of the source image is visible", rather than maintaining two
     *     slightly different approximations that could drift apart.
     *
     * What this intentionally does NOT attempt to correct: the additional
     * per-pixel parallax displacement the depth shader applies once a depth
     * sidecar is active. That displacement varies continuously across a
     * region (near vs far pixels shift by different amounts), so it can't
     * be expressed as a single rectangle transform — only a full per-pixel
     * remap could, which is far more complexity than a "roughly where to
     * tap" marker needs. With reasonable depth strength settings the
     * residual offset is a small fraction of the screen; it's left as a
     * known, documented approximation (see project chat log, 2026-07-27)
     * rather than solved exactly.
     */
    function computeRegionToScreenMapping() {
        const screen = State.ui.screen;
        const img = currentScreenImage();
        if (!screen || !img) return null;

        const screenRect = screen.getBoundingClientRect();
        const imgRect = img.getBoundingClientRect();
        if (!screenRect.width || !screenRect.height || !imgRect.width || !imgRect.height) return null;

        // Stage 1: where is the <img> box itself, within the screen? In
        // Focus Mode this is always (0,0,1,1) since the img is forced to
        // fill the screen; outside Focus Mode this captures any letterbox
        // offset from natural aspect-ratio-preserving sizing.
        const imgOffsetX = (imgRect.left - screenRect.left) / screenRect.width;
        const imgOffsetY = (imgRect.top - screenRect.top) / screenRect.height;
        const imgFracW = imgRect.width / screenRect.width;
        const imgFracH = imgRect.height / screenRect.height;

        // Stage 2: which part of the SOURCE image is visible within that
        // img box? Full frame outside Focus Mode (object-fit: contain never
        // crops); a cover+zoom crop while Focus Mode is enabled.
        const vp = VP.getProjectorViewportState?.();
        let crop = { originX: 0, originY: 0, sizeX: 1, sizeY: 1 };
        if (vp?.enabled) {
            const srcW = img.naturalWidth || img.width || 1;
            const srcH = img.naturalHeight || img.height || 1;
            const outW = img.clientWidth || imgRect.width || srcW;
            const outH = img.clientHeight || imgRect.height || srcH;
            const zoom = Math.max(1, Number(vp.zoom) || 1);
            const x = Math.max(0, Math.min(1, vp.x != null ? Number(vp.x) : 0.5));
            const y = Math.max(0, Math.min(1, vp.y != null ? Number(vp.y) : 0.5));
            const scale = Math.max(outW / srcW, outH / srcH) * zoom;
            const viewW = Math.min(srcW, outW / scale);
            const viewH = Math.min(srcH, outH / scale);
            const sx = Math.max(0, Math.min(srcW - viewW, (srcW - viewW) * x));
            const sy = Math.max(0, Math.min(srcH - viewH, (srcH - viewH) * y));
            crop = { originX: sx / srcW, originY: sy / srcH, sizeX: viewW / srcW, sizeY: viewH / srcH };
        }

        return { imgOffsetX, imgOffsetY, imgFracW, imgFracH, crop };
    }

    /** Map a region's asset-space (0..1) box into screen-space (0..1),
     *  given the current image-in-screen + source-crop mapping. Returns
     *  null if the region is entirely outside what's currently visible
     *  (fully panned/zoomed off-screen, or — degenerate case — the image
     *  isn't laid out yet). */
    function regionToScreenRect(region, mapping) {
        if (!mapping) return null;
        const { imgOffsetX, imgOffsetY, imgFracW, imgFracH, crop } = mapping;

        // Region position within the img's own box (source-crop compensated).
        const localX = (region.x - crop.originX) / crop.sizeX;
        const localY = (region.y - crop.originY) / crop.sizeY;
        const localW = region.w / crop.sizeX;
        const localH = region.h / crop.sizeY;
        if (localX + localW <= 0 || localY + localH <= 0 || localX >= 1 || localY >= 1) return null;

        const clippedX = Math.max(0, localX);
        const clippedY = Math.max(0, localY);
        const clippedW = Math.min(1, localX + localW) - clippedX;
        const clippedH = Math.min(1, localY + localH) - clippedY;

        // Then place that img-local box within the screen (letterbox offset).
        return {
            x: imgOffsetX + clippedX * imgFracW,
            y: imgOffsetY + clippedY * imgFracH,
            w: clippedW * imgFracW,
            h: clippedH * imgFracH,
        };
    }

    function setTouchModeArmed(next) {
        touchModeArmed = !!next && hasInteractiveAsset();
        renderRegionOverlay();
        updateTouchButton();
        if (!touchModeArmed && State.ui?.screen) State.ui.screen.style.cursor = '';
    }

    // ════════════════════════════════════════════════════════════════
    //  DOM: touch button + region overlay (hover highlight + tooltip)
    // ════════════════════════════════════════════════════════════════

    function ensureTouchButton() {
        const actions = State.ui?.vpWindow?.querySelector('#vp-screen-actions');
        if (!actions) return null;
        let btn = actions.querySelector('#vp-touch-toggle');
        if (!btn) {
            btn = document.createElement('button');
            btn.className = 'vp-btn vp-btn-ghost';
            btn.id = 'vp-touch-toggle';
            btn.title = 'Touch the asset (arms a single interaction)';
            btn.textContent = '🖐';
            btn.addEventListener('click', (e) => {
                e.stopPropagation();
                setTouchModeArmed(!touchModeArmed);
            });
            // Insert first so it reads left-to-right as "act on this asset"
            // ahead of the generic paste/clear actions.
            actions.insertBefore(btn, actions.firstChild);
        }
        return btn;
    }

    function updateTouchButton() {
        const btn = State.ui?.vpWindow?.querySelector('#vp-touch-toggle');
        if (!btn) return;
        const available = hasInteractiveAsset();
        btn.style.display = available ? '' : 'none';
        btn.classList.toggle('vp-btn-active', touchModeArmed);
        btn.classList.toggle('vp-btn-ghost', !touchModeArmed);
        btn.title = !available
            ? 'This asset has no interactive regions'
            : (touchModeArmed ? 'Touch armed — interact with a highlighted region now' : `Touch the asset (${currentRegions().length} region${currentRegions().length === 1 ? '' : 's'} available)`);
    }

    function ensureOverlay() {
        const screen = State.ui?.screen;
        if (!screen) return null;
        let overlay = screen.querySelector('.vp-interactive-overlay');
        if (!overlay) {
            overlay = document.createElement('div');
            overlay.className = 'vp-interactive-overlay';
            screen.appendChild(overlay);
        }
        return overlay;
    }

    function renderRegionOverlay() {
        const overlay = ensureOverlay();
        if (!overlay) return;
        overlay.innerHTML = '';
        overlay.style.display = touchModeArmed ? '' : 'none';
        if (!touchModeArmed) return;

        const mapping = computeRegionToScreenMapping();
        for (const region of currentRegions()) {
            const screenRect = regionToScreenRect(region, mapping);
            if (!screenRect) continue; // panned/zoomed off-screen right now

            const box = document.createElement('div');
            box.className = 'vp-interactive-region';
            box.dataset.regionId = region.id;
            box.style.left = `${screenRect.x * 100}%`;
            box.style.top = `${screenRect.y * 100}%`;
            box.style.width = `${screenRect.w * 100}%`;
            box.style.height = `${screenRect.h * 100}%`;
            box.title = region.label || region.id;

            const marker = document.createElement('div');
            marker.className = 'vp-interactive-region-marker';
            marker.textContent = regionIcon(region);
            box.appendChild(marker);

            overlay.appendChild(box);
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  HIT-TESTING + GESTURE CAPTURE
    //  Wired on #vp-screen alongside (and mutually exclusive with) the
    //  existing Focus Mode pan/zoom pointer handlers.
    // ════════════════════════════════════════════════════════════════

    function regionAtPoint(screen, region, mapping, clientX, clientY) {
        const rect = screen.getBoundingClientRect();
        const rx = (clientX - rect.left) / rect.width;
        const ry = (clientY - rect.top) / rect.height;
        const screenRect = regionToScreenRect(region, mapping);
        if (!screenRect) return null; // panned/zoomed off-screen right now
        const inside = rx >= screenRect.x && rx <= screenRect.x + screenRect.w && ry >= screenRect.y && ry <= screenRect.y + screenRect.h;
        return inside ? { rect, regionWidthPx: screenRect.w * rect.width, regionHeightPx: screenRect.h * rect.height } : null;
    }

    function findRegionAtPoint(screen, clientX, clientY) {
        const mapping = computeRegionToScreenMapping();
        for (const region of currentRegions()) {
            const hit = regionAtPoint(screen, region, mapping, clientX, clientY);
            if (hit) return { region, ...hit };
        }
        return null;
    }

    function wireScreenTouchInput(screen) {
        if (!screen || screen.dataset.interactiveWired === '1') return;
        screen.dataset.interactiveWired = '1';

        let active = null; // { region, regionWidthPx, regionHeightPx, startX, startY, startTime, lastX, lastY, lastDx, lastDy, reversals }

        // Capture-phase, so this runs BEFORE the Focus Mode pan/zoom handler
        // (registered later, in the normal bubble phase) gets a chance to
        // start a viewport drag. Mutually exclusive by mode: if touch mode
        // isn't armed, we do nothing at all and Focus Mode behaves exactly
        // as before this feature existed.
        screen.addEventListener('pointerdown', (event) => {
            if (!touchModeArmed) return;
            const hit = findRegionAtPoint(screen, event.clientX, event.clientY);
            if (!hit) return;
            active = {
                region: hit.region,
                regionWidthPx: hit.regionWidthPx,
                regionHeightPx: hit.regionHeightPx,
                startX: event.clientX,
                startY: event.clientY,
                startTime: Date.now(),
                lastDx: 0,
                lastDy: 0,
                reversals: 0,
            };
            screen.classList.add('vp-interactive-dragging');
            screen.setPointerCapture?.(event.pointerId);
            event.preventDefault();
            event.stopPropagation();
        }, true);

        screen.addEventListener('pointermove', (event) => {
            if (!active) return;
            const dx = event.clientX - active.startX;
            const dy = event.clientY - active.startY;
            // Count direction reversals on the dominant axis as a cheap proxy
            // for "repeats" (stroking back and forth), see module header.
            const dominantIsX = Math.abs(dx) >= Math.abs(dy);
            const prevSign = dominantIsX ? Math.sign(active.lastDx) : Math.sign(active.lastDy);
            const curSign = dominantIsX ? Math.sign(dx) : Math.sign(dy);
            if (prevSign !== 0 && curSign !== 0 && curSign !== prevSign) active.reversals++;
            active.lastDx = dx;
            active.lastDy = dy;
            event.preventDefault();
            event.stopPropagation();
        }, true);

        // Bubble-phase, passive cursor hint: which region-specific emoji
        // (tap/stroke/both — see regionIcon()) is under the pointer right
        // now. Purely cosmetic, never claims/cancels the event, so it can't
        // interfere with the capture-phase gesture handling above or with
        // Focus Mode's own pan/zoom cursor when touch mode isn't armed.
        screen.addEventListener('pointermove', (event) => {
            if (!touchModeArmed || active) return;
            const hit = findRegionAtPoint(screen, event.clientX, event.clientY);
            screen.style.cursor = hit ? regionCursor(hit.region) : '';
        });

        const finish = (event) => {
            if (!active) return;
            const dx = event.clientX - active.startX;
            const dy = event.clientY - active.startY;
            const durationMs = Math.max(1, Date.now() - active.startTime);
            const gesture = classifyGesture({
                dx, dy, durationMs,
                regionWidthPx: active.regionWidthPx,
                regionHeightPx: active.regionHeightPx,
                reversals: active.reversals,
            });
            const tag = buildTouchTag(active.region.id, gesture);
            handleTouchResolved(active.region, gesture, tag);

            screen.classList.remove('vp-interactive-dragging');
            try { screen.releasePointerCapture?.(event.pointerId); } catch {}
            active = null;
            // Single-shot: disarm after one resolved interaction (module
            // header / project decision: deliberate, one action at a time).
            setTouchModeArmed(false);
        };
        screen.addEventListener('pointerup', finish, true);
        screen.addEventListener('pointercancel', () => {
            if (!active) return;
            screen.classList.remove('vp-interactive-dragging');
            active = null;
            setTouchModeArmed(false);
        }, true);
    }

    function handleTouchResolved(region, gesture, tag) {
        if (!region.allowedInputs || region.allowedInputs.includes(gesture.type)) {
            const { manifestText } = queueTouchInteraction(region, gesture, tag) || {};
            VP.showToast?.(`🖐 ${humanizeGesture(region, gesture)}`, 'success');

            // Symmetric "gaze" fast path: if Auto-React is armed the same way
            // gaze auto-reactions are, fire the interaction immediately
            // instead of waiting for the user to send a message. Both paths
            // share the exact same cooldown gate in projector-session.js —
            // see triggerAutoReact() there — so a deliberate touch can never
            // spam the model more than the passive gaze timer already could.
            try {
                window.VP_HUB?.emit?.('interactive:touch', {
                    manifestText,
                    toastText: `${region.label || region.id} заметил(а) прикосновение...`,
                }, { moduleId: 'interactive' });
            } catch (err) {
                console.warn('[VP Interactive] hub emit interactive:touch failed:', err);
            }
        } else {
            VP.showToast?.(`This region only accepts: ${region.allowedInputs.join(', ')}`, 'info');
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  MODEL-FACING SYMMETRY
    //  Same [TOUCH:...] vocabulary the user's gesture produces above is
    //  parsed here so the model can touch the USER'S on-screen avatar (or
    //  any other interactive asset) with the exact same command shape.
    // ════════════════════════════════════════════════════════════════

    function registerTouchCommand() {
        if (!VP.commands?.register || VP.commands?.has?.('TOUCH')) return;
        VP.commands.register('TOUCH', {
            target: 'interactive',
            description: 'Touch an interactive region: [TOUCH:regionId:tap|stroke:direction?:amplitude:tempo:xRepeats?]',
            queueable: false,
            handler(cmd) {
                const parts = String(cmd.body || '').split(':').map(p => p.trim()).filter(Boolean);
                const [regionId, typeRaw, ...restRaw] = parts;
                const type = String(typeRaw || '').toLowerCase();
                const rest = restRaw.map(p => p.toLowerCase());
                if (!regionId || !type) return { ok: false, error: 'TOUCH requires at least regionId:type' };
                const region = currentRegions().find(r => r.id === regionId) || { id: regionId, label: regionId };
                const repeatsToken = rest.find(p => /^x\d+$/i.test(p));
                const repeats = repeatsToken ? Number(repeatsToken.slice(1)) : 1;
                const direction = rest.find(p => ['up', 'down', 'left', 'right'].includes(p)) || null;
                const amplitude = rest.find(p => ['light', 'firm'].includes(p)) || 'light';
                const tempo = rest.find(p => ['slow', 'fast'].includes(p)) || 'slow';
                const gesture = { type, direction, amplitude, tempo, repeats };
                VP.showToast?.(`🤖 ${humanizeGesture(region, gesture)}`, 'info');
                return { ok: true, region: region.id, gesture };
            },
        });
    }

    function registerInteractivePromptProvider() {
        if (!VP.registerPromptProvider) return;
        VP.registerPromptProvider({
            id: 'interactive-regions-context',
            order: 16, // right after active-game-context (order: 15)
            build() {
                const regions = currentRegions();
                if (!regions.length) return '';
                const lines = ['[INTERACTIVE REGIONS AVAILABLE]'];
                for (const region of regions) {
                    const kinds = (region.allowedInputs && region.allowedInputs.length) ? region.allowedInputs.join('/') : 'tap/stroke';
                    lines.push(`- ${region.id}: "${region.label || region.id}" — ${kinds}`);
                }
                lines.push('Use [TOUCH:<regionId>:<tap|stroke>:<direction?>:<amplitude:light|firm>:<tempo:slow|fast>:<xRepeats?>] to touch the user\'s character in return. <regionId> MUST be one of the exact ids listed above (e.g. "hair_left"), never a body part or object name of your own choosing — the tag only encodes WHERE and the physical shape of the gesture, never WHAT you are touching with (hand, lips, tail, an object, etc.) or WHY. Convey that entirely in your narration around the tag, exactly as you would describe any other action.');
                return lines.join('\n');
            },
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  VISUAL REGION EDITOR — draw / move / resize rectangles on the
    //  asset's own image, with a per-region property panel. Opened from
    //  the 🖐 button on each gallery card (projector-gallery.js). Writes
    //  through gallery.setInteractiveRegions() — the same validated entry
    //  point the manual console workflow uses, so there is exactly one
    //  code path that can persist regions, editor or not.
    // ════════════════════════════════════════════════════════════════

    let _regionEditorBackdrop = null;
    let _regionEditorEscHandler = null;

    function closeRegionEditor() {
        if (_regionEditorBackdrop) { _regionEditorBackdrop.remove(); _regionEditorBackdrop = null; }
        if (_regionEditorEscHandler) { document.removeEventListener('keydown', _regionEditorEscHandler, true); _regionEditorEscHandler = null; }
    }

    function makeRegionId(existingIds) {
        let n = existingIds.size + 1;
        while (existingIds.has(`region_${n}`)) n++;
        return `region_${n}`;
    }

    function openRegionEditor(tag) {
        closeRegionEditor();
        const gallery = VP.gallery;
        const data = gallery?.getAssetForRegionEditor?.(tag);
        if (!data || !data.src) {
            VP.showToast?.('Could not load this asset for editing', 'error');
            return;
        }

        // Work on a local copy; only committed to the asset on Save.
        let regions = data.regions.map(r => ({ ...r, allowedInputs: [...(r.allowedInputs || ['tap', 'stroke'])] }));
        let selectedId = regions[0]?.id || null;

        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop global vp-interactive-editor-modal';
        backdrop.style.setProperty('--vp-modal-width', '840px');

        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card vp-interactive-editor-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">🖐 Interactive Regions — ${data.label}</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-region-editor-layout">
                    <div class="vp-region-editor-canvas-wrap">
                        <img class="vp-region-editor-img" src="${data.src}" draggable="false" alt="${tag}">
                        <div class="vp-region-editor-overlay"></div>
                        <div class="vp-region-editor-hint">Drag on the image to draw a new region.</div>
                    </div>
                    <div class="vp-region-editor-panel">
                        <div class="vp-region-editor-list"></div>
                        <div class="vp-region-editor-props" style="display:none;">
                            <label><span>Label (shown to the model)</span><input data-k="label" type="text" placeholder="e.g. hair, cheek, lever handle"></label>
                            <label><span>Region id</span><input data-k="id" type="text" placeholder="unique_id"></label>
                            <div class="vp-region-editor-inputs">
                                <span>Allowed input</span>
                                <label class="vp-region-editor-check"><input data-k="allow-tap" type="checkbox"><span>tap</span></label>
                                <label class="vp-region-editor-check"><input data-k="allow-stroke" type="checkbox"><span>stroke</span></label>
                            </div>
                            <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="delete-region">✕ Delete region</button>
                        </div>
                        <div class="vp-region-editor-note">Coordinates are stored normalized (0..1), so regions stay correct if the image is redisplayed at any size.</div>
                    </div>
                </div>
            </div>
            <div class="vp-shell-modal-foot">
                <button class="vp-btn vp-btn-ghost" data-act="cancel">Cancel</button>
                <button class="vp-btn" data-act="save">Save</button>
            </div>`;

        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        _regionEditorBackdrop = backdrop;

        const canvasWrap = card.querySelector('.vp-region-editor-canvas-wrap');
        const overlay = card.querySelector('.vp-region-editor-overlay');
        const list = card.querySelector('.vp-region-editor-list');
        const props = card.querySelector('.vp-region-editor-props');
        const hint = card.querySelector('.vp-region-editor-hint');

        function boxEl(region) {
            return overlay.querySelector(`[data-region-id="${CSS.escape(region.id)}"]`);
        }

        function renderList() {
            list.innerHTML = '';
            if (!regions.length) {
                list.innerHTML = `<div class="vp-region-editor-empty">No regions yet — drag on the image to draw one.</div>`;
            }
            for (const r of regions) {
                const row = document.createElement('div');
                row.className = 'vp-region-editor-list-item' + (r.id === selectedId ? ' active' : '');
                row.textContent = r.label || r.id;
                row.addEventListener('click', () => selectRegion(r.id));
                list.appendChild(row);
            }
        }

        function renderProps() {
            const region = regions.find(r => r.id === selectedId);
            props.style.display = region ? '' : 'none';
            if (!region) return;
            props.querySelector('[data-k="label"]').value = region.label || '';
            props.querySelector('[data-k="id"]').value = region.id || '';
            props.querySelector('[data-k="allow-tap"]').checked = region.allowedInputs.includes('tap');
            props.querySelector('[data-k="allow-stroke"]').checked = region.allowedInputs.includes('stroke');
        }

        function renderOverlay() {
            overlay.innerHTML = '';
            for (const region of regions) {
                const box = document.createElement('div');
                box.className = 'vp-region-editor-box' + (region.id === selectedId ? ' selected' : '');
                box.dataset.regionId = region.id;
                box.style.left = `${region.x * 100}%`;
                box.style.top = `${region.y * 100}%`;
                box.style.width = `${region.w * 100}%`;
                box.style.height = `${region.h * 100}%`;
                box.title = region.label || region.id;

                box.addEventListener('pointerdown', (e) => {
                    if (e.target !== box) return; // let handles handle their own drags
                    e.stopPropagation();
                    selectRegion(region.id);
                    startMove(region, e);
                });

                for (const corner of ['nw', 'ne', 'sw', 'se']) {
                    const handle = document.createElement('div');
                    handle.className = `vp-region-editor-handle ${corner}`;
                    handle.addEventListener('pointerdown', (e) => {
                        e.stopPropagation();
                        selectRegion(region.id);
                        startResize(region, corner, e);
                    });
                    box.appendChild(handle);
                }
                overlay.appendChild(box);
            }
        }

        function selectRegion(id) {
            selectedId = id;
            renderList();
            renderProps();
            renderOverlay();
        }

        function wrapRect() { return canvasWrap.getBoundingClientRect(); }
        const clamp01 = (v) => Math.max(0, Math.min(1, v));

        function startMove(region, downEvent) {
            const rect = wrapRect();
            const startX = region.x, startY = region.y;
            const pointerStartX = downEvent.clientX, pointerStartY = downEvent.clientY;
            const onMove = (e) => {
                const dx = (e.clientX - pointerStartX) / rect.width;
                const dy = (e.clientY - pointerStartY) / rect.height;
                region.x = clamp01(Math.min(1 - region.w, Math.max(0, startX + dx)));
                region.y = clamp01(Math.min(1 - region.h, Math.max(0, startY + dy)));
                renderOverlay();
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        }

        function startResize(region, corner, downEvent) {
            const rect = wrapRect();
            const start = { x: region.x, y: region.y, w: region.w, h: region.h };
            const pointerStartX = downEvent.clientX, pointerStartY = downEvent.clientY;
            const MIN = 0.02;
            const onMove = (e) => {
                const dx = (e.clientX - pointerStartX) / rect.width;
                const dy = (e.clientY - pointerStartY) / rect.height;
                let { x, y, w, h } = start;
                if (corner.includes('e')) w = Math.max(MIN, start.w + dx);
                if (corner.includes('s')) h = Math.max(MIN, start.h + dy);
                if (corner.includes('w')) { w = Math.max(MIN, start.w - dx); x = start.x + start.w - w; }
                if (corner.includes('n')) { h = Math.max(MIN, start.h - dy); y = start.y + start.h - h; }
                x = clamp01(x); y = clamp01(y);
                w = Math.min(w, 1 - x); h = Math.min(h, 1 - y);
                Object.assign(region, { x, y, w, h });
                renderOverlay();
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        }

        // Draw a brand-new region by dragging on empty canvas space.
        canvasWrap.addEventListener('pointerdown', (e) => {
            if (e.target !== canvasWrap && e.target.closest('.vp-region-editor-box')) return;
            const rect = wrapRect();
            const startX = clamp01((e.clientX - rect.left) / rect.width);
            const startY = clamp01((e.clientY - rect.top) / rect.height);
            const draftId = makeRegionId(new Set(regions.map(r => r.id)));
            const draft = { id: draftId, shape: 'rect', x: startX, y: startY, w: 0.001, h: 0.001, label: draftId, allowedInputs: ['tap', 'stroke'] };
            regions.push(draft);
            hint.style.display = 'none';

            const onMove = (ev) => {
                const curX = clamp01((ev.clientX - rect.left) / rect.width);
                const curY = clamp01((ev.clientY - rect.top) / rect.height);
                draft.x = Math.min(startX, curX);
                draft.y = Math.min(startY, curY);
                draft.w = Math.max(0.005, Math.abs(curX - startX));
                draft.h = Math.max(0.005, Math.abs(curY - startY));
                renderOverlay();
            };
            const onUp = () => {
                document.removeEventListener('pointermove', onMove);
                document.removeEventListener('pointerup', onUp);
                // A near-zero-size drag (an accidental click) is discarded
                // rather than kept as a tiny, unusable region.
                if (draft.w < 0.015 && draft.h < 0.015) {
                    regions = regions.filter(r => r.id !== draftId);
                } else {
                    selectedId = draftId;
                }
                renderList();
                renderProps();
                renderOverlay();
            };
            document.addEventListener('pointermove', onMove);
            document.addEventListener('pointerup', onUp);
        });

        props.querySelector('[data-k="label"]').addEventListener('input', (e) => {
            const region = regions.find(r => r.id === selectedId);
            if (region) { region.label = e.target.value; renderList(); renderOverlay(); }
        });
        props.querySelector('[data-k="id"]').addEventListener('change', (e) => {
            const region = regions.find(r => r.id === selectedId);
            if (!region) return;
            const nextId = String(e.target.value || '').trim().replace(/\s+/g, '_');
            if (!nextId || regions.some(r => r.id === nextId && r !== region)) {
                VP.showToast?.('Region id must be unique and non-empty', 'error');
                e.target.value = region.id;
                return;
            }
            region.id = nextId;
            selectedId = nextId;
            renderList();
            renderOverlay();
        });
        props.querySelector('[data-k="allow-tap"]').addEventListener('change', (e) => {
            const region = regions.find(r => r.id === selectedId);
            if (!region) return;
            region.allowedInputs = e.target.checked
                ? [...new Set([...region.allowedInputs, 'tap'])]
                : region.allowedInputs.filter(k => k !== 'tap');
        });
        props.querySelector('[data-k="allow-stroke"]').addEventListener('change', (e) => {
            const region = regions.find(r => r.id === selectedId);
            if (!region) return;
            region.allowedInputs = e.target.checked
                ? [...new Set([...region.allowedInputs, 'stroke'])]
                : region.allowedInputs.filter(k => k !== 'stroke');
        });
        props.querySelector('[data-act="delete-region"]').addEventListener('click', () => {
            regions = regions.filter(r => r.id !== selectedId);
            selectedId = regions[0]?.id || null;
            renderList();
            renderProps();
            renderOverlay();
        });

        const close = () => closeRegionEditor();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        card.querySelector('[data-act="cancel"]').addEventListener('click', close);
        card.querySelector('[data-act="save"]').addEventListener('click', () => {
            // Guard against an empty label sneaking through (id is always
            // enforced non-empty/unique above at edit time).
            const clean = regions.map(r => ({ ...r, label: (r.label || r.id).trim() || r.id }));
            const result = gallery?.setInteractiveRegions?.(data.tag, clean);
            if (result?.ok) {
                VP.showToast?.(`Saved ${result.regionCount} region${result.regionCount === 1 ? '' : 's'}`, 'success');
                close();
            } else {
                VP.showToast?.('Failed to save regions — see console for details', 'error');
            }
        });
        _regionEditorEscHandler = (e) => { if (e.key === 'Escape') close(); };
        setTimeout(() => document.addEventListener('keydown', _regionEditorEscHandler, true), 0);

        if (!regions.length) hint.style.display = '';
        renderList();
        renderProps();
        renderOverlay();
    }

    // ════════════════════════════════════════════════════════════════
    //  BOOT
    // ════════════════════════════════════════════════════════════════

    async function boot() {
        if (VP.ready) await VP.ready;
        registerTouchCommand();
        registerInteractivePromptProvider();

        const screen = State.ui?.screen;
        if (screen) wireScreenTouchInput(screen);
        ensureTouchButton();
        updateTouchButton();
        renderRegionOverlay();

        // Keep the button/overlay honest across asset switches without
        // requiring every call site that changes State.current to know
        // about this module — hub event is optional/best-effort.
        window.VP_HUB?.on?.('projector:current-changed', () => {
            setTouchModeArmed(false); // new asset: require a fresh, deliberate arm
            ensureTouchButton();
            updateTouchButton();
        }, { moduleId: 'interactive' });

        console.log('[VP Interactive] ready — Interactive Regions module registered.');
    }

    window.VisualProjector.interactive = {
        classifyGesture, buildTouchTag, // exported for future region-editor/tests
        hasInteractiveAsset, setTouchModeArmed,
        openRegionEditor, closeRegionEditor,
        // Called by gallery.setInteractiveRegions() when regions change on
        // the currently-displayed asset, so the button/overlay reflect the
        // edit immediately without requiring a re-select of the asset.
        refresh() { ensureTouchButton(); updateTouchButton(); renderRegionOverlay(); },
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { boot().catch(err => console.error('[VP Interactive] boot failed:', err)); });
    } else {
        setTimeout(() => { boot().catch(err => console.error('[VP Interactive] boot failed:', err)); }, 0);
    }
})();
