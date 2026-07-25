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

            const { userText } = buildTaggerUserPromptForAsset(asset);

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
                        const ctx = buildTaggerAssetContext(asset);
                        if (ctx?.subjectToken && !newTag.startsWith(ctx.subjectToken + '_')) {
                            newTag = `${ctx.subjectToken}_${newTag}`.slice(0, 32);
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
                    const ctx = buildTaggerAssetContext(asset);
                    if (ctx?.subjectToken && !newTag.startsWith(ctx.subjectToken + '_')) {
                        newTag = `${ctx.subjectToken}_${newTag}`.slice(0, 32);
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

    function resolveAssetTag(tag) {
        let cur = String(tag || '').trim();
        if (!cur) return null;
        const visited = new Set();
        while (!S.gallery?.has?.(cur) && S.galleryData?.tagAliases?.[cur]?.to && !visited.has(cur)) {
            visited.add(cur);
            cur = String(S.galleryData.tagAliases[cur].to || '').trim();
        }
        return S.gallery?.has?.(cur) ? cur : null;
    }

    function sanitizeContextToken(value) {
        const raw = String(value || '').trim();
        if (!raw) return '';
        const sanitized = VP.tags?.sanitizeLooseTag
            ? VP.tags.sanitizeLooseTag(raw)
            : raw.toLowerCase().replace(/[^a-z0-9а-яё]+/gi, '_').replace(/^_+|_+$/g, '');
        return String(sanitized || '').slice(0, 24);
    }

    function isGenericContextName(value) {
        const token = sanitizeContextToken(value);
        return !token || /^(main|assets?|images?|gallery|default|misc|other|new|tab|effects?)$/i.test(token);
    }

    function getAssetTabContext(asset) {
        const gd = S.galleryData || { tabs: [], categories: [] };
        const tab = asset?.tabId ? gd.tabs?.find?.(t => t.id === asset.tabId) : null;
        const category = tab?.categoryId ? gd.categories?.find?.(c => c.id === tab.categoryId) : null;
        return { tab: tab || null, category: category || null };
    }

    function buildTaggerAssetContext(asset) {
        if (!asset) return null;
        const { tab, category } = getAssetTabContext(asset);
        const folderToken = sanitizeContextToken(asset.folderContext || '');
        const tabToken = !isGenericContextName(tab?.name) ? sanitizeContextToken(tab?.name) : '';
        const categoryToken = !isGenericContextName(category?.name) ? sanitizeContextToken(category?.name) : '';
        const subjectToken = folderToken || tabToken || categoryToken || '';
        const tabName = tab?.name || null;
        const categoryName = category?.name || null;
        const subjectName = asset.folderContext || tabName || categoryName || null;
        const suggestedPrefix = subjectToken ? `${subjectToken}_` : '';
        const hasUsefulContext = !!(folderToken || tabToken || categoryToken);
        const currentTag = String(asset.tag || '');
        const tagAlreadyAnchored = !!(subjectToken && (currentTag === subjectToken || currentTag.startsWith(`${subjectToken}_`) || currentTag.includes(subjectToken)));

        const guidance = hasUsefulContext
            ? [
                `Collection context: ${[
                    categoryName ? `category "${categoryName}"` : '',
                    tabName ? `tab "${tabName}"` : '',
                    asset.folderContext ? `folder context "${asset.folderContext}"` : '',
                ].filter(Boolean).join(', ')}.`,
                subjectToken ? `Treat "${subjectName}" as the likely character/subject anchor unless the image clearly contradicts it.` : '',
                subjectToken ? `Prefer a tag that starts with "${suggestedPrefix}" and then describes emotion/pose/action.` : '',
                subjectName ? `Prefer descriptions like "${subjectName} smiling" over generic "girl smiling" when appropriate.` : '',
            ].filter(Boolean).join(' ')
            : 'No strong collection/tab context is available; use visual content only.';

        return {
            tag: asset.tag || null,
            filename: asset.filename || asset.file || asset.path || null,
            tabId: asset.tabId || null,
            tabName,
            categoryId: category?.id || null,
            categoryName,
            folderContext: asset.folderContext || null,
            subjectName,
            subjectToken,
            suggestedPrefix,
            hasUsefulContext,
            tagAlreadyAnchored,
            hasDescription: !!String(asset.description || '').trim(),
            currentDescription: asset.description || '',
            guidance,
        };
    }

    function buildTaggerUserPromptForAsset(asset) {
        let userText = TAGGER_USER_PROMPT;
        const ctx = buildTaggerAssetContext(asset);
        if (ctx?.hasUsefulContext) {
            userText += `

${ctx.guidance}`;
        }
        return { userText, context: ctx };
    }

    function getTaggerPublicState() {
        const api = Tagger.getApiContext();
        const assets = Array.from(S.gallery?.values?.() || []);
        const pending = assets.filter(a => !String(a.description || '').trim());
        const selected = S.selection?.tags ? Array.from(S.selection.tags) : [];
        return {
            ok: true,
            state: {
                available: true,
                running: !!S.tagger?.running,
                cancelled: !!S.tagger?.cancelled,
                total: Number(S.tagger?.total) || 0,
                done: Number(S.tagger?.done) || 0,
                failed: Number(S.tagger?.failed) || 0,
                currentTag: S.tagger?.current?.tag || null,
                lastDesc: S.tagger?.lastDesc || '',
                apiAvailable: !!api,
                endpoint: api?.endpoint || null,
                model: api?.model || null,
                autoTagOnLoad: S.config?.autoTagOnLoad || 'ask',
                assetCount: assets.length,
                pendingDescriptionCount: pending.length,
                selectedCount: selected.length,
            },
        };
    }

    function getTaggerHealth(payload = {}) {
        const includeSamples = payload.samples !== false;
        const api = Tagger.getApiContext();
        const assets = Array.from(S.gallery?.values?.() || []);
        const pending = assets.filter(a => !String(a.description || '').trim());
        const withUsefulContext = assets.filter(a => buildTaggerAssetContext(a)?.hasUsefulContext);
        const genericTagPattern = /(^|_)(girl|boy|woman|man|anime|portrait|character|person|asset|image|img)(_|$)/i;
        const genericAnchorCandidates = withUsefulContext
            .filter(a => genericTagPattern.test(a.tag || '') && !buildTaggerAssetContext(a)?.tagAlreadyAnchored)
            .map(a => buildTaggerAssetContext(a));
        const missingTabContext = assets
            .filter(a => !a.folderContext && !getAssetTabContext(a).tab)
            .map(a => a.tag || a.filename || '(untagged)');

        const issues = [];
        if (!api) issues.push({ code: 'api-context-missing', severity: 'info' });
        if (!S.gallery) issues.push({ code: 'gallery-missing', severity: 'error' });
        if (S.tagger?.running && S.tagger?.cancelled) issues.push({ code: 'running-and-cancelled', severity: 'warn' });
        if (pending.length) issues.push({ code: 'assets-without-description', severity: 'info', count: pending.length });
        if (genericAnchorCandidates.length) issues.push({ code: 'generic-tags-with-context', severity: 'info', count: genericAnchorCandidates.length });
        if (missingTabContext.length) issues.push({ code: 'assets-without-tab-context', severity: 'info', count: missingTabContext.length });

        return {
            ok: true,
            healthy: issues.filter(i => i.severity === 'error' || i.severity === 'warn').length === 0,
            summary: {
                apiAvailable: !!api,
                model: api?.model || null,
                autoTagOnLoad: S.config?.autoTagOnLoad || 'ask',
                running: !!S.tagger?.running,
                assetCount: assets.length,
                pendingDescriptionCount: pending.length,
                assetsWithUsefulContext: withUsefulContext.length,
                genericAnchorCandidateCount: genericAnchorCandidates.length,
                missingTabContextCount: missingTabContext.length,
            },
            issues,
            samples: includeSamples ? {
                pendingDescriptionTags: pending.slice(0, 20).map(a => a.tag || a.filename || '(untagged)'),
                genericAnchorCandidates: genericAnchorCandidates.slice(0, 20),
                missingTabContext: missingTabContext.slice(0, 20),
            } : null,
        };
    }

    function getTaggerAssetContext(payload = {}) {
        const tag = resolveAssetTag(payload.tag || payload.assetTag || payload.id);
        if (!tag) return { ok: false, error: 'asset-not-found', context: null };
        return { ok: true, context: buildTaggerAssetContext(S.gallery.get(tag)) };
    }

    function getTaggerPromptPreview(payload = {}) {
        const tag = resolveAssetTag(payload.tag || payload.assetTag || payload.id);
        if (!tag) return { ok: false, error: 'asset-not-found', prompt: null, context: null };
        const asset = S.gallery.get(tag);
        const built = buildTaggerUserPromptForAsset(asset);
        return {
            ok: true,
            tag,
            context: built.context,
            prompt: {
                systemPreview: TAGGER_SYSTEM_PROMPT.slice(0, 1200),
                userText: built.userText,
                includesImage: true,
                imageTransport: 'omitted-from-hub-preview',
            },
        };
    }

    function registerTaggerHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'tagger');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'tagger', title: 'AI Autotagger', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Tagger] Hub module registration failed:', err); }
        }
        if (!hasCommand('tagger:get-state')) hub.handle('tagger:get-state', () => getTaggerPublicState(), { moduleId: 'tagger' });
        if (!hasCommand('tagger:get-health')) hub.handle('tagger:get-health', (payload = {}) => getTaggerHealth(payload), { moduleId: 'tagger' });
        if (!hasCommand('tagger:get-asset-context')) hub.handle('tagger:get-asset-context', (payload = {}) => getTaggerAssetContext(payload), { moduleId: 'tagger' });
        if (!hasCommand('tagger:get-prompt-preview')) hub.handle('tagger:get-prompt-preview', (payload = {}) => getTaggerPromptPreview(payload), { moduleId: 'tagger' });
    }

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
    registerTaggerHubCommands();

    console.log('[VP Tagger] Module initialized.');

})();
