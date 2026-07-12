// ╔══════════════════════════════════════════════════════════════════╗
// ║ projector-games.js                                              ║
// ║ Visual Projector — trusted game module host foundation           ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Games] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const S = VP.state;
    const DB = window.VP_DB;
    const modules = new Map();
    const loadedScripts = new Set();
    let activeMounted = null;
    let activeGame = null; // active/headless orchestrator game for prompt context
    const gameObjectUrls = new Set();

    function register(def) {
        if (!def || !def.id || typeof def.mount !== 'function') {
            console.warn('[VP Games] Invalid game module registration:', def);
            return false;
        }
        modules.set(def.id, {
            title: def.title || def.id,
            ...def,
        });
        console.log('[VP Games] registered:', def.id);
        return true;
    }

    function unregister(id) {
        return modules.delete(id);
    }

    function getModule(id) {
        return modules.get(id) || null;
    }

    function escapeHtml(value) {
        return String(value ?? '').replace(/[&<>"']/g, ch => ({
            '&': '&amp;',
            '<': '&lt;',
            '>': '&gt;',
            '"': '&quot;',
            "'": '&#39;',
        }[ch]));
    }

    function errorText(prefix, err) {
        const msg = err?.message || err || 'Unknown error';
        return prefix ? `${prefix}: ${msg}` : String(msg);
    }

    function setEmptyMessage(el, text) {
        if (!el) return;
        el.innerHTML = '';
        const div = document.createElement('div');
        div.className = 'vp-games-empty';
        div.textContent = String(text || '');
        el.appendChild(div);
    }


    let activeOverlay = null;

    function closeGameOverlay(result = null) {
        if (!activeOverlay) return false;
        const current = activeOverlay;
        activeOverlay = null;
        try { current.onClose?.(result); } catch (err) { console.warn('[VP Games] overlay onClose failed:', err); }
        try { current.root.remove(); } catch {}
        document.body.classList.remove('vp-game-overlay-active');
        return true;
    }

    function openGameOverlay(options = {}) {
        closeGameOverlay({ reason: 'replaced' });
        const root = document.createElement('div');
        root.id = 'vp-game-overlay-root';
        root.innerHTML = `
            <div class="vp-game-overlay-topbar">
                <div class="vp-game-overlay-title"></div>
                <div class="vp-game-overlay-actions">
                    <button class="vp-btn vp-btn-ghost" data-act="close">Exit</button>
                </div>
            </div>
            <div class="vp-game-overlay-body"></div>`;
        const titleEl = root.querySelector('.vp-game-overlay-title');
        const body = root.querySelector('.vp-game-overlay-body');
        titleEl.textContent = options.title || 'Game Activity';
        document.body.appendChild(root);
        document.body.classList.add('vp-game-overlay-active');

        const overlay = {
            root,
            body,
            titleEl,
            close: (result = null) => closeGameOverlay(result),
            setTitle(title) { titleEl.textContent = title || 'Game Activity'; },
            onClose: typeof options.onClose === 'function' ? options.onClose : null,
        };
        activeOverlay = overlay;
        root.querySelector('[data-act="close"]').addEventListener('click', () => overlay.close({ reason: 'user' }));
        if (typeof options.mount === 'function') {
            try { options.mount(body, overlay); }
            catch (err) {
                console.error('[VP Games] overlay mount failed:', err);
                setEmptyMessage(body, errorText('Overlay failed', err));
            }
        }
        return overlay;
    }

    // ════════════════════════════════════════════════════════════════
    //  ACTIVITY BROKER
    //  Chat command → request/challenge/start/auto → overlay/result context.
    // ════════════════════════════════════════════════════════════════

    let activeActivityRequest = null;
    let activityRequestToast = null;

    const ACTIVITY_COMMAND_RE = /\[\s*(ACTIVITY_REQUEST|ACTIVITY_CHALLENGE|ACTIVITY_START|ACTIVITY_AUTO|ACTIVITY_ACCEPT|ACTIVITY_DECLINE)\s*(?::|：)?\s*([^\]\r\n]*)?\]/giu;

    function humanizeActivityId(id = '') {
        return String(id || 'activity')
            .split(/[\/_\-]+/g).filter(Boolean)
            .map(x => x.charAt(0).toUpperCase() + x.slice(1))
            .join(' ') || 'Activity';
    }

    function parseActivityRef(ref = '') {
        const raw = String(ref || '').trim();
        if (!raw) return { gameId: '', activityId: '' };
        const [gameId, ...rest] = raw.split('/');
        return { gameId: String(gameId || '').trim(), activityId: String(rest.join('/') || '').trim() };
    }

    function actorLabel(role = 'assistant') {
        if (role === 'user') return String(S.config?.userName || 'User').trim() || 'User';
        const speaker = VP.chats?.getActiveSpeaker?.();
        return speaker ? (VP.chats?.getParticipantDisplayName?.(speaker) || 'Assistant') : 'Assistant';
    }

    function postActivitySceneEvent(kind, req, extra = {}) {
        const title = req?.title || humanizeActivityId(req?.activityId);
        const initiator = req?.initiatorLabel || actorLabel(req?.sourceRole || 'assistant');
        const responder = extra.responder || actorLabel(extra.role || 'user');
        const lines = [
            `[SCENE EVENT: ACTIVITY ${String(kind || '').toUpperCase()}]`,
            `Activity: ${title}`,
            `Activity ref: ${req?.gameId || 'unknown'}/${req?.activityId || 'unknown'}`,
            `Initiator: ${initiator}`,
        ];
        if (kind === 'accepted') lines.push(`Responder: ${responder}`, 'Status: accepted');
        if (kind === 'declined') lines.push(`Responder: ${responder}`, 'Status: declined', 'Interpret refusal as non-hostile unless the dialogue clearly says otherwise.');
        if (kind === 'started') lines.push(`Participants: ${responder ? `${initiator}, ${responder}` : initiator}`, 'Status: started');
        if (extra.summary) lines.push(`Summary: ${extra.summary}`);
        const replaySummary = extra.replaySummary || (kind === 'accepted'
            ? `${responder} accepted ${initiator}'s ${title} activity proposal.`
            : kind === 'declined'
                ? `${responder} declined ${initiator}'s ${title} activity proposal.`
                : kind === 'started'
                    ? `${initiator} and ${responder} begin ${title}.`
                    : '');
        if (replaySummary) lines.push(`Replay summary: ${replaySummary}`);
        lines.push('Use this as recent shared roleplay context.', `[/SCENE EVENT]`);
        const note = lines.join('\n');
        try { VP.session?.addMessage?.('system', note); } catch (err) { console.warn('[VP Games] post scene event failed:', err); }
        return note;
    }

    function closeActivityRequestToast() {
        if (!activityRequestToast) return;
        try { activityRequestToast.remove(); } catch {}
        activityRequestToast = null;
    }

    function showActivityRequestToast(req) {
        closeActivityRequestToast();
        const box = document.createElement('div');
        box.className = 'vp-activity-request-toast';
        const title = req.title || humanizeActivityId(req.activityId);
        const modeLabel = req.intent === 'challenge' ? 'Challenge' : 'Activity request';
        box.innerHTML = `
            <div class="vp-activity-request-head">
                <b></b>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="close">×</button>
            </div>
            <div class="vp-activity-request-body"></div>
            <div class="vp-activity-request-actions">
                <button class="vp-btn vp-btn-sm" data-act="play">Play</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="auto">Auto</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="decline">Decline</button>
            </div>`;
        box.querySelector('b').textContent = `${modeLabel}: ${title}`;
        box.querySelector('.vp-activity-request-body').textContent = `${req.initiatorLabel || 'Someone'} suggests ${title}.`;
        box.querySelector('[data-act="close"]').addEventListener('click', closeActivityRequestToast);
        box.querySelector('[data-act="play"]').addEventListener('click', () => acceptActivity(req.id).catch(err => VP.showToast?.(`Activity start failed: ${err.message || err}`, 'error')));
        box.querySelector('[data-act="auto"]').addEventListener('click', () => autoActivity(req.id, { acceptedBy: 'user' }).catch(err => VP.showToast?.(`Activity auto failed: ${err.message || err}`, 'error')));
        box.querySelector('[data-act="decline"]').addEventListener('click', () => declineActivity(req.id, { role: 'user' }).catch(err => VP.showToast?.(`Activity decline failed: ${err.message || err}`, 'error')));
        document.body.appendChild(box);
        activityRequestToast = box;
    }

    async function getActivityModule(gameId) {
        const id = String(gameId || '').trim();
        if (!id) throw new Error('Activity game id is empty');
        const loaded = await loadGameModule(id);
        return loaded;
    }

    async function startActivityRef(gameId, activityId, opts = {}) {
        const { info, module } = await getActivityModule(gameId);
        const api = makeApi(gameId, info);
        if (typeof module.startActivity !== 'function') {
            throw new Error(`Game ${gameId} does not expose startActivity(activityId, api, opts)`);
        }
        if (opts.postStarted !== false) {
            const req = opts.request || { gameId, activityId, title: humanizeActivityId(activityId), sourceRole: opts.source || 'user', initiatorLabel: actorLabel(opts.source || 'user') };
            postActivitySceneEvent('started', req, {
                role: opts.acceptedBy || opts.source || 'user',
                responder: opts.responder || actorLabel(opts.acceptedBy || opts.source || 'user'),
                summary: `The ${req.title || humanizeActivityId(activityId)} activity starts.`,
                replaySummary: `${actorLabel(opts.acceptedBy || opts.source || 'user')} starts ${req.title || humanizeActivityId(activityId)}.`,
            });
        }
        return module.startActivity(activityId, api, opts);
    }

    async function autoActivityRef(gameId, activityId, opts = {}) {
        const { info, module } = await getActivityModule(gameId);
        const api = makeApi(gameId, info);
        if (typeof module.autoResolveActivity === 'function') return module.autoResolveActivity(activityId, api, opts);
        if (typeof module.startActivity === 'function') return module.startActivity(activityId, api, { ...opts, auto: true });
        throw new Error(`Game ${gameId} does not expose autoResolveActivity/startActivity`);
    }

    async function requestActivity(input = {}) {
        const gameId = String(input.gameId || '').trim();
        const activityId = String(input.activityId || '').trim();
        if (!gameId || !activityId) throw new Error('Activity request requires gameId/activityId');
        const req = {
            id: input.id || `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
            gameId,
            activityId,
            title: input.title || humanizeActivityId(activityId),
            intent: input.intent || 'request',
            sourceRole: input.sourceRole || 'assistant',
            initiatorLabel: input.initiatorLabel || actorLabel(input.sourceRole || 'assistant'),
            status: 'pending',
            createdAt: Date.now(),
            payload: input.payload || {},
        };
        activeActivityRequest = req;
        window.dispatchEvent(new CustomEvent('vp-game:activity:request', { detail: req }));
        if (req.sourceRole === 'assistant' || req.intent === 'challenge') showActivityRequestToast(req);
        VP.showToast?.(`${req.initiatorLabel} suggests ${req.title}`, 'info');
        return req;
    }

    async function acceptActivity(requestId = null, opts = {}) {
        const req = activeActivityRequest;
        if (!req || (requestId && req.id !== requestId)) throw new Error('No matching pending activity request');
        req.status = 'accepted';
        closeActivityRequestToast();
        postActivitySceneEvent('accepted', req, { role: opts.role || 'user', responder: opts.responder });
        window.dispatchEvent(new CustomEvent('vp-game:activity:accepted', { detail: req }));
        activeActivityRequest = null;
        return startActivityRef(req.gameId, req.activityId, { request: req, source: 'request', acceptedBy: opts.acceptedBy || opts.role || 'user' });
    }

    async function declineActivity(requestId = null, opts = {}) {
        const req = activeActivityRequest;
        if (!req || (requestId && req.id !== requestId)) throw new Error('No matching pending activity request');
        req.status = 'declined';
        closeActivityRequestToast();
        postActivitySceneEvent('declined', req, { role: opts.role || 'user', responder: opts.responder, summary: opts.summary });
        window.dispatchEvent(new CustomEvent('vp-game:activity:declined', { detail: req }));
        activeActivityRequest = null;
        VP.showToast?.(`Declined: ${req.title}`, 'info');
        return req;
    }

    async function autoActivity(requestId = null, opts = {}) {
        const req = activeActivityRequest;
        if (!req || (requestId && req.id !== requestId)) throw new Error('No matching pending activity request');
        req.status = 'auto';
        closeActivityRequestToast();
        postActivitySceneEvent('accepted', req, { role: opts.role || 'user', responder: opts.responder, summary: 'The activity was resolved automatically.' });
        activeActivityRequest = null;
        return autoActivityRef(req.gameId, req.activityId, { request: req, source: 'request-auto', acceptedBy: opts.acceptedBy || opts.role || 'user' });
    }

    function processActivityCommands(text, meta = {}) {
        const role = meta.role || 'assistant';
        const commands = [];
        let m;
        ACTIVITY_COMMAND_RE.lastIndex = 0;
        while ((m = ACTIVITY_COMMAND_RE.exec(String(text || ''))) !== null) {
            commands.push({ type: m[1].toUpperCase(), arg: String(m[2] || '').trim(), raw: m[0] });
        }
        if (!commands.length) return Promise.resolve([]);
        return (async () => {
            const results = [];
            for (const cmd of commands) {
                try {
                    if (cmd.type === 'ACTIVITY_REQUEST' || cmd.type === 'ACTIVITY_CHALLENGE') {
                        const ref = parseActivityRef(cmd.arg);
                        results.push(await requestActivity({
                            ...ref,
                            intent: cmd.type === 'ACTIVITY_CHALLENGE' ? 'challenge' : 'request',
                            sourceRole: role,
                            initiatorLabel: actorLabel(role),
                        }));
                    } else if (cmd.type === 'ACTIVITY_START') {
                        const ref = parseActivityRef(cmd.arg);
                        if (role === 'assistant') {
                            results.push(await requestActivity({ ...ref, intent: 'request', sourceRole: role, initiatorLabel: actorLabel(role) }));
                        } else {
                            results.push(await startActivityRef(ref.gameId, ref.activityId, { source: role, acceptedBy: role, direct: true }));
                        }
                    } else if (cmd.type === 'ACTIVITY_AUTO') {
                        const ref = parseActivityRef(cmd.arg);
                        if (role === 'assistant') {
                            results.push(await requestActivity({ ...ref, intent: 'request', sourceRole: role, initiatorLabel: actorLabel(role), payload: { autoSuggested: true } }));
                        } else {
                            results.push(await autoActivityRef(ref.gameId, ref.activityId, { source: role, direct: true }));
                        }
                    } else if (cmd.type === 'ACTIVITY_ACCEPT') {
                        if (activeActivityRequest) results.push(await acceptActivity(cmd.arg || null, { role }));
                    } else if (cmd.type === 'ACTIVITY_DECLINE') {
                        if (activeActivityRequest) results.push(await declineActivity(cmd.arg || null, { role }));
                    }
                } catch (err) {
                    console.warn('[VP Games] activity command failed:', cmd, err);
                    VP.showToast?.(`Activity command failed: ${err.message || err}`, 'error');
                }
            }
            return results;
        })();
    }

    function inferMime(path) {
        const p = String(path || '').toLowerCase();
        if (p.endsWith('.svg')) return 'image/svg+xml';
        if (p.endsWith('.png')) return 'image/png';
        if (p.endsWith('.jpg') || p.endsWith('.jpeg')) return 'image/jpeg';
        if (p.endsWith('.webp')) return 'image/webp';
        if (p.endsWith('.gif')) return 'image/gif';
        if (p.endsWith('.json')) return 'application/json';
        if (p.endsWith('.glb')) return 'model/gltf-binary';
        if (p.endsWith('.gltf')) return 'model/gltf+json';
        if (p.endsWith('.mp3')) return 'audio/mpeg';
        if (p.endsWith('.ogg')) return 'audio/ogg';
        if (p.endsWith('.wav')) return 'audio/wav';
        return 'application/octet-stream';
    }

    function stripJsonCodeFence(text) {
        return String(text || '').trim()
            .replace(/^```(?:json)?\s*/i, '')
            .replace(/\s*```$/i, '')
            .trim();
    }

    function extractJsonCandidate(text) {
        const cleaned = stripJsonCodeFence(text);
        if (!cleaned) return '';
        if ((cleaned.startsWith('{') && cleaned.endsWith('}')) || (cleaned.startsWith('[') && cleaned.endsWith(']'))) return cleaned;
        const firstObj = cleaned.indexOf('{');
        const lastObj = cleaned.lastIndexOf('}');
        if (firstObj !== -1 && lastObj > firstObj) return cleaned.slice(firstObj, lastObj + 1);
        const firstArr = cleaned.indexOf('[');
        const lastArr = cleaned.lastIndexOf(']');
        if (firstArr !== -1 && lastArr > firstArr) return cleaned.slice(firstArr, lastArr + 1);
        return cleaned;
    }

    function validateJsonShape(value, shape) {
        if (!shape || typeof shape !== 'object') return true;
        if (!value || typeof value !== 'object') return false;
        for (const [key, type] of Object.entries(shape)) {
            if (!(key in value)) return false;
            if (type === 'array') { if (!Array.isArray(value[key])) return false; }
            else if (type === 'object') { if (!value[key] || typeof value[key] !== 'object' || Array.isArray(value[key])) return false; }
            else if (type === 'number') { if (typeof value[key] !== 'number') return false; }
            else if (type === 'boolean') { if (typeof value[key] !== 'boolean') return false; }
            else if (type === 'string') { if (typeof value[key] !== 'string') return false; }
        }
        return true;
    }

    function makeApi(gameId, gameInfo = {}) {
        const getState = (fallback = {}) => DB?.getGameState?.(gameId, fallback) || Promise.resolve(fallback);
        const setState = (state) => DB?.setGameState?.(gameId, state);
        const appendLog = async (type, text, meta = {}) => {
            const state = await getState({});
            if (!Array.isArray(state.log)) state.log = [];
            const row = { id: `log_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`, type, text: String(text || ''), meta, createdAt: Date.now() };
            state.log.push(row);
            if (state.log.length > 500) state.log = state.log.slice(-500);
            await setState(state);
            return row;
        };
        const buildHeaders = (apiKey = '') => {
            const headers = { 'Content-Type': 'application/json' };
            const key = String(apiKey || '').trim();
            if (key) headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
            return headers;
        };
        const llmComplete = async (opts = {}) => {
            const cfg = { ...(S.modelConfig || {}) };
            const endpoint = String(opts.endpoint || cfg.endpoint || '').trim();
            if (!endpoint) throw new Error('Model endpoint is empty');
            const messages = [];
            if (opts.system) messages.push({ role: 'system', content: String(opts.system) });
            if (Array.isArray(opts.messages)) messages.push(...opts.messages);
            else if (opts.prompt) messages.push({ role: 'user', content: String(opts.prompt) });
            if (!messages.length) throw new Error('LLM request has no messages');
            const body = {
                model: opts.model || cfg.model || 'local-model',
                messages,
                temperature: Number.isFinite(+opts.temperature) ? +opts.temperature : (Number.isFinite(+cfg.temperature) ? +cfg.temperature : 0.7),
                max_tokens: Number.isFinite(+opts.maxTokens) ? +opts.maxTokens : (Number.isFinite(+cfg.maxTokens) ? +cfg.maxTokens : 512),
                stream: false,
            };
            const fetcher = S.originalFetch || window.fetch;
            const response = await fetcher(endpoint, {
                method: 'POST',
                headers: buildHeaders(opts.apiKey ?? cfg.apiKey),
                body: JSON.stringify(body),
            });
            if (!response.ok) {
                const text = await response.text().catch(() => '');
                throw new Error(`LLM HTTP ${response.status}: ${text.slice(0, 300)}`);
            }
            const data = await response.json();
            return data.choices?.[0]?.message?.content || data.choices?.[0]?.text || '';
        };
        const llmJson = async (opts = {}) => {
            const fallback = opts.fallback !== undefined ? opts.fallback : null;
            const shape = opts.shape || null;
            const schemaText = opts.schemaText || (shape ? `Required JSON shape/types: ${JSON.stringify(shape)}` : 'Return valid JSON only.');
            const system = [
                opts.system || '',
                'CRITICAL OUTPUT FORMAT: Return ONLY valid JSON. No markdown, no code fences, no commentary.',
                schemaText,
            ].filter(Boolean).join('\n\n');
            const prompt = opts.prompt || 'Return JSON.';
            let raw = '';
            try {
                raw = await llmComplete({ ...opts, system, prompt });
                const candidate = extractJsonCandidate(raw);
                const parsed = JSON.parse(candidate);
                if (!validateJsonShape(parsed, shape)) {
                    throw new Error('JSON shape validation failed');
                }
                return { ok: true, data: parsed, raw, error: null };
            } catch (err) {
                console.warn('[VP Games] llm.json failed, using fallback:', err, 'raw:', raw);
                return { ok: false, data: fallback, raw, error: err.message || String(err) };
            }
        };

        const normalizeActivityResult = (result = {}) => {
            const now = Date.now();
            const status = result.status || (result.cancelled ? 'cancelled' : 'completed');
            const success = result.success !== undefined ? !!result.success : status === 'completed';
            return {
                id: result.id || `act_${now.toString(36)}_${Math.random().toString(36).slice(2, 6)}`,
                gameId,
                activityId: result.activityId || result.id || 'activity',
                status,
                outcome: result.outcome || (success ? 'success' : status),
                success,
                score: Number.isFinite(+result.score) ? +result.score : null,
                quality: result.quality || null,
                durationMs: Number.isFinite(+result.durationMs) ? +result.durationMs : null,
                effects: result.effects && typeof result.effects === 'object' ? result.effects : {},
                tags: Array.isArray(result.tags) ? result.tags : [],
                summary: String(result.summary || ''),
                payload: result.payload && typeof result.payload === 'object' ? result.payload : {},
                createdAt: result.createdAt || now,
            };
        };
        const logActivityResult = async (result = {}) => {
            const normalized = normalizeActivityResult(result);
            const label = normalized.summary || `${normalized.activityId}: ${normalized.outcome}${normalized.score !== null ? ` (${normalized.score})` : ''}`;
            await appendLog('activity-result', label, { result: normalized });
            window.dispatchEvent(new CustomEvent('vp-game:activity:complete', { detail: normalized }));
            return normalized;
        };

        const context = {
            compose(parts = []) {
                return (parts || []).filter(Boolean).map(x => String(x).trim()).filter(Boolean).join('\n\n');
            },
            world() {
                const info = DB?.getBackendInfo?.() || {};
                return `[VP WORLD]\nWorld id: ${info.worldId || 'unknown'}\nWorld folder: ${info.worldRoot || 'unknown'}\n[/VP WORLD]`;
            },
            user() {
                const name = String(S.config?.userName || 'User').trim() || 'User';
                const persona = String(S.config?.userPersona || '').trim();
                return `[USER]\nName: ${name}${persona ? `\nPersona:\n${persona}` : ''}\n[/USER]`;
            },
            activeProfile() {
                const speaker = VP.chats?.getActiveSpeaker?.();
                const profile = speaker ? VP.chats?.getParticipantProfile?.(speaker) : null;
                const display = speaker ? (VP.chats?.getParticipantDisplayName?.(speaker) || profile?.name || 'Assistant') : 'Assistant';
                if (!profile) return `[ACTIVE PROFILE]\nSpeaker: ${display}\n[/ACTIVE PROFILE]`;
                return `[ACTIVE PROFILE]\nSpeaker: ${display}\nProfile name: ${profile.name || 'Profile'}\nKind: ${profile.meta?.kind || 'character'}\nDescription: ${profile.description || ''}\nSystem prompt: ${profile.systemPrompt ? '(present)' : '(empty)'}\n[/ACTIVE PROFILE]`;
            },
            profiles(opts = {}) {
                const max = Number.isFinite(+opts.max) ? +opts.max : 12;
                const mode = opts.mode || 'summary';
                const profiles = (VP.chats?.getProfilesStore?.()?.items || []).slice(0, max);
                const lines = profiles.map(p => {
                    if (mode === 'names') return `- ${p.name}`;
                    return `- ${p.name} (${p.meta?.kind || 'character'}): ${p.description || 'no description'}`;
                });
                return `[WORLD PROFILES]\n${lines.join('\n') || '(none)'}\n[/WORLD PROFILES]`;
            },
            gallery(opts = {}) {
                const mode = opts.mode || 'tags';
                const max = Number.isFinite(+opts.maxAssets) ? +opts.maxAssets : 30;
                const includeHidden = !!opts.includeHidden;
                const assets = Array.from(S.gallery?.values?.() || []).filter(a => includeHidden || !a.hidden).slice(0, max);
                const total = Array.from(S.gallery?.values?.() || []).filter(a => includeHidden || !a.hidden).length;
                const lines = assets.map(a => {
                    if (mode === 'tags') return `- ${a.tag}`;
                    return `- ${a.tag}${a.description ? ` — ${a.description}` : ''}`;
                });
                return `[GALLERY ${mode.toUpperCase()}]\nVisible assets: ${total}${total > assets.length ? ` (showing first ${assets.length})` : ''}\n${lines.join('\n') || '(none)'}\n[/GALLERY]`;
            },
            projector() {
                const cur = S.current?.tag || 'none';
                const cover = S.coverTag || 'none';
                const prepared = S.preparedTag || 'none';
                return `[PROJECTOR]\nCurrent image: ${cur}\nCover: ${cover}\nPrepared: ${prepared}\n[/PROJECTOR]`;
            },
            gameState(state = {}) {
                let json = '{}';
                try { json = JSON.stringify(state || {}, null, 2); } catch {}
                return `[GAME STATE: ${gameId}]\n${json}\n[/GAME STATE]`;
            },
            commands(commands = []) {
                const list = (commands || []).map(c => typeof c === 'string' ? `- ${c}` : `- ${c.name || c.id}: ${c.description || ''}`).join('\n');
                return `[GAME COMMANDS]\nThe game may interpret structured commands/intents, but game state is the source of physical truth.\n${list || '(game did not declare commands)'}\n[/GAME COMMANDS]`;
            },
        };
        return {
            game: {
                id: gameId,
                info: gameInfo,
            },
            world: {
                getInfo() { return DB?.getBackendInfo?.() || {}; },
                async getActive() { return DB?.getActiveWorld?.(); },
            },
            storage: {
                getState,
                setState,
                readText: (path, fallback = '') => DB?.readGameFile?.(gameId, path, fallback),
                writeText: (path, text) => DB?.writeGameFile?.(gameId, path, text),
            },
            assets: {
                list: (path = '') => DB?.listGameFiles?.(gameId, path) || Promise.resolve([]),
                readText: (path, fallback = '') => DB?.readGameFile?.(gameId, path, fallback),
                readBinary: (path) => DB?.readGameBinaryFile?.(gameId, path),
                writeText: (path, text) => DB?.writeGameFile?.(gameId, path, text),
                writeBinary: (path, data) => DB?.writeGameBinaryFile?.(gameId, path, data),
                async objectUrl(path, mime = null) {
                    const data = await DB?.readGameBinaryFile?.(gameId, path);
                    if (!data) throw new Error(`Game asset not found: ${path}`);
                    const url = URL.createObjectURL(new Blob([data], { type: mime || inferMime(path) }));
                    gameObjectUrls.add(url);
                    return url;
                },
                revokeUrl(url) {
                    try { URL.revokeObjectURL(url); } catch {}
                    gameObjectUrls.delete(url);
                },
                revokeAll() {
                    for (const url of Array.from(gameObjectUrls)) {
                        try { URL.revokeObjectURL(url); } catch {}
                        gameObjectUrls.delete(url);
                    }
                },
            },
            projector: {
                showImage(tag) { return VP.setCurrent?.(tag, 'game', true); },
                clear() { return VP.clearCurrent?.(); },
                subtitle(text, role = 'assistant') {
                    if (VP._subtitle?.play) VP._subtitle.play(String(text || ''), role);
                    else VP.showToast?.(String(text || ''), 'info');
                },
                async say(text, opts = {}) {
                    const role = opts.role || 'assistant';
                    if (VP._subtitle?.play) VP._subtitle.play(String(text || ''), role);
                    else VP.showToast?.(String(text || ''), 'info');
                    if (opts.log !== false) await appendLog(opts.type || 'projector', text, { role, ...(opts.meta || {}) });
                },
                fireEffect(name) {
                    try { VP.FX?.fire?.(name); } catch (err) { console.warn('[VP Games] effect failed:', err); }
                },
                getCurrent() { return S.current || null; },
            },
            gallery: {
                listAssets() {
                    return Array.from(S.gallery?.values?.() || []).map(a => ({
                        tag: a.tag,
                        filename: a.filename,
                        description: a.description || '',
                        hidden: !!a.hidden,
                        tabId: a.tabId || null,
                        source: a.source || 'user',
                    }));
                },
                getAsset(tag) {
                    const a = S.gallery?.get?.(tag);
                    return a ? { tag: a.tag, filename: a.filename, description: a.description || '', hidden: !!a.hidden, tabId: a.tabId || null } : null;
                },
                buildManifest() { return VP.buildManifest?.() || ''; },
            },
            profiles: {
                list() { return VP.chats?.getProfilesStore?.()?.items || []; },
                getActive() {
                    const speaker = VP.chats?.getActiveSpeaker?.();
                    return speaker ? VP.chats?.getParticipantProfile?.(speaker) : null;
                },
                getActiveSpeaker() { return VP.chats?.getActiveSpeaker?.() || null; },
            },
            context,
            llm: {
                complete: llmComplete,
                json: llmJson,
            },
            log: {
                add: appendLog,
                async list() { return (await getState({})).log || []; },
                async clear() { const state = await getState({}); state.log = []; await setState(state); return []; },
            },
            tools: {
                register(def) { return VP.tools?.register({ ...def, source: gameId }); },
                unregister(name) { return VP.tools?.unregister(name); },
                list() { return VP.tools?.list?.() || []; },
            },
            chat: {
                addSystemNote(text) { return VP.session?.addMessage?.('system', text); },
                addAssistantMessage(text) { return VP.session?.addMessage?.('assistant', text); },
                addUserMessage(text) { return VP.session?.addMessage?.('user', text); },
                // Context manifests: hidden model-visible notes pinned to messages.
                // attachManifest(target, text, opts) — target: msg id | 'last' | 'last-user'
                // queueManifest(text, opts)         — pins to the NEXT user message
                // opts: { ttl?: number, source?: string } (source defaults to game id)
                attachManifest(target, text, opts = {}) {
                    return VP.session?.attachManifest?.(target, text, { source: gameId, ...opts }) || null;
                },
                queueManifest(text, opts = {}) {
                    return VP.session?.queueManifest?.(text, { source: gameId, ...opts }) || null;
                },
                getManifests(messageId) { return VP.session?.getManifests?.(messageId) || []; },
                removeManifest(messageId, manifestId) { return VP.session?.removeManifest?.(messageId, manifestId) || false; },
                async requestAssistant(text = 'React to the latest scene event in character.', opts = {}) {
                    if (!VP.session?.send) throw new Error('Session send API is unavailable');
                    const prompt = String(text || 'React to the latest scene event in character.');
                    const timeoutMs = Number.isFinite(+opts.timeoutMs) ? +opts.timeoutMs : 8000;
                    const started = Date.now();
                    while (S.session?.running && Date.now() - started < timeoutMs) {
                        await new Promise(resolve => setTimeout(resolve, 120));
                    }
                    if (S.session?.running) {
                        VP.showToast?.('Assistant is still busy; reaction was not sent.', 'info');
                        return false;
                    }
                    console.log('[VP Games] requesting assistant reaction:', prompt.slice(0, 160));
                    const res = await VP.session.send(prompt, { ...opts, skipUserAppend: true });
                    if (res === false) VP.showToast?.('Assistant reaction request was skipped.', 'info');
                    return res;
                },
                getMessages() { return VP.chats?.getActiveChatMessages?.() || []; },
            },
            ui: {
                toast: (message, type = 'info') => VP.showToast?.(message, type),
                openOverlay: openGameOverlay,
                closeOverlay: closeGameOverlay,
                isOverlayOpen: () => !!activeOverlay,
            },
            activities: {
                openOverlay: openGameOverlay,
                closeOverlay: closeGameOverlay,
                normalizeResult: normalizeActivityResult,
                logResult: logActivityResult,
                complete: logActivityResult,
                request: (opts = {}) => requestActivity({ ...opts, gameId: opts.gameId || gameId }),
                start: (activityId, opts = {}) => startActivityRef(opts.gameId || gameId, activityId, opts),
                auto: (activityId, opts = {}) => autoActivityRef(opts.gameId || gameId, activityId, opts),
            },
            events: {
                on: (name, handler) => window.addEventListener(`vp-game:${name}`, handler),
                off: (name, handler) => window.removeEventListener(`vp-game:${name}`, handler),
                emit: (name, detail) => window.dispatchEvent(new CustomEvent(`vp-game:${name}`, { detail })),
            },
        };
    }

    async function loadGameModule(gameId, opts = {}) {
        const info = await DB?.getGameInfo?.(gameId);
        if (!info) throw new Error(`Game not found: ${gameId}`);
        const entry = info.entry || 'main.js';
        const stylePath = info.style || 'style.css';

        if (stylePath && !document.getElementById(`vp-game-style-${gameId}`)) {
            const css = await DB.readGameFile(gameId, stylePath, '').catch(() => '');
            if (css) {
                const style = document.createElement('style');
                style.id = `vp-game-style-${gameId}`;
                style.textContent = css;
                document.head.appendChild(style);
            }
        }

        if (opts.forceReload) {
            loadedScripts.delete(gameId);
            unregister(gameId);
            document.getElementById(`vp-game-style-${gameId}`)?.remove();
            const css = stylePath ? await DB.readGameFile(gameId, stylePath, '').catch(() => '') : '';
            if (css) {
                const style = document.createElement('style');
                style.id = `vp-game-style-${gameId}`;
                style.textContent = css;
                document.head.appendChild(style);
            }
        }

        if (!loadedScripts.has(gameId)) {
            const code = await DB.readGameFile(gameId, entry, '');
            if (!code.trim()) throw new Error(`Game entry is empty: ${entry}`);
            const script = document.createElement('script');
            script.textContent = `${code}\n//# sourceURL=vp-game-${gameId}.js`;
            document.head.appendChild(script);
            loadedScripts.add(gameId);
        }

        const mod = getModule(gameId);
        if (!mod) throw new Error(`Game did not register itself: ${gameId}`);
        return { info, module: mod };
    }

    async function mountGame(gameId, container, opts = {}) {
        if (activeMounted?.module?.unmount) {
            try { await activeMounted.module.unmount(); } catch (err) { console.warn('[VP Games] unmount failed:', err); }
        }
        // Revoke blob URLs made by previous mounted game instance.
        for (const url of Array.from(gameObjectUrls)) {
            try { URL.revokeObjectURL(url); } catch {}
            gameObjectUrls.delete(url);
        }
        activeMounted = null;
        container.innerHTML = '<div class="vp-games-empty">Loading game...</div>';
        const { info, module } = await loadGameModule(gameId, { forceReload: !!opts.forceReload });
        container.innerHTML = '';
        const api = makeApi(gameId, info);
        await module.mount(container, api);
        activeMounted = { id: gameId, module, container, api, info };
        return module;
    }

    async function unmountActiveGame() {
        closeGameOverlay({ reason: 'unmount' });
        if (activeMounted?.module?.unmount) {
            try { await activeMounted.module.unmount(); } catch (err) { console.warn('[VP Games] unmount failed:', err); }
        }
        // Auto-cleanup: remove this game's tools from the registry
        if (activeMounted?.id) {
            const removed = VP.tools?.unregisterBySource?.(activeMounted.id) || 0;
            if (removed) console.log(`[VP Games] cleaned ${removed} tool(s) from unmounted game: ${activeMounted.id}`);
        }
        for (const url of Array.from(gameObjectUrls)) {
            try { URL.revokeObjectURL(url); } catch {}
            gameObjectUrls.delete(url);
        }
        const container = activeMounted?.container || null;
        activeMounted = null;
        if (container) container.innerHTML = '<div class="vp-games-empty">Game unmounted.</div>';
        return true;
    }

    async function reloadGame(gameId = null, container = null) {
        const id = gameId || activeMounted?.id;
        const host = container || activeMounted?.container;
        if (!id || !host) throw new Error('No active/selected game to reload');
        const wasActive = activeGame?.id === id;
        if (wasActive && activeGame?.module?.deactivate) {
            try { await activeGame.module.deactivate(activeGame.api); }
            catch (err) { console.warn('[VP Games] deactivate before reload failed:', err); }
        }
        if (wasActive) activeGame = null;
        closeGameOverlay({ reason: 'reload' });
        const module = await mountGame(id, host, { forceReload: true });
        if (wasActive) {
            await activateGame(id, { persist: true, forceReload: false });
            window.dispatchEvent(new CustomEvent('vp-game:reloaded-active', { detail: { id } }));
        }
        return module;
    }

    async function activateGame(gameId, opts = {}) {
        const id = gameId || activeMounted?.id;
        if (!id) throw new Error('No game selected to activate');
        if (activeGame?.id && activeGame.id !== id) await deactivateGame({ persist: false });
        const { info, module } = await loadGameModule(id, { forceReload: !!opts.forceReload });
        const api = makeApi(id, info);
        if (typeof module.activate === 'function') await module.activate(api);
        activeGame = { id, module, api, info };
        if (opts.persist !== false) await DB?.setActiveGameId?.(id);
        window.dispatchEvent(new CustomEvent('vp-game:activated', { detail: { id, info } }));
        return activeGame;
    }

    async function deactivateGame(opts = {}) {
        if (activeGame?.module?.deactivate) {
            try { await activeGame.module.deactivate(activeGame.api); } catch (err) { console.warn('[VP Games] deactivate failed:', err); }
        }
        // Auto-cleanup: remove this game's tools from the registry
        if (activeGame?.id) {
            const removed = VP.tools?.unregisterBySource?.(activeGame.id) || 0;
            if (removed) console.log(`[VP Games] cleaned ${removed} tool(s) from deactivated game: ${activeGame.id}`);
        }
        const old = activeGame;
        activeGame = null;
        if (opts.persist !== false) await DB?.clearActiveGameId?.();
        window.dispatchEvent(new CustomEvent('vp-game:deactivated', { detail: old ? { id: old.id, info: old.info } : null }));
        return true;
    }

    function getActiveGame() { return activeGame; }

    async function autoActivateSavedGame() {
        const id = await DB?.getActiveGameId?.().catch(() => null);
        if (!id) return null;
        try {
            const active = await activateGame(id, { persist: false });
            console.log('[VP Games] auto-activated:', id);
            return active;
        } catch (err) {
            console.warn('[VP Games] auto-activate failed:', id, err);
            return null;
        }
    }

    function injectStyles() {
        if (document.getElementById('vp-games-style')) return;
        const style = document.createElement('style');
        style.id = 'vp-games-style';
        style.textContent = `
            .vp-games-panel { height:100%; display:flex; flex-direction:column; min-height:0; }
            .vp-games-toolbar { flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:8px 8px 6px; border-bottom:1px solid rgba(255,255,255,0.06); background:rgba(255,255,255,0.025); flex-wrap:wrap; }
            .vp-games-toolbar .spacer { flex:1; }
            .vp-games-create { display:flex; gap:6px; flex-wrap:wrap; align-items:center; }
            .vp-games-statusbar { flex:0 0 auto; display:flex; align-items:center; gap:8px; padding:0 9px 7px; border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.018); color:var(--text-secondary,#a6adc8); font-size:11px; }
            .vp-games-body { flex:1; min-height:0; display:flex; flex-direction:column; padding:0; }
            .vp-games-list { flex:0 0 auto; max-height: 220px; overflow:auto; display:flex; flex-direction:column; padding: 8px; border-bottom: 1px solid rgba(255,255,255,0.08); background: rgba(0,0,0,0.12); }
            .vp-games-list-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(280px, 1fr)); gap: 8px; }
            .vp-games-stage { flex:1; min-width:0; min-height:0; overflow:auto; border-radius:0; background:rgba(0,0,0,0.16); position: relative; }
            .vp-game-item { border:1px solid rgba(255,255,255,0.08); border-radius:8px; padding:8px 10px; background:rgba(255,255,255,0.04); cursor:pointer; display: flex; flex-direction: column; gap: 5px; }
            .vp-game-item:hover { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.16); }
            .vp-game-item.active { border-color:rgba(108,95,166,0.72); background:rgba(108,95,166,0.14); }
            .vp-game-item.active-context { border-color:rgba(166,227,161,0.62); box-shadow:0 0 0 1px rgba(166,227,161,0.12) inset; }
            .vp-game-title-row { display:flex; align-items:center; gap:6px; min-width:0; }
            .vp-game-title { flex:1; min-width:0; font-size:13px; font-weight:800; color:var(--text-primary,#cdd6f4); overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
            .vp-game-badge { flex:0 0 auto; border:1px solid rgba(255,255,255,0.12); border-radius:999px; padding:1px 6px; font-size:10px; color:var(--text-secondary,#a6adc8); background:rgba(255,255,255,0.05); }
            .vp-game-badge.active { color:#eaffef; border-color:rgba(166,227,161,0.36); background:rgba(166,227,161,0.12); }
            .vp-game-badge.mounted { color:#f9e2af; border-color:rgba(249,226,175,0.28); background:rgba(249,226,175,0.1); }
            .vp-game-sub { margin-top:5px; font-size:11px; color:var(--text-secondary,#a6adc8); line-height:1.35; overflow-wrap:anywhere; }
            .vp-game-actions { margin-top:7px; display:flex; gap:5px; flex-wrap:wrap; }
            .vp-games-empty { height:100%; display:flex; align-items:center; justify-content:center; text-align:center; color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.45; padding:18px; }
            #vp-game-overlay-root { position:fixed; inset:0; z-index:70000; background:var(--bg-primary,#11111b); color:var(--text-primary,#cdd6f4); display:flex; flex-direction:column; font-family:system-ui,-apple-system,Segoe UI,sans-serif; }
            .vp-game-overlay-topbar { height:38px; flex:0 0 38px; display:flex; align-items:center; gap:10px; padding:0 10px; background:var(--bg-tertiary,#252540); border-bottom:1px solid var(--border,#383860); box-shadow:0 4px 18px rgba(0,0,0,.22); }
            .vp-game-overlay-title { flex:1; min-width:0; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; font-weight:900; font-size:13px; }
            .vp-game-overlay-actions { display:flex; gap:7px; }
            .vp-game-overlay-body { flex:1; min-height:0; overflow:auto; position:relative; background:radial-gradient(circle at 50% 0%, rgba(108,95,166,.14), transparent 34%), var(--bg-primary,#11111b); }
            body.vp-game-overlay-active { overflow:hidden !important; }
            .vp-activity-request-toast { position:fixed; left:50%; top:50%; transform:translate(-50%,-50%); z-index:71000; width:min(420px, calc(100vw - 32px)); border:1px solid rgba(255,255,255,.16); border-radius:16px; background:rgba(24,24,38,.97); color:var(--text-primary,#cdd6f4); box-shadow:0 24px 80px rgba(0,0,0,.55), 0 0 0 9999px rgba(0,0,0,.34); padding:12px; font-family:system-ui,-apple-system,Segoe UI,sans-serif; }
            .vp-activity-request-head { display:flex; align-items:center; gap:8px; }
            .vp-activity-request-head b { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; font-size:13px; }
            .vp-activity-request-body { margin:7px 0 10px; color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.4; }
            .vp-activity-request-actions { display:flex; gap:7px; flex-wrap:wrap; }
        `;
        document.head.appendChild(style);
    }

    async function renderGamesPanel(container) {
        injectStyles();
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'vp-games-panel';
        wrap.innerHTML = `
            <div class="vp-games-toolbar">
                <div class="vp-games-create">
                    <button class="vp-btn" data-act="hello">＋ Hello</button>
                    <button class="vp-btn vp-btn-ghost" data-act="messenger">＋ Messenger</button>
                    <button class="vp-btn vp-btn-ghost" data-act="lifesim">＋ LifeSim</button>
                </div>
                <span class="spacer"></span>
                <button class="vp-btn vp-btn-ghost" data-act="import">📥 Import</button>
                <button class="vp-btn vp-btn-ghost" data-act="refresh">Refresh</button>
                <button class="vp-btn vp-btn-ghost" data-act="folder">📂 Folder</button>
            </div>
            <div class="vp-games-statusbar">
                <span data-role="active-status">Trusted local game modules</span>
            </div>
            <div class="vp-games-body">
                <div class="vp-games-list"></div>
                <div class="vp-games-stage"><div class="vp-games-empty">Select or create a game module.</div></div>
            </div>`;
        container.appendChild(wrap);

        const listEl = wrap.querySelector('.vp-games-list');
        const stage = wrap.querySelector('.vp-games-stage');
        let selectedId = null;
        const activeStatus = wrap.querySelector('[data-role="active-status"]');
        const updateActiveStatus = () => {
            const mounted = activeMounted?.id || 'none';
            const active = activeGame?.id || 'none';
            activeStatus.textContent = `Mounted: ${mounted} · Active context: ${active}`;
        };

        const renderList = async () => {
            const games = await DB?.listGames?.().catch(err => { VP.showToast?.(`List games failed: ${err.message || err}`, 'error'); return []; }) || [];
            listEl.innerHTML = '';
            if (!games.length) {
                setEmptyMessage(listEl, 'No games installed in this world yet.');
                return;
            }
            
            const gridEl = document.createElement('div');
            gridEl.className = 'vp-games-list-grid';
            
            for (const game of games) {
                const item = document.createElement('div');
                const isSelected = selectedId === game.id;
                const isMounted = activeMounted?.id === game.id;
                const isActive = activeGame?.id === game.id;
                item.className = 'vp-game-item' + (isSelected ? ' active' : '') + (isActive ? ' active-context' : '');
                item.innerHTML = `
                    <div class="vp-game-title-row">
                        <div class="vp-game-title"></div>
                        ${isMounted ? '<span class="vp-game-badge mounted">mounted</span>' : ''}
                        ${isActive ? '<span class="vp-game-badge active">active</span>' : ''}
                    </div>
                    <div class="vp-game-sub"><span data-role="desc"></span> <code></code></div>
                    <div class="vp-game-actions">
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="load">Load</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="reload" title="Reload Module">↻</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="activate">${isActive ? 'Deactivate' : 'Activate Context'}</button>
                        <span class="spacer" style="flex:1"></span>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="export" title="Export .vpgame">📥</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm vp-btn-danger" data-act="delete" title="Delete">🗑</button>
                        <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="folder" title="Open folder">📂</button>
                    </div>`;
                item.querySelector('.vp-game-title').textContent = game.title || game.id;
                item.querySelector('[data-role="desc"]').textContent = game.description || '';
                item.querySelector('code').textContent = game.id;
                item.querySelector('[data-act="load"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    selectedId = game.id;
                    await renderList();
                    try { await mountGame(game.id, stage); updateActiveStatus(); await renderList(); }
                    catch (err) { console.error('[VP Games] mount failed:', err); setEmptyMessage(stage, errorText('Game failed', err)); }
                });
                item.querySelector('[data-act="reload"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    selectedId = game.id;
                    await renderList();
                    try { await reloadGame(game.id, stage); updateActiveStatus(); await renderList(); VP.showToast?.('Game reloaded', 'success'); }
                    catch (err) { console.error('[VP Games] reload failed:', err); setEmptyMessage(stage, errorText('Reload failed', err)); }
                });
                item.querySelector('[data-act="export"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        const res = await DB?.exportGame?.(game.id, null, { includeState: false });
                        if (res) VP.showToast?.(`Exported .vpgame (${Math.round((res.bytes || 0) / 1024)} KB)`, 'success');
                    } catch (err) { VP.showToast?.(`Export game failed: ${err.message || err}`, 'error'); }
                });
                item.querySelector('[data-act="activate"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try {
                        if (activeGame?.id === game.id) {
                            await deactivateGame();
                            VP.showToast?.(`Deactivated game context: ${game.title || game.id}`, 'info');
                        } else {
                            await activateGame(game.id);
                            VP.showToast?.(`Activated game context: ${game.title || game.id}`, 'success');
                        }
                        updateActiveStatus();
                        await renderList();
                    }
                    catch (err) { VP.showToast?.(`Activate failed: ${err.message || err}`, 'error'); }
                });
                item.querySelector('[data-act="delete"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    const ans = await VP.showConfirm?.({
                        title: 'Delete game?',
                        message: `Delete game «${game.title || game.id}» from this world?\n\nThe installed game folder will be removed. Game state will be deleted too. Export first if you want to keep it.`,
                        buttons: [
                            { id: 'cancel', label: 'Cancel', ghost: true },
                            { id: 'ok', label: 'Delete', danger: true },
                        ],
                    });
                    if (ans !== 'ok') return;
                    try {
                        const wasMounted = activeMounted?.id === game.id;
                        const wasActive = activeGame?.id === game.id;
                        if (wasMounted) await unmountActiveGame();
                        if (wasActive) await deactivateGame();
                        await DB?.deleteGame?.(game.id);
                        if (selectedId === game.id) selectedId = null;
                        setEmptyMessage(stage, 'Game deleted.');
                        updateActiveStatus();
                        await renderList();
                        VP.showToast?.('Game deleted', 'success');
                    } catch (err) { VP.showToast?.(`Delete game failed: ${err.message || err}`, 'error'); }
                });
                item.querySelector('[data-act="folder"]').addEventListener('click', async (e) => {
                    e.stopPropagation();
                    try { await DB?.openGameFolder?.(game.id); } catch (err) { VP.showToast?.(`Open game folder failed: ${err.message || err}`, 'error'); }
                });
                item.addEventListener('dblclick', () => item.querySelector('[data-act="load"]').click());
                gridEl.appendChild(item);
            }
            listEl.appendChild(gridEl);
        };

        wrap.querySelector('[data-act="hello"]').addEventListener('click', async () => {
            try {
                const info = await DB?.createHelloGame?.();
                VP.showToast?.('Hello Game created/updated', 'success');
                await renderList();
                if (info?.id) {
                    selectedId = info.id;
                    await mountGame(info.id, stage);
                    updateActiveStatus();
                    await renderList();
                }
            } catch (err) { VP.showToast?.(`Create Hello Game failed: ${err.message || err}`, 'error'); }
        });
        wrap.querySelector('[data-act="messenger"]').addEventListener('click', async () => {
            try {
                const info = await DB?.createMessengerGame?.();
                VP.showToast?.('Messenger Game created/updated', 'success');
                await renderList();
                if (info?.id) {
                    selectedId = info.id;
                    await mountGame(info.id, stage);
                    updateActiveStatus();
                    await renderList();
                }
            } catch (err) { VP.showToast?.(`Create Messenger Game failed: ${err.message || err}`, 'error'); }
        });
        wrap.querySelector('[data-act="lifesim"]').addEventListener('click', async () => {
            try {
                const info = await DB?.createLifeSimGame?.();
                VP.showToast?.('LifeSim Core created/updated', 'success');
                await renderList();
                if (info?.id) {
                    selectedId = info.id;
                    await mountGame(info.id, stage);
                    updateActiveStatus();
                    await renderList();
                }
            } catch (err) { VP.showToast?.(`Create LifeSim Core failed: ${err.message || err}`, 'error'); }
        });
        wrap.querySelector('[data-act="import"]').addEventListener('click', async () => {
            const ans = await VP.showConfirm?.({
                title: 'Import .vpgame?',
                message: '.vpgame files contain executable JavaScript. Only import games you trust.\n\nContinue?',
                buttons: [
                    { id: 'cancel', label: 'Cancel', ghost: true },
                    { id: 'ok', label: 'Import' },
                ],
            });
            if (ans !== 'ok') return;
            try {
                const res = await DB?.importGameFromFile?.();
                if (!res?.game) return;
                VP.showToast?.(`Imported game: ${res.game.title || res.game.id}`, 'success');
                await renderList();
                selectedId = res.game.id;
                await mountGame(res.game.id, stage);
                updateActiveStatus();
                await renderList();
            } catch (err) { VP.showToast?.(`Import .vpgame failed: ${err.message || err}`, 'error'); }
        });
        wrap.querySelector('[data-act="refresh"]').addEventListener('click', renderList);
        wrap.querySelector('[data-act="folder"]').addEventListener('click', async () => {
            try { await DB?.openGamesFolder?.(); } catch (err) { VP.showToast?.(`Open games folder failed: ${err.message || err}`, 'error'); }
        });
        updateActiveStatus();
        renderList();
    }


    function registerActiveGamePromptProvider() {
        if (!VP.registerPromptProvider || window.__VP_ACTIVE_GAME_PROMPT_PROVIDER__) return;
        window.__VP_ACTIVE_GAME_PROMPT_PROVIDER__ = true;
        VP.registerPromptProvider({
            id: 'active-game-context',
            order: 15,
            build() {
                const source = activeGame?.module ? activeGame : null;
                if (!source?.module) return '';
                try {
                    if (typeof source.module.buildPromptContext === 'function') {
                        return source.module.buildPromptContext(source.api) || '';
                    }
                    if (typeof source.module.getPromptContext === 'function') {
                        return source.module.getPromptContext(source.api) || '';
                    }
                } catch (err) {
                    console.warn('[VP Games] active game prompt provider failed:', err);
                }
                return '';
            },
        });
    }

    async function bootGames() {
        if (VP.ready) await VP.ready;
        registerActiveGamePromptProvider();

        // Register the panel BEFORE any async game activation. Otherwise the
        // shell can restore a saved layout containing panel='game' while the
        // panel registry doesn't know it yet; shell then falls back to Stage
        // and may persist that mutation. This was visible after app restart.
        if (!VP.getPanel?.('game')) {
            VP.registerPanel({ id: 'game', title: 'Game', icon: '🎮', order: 27, create: renderGamesPanel });
        }

        await autoActivateSavedGame();
        VP.shell?.render?.();
        console.log('[VP Games] ready — trusted game host registered.');
    }

    window.VP_GAMES = {
        register,
        unregister,
        getModule,
        loadGameModule,
        mountGame,
        reloadGame,
        unmountActiveGame,
        activateGame,
        deactivateGame,
        getActiveGame,
        makeApi,
        requestActivity,
        acceptActivity,
        declineActivity,
        startActivity: startActivityRef,
        autoActivity: autoActivityRef,
        getActiveActivityRequest: () => activeActivityRequest,
        processActivityCommands,
        processChatCommands: processActivityCommands,
        openOverlay: openGameOverlay,
        closeOverlay: closeGameOverlay,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootGames().catch(err => console.error('[VP Games] boot failed:', err)); });
    } else {
        setTimeout(() => { bootGames().catch(err => console.error('[VP Games] boot failed:', err)); }, 0);
    }
})();
