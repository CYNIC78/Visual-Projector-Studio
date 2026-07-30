// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-session.js                                           ║
// ║  Visual Projector — autonomous local session frontend            ║
// ║                                                                  ║
// ║  Owns: Stage input, session log, local OpenAI-compatible model   ║
// ║  settings, basic send/stop/regenerate.                           ║
// ║                                                                  ║
// ║  v0 now talks to the VP native chat pipeline directly: the core   ║
// ║  still injects manifest/frame context and consumes [IMG]/[FX]/    ║
// ║  [CAT]/[TAB], but the standalone frontend no longer depends on    ║
// ║  the global fetch interceptor as its main runtime path.           ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Session] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const S = VP.state;
    const DB = window.VP_DB;
    const SESSION_KEY = 'vp-session-v1';
    const MODEL_KEY   = 'vp-model-config-v1';

    // activeInlineMessageEditCleanup — moved to js/session-panels.js (v13): all usages lived in the UI-renderers zone.

    const DEFAULT_MODEL = {
        endpoint: 'http://localhost:1234/v1/chat/completions',
        apiKey: '',
        model: 'local-model',
        temperature: 0.7,
        maxTokens: 2048,
        stream: true,
        toolsMode: 'off',        // 'off' | 'native' ('text-tags' reserved but dead — option hidden in UI v26)
        toolLoopLimit: 4,        // max tool call rounds per turn
        agenticLoop: false,      // v24: one continuation after [TAB/CAT] scene transitions (depth 1)
        // v26 per-tool management: disabledTools: string[] — persisted truth for
        // per-tool toggles (UI lives in the Model panel; applied to the registry at
        // boot and respected by VP.tools.register for late registrations).
    };

    const DEFAULT_SESSION = {
        messages: [],
        running: false,
        abortController: null,
        draft: '',
        view: {
            compact: false,
            showRaw: false,
            autoScroll: true,
            markdown: false,
            fontSize: 13,
            fontFamily: 'system',
            avatarSize: 22,
            avatarStyle: 'head',   // 'head' = in bubble header | 'float' = inline, text wraps right/below
            logBackground: '',     // gallery asset tag used as log backdrop ('' = none)
            logBackgroundDim: 40,  // 0..90 % darkening overlay for readability
            bubbleBlur: false,     // frosted-glass bubbles (backdrop blur)
            marginLeft: 0,
            marginRight: 0,
            bubbleAlign: 'full',
            sceneEventMode: 'compact',
            sceneEventContextDepth: 4,
            syncChatTyping: false, // Studio 2.0: Synchronize chat text with subtitles
        },
        input: {
            clearAfterSend: true,
            enterToSend: false,
            fontSize: 13,
            marginLeft: 0,
            marginRight: 0,
        },
    };

    const uid = (prefix = 'msg') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    let _stateHydrated = false;
    let _panelsRenderQueued = false;
    let _renderAllPanels = false;
    let _panelsToRender = new Set();
    let _storageHydrationPromise = null;

    function normalizeState() {
        S.modelConfig = {
            ...DEFAULT_MODEL,
            ...(S.modelConfig || {}),
        };
        if (!String(S.modelConfig.endpoint || '').trim()) S.modelConfig.endpoint = DEFAULT_MODEL.endpoint;
        if (!String(S.modelConfig.model || '').trim()) S.modelConfig.model = DEFAULT_MODEL.model;
        if (!Number.isFinite(+S.modelConfig.temperature)) S.modelConfig.temperature = DEFAULT_MODEL.temperature;
        if (!Number.isFinite(+S.modelConfig.maxTokens)) S.modelConfig.maxTokens = DEFAULT_MODEL.maxTokens;
        // v26: 'text-tags' was never implemented (loop only honors 'native'); migrate honestly
        if (S.modelConfig.toolsMode === 'text-tags') S.modelConfig.toolsMode = 'off';

        S.session = {
            ...JSON.parse(JSON.stringify(DEFAULT_SESSION)),
            ...(S.session || {}),
            running: false,
            abortController: null,
            view: { ...DEFAULT_SESSION.view, ...(S.session?.view || {}) },
            input: { ...DEFAULT_SESSION.input, ...(S.session?.input || {}) },
        };
    }

    async function hydratePersistentState() {
        if (_storageHydrationPromise) return _storageHydrationPromise;
        _storageHydrationPromise = (async () => {
            let savedModel = null;
            let savedSession = null;

            if (DB?.getModelConfig) {
                try { savedModel = await DB.getModelConfig(); } catch (err) {
                    console.warn('[VP Session] Failed to load model config from storage:', err);
                }
            }
            if (DB?.getSessionState) {
                try { savedSession = await DB.getSessionState(); } catch (err) {
                    console.warn('[VP Session] Failed to load session from storage:', err);
                }
            }

            if (!savedModel) {
                try { savedModel = JSON.parse(localStorage.getItem(MODEL_KEY) || 'null'); } catch {}
                if (savedModel && DB?.setModelConfig) DB.setModelConfig(savedModel).catch(() => {});
            }
            if (!savedSession) {
                try { savedSession = JSON.parse(localStorage.getItem(SESSION_KEY) || 'null'); } catch (err) {
                    console.warn('[VP Session] Failed to load legacy session:', err);
                }
                if (savedSession && DB?.setSessionState) DB.setSessionState(savedSession).catch(() => {});
            }

            if (savedModel) S.modelConfig = { ...(S.modelConfig || {}), ...savedModel };
            if (savedSession) S.session = { ...(S.session || {}), ...savedSession };
            normalizeState();
            _stateHydrated = true;
        })();
        return _storageHydrationPromise;
    }

    function ensureState() {
        if (!_stateHydrated) normalizeState();
    }

    function persistModel() {
        if (DB?.setModelConfig) DB.setModelConfig(S.modelConfig).catch(() => {});
        else {
            try { localStorage.setItem(MODEL_KEY, JSON.stringify(S.modelConfig)); } catch {}
        }
    }

    function persistSession() {
        const copy = {
            ...S.session,
            running: false,
            abortController: null,
        };
        delete copy.messages;
        delete copy.draft;
        if (DB?.setSessionState) DB.setSessionState(copy).catch(() => {});
        else {
            try { localStorage.setItem(SESSION_KEY, JSON.stringify(copy)); } catch {}
        }
    }

    function safeParseJson(value) {
        if (value == null) return {};
        if (typeof value === 'object') return value;
        try { return JSON.parse(value); }
        catch { return {}; }
    }

    // v24: collect executable [TAB:…]/[CAT:…] transitions from a reply text.
    // Only verb-valid ones (parseDirBody keeps the grammar of v17).
    function detectDirTransitions(text) {
        const cmds = VP.tags?.commands?.(String(text || '')) || [];
        const out = [];
        for (const cmd of cmds) {
            if (cmd.type !== 'TAB' && cmd.type !== 'CAT') continue;
            const dir = VP.tags?.parseDirBody?.(cmd.body);
            if (!dir) continue;
            out.push({ raw: cmd.raw, entity: cmd.type, action: dir.action, name: dir.name });
        }
        return out;
    }

    // v25: tool vision attachments. A tool (e.g. scene_navigate) may return
    // { attachments: [{ kind:'image', dataUrl, caption, tag }] } inside its
    // result data. The image rides to the model as a dedicated user-role vision
    // message in the SAME proven shape as collage/focus context (see
    // getContextMessages in visual-projector.js); the model-facing tool JSON and
    // the persisted tool_results keep metadata only — no base64 in context
    // tokens or in chat storage.
    function extractToolAttachments(resultData) {
        if (!resultData || !Array.isArray(resultData.attachments)) return [];
        return resultData.attachments.filter(a => a && a.kind === 'image'
            && typeof a.dataUrl === 'string' && a.dataUrl.startsWith('data:image/'));
    }

    function sanitizeToolResultData(resultData) {
        if (!resultData || typeof resultData !== 'object' || !Array.isArray(resultData.attachments)) return resultData;
        return { ...resultData, attachments: resultData.attachments.map(({ dataUrl, ...meta }) => meta) };
    }

    function buildToolVisionMessage(resultData) {
        const attachments = extractToolAttachments(resultData);
        if (!attachments.length) return null;
        const caption = attachments.map(a => String(a.caption || 'Tool image attachment')).join('\n');
        return {
            role: 'user',
            content: [
                { type: 'text', text: `[TOOL VISION]\n${caption}\n[/TOOL VISION]` },
                ...attachments.map(a => ({ type: 'image_url', image_url: { url: a.dataUrl } })),
            ],
        };
    }

    function stripVpCommands(text) {
        // Keep log cleanup gentler than subtitle cleanup: only strip VP commands here.
        const raw = String(text || '');
        const stripped = VP.tags?.strip
            ? VP.tags.strip(raw)
            : raw.replace(/\[\s*(IMG|SET|PLAY|FRAME|IMAGE|FX|CAT|TAB|ACTIVITY_REQUEST|ACTIVITY_CHALLENGE|ACTIVITY_START|ACTIVITY_AUTO|ACTIVITY_ACCEPT|ACTIVITY_DECLINE)\s*(?::|：)?[^\]\r\n]*\]/giu, '');
        return stripped.replace(/\n{3,}/g, '\n\n').trim();
    }

    const ACTIVITY_COMMAND_TYPES = ['ACTIVITY_REQUEST', 'ACTIVITY_CHALLENGE', 'ACTIVITY_START', 'ACTIVITY_AUTO', 'ACTIVITY_ACCEPT', 'ACTIVITY_DECLINE'];

    async function hubRequest(name, payload = {}, fallback = null) {
        if (window.VP_HUB?.request) {
            try { return await window.VP_HUB.request(name, payload); }
            catch (err) { console.warn(`[VP Session] Hub request failed: ${name}`, err); }
        }
        return typeof fallback === 'function' ? fallback() : fallback;
    }

    async function requestShellRender(reason = 'session') {
        return hubRequest('shell:render', { reason }, () => VP.shell?.render?.());
    }

    async function buildOpenAIToolsForSession() {
        const res = await hubRequest('tools:build-openai-tools', {}, null);
        if (Array.isArray(res?.tools)) return res.tools;
        return VP.tools?.buildOpenAITools?.() || [];
    }

    async function executeToolForSession(name, args = {}, meta = {}) {
        const res = await hubRequest('tools:execute', { name, args, meta }, null);
        if (res) return res;
        return VP.tools?.execute?.(name, args, meta) || { ok: false, error: 'Tools registry unavailable' };
    }

    function summarizeToolForSession(name, result) {
        return VP.tools?.summarize?.(name, result) || `Tool: ${name}`;
    }

    async function processActivityCommandsViaBus(text, meta = {}, warnLabel = 'activity command') {
        if (!text) return;
        if (window.VP_HUB?.request) {
            window.VP_HUB.request('games:process-activity-commands', { text, meta })
                .catch(err => console.warn(`[VP Session] ${warnLabel} processing failed:`, err));
            return;
        }
        if (!window.VP_GAMES?.processActivityCommands) return;
        if (VP.commands?.executeText) {
            VP.commands.executeText(text, {
                ...meta,
                allowNonQueueable: true,
                types: ACTIVITY_COMMAND_TYPES,
            }).catch(err => console.warn(`[VP Session] ${warnLabel} processing failed:`, err));
        } else {
            window.VP_GAMES.processActivityCommands(text, meta)
                .catch(err => console.warn(`[VP Session] ${warnLabel} processing failed:`, err));
        }
    }

    function requestPlayback(command, payload = {}, fallback = null) {
        if (window.VP_HUB?.request) {
            window.VP_HUB.request(`playback:${command}`, payload)
                .catch((err) => {
                    console.warn(`[VP Session] Hub playback:${command} failed; using legacy fallback:`, err);
                    if (typeof fallback === 'function') fallback();
                });
            return true;
        }
        if (typeof fallback === 'function') fallback();
        return false;
    }

    function requestPlaybackOpen(role, metadata = {}) {
        return requestPlayback('open', { role, metadata }, () => VP.playback?.open?.(role, metadata));
    }

    function requestPlaybackPush(delta) {
        return requestPlayback('push', { delta: String(delta || '') }, () => VP.playback?.push?.(delta));
    }

    function requestPlaybackCommit(text, metadata = {}) {
        return requestPlayback('commit', { text: String(text || ''), metadata }, () => VP.playback?.commit?.(text, metadata));
    }

    function requestPlaybackAbort() {
        return requestPlayback('abort', {}, () => VP.playback?.abort?.());
    }

    function requestPlaybackSync(messages) {
        return requestPlayback('sync', { messages: Array.isArray(messages) ? messages : [] }, () => VP.playback?.sync?.(messages));
    }

    async function prepareRequestBodyViaContext(body) {
        if (window.VP_HUB?.request && VP.context?.consumePreparedBody) {
            try {
                const res = await window.VP_HUB.request('context:prepare-request-body', { body, source: 'session' });
                if (res?.ticket) {
                    const prepared = VP.context.consumePreparedBody(res.ticket);
                    if (prepared) return prepared;
                    console.warn('[VP Session] Context ticket returned no body; using legacy context injection.');
                }
            } catch (err) {
                console.warn('[VP Session] Hub context:prepare-request-body failed; using legacy context injection:', err);
            }
        }
        return VP.utils.injectProjectorRequestBody(body);
    }


    function escapeHtml(str) {
        return String(str == null ? '' : str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#39;');
    }

    function renderMiniMarkdown(text) {
        // Safe, deliberately tiny chat-markdown subset. No raw HTML, no images,
        // no tables, no links for now — just the useful roleplay/chat basics.
        let s = escapeHtml(text);
        const code = [];
        s = s.replace(/`([^`\n]+)`/g, (_, inner) => {
            code.push(`<code>${inner}</code>`);
            return `\uE100${code.length - 1}\uE101`;
        });
        s = s.replace(/^&gt;\s?(.*)$/gm, '<blockquote>$1</blockquote>');
        s = s.replace(/\*\*([^*\n][\s\S]*?[^*\n])\*\*/g, '<strong>$1</strong>');
        s = s.replace(/(^|[\s(])\*(?!\s|\*)([^*\n]+?)(?<!\s)\*(?=[\s).,!?;:]|$)/g, '$1<em>$2</em>');
        s = s.replace(/\uE100(\d+)\uE101/g, (_, i) => code[+i] || '');
        s = s.replace(/\n/g, '<br>');
        return s;
    }

    function parseSceneEvent(text) {
        const raw = String(text || '').trim();
        const match = raw.match(/^\[SCENE EVENT:\s*([^\]]+)\]([\s\S]*?)\[\/SCENE EVENT\]\s*$/i);
        if (!match) return null;
        const type = String(match[1] || 'EVENT').trim();
        const inner = String(match[2] || '').trim();
        const lines = inner.split(/\r?\n/).map(x => x.trim()).filter(Boolean);
        const fields = [];
        const notes = [];
        for (const line of lines) {
            const kv = line.match(/^([^:]{2,42}):\s*(.*)$/);
            if (kv) fields.push({ key: kv[1].trim(), value: kv[2].trim() });
            else notes.push(line);
        }
        const get = (name) => fields.find(f => f.key.toLowerCase() === name.toLowerCase())?.value || '';
        const summary = get('Replay summary') || get('Summary') || notes.find(x => !/^Use this/i.test(x)) || get('Outcome') || get('Status') || inner.slice(0, 160);
        const activity = get('Activity') || get('Activity ref') || '';
        return { type, inner, lines, fields, notes, summary, activity };
    }

    function isSceneEventMessage(m) {
        return !!parseSceneEvent(m?.raw ?? m?.text ?? '');
    }

    function sceneEventIcon(type = '') {
        const t = String(type || '').toUpperCase();
        if (t.includes('RESULT')) return '🎮';
        if (t.includes('ACCEPT')) return '✅';
        if (t.includes('DECLIN')) return '↩️';
        if (t.includes('START')) return '▶️';
        return '🎭';
    }

    function renderSceneEventCard(evt) {
        const mode = S.session.view.sceneEventMode || 'compact';
        const title = evt.type.replace(/_/g, ' ').toLowerCase().replace(/\b\w/g, c => c.toUpperCase());
        const summary = evt.summary || 'Scene event';
        const activity = evt.activity ? `<span class="vp-scene-event-pill">${escapeHtml(evt.activity)}</span>` : '';
        const fields = evt.fields.map(f => `<div class="vp-scene-event-field"><b>${escapeHtml(f.key)}</b><span>${escapeHtml(f.value)}</span></div>`).join('');
        const notes = evt.notes.length ? `<div class="vp-scene-event-notes">${evt.notes.map(escapeHtml).join('<br>')}</div>` : '';
        const line = `
            <div class="vp-scene-event-line">
                <span class="vp-scene-event-icon">${sceneEventIcon(evt.type)}</span>
                <b>${escapeHtml(title)}</b>
                ${activity}
                <span class="vp-scene-event-summary">${escapeHtml(summary)}</span>
            </div>`;
        if (mode === 'minimal') {
            return `<div class="vp-scene-event-card mode-minimal">${line}</div>`;
        }
        if (mode === 'expanded') {
            return `
                <div class="vp-scene-event-card mode-expanded">
                    ${line}
                    <div class="vp-scene-event-fields">${fields || '<em>No structured fields.</em>'}</div>
                    ${notes}
                </div>`;
        }
        return `
            <div class="vp-scene-event-card mode-compact">
                ${line}
                <details class="vp-scene-event-details">
                    <summary>details</summary>
                    <div class="vp-scene-event-fields">${fields || '<em>No structured fields.</em>'}</div>
                    ${notes}
                </details>
            </div>`;
    }

    function compactSceneEventForContext(evt) {
        if (!evt) return '';
        const type = String(evt.type || 'SCENE EVENT').replace(/_/g, ' ').trim();
        const activity = evt.activity || evt.fields.find(f => /^Activity ref$/i.test(f.key))?.value || '';
        const status = evt.fields.find(f => /^Status$/i.test(f.key))?.value || '';
        const outcome = evt.fields.find(f => /^Outcome$/i.test(f.key))?.value || '';
        const score = evt.fields.find(f => /^Score$/i.test(f.key))?.value || '';
        const parts = [type];
        if (activity) parts.push(activity);
        if (status) parts.push(`status=${status}`);
        if (outcome) parts.push(`outcome=${outcome}`);
        if (score && score !== 'n/a') parts.push(`score=${score}`);
        const summary = evt.summary ? ` — ${evt.summary}` : '';
        return `[PAST SCENE EVENT MARKER] ${parts.join(' · ')}${summary}\nDetails omitted from current model context; use the following dialogue/reaction messages as the narrative summary. [/PAST SCENE EVENT MARKER]`;
    }

    function setMessageBodyContent(body, m) {
        const raw = m.raw || '';
        const clean = m.clean || raw || '';
        const sceneEvent = m.role === 'system' ? parseSceneEvent(raw) : null;
        
        // Float avatar mode
        const floatAvatar = (!sceneEvent
            && S.session.view.avatarStyle === 'float'
            && (m.role === 'user' || m.role === 'assistant'))
            ? renderMessageAvatar(m, 'float') : '';
            
        if (S.session.view.showRaw) {
            if (floatAvatar) body.innerHTML = floatAvatar + escapeHtml(raw);
            else body.textContent = raw;
            return;
        }
        if (sceneEvent) {
            body.innerHTML = renderSceneEventCard(sceneEvent);
            return;
        }

        // Studio 2.0: Build body with integrated tool indicators
        let htmlContent = '';
        let toolsHtml = '';

        // 1. Prepare technical tool info (Pre-pended for stability)
        if (m.tool_calls && Array.isArray(m.tool_calls) && m.tool_calls.length) {
            const results = Array.isArray(m.tool_results) ? m.tool_results : [];
            const isSimple = S.session.view.simpleBubbles;
            
            m.tool_calls.forEach((tc, idx) => {
                const name = tc.function?.name || 'unknown_tool';
                const result = results[idx] || null;
                const toolDef = VP.tools?.get(name);
                const summary = VP.tools?.summarize(name, result) || `Tool: ${name}`;
                const icon = toolDef?.icon || '🔧';
                
                if (isSimple) {
                    // Immersive Pill (Top-aligned)
                    toolsHtml += `<div class="vp-tool-pill" title="Technical detail available in Log mode">${icon} ${summary}</div>`;
                } else {
                    // Full Spoiler for Log mode (No extra whitespace here!)
                    const args = tc.function?.arguments || '{}';
                    toolsHtml += `<details class="vp-tool-info ${result ? 'status-success' : ''}"><summary>${icon} ${summary}</summary><pre>Call: ${name}(${args})${result ? '\nResponse: ' + JSON.stringify(result, null, 2) : ''}</pre></details>`;
                }
            });
        }

        // Add tools to the top
        if (toolsHtml) {
            htmlContent += `<div class="vp-message-tools-area">${toolsHtml}</div>`;
        }
        
        // 2. Add main text content below
        if (S.session.view.markdown) htmlContent += floatAvatar + renderMiniMarkdown(clean);
        else htmlContent += floatAvatar + escapeHtml(clean);

        body.innerHTML = htmlContent;
    }

    function msgText(m) {
        return m.raw ?? m.text ?? '';
    }

    function getSessionMessageDescriptor(message) {
        if (!message) return null;
        const text = String(msgText(message) || message.clean || '');
        return {
            id: message.id || null,
            role: message.role || null,
            speakerId: message.speakerId || null,
            status: message.status || null,
            createdAt: message.createdAt || message.timestamp || null,
            textPreview: text.slice(0, 260),
            textLength: text.length,
            hasInternalPrompt: !!message.internalPrompt,
            toolCallCount: Array.isArray(message.tool_calls) ? message.tool_calls.length : 0,
            toolResultCount: Array.isArray(message.tool_results) ? message.tool_results.length : 0,
            manifestCount: Array.isArray(message.manifests) ? message.manifests.length : 0,
        };
    }

    function chatApi() {
        return VP.chats || null;
    }

    // Session hot path remains synchronous for streaming, but all chat ownership
    // is now centralized here. This adapter is the suspension bridge between the
    // old immediate Session loop and the new Chats/Hub owner contract.
    const SessionMessageAdapter = {
        api() { return chatApi(); },
        activeChat() { return this.api()?.getActiveChat?.() || null; },
        activeSpeaker() { return this.api()?.getActiveSpeaker?.() || null; },
        getMessages() {
            return this.api()?.getActiveChatMessages?.() || S.session.messages || [];
        },
        getDraft() {
            const draft = this.api()?.getActiveChatDraft?.();
            return draft != null ? draft : (S.session.draft || '');
        },
        setDraft(value) {
            const text = String(value || '');
            const ok = this.api()?.setActiveChatDraft ? this.api().setActiveChatDraft(text) : (() => {
                S.session.draft = text;
                persistSession();
                return true;
            })();
            emitSessionDraftChanged('message-adapter');
            return ok;
        },
        replaceMessages(messages) {
            const next = Array.isArray(messages) ? messages : [];
            if (this.api()?.setActiveChatMessages) this.api().setActiveChatMessages(next);
            else {
                S.session.messages = next;
                persistSession();
            }
            const current = this.getMessages();
            emitSessionEvent('session:messages-changed', {
                reason: 'replace-messages',
                count: current.length,
                activeChatId: this.activeChat()?.id || null,
            });
            return current;
        },
        addMessage(message) {
            const added = this.api()?.addActiveChatMessage ? this.api().addActiveChatMessage(message) : (() => {
                S.session.messages.push(message);
                persistSession();
                return message;
            })();
            emitSessionEvent('session:messages-changed', {
                reason: 'add-message',
                message: getSessionMessageDescriptor(added),
                count: this.getMessages().length,
                activeChatId: this.activeChat()?.id || null,
            });
            return added;
        },
        updateMessage(id, patch) {
            const m = this.api()?.updateActiveChatMessage ? this.api().updateActiveChatMessage(id, patch) : (() => {
                const local = S.session.messages.find(x => x.id === id);
                if (!local) return null;
                Object.assign(local, patch || {});
                if ('raw' in (patch || {}) && !('clean' in (patch || {}))) local.clean = stripVpCommands(local.raw);
                persistSession();
                return local;
            })();
            if (m) emitSessionEvent('session:messages-changed', {
                reason: 'update-message',
                message: getSessionMessageDescriptor(m),
                count: this.getMessages().length,
                activeChatId: this.activeChat()?.id || null,
            });
            return m;
        },
        deleteMessage(id) {
            const ok = this.api()?.deleteActiveChatMessage ? this.api().deleteActiveChatMessage(id) : (() => {
                const before = S.session.messages.length;
                S.session.messages = S.session.messages.filter(m => m.id !== id);
                if (S.session.messages.length !== before) persistSession();
                return S.session.messages.length !== before;
            })();
            if (ok) emitSessionEvent('session:messages-changed', {
                reason: 'delete-message',
                messageId: id,
                count: this.getMessages().length,
                activeChatId: this.activeChat()?.id || null,
            });
            return ok;
        },
        getSpeakerId() {
            return this.activeSpeaker()?.id || null;
        },
        getParticipantDisplayName(participant) {
            return this.api()?.getParticipantDisplayName?.(participant) || participant?.alias || null;
        },
        getParticipantProfile(participant) {
            return participant ? this.api()?.getParticipantProfile?.(participant) || null : null;
        },
        getProfileById(profileId) {
            return profileId ? this.api()?.getProfileById?.(profileId) || null : null;
        },
    };

    function getActiveMessages() {
        return SessionMessageAdapter.getMessages();
    }

    function getActiveDraft() {
        return SessionMessageAdapter.getDraft();
    }

    function setActiveDraft(value) {
        return SessionMessageAdapter.setDraft(value);
    }

    function replaceActiveMessages(messages) {
        const next = SessionMessageAdapter.replaceMessages(messages);
        // Studio 2.0: Synchronize projector history immediately
        requestPlaybackSync(next);
        
        // Use true for immediate (synchronous) render during history replacement
        renderRegisteredPanelsNow(); 
    }

    function getActiveSpeakerId() {
        return SessionMessageAdapter.getSpeakerId();
    }

    function getMessageSpeakerLabel(message) {
        if (!message) return 'Assistant';
        if (message.role === 'user') {
            const userName = window.VisualProjector?.state?.config?.userName;
            return String(userName || '').trim() || 'User';
        }
        if (message.role !== 'assistant' || !message.speakerId) {
            return message.role || 'assistant';
        }
        const chat = SessionMessageAdapter.activeChat();
        const participant = chat?.participants?.find(p => p.id === message.speakerId);
        const profile = participant?.profileId ? SessionMessageAdapter.getProfileById(participant.profileId) : null;
        return participant?.alias || profile?.name || message.role || 'assistant';
    }

    function safeAvatarColor(value, fallback = '#6c5fa6') {
        const c = String(value || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
    }

    function getMessageAvatarInfo(message) {
        if (!message) return null;
        if (message.role === 'assistant') {
            const chat = SessionMessageAdapter.activeChat();
            const participant = message.speakerId
                ? chat?.participants?.find(p => p.id === message.speakerId)
                : SessionMessageAdapter.activeSpeaker();
            const profile = SessionMessageAdapter.getParticipantProfile(participant);
            const label = participant ? (SessionMessageAdapter.getParticipantDisplayName(participant) || profile?.name || 'Assistant') : 'Assistant';
            return {
                role: 'assistant',
                label,
                color: safeAvatarColor(profile?.color, '#6c5fa6'),
                avatar: profile?.avatar || null,
                initial: String(label || 'A').slice(0, 1).toUpperCase(),
            };
        }
        if (message.role === 'user') {
            const label = String(S.config?.userName || '').trim() || 'User';
            return {
                role: 'user',
                label,
                color: '#6c5fa6',
                avatar: null,
                initial: String(label || 'U').slice(0, 1).toUpperCase(),
            };
        }
        if (message.role === 'system') {
            return { role: 'system', label: 'System', color: '#89b4fa', avatar: null, initial: '🎭' };
        }
        return null;
    }

    function renderMessageAvatar(message, variant = 'head') {
        const info = getMessageAvatarInfo(message);
        if (!info) return '';
        const title = escapeHtml(info.label || info.role || 'Speaker');
        const color = safeAvatarColor(info.color, '#6c5fa6');
        const cls = `vp-session-msg-avatar role-${info.role}${variant === 'float' ? ' vp-msg-avatar-float' : ''}`;
        if (info.avatar) {
            return `<span class="${cls}" style="--vp-msg-avatar-color:${color}" title="${title}"><img src="${escapeHtml(info.avatar)}" alt="${title}"></span>`;
        }
        return `<span class="${cls}" style="--vp-msg-avatar-color:${color}" title="${title}">${escapeHtml(info.initial || '?')}</span>`;
    }

    function addMessage(role, raw, extra = {}) {
        const m = {
            id: uid(),
            role,
            speakerId: role === 'assistant' ? (extra.speakerId || getActiveSpeakerId()) : null,
            raw: String(raw || ''),
            clean: stripVpCommands(raw),
            createdAt: Date.now(),
            frameTagAtStart: extra.frameTagAtStart || S.current?.tag || null,
            ...extra,
        };
        SessionMessageAdapter.addMessage(m);
        
        // Studio 2.0: Keep projector in sync with session log
        requestPlaybackSync(getActiveMessages());
        
        // Studio 2.5.3: Sync render for new messages to avoid streaming delay
        renderRegisteredPanelsNow();
        return m;
    }

    function updateMessage(id, patch) {
        const m = SessionMessageAdapter.updateMessage(id, patch);
        if (!m) return null;

        // Studio 2.0: Update projector history
        requestPlaybackSync(getActiveMessages());

        renderRegisteredPanels();
        return m;
    }

    function deleteMessage(id) {
        SessionMessageAdapter.deleteMessage(id);
        // Studio 2.0: Sync after delete
        requestPlaybackSync(getActiveMessages());
        renderRegisteredPanels();
    }

    function isNearBottom(el, threshold = 48) {
        if (!el) return true;
        return (el.scrollHeight - el.scrollTop - el.clientHeight) <= threshold;
    }

    function updateVisibleMessage(id) {
        const m = getActiveMessages().find(x => x.id === id);
        if (!m) return false;
        let updated = false;
        document.querySelectorAll(`.vp-session-msg[data-msg-id="${id}"]`).forEach(item => {
            const list = item.closest('.vp-session-log-list');
            const stick = S.session.view.autoScroll !== false && isNearBottom(list);
            item.className = `vp-session-msg role-${m.role || 'assistant'} status-${m.status || 'done'}${isSceneEventMessage(m) ? ' scene-event' : ''}`;
            const status = item.querySelector('.vp-session-msg-head .status');
            if (status) {
                if (m.status && m.status !== 'done') { status.textContent = m.status; status.style.display = ''; }
                else status.style.display = 'none';
            }
            const body = item.querySelector('.vp-session-msg-body');
            if (body && !body.classList.contains('is-editing')) {
                setMessageBodyContent(body, m);
            }
            if (stick && list) list.scrollTop = list.scrollHeight;
            updated = true;
        });
        return updated;
    }

    /** 
     * Studio 2.5.3: Selective Panel Rendering 
     * @param {string[]} onlyPanelIds - Optional list of panel IDs to refresh. 
     * If omitted, refreshes all session panels.
     */
    function renderRegisteredPanelsNow(onlyPanelIds = null) {
        const root = document.getElementById('vp-shell-root');
        let updated = 0;
        if (root && root.style.display !== 'none') {
            root.querySelectorAll('.vp-shell-area').forEach(area => {
                const panelId = area.querySelector('.vp-shell-panel-select')?.value;
                const host = area.querySelector('.vp-shell-panel-host');
                if (!host) return;
                
                // If filter is provided, skip panels not in the list
                if (onlyPanelIds && !onlyPanelIds.includes(panelId)) return;

                const ctx = VP.shell?.getPanelContext?.(area.dataset.areaId, panelId) || {};
                if (panelId === 'input') { renderInputPanel(host, ctx); updated++; }
                else if (panelId === 'log') { renderLogPanel(host, ctx); updated++; }
                else if (panelId === 'model') { renderModelPanel(host, ctx); updated++; }
                else if (panelId === 'bus') { renderBusPanel(host, ctx); updated++; }
            });
        }
        if (!updated && (!onlyPanelIds)) {
            requestShellRender('session-render-panels');
        }
    }

    function renderRegisteredPanels(onlyPanelIds = null) {
        if (onlyPanelIds === null) {
            _renderAllPanels = true;
        } else {
            onlyPanelIds.forEach(id => _panelsToRender.add(id));
        }

        if (_panelsRenderQueued) return;
        _panelsRenderQueued = true;
        
        requestAnimationFrame(() => {
            const ids = _renderAllPanels ? null : Array.from(_panelsToRender);
            
            _panelsRenderQueued = false;
            _renderAllPanels = false;
            _panelsToRender.clear();
            
            renderRegisteredPanelsNow(ids);
        });
    }

    function renderPersonaTemplate(text, profile = null, participant = null) {
        const charName = (participant?.alias || profile?.name || 'Assistant').trim() || 'Assistant';
        const userName = String(S.config?.userName || 'User').trim() || 'User';
        return String(text || '')
            .replace(/\{\{\s*char\s*\}\}/gi, charName)
            .replace(/\{\{\s*user\s*\}\}/gi, userName);
    }

    function getEffectiveModelConfig() {
        const speaker = chatApi()?.getActiveSpeaker?.() || null;
        const profile = speaker ? chatApi()?.getParticipantProfile?.(speaker) : null;
        const cfg = { ...(S.modelConfig || {}) };
        const apply = (src = {}) => {
            if (src.model) cfg.model = src.model;
            if (src.temperature !== null && src.temperature !== undefined && src.temperature !== '') cfg.temperature = Number(src.temperature);
            if (src.maxTokens !== null && src.maxTokens !== undefined && src.maxTokens !== '') cfg.maxTokens = parseInt(src.maxTokens, 10);
        };
        apply(profile?.modelDefaults || {});
        apply(speaker?.modelOverrides || {});
        return cfg;
    }

    function buildProfileSystemMessage() {
        const speaker = chatApi()?.getActiveSpeaker?.() || null;
        const profile = speaker ? chatApi()?.getParticipantProfile?.(speaker) : null;
        const displayName = speaker ? (chatApi()?.getParticipantDisplayName?.(speaker) || speaker.alias || profile?.name || 'Assistant') : null;
        const userName = String(S.config?.userName || 'User').trim() || 'User';
        const userPersona = String(S.config?.userPersona || '').trim();

        const profilePrompt = renderPersonaTemplate(profile?.systemPrompt || '', profile, speaker).trim();
        const promptPatch = renderPersonaTemplate(speaker?.promptPatch || '', profile, speaker).trim();
        const description = renderPersonaTemplate(profile?.description || '', profile, speaker).trim();

        const hasProfileContext = !!(profilePrompt || promptPatch || description || (speaker && profile && displayName));
        const hasUserContext = !!(S.config?.userName || userPersona);
        if (!hasProfileContext && !hasUserContext) return null;

        const lines = [];
        lines.push('[ACTIVE ROLEPLAY PROFILE]');
        if (displayName) lines.push(`Assistant speaker: ${displayName}`);
        if (profile?.name && profile.name !== displayName) lines.push(`Base profile: ${profile.name}`);
        if (profile?.meta?.kind) lines.push(`Profile kind: ${profile.meta.kind}`);
        if (description) lines.push(`Description: ${description}`);
        if (profilePrompt) lines.push(`System prompt:\n${profilePrompt}`);
        if (promptPatch) lines.push(`Participant/chat-specific instructions:\n${promptPatch}`);
        lines.push(`User name: ${userName}`);
        if (userPersona) lines.push(`User persona:\n${renderPersonaTemplate(userPersona, profile, speaker)}`);
        lines.push('Template variables available in profile prompts: {{char}} = active assistant speaker, {{user}} = user name.');
        lines.push('[/ACTIVE ROLEPLAY PROFILE]');
        return lines.join('\n');
    }

    function buildRequestMessages() {
        const rows = getActiveMessages()
            .filter(m => (m.role === "user" || m.role === "assistant" || m.role === "system" || m.role === "tool") && msgText(m).trim());

        const sceneRanks = new Map();
        let sceneCount = 0;
        rows.forEach((m, i) => {
            if (m.role === "system" && parseSceneEvent(msgText(m))) sceneRanks.set(i, sceneCount++);
        });
        const keepFull = Math.max(0, Math.min(20, Number(S.session.view.sceneEventContextDepth ?? 4) || 0));
        const fullFromRank = Math.max(0, sceneCount - keepFull);

        // Tool context depth logic
        const toolDepth = 3; // Keep last 3 messages with full tool data

        const messages = [];
        rows.forEach((m, i) => {
            let content = msgText(m);
            const fromEnd = rows.length - 1 - i;
            
            const rank = sceneRanks.get(i);
            if (rank !== undefined && rank < fullFromRank) {
                content = compactSceneEventForContext(parseSceneEvent(content));
            }
            
            (Array.isArray(m.manifests) ? m.manifests : []).forEach(mnf => {
                const text = String(mnf?.text || "").trim();
                if (!text) return;
                if (mnf.ttl != null && fromEnd >= mnf.ttl) return;
                messages.push({ role: "system", content: `[CONTEXT MANIFEST source=${mnf.source || "user"}]\n${text}\n[/CONTEXT MANIFEST]` });
            });
            
            const msgObj = { role: m.role, content };
            
            // STUDIO 2.0: Context Sieve Logic
            const hasTools = (m.tool_calls || m.role === 'tool');
            const shouldBeFull = fromEnd < toolDepth;

            if (hasTools) {
                if (shouldBeFull) {
                    if (m.tool_calls) msgObj.tool_calls = m.tool_calls;
                    if (m.tool_call_id) msgObj.tool_call_id = m.tool_call_id;
                    if (m.name) msgObj.name = m.name;
                } else {
                    // Sieve: Replace heavy JSON with short summary in text content
                    let toolSummary = '';
                    if (m.tool_calls) {
                        toolSummary = m.tool_calls.map((tc, idx) => {
                            const res = m.tool_results?.[idx];
                            return VP.tools?.summarize(tc.function?.name, res);
                        }).join('\n');
                    } else if (m.role === 'tool') {
                        // Tool results are already handled by the assistant's previous call summary
                        // but we need to keep the message to avoid breaking the sequence.
                        msgObj.content = `[Tool result processed]`;
                        return; // skip adding raw tool responses for old turns
                    }
                    
                    if (toolSummary) {
                        msgObj.content = `[TECHNICAL LOG]\n${toolSummary}\n[/TECHNICAL LOG]\n${content}`;
                    }
                }
            }
            
            messages.push(msgObj);
        });

        const profileSystem = buildProfileSystemMessage();
        if (profileSystem) messages.unshift({ role: "system", content: profileSystem });

        return messages;
    }

    // ════════════════════════════════════════════════════════════════
    //  CONTEXT MANIFESTS — SATELLITE BRIDGE → js/session-manifests.js
    //
    //  attachManifest / queueManifest / getManifests / removeManifest /
    //  showManifestsModal extracted byte-verbatim (v12). The pending
    //  queue itself stays on shared S.session.pendingManifests; the two
    //  direct splice sites the host had (send() drain + input pill
    //  removal) now go through the satellite's seam functions
    //  (drainPendingManifests / removePendingManifestAt), destructured
    //  below under the same footprint.
    // ════════════════════════════════════════════════════════════════
    if (!window.VP_SESSION_MANIFESTS?.init) {
        throw new Error(
            '[VP Session] js/session-manifests.js is missing or loaded out of order.\n' +
            'Script order must be: js/session-manifests.js BEFORE js/projector-session.js (see index.html).'
        );
    }
    const {
        attachManifest, queueManifest, getManifests, removeManifest,
        showManifestsModal,
        drainPendingManifests, removePendingManifestAt,
        buildSceneTransitionObservation,
    } = window.VP_SESSION_MANIFESTS.init({
        getActiveMessages, updateMessage, emitSessionEvent,
        persistSession, ensureState, uid, escapeHtml, renderRegisteredPanels,
    });

    function buildHeaders() {
        const headers = { 'Content-Type': 'application/json' };
        const key = (S.modelConfig.apiKey || '').trim();
        if (key) headers.Authorization = key.toLowerCase().startsWith('bearer ') ? key : `Bearer ${key}`;
        return headers;
    }

    async function send(text = null, opts = {}) {
        ensureState();
        if (S.session.running) return false;

        const input = text != null ? String(text) : String(getActiveDraft() || '');
        const userText = input.trim();
        if (!userText) return false;

        const endpoint = (S.modelConfig.endpoint || '').trim();
        if (!endpoint) {
            VP.showToast?.('Model endpoint is empty', 'error');
            return false;
        }
        if (!endpoint.includes('/chat/completions')) {
            VP.showToast?.('Endpoint should be /v1/chat/completions compatible', 'error');
            return false;
        }

        if (S.session.input?.clearAfterSend !== false) setActiveDraft('');
        if (!opts.skipUserAppend) {
            // Drain queued manifests (game/FSM/director) into this user message,
            // plus any manifests passed directly via send() opts.
            const queued = drainPendingManifests(); // v12 seam — pending queue owned by session-manifests.js
            const direct = (Array.isArray(opts.manifests) ? opts.manifests : [])
                .map(x => normalizeManifestInput(x?.text ?? x, x)).filter(Boolean);
            const manifests = [...queued, ...direct];
            addMessage('user', userText, manifests.length ? { manifests } : {});
            if (manifests.length) persistSession();

            // Studio 2.0: Direct playback control
            requestPlaybackOpen('user', { text: userText });
            requestPlaybackCommit(userText, { role: 'user' });
        }
        if (!opts.skipUserAppend) {
            processActivityCommandsViaBus(userText, { role: 'user', source: 'session' }, 'user activity command');
        }

        // Studio 2.0: Open assistant turn
        requestPlaybackOpen('assistant');

        // Studio 2.7: Store the prompt for proper regeneration 
        // especially important for hidden prompts from games/activities
        const assistant = addMessage('assistant', '', { 
            status: 'streaming',
            internalPrompt: opts.skipUserAppend ? userText : null
        });
        S.session.running = true;
        const ac = new AbortController();
        S.session.abortController = ac;
        emitSessionEvent('session:send-started', {
            assistantMessageId: assistant.id,
            skippedUserAppend: !!opts.skipUserAppend,
            textLength: userText.length,
            toolsMode: S.modelConfig.toolsMode || 'off',
            activeChatId: chatApi()?.getActiveChat?.()?.id || null,
        });
        renderRegisteredPanels();

        const effectiveModel = getEffectiveModelConfig();
        const body = {
            model: effectiveModel.model || 'local-model',
            messages: buildRequestMessages(),
            temperature: Number.isFinite(+effectiveModel.temperature) ? +effectiveModel.temperature : 0.7,
            max_tokens: Number.isFinite(+effectiveModel.maxTokens) ? +effectiveModel.maxTokens : 2048,
            stream: true,
        };
        // Hidden prompts are used by game/activity systems: they should affect
        // this request without being appended as a visible user message.
        if (opts.skipUserAppend && userText) {
            const hiddenPrompt = { role: 'user', content: userText };
            try {
                Object.defineProperty(hiddenPrompt, '__vpPlayback', { value: { internal: true }, enumerable: false, configurable: true });
                Object.defineProperty(body, '__vpSuppressLiveUserCue', { value: true, enumerable: false, configurable: true });
            } catch {}
            body.messages.push(hiddenPrompt);
            // console.log('[VP Session] hidden user prompt appended to request:', userText.slice(0, 160));
        }

        // Ensure the just-created empty assistant placeholder is not sent.
        body.messages = body.messages.filter(m => !(m.role === 'assistant' && !String(m.content || '').trim()));

        // Studio 2.0: Context injection happens ONCE before the tool loop starts.
        // The primary route is the Hub Context owner with a ticket transport,
        // because prepared bodies may contain base64 vision payloads that must not cross Hub.
        const preparedBody = await prepareRequestBodyViaContext(body);

        try {
            const headers = buildHeaders();
            let toolsEnabled = S.modelConfig.toolsMode === 'native' && !!(window.VP_HUB?.request || VP.tools);
            const loopLimit = Math.max(1, Math.min(10, parseInt(S.modelConfig.toolLoopLimit, 10) || 4));

            if (toolsEnabled) {
                const toolDefs = await buildOpenAIToolsForSession();
                if (toolDefs.length) {
                    preparedBody.tools = toolDefs;
                    console.log(`[VP Tools] 🛠 Context ready. ${toolDefs.length} tool(s) attached.`);
                } else {
                    toolsEnabled = false;
                }
            }

            let loops = 0;
            let sceneLoopUsed = false;   // v24 anti-loop: at most ONE dir continuation per turn
            let transcriptParts = [];
            let finalContent = "";
            let toolCallDetected = false;

            while (true) {
                // Studio 2.0: Always use streaming for maximum responsiveness
                preparedBody.stream = true;

                const response = await VP.utils.fetchWithImageFallback(endpoint, headers, preparedBody, ac.signal);

                if (!response.ok) {
                    const errText = await response.text().catch(() => '');
                    throw new Error(`HTTP ${response.status}: ${errText.slice(0, 500)}`);
                }

                const contentType = response.headers.get('content-type') || '';
                const isStreaming = contentType.includes('text/event-stream')
                    || (!!preparedBody.stream && !contentType.includes('application/json'));

                if (isStreaming) {
                    // readStreamingResponse now returns tool_calls if detected in stream
                    const result = await readStreamingResponse(response, assistant.id);
                    
                    if (result && result.tool_calls && result.tool_calls.length && toolsEnabled) {
                        toolCallDetected = true;
                        loops++;
                        if (result.fullText) transcriptParts.push(result.fullText);
                        
                        const callNames = result.tool_calls.map(tc => tc.function?.name).join(', ');
                        updateMessage(assistant.id, { status: `thinking (${loops}): ${callNames}...` });
                        
                        console.log(`[VP Tools] 🤖 Detected tool calls in stream (loop ${loops}): ${callNames}`);

                        // Execute tools and update history
                        preparedBody.messages.push({
                            role: "assistant",
                            content: result.fullText || null,
                            tool_calls: result.tool_calls
                        });

                        const toolResults = [];
                        for (const tc of result.tool_calls) {
                            const args = safeParseJson(tc.function?.arguments);
                            const toolResult = await executeToolForSession(tc.function?.name, args, { role: 'assistant', source: 'tool-stream-loop' });
                            const rawResultData = toolResult.ok ? toolResult.data : toolResult;
                            const resultData = sanitizeToolResultData(rawResultData); // v25: no base64 in model JSON / persisted results
                            toolResults.push(resultData);

                            // Studio 2.0: Feed summary to subtitles for immersive feedback
                            const summary = summarizeToolForSession(tc.function?.name, toolResult);
                            requestPlaybackPush(summary);

                            preparedBody.messages.push({
                                role: "tool",
                                tool_call_id: tc.id,
                                name: tc.function?.name,
                                content: JSON.stringify(resultData)
                            });

                            // v25: tool vision attachments (fresh scene_navigate collage, …)
                            const visionMsg = buildToolVisionMessage(rawResultData);
                            if (visionMsg) preparedBody.messages.push(visionMsg);
                        }
                        
                        // Studio 2.0: Update message in UI with tool data for spoilers
                        const currentMsg = getActiveMessages().find(m => m.id === assistant.id);
                        if (currentMsg) {
                            const oldCalls = currentMsg.tool_calls || [];
                            const oldResults = currentMsg.tool_results || [];
                            updateMessage(assistant.id, { 
                                tool_calls: [...oldCalls, ...result.tool_calls],
                                tool_results: [...oldResults, ...toolResults]
                            });
                        }

                        if (loops >= loopLimit) {
                            preparedBody.messages.push({ role: 'system', content: 'Loop limit reached. Finalize now.' });
                        }
                        continue; // Next round in loop
                    }
                    // v24 agentic micro-loop (design: docs/agentic-loop-design.md, option B).
                    // After dir transitions (TAB/CAT open/close) the world changes —
                    // give the model ONE continuation with a deterministic observation.
                    // Depth 1 by construction: sceneLoopUsed seals this turn; the
                    // continuation's own dir commands still execute but never re-trigger.
                    if (S.modelConfig.agenticLoop && !sceneLoopUsed && result && result.fullText) {
                        const dirNotes = detectDirTransitions(result.fullText);
                        if (dirNotes.length) {
                            sceneLoopUsed = true;
                            loops++;
                            console.log('[VP Session] 🔁 Agentic micro-loop: executing', dirNotes.length, 'dir transition(s), one continuation follows');
                            for (const n of dirNotes) {
                                await VP.commands?.execute?.(n.raw, { source: 'agentic-loop', showToast: true });
                            }
                            preparedBody.messages.push({ role: 'assistant', content: result.fullText });
                            preparedBody.messages.push({ role: 'system', content: buildSceneTransitionObservation(dirNotes) });
                            updateMessage(assistant.id, { status: '👁 осматривается… (agent loop)' });
                            requestPlaybackPush('\n\n');
                            continue;
                        }
                    }
                    // If no tools were found in stream, readStreamingResponse already finalized the message
                    break; 
                }

                // Fallback for non-streaming response (unlikely with our new config)
                const data = await response.json();
                const choice = data.choices?.[0];
                if (!choice) throw new Error('Model returned no choices');

                // Tool call handling (Standard OpenAI API format - NON-STREAMING FALLBACK)
                if (toolsEnabled && choice.finish_reason === 'tool_calls' && choice.message?.tool_calls?.length) {
                    toolCallDetected = true;
                    loops++;
                    
                    const callDetails = choice.message.tool_calls.map(tc => {
                        const def = VP.tools?.get(tc.function?.name);
                        return (def?.icon || '🔧') + ' ' + (tc.function?.name || 'tool');
                    }).join(', ');

                    // Show immersive status with icons in chat and subtitles
                    updateMessage(assistant.id, { status: `thinking (${loops}): ${callDetails}...` });
                    requestPlaybackPush(`... [Thinking: ${callDetails}] ...`);

                    preparedBody.messages.push(choice.message);

                    if (choice.message.content) {
                        transcriptParts.push(choice.message.content);
                        requestPlaybackPush(choice.message.content);
                    }

                    const currentResults = [];
                    for (const tc of choice.message.tool_calls) {
                        const args = safeParseJson(tc.function?.arguments);
                        const result = await executeToolForSession(tc.function?.name, args, { role: "assistant", source: "tool-loop-fallback" });
                        const rawResultData = result.ok ? result.data : result;
                        const resultData = sanitizeToolResultData(rawResultData); // v25: no base64 in model JSON / persisted results
                        currentResults.push(resultData);

                        preparedBody.messages.push({
                            role: "tool",
                            tool_call_id: tc.id,
                            name: tc.function?.name,
                            content: JSON.stringify(resultData)
                        });

                        // v25: tool vision attachments (fresh scene_navigate collage, …)
                        const visionMsg = buildToolVisionMessage(rawResultData);
                        if (visionMsg) preparedBody.messages.push(visionMsg);
                    }
                    
                    // Update UI with tool data for spoilers
                    const currentMsg = getActiveMessages().find(m => m.id === assistant.id);
                    if (currentMsg) {
                        const oldCalls = currentMsg.tool_calls || [];
                        const oldResults = currentMsg.tool_results || [];
                        updateMessage(assistant.id, { 
                            tool_calls: [...oldCalls, ...choice.message.tool_calls],
                            tool_results: [...oldResults, ...currentResults]
                        });
                    }

                    if (loops >= loopLimit) {
                        preparedBody.messages.push({ role: 'system', content: 'Tool loop limit reached. Respond now.' });
                    }
                    continue; 
                }

                finalContent = choice.message?.content || "";
                if (!finalContent && toolCallDetected && choice.finish_reason === "stop") {
                     // Final text empty but loop done
                }
                if (transcriptParts.length && finalContent) {
                    finalContent = transcriptParts.join("\n\n") + "\n\n" + finalContent;
                } else if (transcriptParts.length && !finalContent) {
                    finalContent = transcriptParts.join("\n\n");
                }

                updateMessage(assistant.id, {
                    raw: finalContent,
                    clean: stripVpCommands(finalContent),
                    status: "done",
                });

                processActivityCommandsViaBus(finalContent, { role: "assistant", source: "session" });
                requestPlaybackCommit(finalContent);
                break;
            }
            emitSessionEvent('session:send-completed', {
                assistantMessageId: assistant.id,
                textLength: String(finalContent || '').length,
                toolCallDetected: !!toolCallDetected,
                loops,
                activeChatId: chatApi()?.getActiveChat?.()?.id || null,
            });
            return true;
        } catch (err) {
            const partial = msgText(getActiveMessages().find(m => m.id === assistant.id)) || '';
            
            // Studio 2.0: Abort playback
            requestPlaybackAbort();

            if (err.name === 'AbortError') {
                updateMessage(assistant.id, { status: 'aborted', clean: stripVpCommands(partial) });
                emitSessionEvent('session:send-stopped', {
                    assistantMessageId: assistant.id,
                    partialLength: String(partial || '').length,
                    activeChatId: chatApi()?.getActiveChat?.()?.id || null,
                });
                VP.showToast?.('Generation stopped', 'info');
            } else {
                console.error('[VP Session] send failed:', err);
                updateMessage(assistant.id, { raw: `⚠ ${err.message}`, clean: `⚠ ${err.message}`, status: 'error' });
                emitSessionEvent('session:send-failed', {
                    assistantMessageId: assistant.id,
                    error: err?.message || String(err),
                    partialLength: String(partial || '').length,
                    activeChatId: chatApi()?.getActiveChat?.()?.id || null,
                });
                VP.showToast?.(`Model error: ${err.message.slice(0, 120)}`, 'error');
            }
            return false;
        } finally {
            S.session.running = false;
            S.session.abortController = null;
            persistSession();
            renderRegisteredPanels();
        }
    }

    async function readStreamingResponse(response, assistantId) {
        const reader = response.body.getReader();
        const decoder = new TextDecoder();
        let buffer = "";
        // v25 stream accumulation fix: continuation iterations (native tool loop,
        // v24 dir micro-loop) used to restart `full` from zero and OVERWRITE the
        // first generation's speech in the bubble (owner report: "сообщение
        // удаляется и модель отвечает заново"). Seed from the current raw; keep
        // `own` for iteration-local side effects (playback commit, activity bus,
        // preparedBody assistant echo) so earlier iterations are never doubled.
        const seededRaw = String(getActiveMessages().find(x => x.id === assistantId)?.raw || '');
        let full = seededRaw;
        let own = "";
        let lastRender = 0;

        const toolCallAccumulator = [];
        let finishReason = null;

        const applyDelta = (delta) => {
            if (!delta) return;
            if (!own && seededRaw && !/\n\s*$/.test(seededRaw)) full += "\n\n"; // seam between loop generations
            full += delta;
            own += delta;
            requestPlaybackPush(delta);

            const m = getActiveMessages().find(x => x.id === assistantId);
            if (m) {
                m.raw = full;
                m.clean = stripVpCommands(full);
                m.status = "streaming";
            }
            const now = Date.now();
            if (now - lastRender > 80) {
                lastRender = now;
                updateVisibleMessage(assistantId);
            }
        };

        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            buffer += decoder.decode(value, { stream: true });
            const lines = buffer.split("\n");
            buffer = lines.pop() || "";

            for (const lineRaw of lines) {
                const line = lineRaw.trim();
                if (!line || !line.startsWith("data:")) continue;
                const data = line.slice(5).trim();
                if (!data || data === "[DONE]") continue;
                try {
                    const json = JSON.parse(data);
                    const choice = json.choices?.[0];
                    if (choice?.finish_reason) finishReason = choice.finish_reason;

                    if (choice?.delta?.tool_calls) {
                        for (const tc of choice.delta.tool_calls) {
                            const idx = tc.index || 0;
                            if (!toolCallAccumulator[idx]) {
                                toolCallAccumulator[idx] = { id: "", type: "function", function: { name: "", arguments: "" } };
                            }
                            if (tc.id) toolCallAccumulator[idx].id = tc.id;
                            if (tc.function?.name) toolCallAccumulator[idx].function.name += tc.function.name;
                            if (tc.function?.arguments) toolCallAccumulator[idx].function.arguments += tc.function.arguments;
                        }
                    } else {
                        const delta = choice?.delta?.content ?? choice?.message?.content ?? "";
                        applyDelta(delta);
                    }
                } catch {
                    applyDelta(data);
                }
            }
        }

        if (finishReason === "tool_calls" || toolCallAccumulator.length > 0) {
            return { tool_calls: toolCallAccumulator, fullText: own };
        }

        updateMessage(assistantId, { raw: full, clean: stripVpCommands(full), status: "done" });
        processActivityCommandsViaBus(own, { role: "assistant", source: "session" });
        requestPlaybackCommit(own);
        
        // Final UI update to ensure full text is visible (Studio 2.0)
        updateVisibleMessage(assistantId);
        
        return { fullText: full };
    }
    function stop() {
        if (S.session?.abortController) {
            emitSessionEvent('session:stop-requested', { activeChatId: chatApi()?.getActiveChat?.()?.id || null });
            S.session.abortController.abort();
        }
    }

    async function clearSession() {
        const ans = await VP.showConfirm?.({
            title: 'Clear session log?',
            message: 'Очистить session log? Это удалит сообщения текущего чата/сессии.',
            buttons: [
                { id: 'cancel', label: 'Cancel', ghost: true },
                { id: 'ok', label: 'Clear', danger: true },
            ],
        });
        if (ans !== 'ok') return;
        replaceActiveMessages([]);
        renderRegisteredPanels();
    }

    function regenerateLast() {
        if (S.session.running) return;
        const msgs = getActiveMessages();
        let lastAssistantIdx = -1;
        for (let i = msgs.length - 1; i >= 0; i--) {
            if (msgs[i].role === 'assistant') { lastAssistantIdx = i; break; }
        }
        if (lastAssistantIdx === -1) { VP.showToast?.('No assistant message to regenerate', 'error'); return; }

        const lastAssistant = msgs[lastAssistantIdx];

        // Studio 2.7: If this message was generated from an internal (hidden) prompt,
        // use it for regeneration instead of looking for the last visible user message.
        if (lastAssistant.internalPrompt) {
            const prompt = lastAssistant.internalPrompt;
            replaceActiveMessages(msgs.slice(0, lastAssistantIdx));
            send(prompt, { skipUserAppend: true });
            return;
        }

        let userIdx = -1;
        for (let i = lastAssistantIdx - 1; i >= 0; i--) {
            if (msgs[i].role === 'user') { userIdx = i; break; }
        }

        if (userIdx !== -1) {
            const userText = msgText(msgs[userIdx]);
            replaceActiveMessages(msgs.slice(0, lastAssistantIdx));
            send(userText, { skipUserAppend: true });
        } else {
            replaceActiveMessages(msgs.slice(0, lastAssistantIdx));
            const hasChatMessages = msgs.slice(0, lastAssistantIdx).some(m => m.role === 'assistant' || m.role === 'user');
            const prompt = hasChatMessages
                ? 'Continue the scene naturally.'
                : 'Begin the scene naturally.';
            send(prompt, { skipUserAppend: true });
        }
    }

    // ════════════════════════════════════════════════════════════════
    //  UI RENDERERS — SATELLITE BRIDGE → js/session-panels.js
    //
    //  injectStyles / clearContainer / the five render* panels /
    //  settings renderers / context inspector (+ token estimators) now
    //  live in js/session-panels.js (v13 — byte-verbatim bodies; the
    //  inline-edit cleanup state moved with them). init(deps) passes
    //  the 26 shared helpers + DEFAULT_SESSION; every call-site below
    //  keeps its original name via this destructure.
    // ════════════════════════════════════════════════════════════════
    if (!window.VP_SESSION_PANELS?.init) {
        throw new Error(
            '[VP Session] js/session-panels.js is missing or loaded out of order.\n' +
            'Script order must be: js/session-panels.js BEFORE js/projector-session.js (see index.html).'
        );
    }
    const {
        injectStyles, clearContainer,
        renderInputPanel, renderInputSettings,
        renderLogPanel, renderLogSettings, renderModelPanel,
        showContextInspector, makeInspectorSection,
        estimateTextTokens, sumMessageTokens,
    } = window.VP_SESSION_PANELS.init({
        buildProfileSystemMessage, buildRequestMessages, chatApi, deleteMessage,
        ensureState, escapeHtml, getActiveDraft, getActiveMessages, getMessageSpeakerLabel,
        isNearBottom, isSceneEventMessage, msgText, parseSceneEvent, persistModel, persistSession,
        removePendingManifestAt, renderMessageAvatar, renderRegisteredPanels, sceneEventIcon,
        send, setActiveDraft, setMessageBodyContent, showManifestsModal, stop, stripVpCommands,
        updateMessage, regenerateLast, clearSession,
        DEFAULT_SESSION,
    });

    // ════════════════════════════════════════════════════════════════
    //  COMMAND BUS DEBUG PANEL — SATELLITE BRIDGE → js/session-bus-panel.js
    //  Body extracted byte-verbatim (v11); satellite loads BEFORE this
    //  file (see index.html). Receives the one local helper it needs;
    //  VP.commands is read by the panel itself at render time.
    // ════════════════════════════════════════════════════════════════
    if (!window.VP_SESSION_BUS_PANEL?.init) {
        throw new Error(
            '[VP Session] js/session-bus-panel.js is missing or loaded out of order.\n' +
            'Script order must be: js/session-bus-panel.js BEFORE js/projector-session.js (see index.html).'
        );
    }
    const renderBusPanel = window.VP_SESSION_BUS_PANEL.init({ clearContainer }).renderBusPanel;

    function registerPanels() {
        VP.registerPanel({
            id: 'input', title: 'Input', icon: '⌨️', order: 40, create: renderInputPanel,
            settings: {
                title: 'Input Settings', icon: '⌨️', mode: 'auto', minWidth: 250, minHeight: 150, width: 360,
                create: renderInputSettings,
            },
        });
        VP.registerPanel({ 
            id: 'log', title: 'Log', icon: '💬', order: 30, create: renderLogPanel,
            settings: {
                title: 'Log Settings', icon: '💬', mode: 'auto', minWidth: 340, minHeight: 230, width: 420,
                create: renderLogSettings,
            },
        });
        VP.registerPanel({ id: 'model', title: 'Model', icon: '🤖', order: 50, create: renderModelPanel });
        VP.registerPanel({ id: 'bus', title: 'Commands', icon: '🔧', order: 55, create: renderBusPanel });
    }

    function getSessionPublicState() {
        ensureState();
        const activeChat = chatApi()?.getActiveChat?.() || null;
        const activeSpeaker = chatApi()?.getActiveSpeaker?.() || null;
        const messages = getActiveMessages();
        const draft = getActiveDraft();
        return {
            running: !!S.session.running,
            draft,
            draftLength: String(draft || '').length,
            activeChat: activeChat ? {
                id: activeChat.id || null,
                title: activeChat.title || null,
                messageCount: Array.isArray(activeChat.messages) ? activeChat.messages.length : 0,
                participantCount: Array.isArray(activeChat.participants) ? activeChat.participants.length : 0,
                activeSpeakerId: activeChat.activeSpeakerId || null,
            } : null,
            activeSpeaker: activeSpeaker ? {
                id: activeSpeaker.id || null,
                profileId: activeSpeaker.profileId || null,
                name: chatApi()?.getParticipantDisplayName?.(activeSpeaker) || activeSpeaker.name || null,
            } : null,
            messages: Array.isArray(messages) ? messages.slice(-10).map(message => ({
                id: message.id || null,
                role: message.role || null,
                timestamp: message.timestamp || null,
                textPreview: String(msgText(message) || '').slice(0, 240),
                textLength: String(msgText(message) || '').length,
            })) : [],
            model: {
                endpoint: S.modelConfig.endpoint || '',
                model: S.modelConfig.model || '',
                temperature: Number(S.modelConfig.temperature),
                maxTokens: Number(S.modelConfig.maxTokens),
                toolsMode: S.modelConfig.toolsMode || 'off',
            },
            input: {
                clearAfterSend: S.session.input?.clearAfterSend !== false,
                enterToSend: !!S.session.input?.enterToSend,
                fontSize: Number(S.session.input?.fontSize) || 13,
            },
            pendingManifestCount: Array.isArray(S.session.pendingManifests) ? S.session.pendingManifests.length : 0,
        };
    }

    function emitSessionEvent(eventName, payload = {}) {
        try {
            window.VP_HUB?.emit?.(eventName, payload, { moduleId: 'session' });
        } catch (err) {
            console.warn(`[VP Session] hub emit ${eventName} failed:`, err);
        }
    }

    function emitSessionDraftChanged(source = 'hub') {
        emitSessionEvent('session:draft-changed', {
            draft: getActiveDraft(),
            draftLength: String(getActiveDraft() || '').length,
            source,
        });
    }

    async function setDraftFromHub(text = '', source = 'hub') {
        ensureState();
        const draft = String(text || '');
        const res = await hubRequest('chats:set-active-draft', { draft, source }, null);
        if (!res?.ok) setActiveDraft(draft);
        renderRegisteredPanels(['input']);
        emitSessionDraftChanged(source);
        return { ok: true, state: getSessionPublicState() };
    }

    function registerSessionHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'session');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'session', title: 'Session', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Session] Hub module registration failed:', err); }
        }
        if (!hasCommand('session:get-state')) {
            hub.handle('session:get-state', () => getSessionPublicState(), { moduleId: 'session' });
        }
        if (!hasCommand('session:get-draft')) {
            hub.handle('session:get-draft', () => ({ ok: true, draft: getActiveDraft() }), { moduleId: 'session' });
        }
        if (!hasCommand('session:set-draft')) {
            hub.handle('session:set-draft', (payload = {}) => setDraftFromHub(payload.text ?? payload.draft ?? '', payload.source || 'hub'), { moduleId: 'session' });
        }
        if (!hasCommand('session:clear-draft')) {
            hub.handle('session:clear-draft', (payload = {}) => setDraftFromHub('', payload.source || 'hub'), { moduleId: 'session' });
        }
        if (!hasCommand('session:get-messages')) {
            hub.handle('session:get-messages', (payload = {}) => {
                const messages = SessionMessageAdapter.getMessages();
                const limitRaw = Number(payload.limit ?? 50);
                const offsetRaw = Number(payload.offset ?? Math.max(0, messages.length - limitRaw));
                const limit = Math.max(1, Math.min(500, Number.isFinite(limitRaw) ? Math.floor(limitRaw) : 50));
                const offset = Math.max(0, Number.isFinite(offsetRaw) ? Math.floor(offsetRaw) : 0);
                return {
                    ok: true,
                    total: messages.length,
                    offset,
                    limit,
                    messages: messages.slice(offset, offset + limit).map(getSessionMessageDescriptor),
                };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:add-message')) {
            hub.handle('session:add-message', (payload = {}) => {
                const message = SessionMessageAdapter.addMessage(payload.message || payload);
                requestPlaybackSync(SessionMessageAdapter.getMessages());
                renderRegisteredPanelsNow();
                return { ok: !!message, message: getSessionMessageDescriptor(message) };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:update-message')) {
            hub.handle('session:update-message', (payload = {}) => {
                const id = String(payload.id || payload.messageId || '').trim();
                if (!id) throw new Error('session:update-message requires payload.id');
                const message = SessionMessageAdapter.updateMessage(id, payload.patch || {});
                requestPlaybackSync(SessionMessageAdapter.getMessages());
                renderRegisteredPanels();
                return { ok: !!message, message: getSessionMessageDescriptor(message) };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:delete-message')) {
            hub.handle('session:delete-message', (payload = {}) => {
                const id = String(payload.id || payload.messageId || '').trim();
                if (!id) throw new Error('session:delete-message requires payload.id');
                const ok = SessionMessageAdapter.deleteMessage(id);
                requestPlaybackSync(SessionMessageAdapter.getMessages());
                renderRegisteredPanels();
                return { ok, messageId: id };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:replace-messages')) {
            hub.handle('session:replace-messages', (payload = {}) => {
                const messages = SessionMessageAdapter.replaceMessages(Array.isArray(payload.messages) ? payload.messages : []);
                requestPlaybackSync(messages);
                renderRegisteredPanelsNow();
                return { ok: true, count: messages.length, messages: messages.map(getSessionMessageDescriptor) };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:get-active-speaker')) {
            hub.handle('session:get-active-speaker', () => {
                const speaker = SessionMessageAdapter.activeSpeaker();
                const profile = SessionMessageAdapter.getParticipantProfile(speaker);
                return {
                    ok: !!speaker,
                    speaker: speaker ? {
                        id: speaker.id || null,
                        profileId: speaker.profileId || null,
                        name: SessionMessageAdapter.getParticipantDisplayName(speaker) || profile?.name || speaker.alias || null,
                        alias: speaker.alias || null,
                        profile: profile ? {
                            id: profile.id || null,
                            name: profile.name || null,
                            color: profile.color || null,
                            description: profile.description || '',
                        } : null,
                    } : null,
                };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:attach-manifest')) {
            hub.handle('session:attach-manifest', (payload = {}) => {
                const target = payload.target || payload.messageId || 'last';
                const manifest = attachManifest(target, payload.text || payload.content || '', {
                    ttl: payload.ttl,
                    source: payload.source || 'hub',
                });
                return { ok: !!manifest, manifest, target };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:queue-manifest')) {
            hub.handle('session:queue-manifest', (payload = {}) => {
                const manifest = queueManifest(payload.text || payload.content || '', {
                    ttl: payload.ttl,
                    source: payload.source || 'hub',
                });
                return {
                    ok: !!manifest,
                    manifest,
                    pendingCount: Array.isArray(S.session.pendingManifests) ? S.session.pendingManifests.length : 0,
                };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:get-manifests')) {
            hub.handle('session:get-manifests', (payload = {}) => {
                const messageId = String(payload.messageId || payload.id || '').trim();
                if (!messageId) throw new Error('session:get-manifests requires payload.messageId');
                const manifests = getManifests(messageId);
                return { ok: true, messageId, count: manifests.length, manifests };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:remove-manifest')) {
            hub.handle('session:remove-manifest', (payload = {}) => {
                const messageId = String(payload.messageId || payload.id || '').trim();
                const manifestId = String(payload.manifestId || payload.manifest || '').trim();
                if (!messageId || !manifestId) throw new Error('session:remove-manifest requires messageId/manifestId');
                return { ok: removeManifest(messageId, manifestId), messageId, manifestId };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:send-text')) {
            hub.handle('session:send-text', async (payload = {}) => {
                const text = payload.text ?? payload.message ?? null;
                const ok = await send(text, {
                    skipUserAppend: payload.skipUserAppend === true,
                    manifests: Array.isArray(payload.manifests) ? payload.manifests : [],
                });
                return { ok: !!ok, state: getSessionPublicState() };
            }, { moduleId: 'session' });
        }
        if (!hasCommand('session:stop')) {
            hub.handle('session:stop', () => {
                stop();
                return { ok: true, state: getSessionPublicState() };
            }, { moduleId: 'session' });
        }
    }

    // v26 per-tool management (owner: option B — docs/tools-management-audit.md).
    // Registry enabled flags are runtime-only; modelConfig.disabledTools is the
    // persisted truth across F5. Static tools register before hydration, so the
    // boot re-syncs the registry once state is loaded.
    function applyDisabledToolsFromConfig() {
        const list = Array.isArray(S.modelConfig?.disabledTools) ? S.modelConfig.disabledTools : [];
        if (!VP.tools?.list) return;
        for (const t of VP.tools.list({ enabledOnly: false, includeSchema: false })) {
            const entry = VP.tools.get(t.name);
            const want = !list.includes(t.name);
            if (entry && !!entry.enabled !== want) {
                if (want) VP.tools.enable(t.name);
                else VP.tools.disable(t.name);
            }
        }
    }

    async function bootSession() {
        if (VP.ready) await VP.ready;
        if (VP.chats?.ready) await VP.chats.ready;
        await hydratePersistentState();
        ensureState();
        applyDisabledToolsFromConfig(); // v26: persisted per-tool toggles → registry
        injectStyles();
        
        // Studio 2.0: Synchronize projector with loaded history
        const messages = getActiveMessages();
        if (messages.length) requestPlaybackSync(messages);

        // --- GAZE ATTENTION AUTO-REACTION TRACKER ---
        let lastGazeTriggerTime = 0;
        let gazeTimeout = null;
        
        const hub = window.VP_HUB;
        if (hub?.on) {
            let chatResyncQueued = false;
            const queueChatResync = (reason = 'chat-event') => {
                if (chatResyncQueued) return;
                chatResyncQueued = true;
                requestAnimationFrame(() => {
                    chatResyncQueued = false;
                    const currentMessages = getActiveMessages();
                    requestPlaybackSync(currentMessages);
                    renderRegisteredPanels(['log', 'input']);
                    emitSessionEvent('session:chat-resynced', {
                        reason,
                        activeChatId: SessionMessageAdapter.activeChat()?.id || null,
                        messageCount: currentMessages.length,
                    });
                });
            };

            // Chats owns chat selection/history. Session keeps the hot streaming path
            // direct, but listens to coarse chat-owner events so panel/playback state
            // does not drift when the active chat is switched outside Session.
            hub.on('chat:active-changed', () => {
                queueChatResync('chat-active-changed');
            }, { moduleId: 'session' });
            hub.on('chat:messages-changed', (payload = {}) => {
                // Avoid per-token duplicate work during streaming updates. A full
                // set/replace is coarse enough to resync through Hub safely.
                if (payload.reason === 'set-messages') queueChatResync('chat-set-messages');
            }, { moduleId: 'session' });

            hub.on('projector:viewport-changed', (payload) => {
                if (gazeTimeout) clearTimeout(gazeTimeout);
                
                // Check if Gaze Auto-Reaction is enabled in Settings
                const isEnabled = VP.state?.config?.gazeAutoReaction !== false;
                if (!isEnabled) return;
                
                // Only track if Focus Mode is enabled and zoomed in
                const vp = payload?.viewport || VP.getProjectorViewportState?.();
                if (!vp?.enabled || vp.zoom <= 1.05 || !VP.state?.current) return;
                
                // Get customizable hold time from config (default 6 sec)
                const holdDuration = VP.state?.config?.gazeHoldDuration ?? 6;
                const holdTimeMs = Math.max(2, Math.min(30, holdDuration)) * 1000;
                
                // Set timer for complete stillness!
                gazeTimeout = setTimeout(async () => {
                    // Check all safety conditions before triggering an auto-reaction
                    const isRunning = S.session.running;
                    if (isRunning) return; // ignore if model is already thinking
                    
                    const msgs = getActiveMessages();
                    if (!msgs.length) return;
                    const lastMsg = msgs[msgs.length - 1];
                    if (lastMsg.role !== 'assistant') return; // only react if it's the user's turn (user is silent!)
                    
                    // Cooldown check (default 50 sec)
                    const cooldown = VP.state?.config?.gazeCooldown ?? 50;
                    const cooldownMs = Math.max(5, Math.min(300, cooldown)) * 1000;
                    
                    const now = Date.now();
                    if (now - lastGazeTriggerTime < cooldownMs) return;
                    
                    // Check if the user is currently typing something (to avoid interrupting their typing!)
                    const inputEl = document.querySelector('.vp-session-input');
                    if (inputEl && inputEl.value.trim().length > 0) return;
                    
                    try {
                        const focus = await VP.captureFocusViewportDataUrl?.();
                        if (!focus || !focus.dataUrl) return;
                        
                        lastGazeTriggerTime = now;
                        
                        // Formulate a beautiful, highly contextual system instruction
                        const tag = focus.sourceTag || VP.state?.current?.tag || 'current';
                        const systemPrompt = `[SYSTEM EVENT: The user has been silently and closely staring at this specific part of the scene on frame [${tag}] for several seconds. Notice where their attention is focused, and react naturally in character — either comment on what they are looking at, show embarrassment/смущение, or respond spontaneously. Do not mention "system event" or "coordinates", speak naturally in character.]`;
                        
                        // Trigger the silent turn!
                        await send(systemPrompt, {
                            skipUserAppend: true,
                            manifests: [
                                { text: `[GAZE FOCUS ATTACHMENT: ${tag}]\nUser is looking closely at this crop.`, source: 'user-gaze', ttl: 1 }
                            ]
                        });
                        
                        // Visual feedback
                        VP.showToast?.('Персонаж заметил ваш взгляд...', 'info');
                    } catch (err) {
                        console.warn('[Gaze Tracker] Auto-reaction failed:', err);
                    }
                }, 6000); // 6 seconds of focused gazing triggers it!
            }, { moduleId: 'session' });
        }

        registerPanels();
        registerSessionHubCommands();
        requestShellRender('session-boot');
        console.log('[VP Session] ready — local session frontend registered.');
    }

    window.VisualProjector.session = {
        send, stop, clearSession, regenerateLast,
        getSessionPublicState,
        messageAdapter: SessionMessageAdapter,
        addMessage, updateMessage, deleteMessage,
        attachManifest, queueManifest, getManifests, removeManifest,
        renderInputPanel, renderInputSettings, renderLogPanel, renderLogSettings, renderModelPanel,
        persistSession, persistModel,
        renderRegisteredPanels,
    };

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { bootSession().catch(err => console.error('[VP Session] boot failed:', err)); });
    } else {
        setTimeout(() => { bootSession().catch(err => console.error('[VP Session] boot failed:', err)); }, 0);
    }
})();
