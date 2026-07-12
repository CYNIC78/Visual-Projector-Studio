// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-tagger.js                                            ║
// ║  Visual Projector — AI Autotagger Module (VLM)                  ║
// ║                                                                  ║
// ║  Logic for analyzing images via Vision Language Models and       ║
// ║  automatically assigning tags and descriptions.                  ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Tagger] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const S = VP.state;
    const DB = window.VP_DB;

    const TAGGER_SYSTEM_PROMPT = `You are an image tagging assistant for a visual novel engine.

CRITICAL: Respond with ONLY the JSON object. No thinking, no reasoning, no explanation, no markdown. Just the raw JSON.

Format:
{"tag": "short_tag", "description": "brief description"}

Rules:
- tag: lowercase, snake_case, English, max 20 chars
- description: 3-8 words, English, what is visually shown
- Focus on: character emotion, pose, action, setting

Examples of CORRECT responses:
{"tag": "happy_smile", "description": "girl smiling warmly at camera"}
{"tag": "devil_costume", "description": "anime girl in red devil outfit"}
{"tag": "forest_night", "description": "dark forest path under moonlight"}

WRONG: Any text before or after the JSON.
WRONG: Markdown code blocks.
WRONG: Step-by-step thinking.
CORRECT: Just {"tag":"...","description":"..."} and nothing else.`;

    const TAGGER_USER_PROMPT = `Analyze this image and provide a tag and brief description as JSON:`;

    const Tagger = {

        /** Resolve API context from session config or captured context. */
        getApiContext() {
            const cfg = S.modelConfig;
            if (cfg && cfg.endpoint) {
                const headers = { 'Content-Type': 'application/json' };
                const key = (cfg.apiKey || '').trim();
                if (key) headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
                return { endpoint: cfg.endpoint, headers, model: cfg.model || 'default' };
            }
            if (S.api?.endpoint) {
                return { endpoint: S.api.endpoint, headers: S.api.headers || { 'Content-Type': 'application/json' }, model: S.api.model || 'default' };
            }
            return null;
        },

        /** Tag a single asset via VLM. Returns {tag, description} or null. */
        async tagAsset(asset) {
            const api = this.getApiContext();
            if (!api) {
                throw new Error('Настройте Endpoint в панели Model (настройки модели).');
            }

            let userText = TAGGER_USER_PROMPT;
            if (asset.folderContext) {
                const niceName = asset.folderContext.replace(/_/g, ' ');
                userText += `\n\nContext: This image belongs to a collection named "${niceName}". ` +
                    `If "${niceName}" appears to be a character name or subject identifier, ` +
                    `use it naturally in the description (e.g. "${niceName} smiling" instead of "girl smiling"). ` +
                    `The tag should start with "${asset.folderContext}_" prefix.`;
            }

            const base64Str = asset.blob ? await VP.blobToBase64(asset.blob) : (asset.base64 || asset.url);
            const body = {
                model: api.model,
                messages: [
                    { role: 'system', content: TAGGER_SYSTEM_PROMPT },
                    { role: 'user', content: [
                        { type: 'text', text: userText },
                        { type: 'image_url', image_url: { url: base64Str } },
                    ]},
                ],
                temperature: 0.3,
                max_tokens: 500,
                stream: false,
            };

            const fetcher = S.originalFetch || window.fetch;
            const response = await fetcher(api.endpoint, {
                method: 'POST',
                headers: api.headers,
                body: JSON.stringify(body),
            });

            if (!response.ok) {
                const errText = await response.text().catch(() => '');
                throw new Error(`API ${response.status}: ${errText.slice(0, 200)}`);
            }

            const data = await response.json();
            const msg = data.choices?.[0]?.message || {};
            const content   = msg.content          || '';
            const reasoning = msg.reasoning_content || '';
            return Tagger.parseResponse(content) || Tagger.parseResponse(reasoning);
        },

        /** Robust JSON extraction (4 fallback strategies). */
        parseResponse(text) {
            if (!text || typeof text !== 'string') return null;
            const cleaned = text.trim().replace(/^```(?:json)?\s*/i, '').replace(/\s*```$/i, '').trim();

            try {
                const p = JSON.parse(cleaned);
                if (p.tag && p.description)
                    return { tag: VP.tags.sanitizeLooseTag(p.tag).slice(0, 20), description: String(p.description).slice(0, 120) };
            } catch {}

            const m = cleaned.match(/\{[\s\S]*?"tag"[\s\S]*?"description"[\s\S]*?\}/);
            if (m) {
                try {
                    const p = JSON.parse(m[0]);
                    if (p.tag && p.description)
                        return { tag: VP.tags.sanitizeLooseTag(p.tag).slice(0, 20), description: String(p.description).slice(0, 120) };
                } catch {}
            }

            const tagM  = cleaned.match(/[`'"]?tag[`'"]?\s*[:=]\s*[`'"]([^`'\n]+)[`'"]/i);
            const descM = cleaned.match(/[`'"]?description[`'"]?\s*[:=]\s*[`'"]([^`'\n]+)[`'"]?/i);
            if (tagM && descM)
                return { tag: VP.tags.sanitizeLooseTag(tagM[1]).slice(0, 20), description: descM[1].slice(0, 120) };

            if (tagM) {
                const df = cleaned.match(/description[`'"]?\s*[:=]\s*[`'"]?([^`'\n}]{3,})/i);
                if (df) return { tag: VP.tags.sanitizeLooseTag(tagM[1]).slice(0, 20), description: df[1].trim().slice(0, 120) };
            }
            return null;
        },

        /** Batch-tag assets. */
        async tagAll(onlyTags = null) {
            if (S.tagger.running) return;
            const api = this.getApiContext();
            if (!api) {
                VP.showToast('Настройте Endpoint в панели Model (настройки модели).', 'error');
                return;
            }

            const filter = onlyTags ? (onlyTags instanceof Set ? onlyTags : new Set(onlyTags)) : null;
            const queue = Array.from(S.gallery.values()).filter(a => filter ? filter.has(a.tag) : !a.description);
            if (queue.length === 0) { VP.showToast('All assets already tagged ✓', 'success'); return; }

            Object.assign(S.tagger, {
                running: true, cancelled: false, total: queue.length,
                done: 0, failed: 0, current: null, lastDesc: '',
            });
            showTaggerOverlay();

            for (const asset of queue) {
                if (S.tagger.cancelled) break;
                S.tagger.current = asset;
                updateTaggerOverlay();

                try {
                    const result = await Tagger.tagAsset(asset);
                    if (result) {
                        let newTag = result.tag;
                        if (asset.folderContext && !newTag.startsWith(asset.folderContext + '_')) {
                            newTag = `${asset.folderContext}_${newTag}`.slice(0, 32);
                        }
                        if (newTag !== asset.tag && !S.gallery.has(newTag)) {
                            const oldTag = asset.tag;
                            S.gallery.delete(oldTag);
                            asset.tag = newTag;
                            S.gallery.set(newTag, asset);
                            if (S.current?.tag === oldTag) S.current = asset;
                            if (DB) DB.deleteAsset(oldTag);
                        }
                        asset.description = result.description;
                        VP.gallery.persistAsset(asset);
                        S.tagger.lastDesc = `${asset.tag}: ${result.description}`;
                    } else {
                        S.tagger.failed++;
                        S.tagger.lastDesc = `⚠ ${asset.filename}: couldn't parse response`;
                    }
                } catch (err) {
                    S.tagger.failed++;
                    S.tagger.lastDesc = `⚠ ${asset.filename}: ${err.message}`;
                }

                S.tagger.done++;
                updateTaggerOverlay();
                if (!S.tagger.cancelled) await new Promise(r => setTimeout(r, 300));
            }

            const { done, failed, cancelled } = S.tagger;
            S.tagger.running = false;
            S.tagger.current = null;
            hideTaggerOverlay();

            if (filter) { S.selection.tags.clear(); S.selection.anchor = null; }
            VP.gallery.renderGalleryGrid();
            VP.gallery.updateGalleryFooter();
            VP.updateProjectorUI();

            VP.showToast(
                cancelled ? `Cancelled. Tagged ${done - failed} of ${S.tagger.total}`
                          : (failed > 0 ? `Done: ${done - failed} tagged, ${failed} failed` : `✨ All ${done} assets tagged!`),
                cancelled ? 'info' : (failed > 0 ? 'error' : 'success')
            );
        },

        /** Re-tag a single asset. */
        async retagSingle(tag) {
            const asset = S.gallery.get(tag);
            if (!asset) return;
            const api = this.getApiContext();
            if (!api) { VP.showToast('Настройте Endpoint в панели Model', 'error'); return; }

            VP.showToast(`✨ Tagging ${tag}...`, 'info');
            try {
                const result = await Tagger.tagAsset(asset);
                if (result) {
                    let newTag = result.tag;
                    if (asset.folderContext && !newTag.startsWith(asset.folderContext + '_')) {
                        newTag = `${asset.folderContext}_${newTag}`.slice(0, 32);
                    }
                    if (newTag !== asset.tag && !S.gallery.has(newTag)) {
                        const oldTag = asset.tag;
                        S.gallery.delete(oldTag);
                        asset.tag = newTag;
                        S.gallery.set(newTag, asset);
                        if (S.current?.tag === oldTag) S.current = asset;
                        if (DB) DB.deleteAsset(oldTag);
                    }
                    asset.description = result.description;
                    VP.gallery.persistAsset(asset);
                    VP.gallery.renderGalleryGrid();
                    VP.updateProjectorUI();
                    VP.showToast(`✨ ${asset.tag}: ${result.description}`, 'success');
                } else {
                    VP.showToast(`Couldn't parse AI response`, 'error');
                }
            } catch (err) {
                VP.showToast(`Error: ${err.message}`, 'error');
            }
        },

        cancel() { S.tagger.cancelled = true; },
    };

    function showTaggerOverlay() {
        const host = S.ui.vpWindow;
        if (!host) return;
        let overlay = host.querySelector('#vp-tagger-overlay');
        if (overlay) { overlay.style.display = 'flex'; return; }

        overlay = document.createElement('div');
        overlay.id = 'vp-tagger-overlay';
        overlay.style.cssText = `
            position: absolute; inset: 0; top: 36px;
            background: var(--bg-secondary, #1e1e2e);
            display: flex; flex-direction: column;
            align-items: center; justify-content: center;
            gap: 12px; padding: 20px; z-index: 100;
            border-bottom-left-radius: 10px; border-bottom-right-radius: 10px;
        `;
        overlay.innerHTML = `
            <div style="font-size: 24px;">✨</div>
            <div id="vp-tagger-status" style="color: var(--text-primary,#cdd6f4); font-size: 13px; font-weight: 600;">Preparing...</div>
            <div id="vp-tagger-thumb-wrap" style="width: 80px; height: 80px; border-radius: 8px; overflow: hidden; background: #242424;">
                <img id="vp-tagger-thumb" src="" style="width: 100%; height: 100%; object-fit: cover; display: block;">
            </div>
            <div id="vp-tagger-last-desc" style="color: var(--text-secondary,#8888aa); font-size: 11px; font-family: monospace; text-align: center; max-width: 90%; word-break: break-word; min-height: 28px;"></div>
            <div style="width: 80%; height: 6px; background: #242424; border-radius: 3px; overflow: hidden;">
                <div id="vp-tagger-bar" style="height: 100%; width: 0%; background: var(--accent,#6c5fa6); border-radius: 3px; transition: width 0.3s ease;"></div>
            </div>
            <div id="vp-tagger-counter" style="color: var(--text-secondary,#8888aa); font-size: 11px;">0 / 0</div>
            <button id="vp-tagger-cancel" class="vp-btn" style="margin-top: 4px; padding: 4px 16px;">✗ Cancel</button>
        `;
        host.appendChild(overlay);

        overlay.querySelector('#vp-tagger-cancel').addEventListener('click', () => {
            Tagger.cancel();
            overlay.querySelector('#vp-tagger-status').textContent = 'Cancelling...';
            overlay.querySelector('#vp-tagger-cancel').disabled = true;
        });
    }

    function updateTaggerOverlay() {
        const { done, total, current, lastDesc } = S.tagger;
        const overlay = S.ui.vpWindow?.querySelector('#vp-tagger-overlay');
        if (!overlay) return;
        overlay.querySelector('#vp-tagger-status').textContent  = `✨ Tagging ${done + 1} of ${total}`;
        overlay.querySelector('#vp-tagger-counter').textContent = `${done} / ${total}`;
        overlay.querySelector('#vp-tagger-bar').style.width     = `${Math.round((done / total) * 100)}%`;
        if (current?.thumbUrl) overlay.querySelector('#vp-tagger-thumb').src = current.thumbUrl;
        if (lastDesc) overlay.querySelector('#vp-tagger-last-desc').textContent = lastDesc;
    }

    function hideTaggerOverlay() {
        const overlay = S.ui.vpWindow?.querySelector('#vp-tagger-overlay');
        if (overlay) overlay.style.display = 'none';
    }

    async function maybeOfferAutoTag() {
        const pending = Array.from(S.gallery.values()).filter(a => !a.description);
        if (pending.length === 0) return;

        const api = Tagger.getApiContext();
        if (!api) {
            VP.showToast('💡 Настройте Endpoint в панели Model, чтобы запустить ✨ Auto-tag', 'info');
            return;
        }

        const mode = S.config.autoTagOnLoad;
        if (mode === 'never') return;
        if (mode === 'always') { Tagger.tagAll(); return; }

        const answer = await VP.showConfirm({
            title: '✨ Auto-tag new assets?',
            message: `${pending.length} asset(s) without descriptions. Run AI tagging now?`,
            buttons: [
                { id: 'always', label: 'Always',  ghost: true },
                { id: 'never',  label: 'Never',   ghost: true },
                { id: 'no',     label: 'Not now', ghost: true },
                { id: 'yes',    label: '✨ Yes' },
            ],
        });

        if (answer === 'always') { S.config.autoTagOnLoad = 'always'; VP.gallery.persistConfig(); Tagger.tagAll(); }
        else if (answer === 'never') { S.config.autoTagOnLoad = 'never'; VP.gallery.persistConfig(); }
        else if (answer === 'yes') { Tagger.tagAll(); }
    }

    // Expose to global and VP facade
    window.VisualProjector.tagger = Tagger;
    if (window.VisualProjector.gallery) {
        window.VisualProjector.gallery.Tagger = Tagger;
        window.VisualProjector.gallery.maybeOfferAutoTag = maybeOfferAutoTag;
    }

    console.log('[VP Tagger] Module initialized.');

})();
