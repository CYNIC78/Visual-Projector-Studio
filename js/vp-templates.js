// ╔══════════════════════════════════════════════════════════════════╗
// ║  vp-templates.js                                                 ║
// ║  Visual Projector — Engine satellite: TEMPLATE ENGINE            ║
// ║  (scene manifest · frame context · prompt-template mini-DSL)     ║
// ║                                                                  ║
// ║  Owns: DEFAULT_MANIFEST_TEMPLATE / DEFAULT_FRAME_TEMPLATE,       ║
// ║        the {{var}} / {{#if flag}} mini-templater                 ║
// ║        (renderTemplate, nested-if resolution), buildManifest()   ║
// ║        (gallery tree + FX catalog + collage block + camera       ║
// ║        controls appendix in Focus Mode), buildCollagePromptData, ║
// ║        buildVisualContextFrames / buildFrameContextPreview,      ║
// ║        TEMPLATE_VARS and the settings-UI prompt helpers          ║
// ║        (updatePromptHints / updateTemplateStatus /               ║
// ║        insertAtCursor / escapeAttr), plus isAssetReady.          ║
// ║                                                                  ║
// ║  Extracted from visual-projector.js (v07 refactor) — the block   ║
// ║  below is BYTE-VERBATIM, incl. its original 4-space indent.      ║
// ║  Do not reindent / "beautify": it must stay diff-verifiable      ║
// ║  against backups/06-extract-director-bus.zip.                    ║
// ║                                                                  ║
// ║  Load order: visual-projector.js → vp-templates.js               ║
// ║  (the VP facade is assembled at the end of visual-projector.js;  ║
// ║   this module captures it and registers window.VP_TEMPLATES.     ║
// ║   The engine keeps name-preserving delegates, so every internal  ║
// ║   call-site and the VP.* facade API behave exactly as before).   ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error(
            '[VP Templates] window.VisualProjector not found.\n' +
            'Load visual-projector.js BEFORE vp-templates.js.'
        );
        return;
    }

    const State = VP.state;       // shared engine state (by reference)

    // ── ENGINE FACADE ALIASES (byte-verbatim body below) ────────────────────
    // Both live in visual-projector.js and are exported on the facade; every
    // other dependency of this module is a runtime global (State, FX, document).
    const getProjectorViewportState = (...a) => VP.getProjectorViewportState(...a);
    const schedulePersist = (...a) => VP.schedulePersist?.(...a);

    function isAssetReady(asset) {
        return !!(asset.description && asset.description.trim().length > 0);
    }

    // ════════════════════════════════════════════════════════════════
    //  TEMPLATE  (manifest + frame context builder)
    // ════════════════════════════════════════════════════════════════

    const DEFAULT_MANIFEST_TEMPLATE =
`[SCENE CONTROL]
{{#if hasGallery}}You are an improv actor playing out a seamless narrative using the provided assets. Match the visual style and emotional tone of the assets while progressing the scene

Use [IMG:tag] to cut to a frame.

GUIDELINES:
- The active frame is the scene's live visual — let it inspire and ground what happens next.
- Pick one or more [IMG:tag] from the frame list to illustrate actions or emotions.
- Put [IMG:tag] before the lines that match that frame.
- Don't use same tags in a row.

{{/if}}{{#if hasReady}}AVAILABLE FRAMES (tag — description):
{{assetsList}}
{{#if isCollageActive}}
[CURRENT GALLERY VIEW]
{{#if collageTitle}}Title: {{collageTitle}}
{{/if}}{{#if collageDescription}}Director note: {{collageDescription}}
{{/if}}Visible tabs: {{collageSections}}

This image shows the current gallery view available for choosing scene frames.
It may change when tabs are opened or collapsed.
Preview cards are grouped by "TAB: <Name>". Use a preview card's [IMG:tag] label only when you want to switch the visible scene frame.
{{#if allowDirectoryCommands}}{{collageNavNote}}{{/if}}
{{/if}}

{{/if}}{{#if hasEffects}}VISUAL EFFECTS:
Trigger an effect that overlays the current frame: insert [FX:name] and it fires automatically. Optional intensity 1-10: [FX:name:8] (default 5). Effects fade on their own; a new one replaces the active effect. Use them sparingly, only when they fit the moment.

Available effects:
{{/if}}{{#if hasTransient}}{{effectsList}}
{{/if}}{{#if hasMood}}{{moodList}}
{{/if}}{{#if hasGallery}}
Projector frame: {{currentTag}}
{{/if}}[/SCENE CONTROL]`;

    const DEFAULT_FRAME_TEMPLATE =
`[STAGE — frame {{n}} of {{total}}, {{position}}]
The scene's current visual. Let it ground and inspire what happens next.
Frame: {{tag}} ({{source}})`;

    function renderTemplate(template, data) {
        try {
            let result = template;
            
            // To properly handle nested blocks like {{#if isCollageActive}}...{{#if collageTitle}}...{{/if}}...{{/if}}
            // we must process the inner-most blocks FIRST.
            // Since JS regex engine does not natively support recursive matching out of the box easily,
            // the safest robust approach for our specific hardcoded keys is to resolve them explicitly from inside out.
            
            // Inner level 1
            result = result.replace(/\{\{#if\s+allowDirectoryCommands\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, content) => data.allowDirectoryCommands ? content : '');
            result = result.replace(/\{\{#if\s+collageTitle\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, content) => data.collageTitle ? content : '');
            result = result.replace(/\{\{#if\s+collageDescription\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, content) => data.collageDescription ? content : '');
            
            // Outer level
            result = result.replace(/\{\{#if\s+isCollageActive\}\}([\s\S]*?)\{\{\/if\}\}/g, (_, content) => data.isCollageActive ? content : '');
            
            // Fallback for everything else (using a do-while loop to catch remaining non-nested ones)
            let prev;
            do {
                prev = result;
                // Important: Use lazy matching and ensure no inner {{#if}} exists in the captured group
                result = result.replace(/\{\{#if\s+(\w+)\}\}((?:(?:(?!\{\{#if\s+\w+\}\})[\s\S])*?))\{\{\/if\}\}/g, (_, key, content) => data[key] ? content : '');
            } while (result !== prev);
            
            // Values replacement
            result = result.replace(/\{\{(\w+)\}\}/g, (match, key) => data[key] !== undefined ? String(data[key]) : match);
            return result;
        } catch (err) {
            console.warn('[VP] Template render failed:', err);
            return null;
        }
    }

    const TEMPLATE_VARS = {
        manifest: {
            '{{currentTag}}':   'tag of the asset currently on the projector frame',
            '{{collageNavNote}}': 'scene-navigation hint for the collage block (short pointer when GALLERY NAVIGATION preamble is present, full grammar otherwise)',
            '{{assetsList}}':   'list of tagged assets (with descriptions if enabled)',
            '{{pendingList}}':  'list of untagged assets',
            '{{galleryCount}}': 'total number of assets',
            '{{readyCount}}':   'number of tagged assets',
            '{{pendingCount}}': 'number of untagged assets',
            '{{effectsList}}':  'list of transient effects available to the bot',
            '{{moodList}}':     'list of mood effects available to the bot',
            '{{#if hasGallery}}...{{/if}}': 'shown only if the gallery has assets',
            '{{#if hasReady}}...{{/if}}':   'shown only if there are tagged assets',
            '{{#if hasPending}}...{{/if}}': 'shown only if there are untagged assets',
            '{{#if noReady}}...{{/if}}':    'shown only if no tagged assets exist',
            '{{#if hasEffects}}...{{/if}}': 'shown only if any effect is available to the bot',
            '{{#if hasTransient}}...{{/if}}': 'shown only if a transient effect is available',
            '{{#if hasMood}}...{{/if}}':      'shown only if a mood effect is available',
        },
        frame: {
            '{{n}}':        'frame number in history (1-based)',
            '{{total}}':    'total frames in history',
            '{{position}}': '"CURRENT ACTIVE frame" or "previous frame"',
            '{{tag}}':      'tag of this frame\'s asset',
            '{{source}}':   'who set this shot',
        },
    };

    function updatePromptHints(textarea, type) {
        const hintsEl = textarea.parentElement.querySelector('.vp-prompt-hints');
        if (!hintsEl) return;
        const content = textarea.value;
        const allVars = TEMPLATE_VARS[type] || {};
        const used = [], unused = [];
        for (const [varName, description] of Object.entries(allVars)) {
            const checkStr = varName.startsWith('{{#if') ? varName.match(/\{\{#if\s+\w+\}\}/)[0] : varName;
            if (content.includes(checkStr)) used.push({ name: varName, desc: description });
            else unused.push({ name: varName, desc: description });
        }
        const usedHTML = used.length > 0
            ? `<div class="vp-hints-section"><div class="vp-hints-title">✓ Using:</div>${used.map(v => `<code class="vp-hint-used" title="${v.desc}">${v.name}</code>`).join(' ')}</div>`
            : '';
        const unusedHTML = unused.length > 0
            ? `<div class="vp-hints-section"><div class="vp-hints-title">+ Available (click to insert):</div>${unused.map(v => `<code class="vp-hint-available" data-insert="${escapeAttr(v.name)}" title="${v.desc}">${v.name}</code>`).join(' ')}</div>`
            : '';
        hintsEl.innerHTML = usedHTML + unusedHTML;
        hintsEl.querySelectorAll('.vp-hint-available').forEach(el => {
            el.addEventListener('click', () => {
                insertAtCursor(textarea, el.dataset.insert);
                textarea.focus();
                updatePromptHints(textarea, type);
                if (type === 'manifest') State.config.prompts.manifest = textarea.value.trim() || null;
                else State.config.prompts.frameContext = textarea.value.trim() || null;
                schedulePersist?.();
            });
        });
    }

    function updateTemplateStatus(textarea) {
        const section = textarea.closest('.vp-prompt-section');
        if (!section) return;
        let badge = section.querySelector('.vp-prompt-badge');
        if (!badge) {
            badge = document.createElement('span');
            badge.className = 'vp-prompt-badge';
            section.querySelector('.vp-prompt-label span').appendChild(badge);
        }
        const isDefault = textarea.dataset.isDefault === 'true';
        badge.textContent = isDefault ? ' · default' : ' · custom';
        badge.classList.toggle('vp-prompt-badge-default', isDefault);
        badge.classList.toggle('vp-prompt-badge-custom', !isDefault);
    }

    function insertAtCursor(textarea, text) {
        const start = textarea.selectionStart;
        const end   = textarea.selectionEnd;
        const value = textarea.value;
        textarea.value = value.substring(0, start) + text + value.substring(end);
        textarea.selectionStart = textarea.selectionEnd = start + text.length;
    }

    function escapeAttr(str) {
        return String(str).replace(/"/g, '&quot;').replace(/</g, '&lt;');
    }

    function buildManifest(templateOverride = null) {
        const fxEnabled = (typeof FX !== 'undefined') && FX.enabled;
        if (State.gallery.size === 0 && !fxEnabled) return '';

        const currentTag = State.current ? State.current.tag : 'none';
        const allAssets = Array.from(State.gallery.values()).filter(a => !a.hidden && a.tag !== '__SCENERY_COLLAGE__');
        const activeCollageAsset = State.coverTag === '__SCENERY_COLLAGE__' ? State.gallery.get('__SCENERY_COLLAGE__') : null;
        const activeCollageTags = new Set((activeCollageAsset?.collageMeta?.tabs || [])
            .flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []));
        const hasActiveCollageFilter = activeCollageTags.size > 0;
        const isInActiveCollage = (asset) => !hasActiveCollageFilter || asset?.tag === '__SCENERY_COLLAGE__' || activeCollageTags.has(asset?.tag);

        let treeList = '';
        let readyCount = 0;
        let pendingCount = 0;

        const hasCollapsibles = State.config.allowDirectoryCommands && State.galleryData &&
            (State.galleryData.categories.some(c => c.state !== 'locked') || State.galleryData.tabs.some(t => t.state !== 'locked'));
        if (hasCollapsibles) {
            treeList += `# GALLERY NAVIGATION\nSome gallery categories and tabs are collapsed below; enter scenes like rooms. [TAB:open:Name] pulls that tab's assets into your NEXT turn and closes the other tabs for you (one scene open at a time). [CAT:open:Name] reveals a whole pack of scenes at once; [CAT:close:Name] packs it away.\n`;
        }

        const processedTags = new Set();

        if (State.galleryData && State.galleryData.categories) {
            for (const cat of State.galleryData.categories) {
                if (cat.state === 'locked') {
                    const lockedTabs = State.galleryData.tabs.filter(t => t.categoryId === cat.id);
                    lockedTabs.forEach(tab => { allAssets.filter(a => a.tabId === tab.id).forEach(a => processedTags.add(a.tag)); });
                    continue;
                }
                const catTabs = State.galleryData.tabs.filter(t => {
                    if (t.categoryId === cat.id) {
                        if (t.state === 'locked') { allAssets.filter(a => a.tabId === t.id).forEach(a => processedTags.add(a.tag)); return false; }
                        return true;
                    }
                    return false;
                });
                if (catTabs.length === 0) continue;

                if (cat.state === 'collapsed') {
                    let catAssetsTotal = 0;
                    catTabs.forEach(tab => {
                        const tabAssets = allAssets.filter(a => a.tabId === tab.id);
                        catAssetsTotal += tabAssets.length;
                        tabAssets.forEach(a => processedTags.add(a.tag));
                    });
                    if (State.config.allowDirectoryCommands) {
                        catTabs.forEach(tab => { allAssets.filter(a => a.tabId === tab.id).forEach(a => isAssetReady(a) ? readyCount++ : pendingCount++); });
                        treeList += `\n# 📦 Category: ${cat.name} — collapsed (${catTabs.length} tabs, ${catAssetsTotal} assets)${cat.desc ? ' — '+cat.desc : ''}. Request with [CAT:open:${cat.name}].\n`;
                    }
                    continue;
                }

                treeList += `\n# 📁 Category: ${cat.name}${cat.desc ? ' — '+cat.desc : ''}\n`;
                for (const tab of catTabs) {
                    const tabAssets = allAssets.filter(a => a.tabId === tab.id);
                    if (tab.state === 'collapsed') {
                        tabAssets.forEach(a => processedTags.add(a.tag));
                        if (State.config.allowDirectoryCommands) {
                            tabAssets.forEach(a => isAssetReady(a) ? readyCount++ : pendingCount++);
                            treeList += `  ▸ Tab: ${tab.name} — collapsed (${tabAssets.length} assets)${tab.desc ? ' — '+tab.desc : ''}. Request with [TAB:open:${tab.name}].\n`;
                        }
                    } else {
                        const isCollageActive = (State.coverTag === '__SCENERY_COLLAGE__');
                        const visibleTabAssets = tabAssets.filter(isInActiveCollage);
                        const tabIsRepresentedInCollage = hasActiveCollageFilter && visibleTabAssets.length > 0;
                        const tabHiddenByContactSheet = isCollageActive && hasActiveCollageFilter && !tabIsRepresentedInCollage;

                        if (tabHiddenByContactSheet) {
                            // The tab is open in the gallery UI, but not part of the current
                            // Gallery View. Do not leak even its tab name unless directory
                            // navigation hints are explicitly enabled.
                            tabAssets.forEach(a => processedTags.add(a.tag));
                            if (State.config.allowDirectoryCommands) {
                                treeList += `  ▸ Tab: ${tab.name}:${tab.desc ? ' '+tab.desc : ''}\n`;
                                treeList += `    [not part of the current Gallery View — ${tabAssets.length} asset(s) hidden; name kept as a navigation hint]\n`;
                            }
                        } else {
                            treeList += `  ▸ Tab: ${tab.name}:${tab.desc ? ' '+tab.desc : ''}\n`;
                            // v27 active-state law fallback (docs/tab-fsm-design.md §8): the collage's
                            // text companion carries rules only while a Gallery View is on display —
                            // without it, the open tab's rules ride the manifest instead.
                            // Exclusive-or by design: no double pay in tokens.
                            // FSM audit (2026-07-31): cap the fallback at 300 chars like the
                            // collage-note (COLLAGE_RULES_TAB_CAP) and entry-observation caps,
                            // so a long rules field cannot blow up the permanent manifest.
                            if (!isCollageActive && String(tab.rules || '').trim()) {
                                const _rules = String(tab.rules).trim();
                                treeList += `    [RULES: ${_rules.length > 300 ? _rules.slice(0, 299) + '…' : _rules}]\n`;
                            }
                            if (tabAssets.length === 0) treeList += `    (empty)\n`;
                            else if (isCollageActive && tabIsRepresentedInCollage) {
                                tabAssets.forEach(a => processedTags.add(a.tag));
                                visibleTabAssets.forEach(a => { if (isAssetReady(a)) readyCount++; else pendingCount++; });
                                treeList += `    [GALLERY VIEW ACTIVE — use the visible preview-card [IMG:tag] labels in the current Gallery View]\n`;
                            } else {
                                for (const a of tabAssets) {
                                    processedTags.add(a.tag);
                                    if (isAssetReady(a)) {
                                        treeList += State.config.manifestDescriptions ? `    ${a.tag} — ${a.description}\n` : `    ${a.tag}\n`;
                                        readyCount++;
                                    } else { treeList += `    ${a.tag}\n`; pendingCount++; }
                                }
                            }
                        }
                    }
                }
            }
        }

        let strayAssets = allAssets.filter(a => !processedTags.has(a.tag));
        if (hasActiveCollageFilter) strayAssets = strayAssets.filter(isInActiveCollage);
        if (strayAssets.length > 0) {
            treeList += `\n# 📁 Category: Uncategorized\n`;
            for (const a of strayAssets) {
                if (isAssetReady(a)) { treeList += State.config.manifestDescriptions ? `    ${a.tag} — ${a.description}\n` : `    ${a.tag}\n`; readyCount++; }
                else { treeList += `    ${a.tag}\n`; pendingCount++; }
            }
        }

        const transientEntries = fxEnabled ? Object.entries(FX.catalog) : [];
        const moodEntries      = fxEnabled ? Object.entries(FX.moodCatalog) : [];
        const fxLine = (name, info) => { const desc = (info.desc || '').trim(); return desc ? `  [FX:${name}] — ${desc}` : `  [FX:${name}]`; };
        const effectsList = transientEntries.map(([name, info]) => fxLine(name, info)).join('\n');
        const moodList    = moodEntries.map(([name, info]) => fxLine(name, info)).join('\n');
        const hasTransient = transientEntries.length > 0;
        const hasMood      = moodEntries.length > 0;
        const hasGallery = State.gallery.size > 0;

        const isCollageActive = (State.coverTag === '__SCENERY_COLLAGE__');
        let collageTitle = '';
        let collageDescription = '';
        let collageSections = 0;

        if (isCollageActive && activeCollageAsset) {
            // Source of truth: coverLabel + asset.description (+tabs summary).
            // collageMeta has NO title/description fields (v04 bugfix: these
            // lines previously read meta.title/meta.description — always empty,
            // so "Title:"/"Director note:" never reached the model).
            const collageData = buildCollagePromptData(activeCollageAsset.tag);
            collageTitle = collageData.collageTitle;
            collageDescription = collageData.collageDescription;
            collageSections = collageData.collageSections;
        }

        const data = {
            currentTag,
            assetsList: treeList.trim(),
            pendingList: '(See untagged items in tree above)',
            galleryCount: State.gallery.size,
            readyCount, pendingCount,
            hasGallery,
            hasReady: readyCount > 0 || pendingCount > 0,
            hasPending: pendingCount > 0,
            noReady: readyCount === 0 && pendingCount === 0,
            hasEffects: fxEnabled && (hasTransient || hasMood),
            hasTransient, hasMood, effectsList, moodList,
            isCollageActive,
            collageTitle,
            collageDescription,
            collageSections,
            allowDirectoryCommands: !!State.config.allowDirectoryCommands,
            // Manifest diet (2026-07-31): the GALLERY NAVIGATION preamble already
            // teaches the 4 scene verbs when any collapsible exists — repeating
            // them in the collage block was ~200 chars of pure duplication in
            // every request. When the tree preamble is absent we still teach the
            // full grammar here; otherwise a one-line pointer suffices.
            collageNavNote: State.config.allowDirectoryCommands
                ? (hasCollapsibles
                    ? '(Scene navigation: [TAB:open:name] / [CAT:open:name] / [CAT:close:name] — described in GALLERY NAVIGATION above.)'
                    : "You may enter scenes like rooms: [TAB:open:name] steps into a tab's scene — its assets join your NEXT turn and the other tabs close for you (one scene open at a time). [CAT:open:name] reveals a whole pack of scenes at once, and [CAT:close:name] packs it away.")
                : '',
        };

        const template = (templateOverride ?? State.config.prompts?.manifest) || DEFAULT_MANIFEST_TEMPLATE;
        let rendered = renderTemplate(template, data);
        if (rendered === null && (templateOverride || State.config.prompts?.manifest)) {
            rendered = renderTemplate(DEFAULT_MANIFEST_TEMPLATE, data);
        }

        // Dynamically inject camera controls manifest strictly in Focus Mode!
        if (getProjectorViewportState().enabled) {
            const cameraControlsManifest = `

[CAMERA CONTROLS]
The screen is in Focus Mode. You can smoothly pan and zoom the camera/projector screen to control the viewport and direct the viewer's attention.
To direct the camera, output [FOCUS:position] or [FOCUS:position:zoom] on a new line:
- Positions: top, middle, bottom, left, right, reset
- Optional zoom parameter: zoom (add ":zoom" to zoom in, omit to stay wide)

Examples:
- [FOCUS:top] — Focus on the top area (wide view).
- [FOCUS:bottom:zoom] — Focus on the bottom area (zoomed in).
- [FOCUS:left:zoom] — Zoom and pan to the left side.
- [FOCUS:reset] — Reset smoothly to the default wide, full view.

Use these camera controls on a new line to emphasize a dramatic shift, zoom in on details, or change perspective during your response!
[/CAMERA CONTROLS]`;
            rendered += cameraControlsManifest;
        }

        // v15 Gaze Attention Layer: optional live attention block (default off,
        // config.gazeManifestState) — tells the model WHERE the user's gaze
        // rests right now and for how long, enabling "gaze mirroring" play.
        // Note: window.VP_FOCUS registers later than this module, so this must
        // stay a runtime lookup, NOT a captured alias.
        if (State.config?.gazeManifestState) {
            const gazeState = window.VP_FOCUS?.getGazeState?.();
            if (gazeState?.enabled) {
                const dwellSec = Math.round((window.VP_FOCUS?.getGazeDwell?.() || 0) / 1000);
                rendered += `\n\n[GAZE STATE]\nThe user's gaze currently rests on region "${gazeState.region}" (x=${gazeState.x.toFixed(2)}, y=${gazeState.y.toFixed(2)}), zoom ${gazeState.zoom.toFixed(2)}x of [${gazeState.tag ?? 'the active frame'}]${dwellSec >= 4 ? ` — held for ${dwellSec}s` : ''}.\nUse this as live attention feedback: react to what the user is staring at, or steer attention elsewhere with [FOCUS:position:zoom].\n[/GAZE STATE]`;
            }
        }

        return rendered;
    }

    function buildCollagePromptData(tag) {
        const asset = State.gallery.get(tag);
        const meta = asset?.collageMeta || null;
        const tabs = Array.isArray(meta?.tabs) ? meta.tabs : [];
        const assetTags = tabs.flatMap(t => Array.isArray(t.assetTags) ? t.assetTags : []);
        const label = String(State.coverLabel || '').trim();
        const labelKey = label.toLowerCase();
        const collageTitle = label && !new Set(['cover', 'contact sheet', 'gallery view', 'current gallery view']).has(labelKey) ? label : '';
        const desc = String(asset?.description || '').trim();
        const descKey = desc.toLowerCase();
        const collageDescription = desc && descKey !== 'automatic scenery assets collage' ? desc : '';
        return {
            collageTitle,
            collageDescription,
            allowDirectoryCommands: !!State.config.allowDirectoryCommands,
            collageSignature: meta?.signature || meta?.generatedAt || 'not-recorded',
            collageSections: tabs.length
                ? tabs.map(t => `${t.name || 'tab'} (${Number(t.count || 0)} cards)`).join('; ')
                : '(sections are visible in the image)',
            collageAssetCount: Number(meta?.assetsCount || assetTags.length || 0) || 'unknown',
        };
    }

    function buildVisualContextFrames() {
        const depth = State.config.contextDepth;
        let frames = [];
        const hasCover = !!State.coverTag;
        const coverIsCurrent = !!(hasCover && State.current?.tag === State.coverTag);

        if (hasCover) {
            const cover = State.gallery.get(State.coverTag);
            if (cover) {
                frames.push({
                    tag: cover.tag,
                    blob: cover.blob,
                    url: cover.url,
                    thumbUrl: cover.thumbUrl,
                    filename: cover.filename || cover.tag,
                    source: 'cover',
                    collageMeta: cover.collageMeta || null,
                });
            }
        }

        // If the cover/contact-sheet is the active frame, older history should not
        // become the "CURRENT ACTIVE frame" after it. This was confusing small
        // vision models and could make them report stale assets as currently seen.
        if (!coverIsCurrent && depth > 0 && State.history.length > 0) {
            const history = State.history
                .slice(-depth)
                .filter(h => h && h.tag && (!State.coverTag || h.tag !== State.coverTag));
            frames = frames.concat(history);
        }

        return frames;
    }

    function buildFrameContextPreview(templateOverride = null) {
        const chosenTemplate = (templateOverride ?? State.config.prompts?.frameContext) || DEFAULT_FRAME_TEMPLATE;
        let frames = buildVisualContextFrames().map(h => ({ tag: h.tag, source: h.source, collageMeta: h.collageMeta || null }));
        if (frames.length === 0) frames = [{ tag: State.current?.tag || 'sample_tag', source: 'user' }];
        return frames.map((h, index) => {
            if (h.tag === '__SCENERY_COLLAGE__') return null; // collage descriptions are now part of the main manifest

            const isLast = index === frames.length - 1;
            const data = {
                n: index + 1, total: frames.length,
                position: isLast ? 'CURRENT ACTIVE frame' : 'previous frame',
                tag: h.tag,
                source: h.source === 'model' ? 'set by you' : 'set by the director',
            };
            let rendered = renderTemplate(chosenTemplate, data);
            if (rendered === null && templateOverride) rendered = renderTemplate(DEFAULT_FRAME_TEMPLATE, data);
            return rendered;
        }).filter(Boolean).join('\n\n---\n\n');
    }

    // ════════════════════════════════════════════════════════════════
    //  v27 — ACTIVE-STATE LAW (docs/tab-fsm-design.md §8; owner channel
    //  decision: text part, not paint). Tabs may carry a `rules` field —
    //  the law of the ACTIVE state. The Gallery View's collage context
    //  message (image) gets a text companion listing the rules of the
    //  scenes currently on display (= marked tabs), so state image and
    //  state law travel as ONE message right after the system prompt.
    //  Diet: built ONLY when at least one displayed tab has rules —
    //  otherwise the message stays image-only (zero diff, zero tokens).
    // ════════════════════════════════════════════════════════════════
    const COLLAGE_RULES_TAB_CAP = 300;
    const COLLAGE_RULES_TOTAL_CAP = 900;

    function buildCollageRulesNote(galleryData) {
        const tabs = Array.isArray(galleryData?.tabs) ? galleryData.tabs : [];
        const cats = Array.isArray(galleryData?.categories) ? galleryData.categories : [];
        const entries = [];
        for (const tab of tabs) {
            if (!tab?.markedForCollage) continue;
            const rules = String(tab.rules || '').trim();
            if (!rules) continue;
            const pack = (cats.find(c => c.id === tab.categoryId)?.name || '').trim();
            const clipped = rules.length > COLLAGE_RULES_TAB_CAP ? rules.slice(0, COLLAGE_RULES_TAB_CAP - 1) + '…' : rules;
            entries.push(`▸ "${tab.name || 'tab'}"${pack ? ` (pack "${pack}")` : ''}: ${clipped}`);
        }
        if (!entries.length) return '';
        let body = entries.join('\n');
        if (body.length > COLLAGE_RULES_TOTAL_CAP) body = body.slice(0, COLLAGE_RULES_TOTAL_CAP - 1) + '…';
        return `[GALLERY VIEW — RULES OF THE DISPLAYED SCENES]\n${body}\nThese rules are the law of the scenes shown in the collage below — honor them while they are on display.\n[/GALLERY VIEW RULES]`;
    }

    // ── Public registration (engine delegates + future satellites consume) ──
    window.VP_TEMPLATES = {
        renderTemplate,
        buildManifest, buildCollagePromptData,
        buildVisualContextFrames, buildFrameContextPreview,
        buildCollageRulesNote,
        updatePromptHints, updateTemplateStatus,
        insertAtCursor, escapeAttr, isAssetReady,
        DEFAULT_MANIFEST_TEMPLATE, DEFAULT_FRAME_TEMPLATE,
        TEMPLATE_VARS,
    };
})();
