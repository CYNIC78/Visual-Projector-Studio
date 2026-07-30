// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-tools.js — Native Tool Calling Registry                    ║
// ║  VP Studio's tool system: register, execute, and loop tools    ║
// ║  compatible with OpenAI function calling protocol.             ║
// ║                                                                ║
// ║  Philosophy (see TOOLS_ROADMAP.md):                            ║
// ║    Tags [IMG:], <diary> = ACTIONS (public, replayable)         ║
// ║    Tools (tool_calls) = PERCEPTION (private model phase)       ║
// ║    Manifests 📎 = TEMPORARY CONTEXT with TTL                   ║
// ║    v25 sanctioned exception: hybrid ACTION+PERCEPTION tools    ║
// ║    are allowed when the value is the RETURNED observation      ║
// ║    (scene_navigate — see docs/agentic-loop-design.md §5).      ║
// ║  Vision: a tool may return { attachments: [{kind:'image',      ║
// ║    dataUrl, caption, tag}] } — the session tool-loop delivers  ║
// ║    them to the model as a dedicated vision message while the   ║
// ║    tool JSON and persisted history keep metadata only (v25).   ║
// ║                                                                ║
// ║  Lifecycle:                                                    ║
// ║    'ephemeral'        — result vanishes after the turn         ║
// ║    { manifest: N }   — result pinned as manifest with TTL     ║
// ║    'persistent'      — result saved to game/world state       ║
// ╚════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP) {
        console.error('[VP Tools] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    // ════════════════════════════════════════════════════════════════
    //  VPTOOLS REGISTRY
    //  Native brother of VPCommandBus. While the bus handles text
    //  commands ([IMG:], [FX:]), tools handle structured function
    //  calls from the model (OpenAI-compatible tool_calls).
    // ════════════════════════════════════════════════════════════════

    const VPTools = {
        _registry: new Map(),
        _trace: [],
        maxTrace: 50,
        _seq: 0,

        _emit(eventName, payload = {}) {
            try {
                window.VP_HUB?.emit?.(eventName, payload, { moduleId: 'tools' });
            } catch (err) {
                console.warn(`[VP Tools] hub emit ${eventName} failed:`, err);
            }
        },

        _toolDescriptor(entry, { includeSchema = true } = {}) {
            if (!entry) return null;
            const descriptor = {
                name: entry.name,
                description: entry.description || '',
                icon: entry.icon || '🔧',
                lifecycle: entry.lifecycle || 'ephemeral',
                source: entry.source || 'core',
                enabled: entry.enabled !== false,
            };
            if (includeSchema) descriptor.schema = this._cloneForLog(entry.schema || { type: 'object', properties: {} });
            return descriptor;
        },

        getPublicState() {
            const tools = this.list({ enabledOnly: false, includeSchema: false });
            return {
                toolCount: tools.length,
                enabledToolCount: tools.filter(t => t.enabled !== false).length,
                disabledToolCount: tools.filter(t => t.enabled === false).length,
                sources: Array.from(new Set(tools.map(t => t.source).filter(Boolean))).sort(),
                traceSize: this._trace.length,
                maxTrace: this.maxTrace,
            };
        },

        register(def) {
            if (!def || !def.name || typeof def.handler !== 'function') {
                console.warn('[VP Tools] Invalid tool definition:', def);
                return false;
            }
            if (this._registry.has(def.name)) {
                console.warn(`[VP Tools] Tool "${def.name}" already registered. Overwriting.`);
            }
            // v26 per-tool management (owner: option B): enabled flags are runtime-only,
            // modelConfig.disabledTools[] is the persisted truth. Tools born while a
            // name is persisted-disabled start disabled (covers late game registrations;
            // static tools are re-synced at boot via applyDisabledToolsFromConfig in
            // projector-session.js).
            const persistedDisabled = window.VisualProjector?.state?.modelConfig?.disabledTools;
            const bornDisabled = Array.isArray(persistedDisabled) && persistedDisabled.includes(def.name);
            const entry = {
                name: def.name,
                description: def.description || '',
                icon: def.icon || '🔧',
                schema: def.schema || { type: 'object', properties: {} },
                handler: def.handler,
                summarize: def.summarize || null, // Optional summarizer
                lifecycle: def.lifecycle || 'ephemeral',
                source: def.source || 'core',
                enabled: def.enabled !== false && !bornDisabled,
            };
            this._registry.set(def.name, entry);
            this._emit('tools:registered', this._toolDescriptor(entry, { includeSchema: false }));
            return true;
        },

        // Get a human-readable summary of a tool result
        summarize(name, result) {
            const entry = this._registry.get(name);
            const data = result?.ok ? (result.data || result) : result;
            
            // 1. Tool-specific summarizer
            if (entry && typeof entry.summarize === 'function') {
                try { return entry.summarize(data); } catch (e) { console.warn(`[VP Tools] Summary failed for ${name}`, e); }
            }

            // 2. Default Error summary
            if (result?.ok === false || data?.ok === false) {
                return `Error in ${name}: ${data?.error || 'Unknown error'}`;
            }

            // 3. Smart Default heuristic
            if (data) {
                if (data.total !== undefined) return `${name} result: ${data.total}`;
                if (data.count !== undefined) return `${name} found ${data.count} items`;
                if (data.status !== undefined) return `${name} status: ${data.status}`;
            }

            return `${name} executed`;
        },

        unregister(name) {
            return this._registry.delete(name);
        },

        list({ enabledOnly = true, includeSchema = true, source = null, query = '' } = {}) {
            const q = String(query || '').trim().toLowerCase();
            const out = [];
            for (const entry of this._registry.values()) {
                if (enabledOnly && entry.enabled === false) continue;
                if (source && entry.source !== source) continue;
                if (q) {
                    const haystack = `${entry.name || ''} ${entry.description || ''} ${entry.source || ''}`.toLowerCase();
                    if (!haystack.includes(q)) continue;
                }
                out.push(this._toolDescriptor(entry, { includeSchema }));
            }
            return out.sort((a, b) => String(a.name).localeCompare(String(b.name)));
        },

        get(name) {
            return this._registry.get(name) || null;
        },

        getPublicTool(name, opts = {}) {
            return this._toolDescriptor(this.get(name), opts);
        },

        enable(name) {
            const entry = this._registry.get(name);
            if (!entry) return false;
            entry.enabled = true;
            this._emit('tools:enabled-changed', { name: entry.name, enabled: true, source: entry.source });
            return true;
        },

        disable(name) {
            const entry = this._registry.get(name);
            if (!entry) return false;
            entry.enabled = false;
            this._emit('tools:enabled-changed', { name: entry.name, enabled: false, source: entry.source });
            return true;
        },

        // Remove all tools from a specific source (used on game unload)
        unregisterBySource(source) {
            const toRemove = [];
            for (const [name, entry] of this._registry) {
                if (entry.source === source) toRemove.push(name);
            }
            toRemove.forEach(name => this._registry.delete(name));
            if (toRemove.length) this._emit('tools:unregistered-by-source', { source, removed: toRemove });
            return toRemove.length;
        },

        // Build OpenAI-compatible tools array for the request body
        buildOpenAITools() {
            return this.list({ enabledOnly: true }).map(t => ({
                type: 'function',
                function: {
                    name: t.name,
                    description: t.description,
                    parameters: t.schema,
                },
            }));
        },

        // Build compact [SERVICES] card for text-tags mode (poor loop)
        buildServicesCard() {
            const tools = this.list({ enabledOnly: true });
            if (!tools.length) return '';
            const lines = tools.map(t => {
                const params = t.schema?.properties
                    ? Object.keys(t.schema.properties).join(', ')
                    : 'no args';
                return `- ${t.name}(${params}): ${t.description}`;
            });
            return `[SERVICES]\nAvailable tools (perception actions — private model phase):\n${lines.join('\n')}\nInvoke via tool_call. Actions in the world still use tags: [IMG:], [FX:], etc.\n[/SERVICES]`;
        },

        // Execute a single tool call with logging and lifecycle handling
        async execute(name, args = {}, meta = {}) {
            const entry = this._registry.get(name);
            const baseMeta = {
                source: meta.source || 'unknown',
                role: meta.role || null,
                timestamp: Date.now(),
            };

            console.log(`[VP Tools] 🔧 Executing: ${name}`, args);

            if (!entry) {
                const error = `Tool "${name}" not registered`;
                this._pushLog({
                    ...baseMeta,
                    tool: name,
                    status: 'error',
                    error,
                    args: this._cloneForLog(args),
                    resultSize: 0,
                });
                console.warn(`[VP Tools] ❌ Error: ${error}`);
                return { ok: false, error };
            }

            if (entry.enabled === false) {
                const error = `Tool "${name}" is disabled`;
                this._pushLog({
                    ...baseMeta,
                    tool: name,
                    status: 'disabled',
                    args: this._cloneForLog(args),
                    resultSize: 0,
                });
                console.warn(`[VP Tools] ❌ Error: ${error}`);
                return { ok: false, error };
            }

            try {
                const result = await entry.handler(args, meta);
                const resultJson = JSON.stringify(result);
                this._pushLog({
                    ...baseMeta,
                    tool: name,
                    status: 'success',
                    args: this._cloneForLog(args),
                    result: this._cloneForLog(result),
                    resultSize: resultJson.length,
                    lifecycle: entry.lifecycle,
                });

                console.log(`[VP Tools] ✅ Success: ${name} ->`, result);
                this._emit('tools:executed', {
                    name,
                    ok: true,
                    source: baseMeta.source,
                    role: baseMeta.role,
                    resultSize: resultJson.length,
                    lifecycle: entry.lifecycle,
                    summary: this.summarize(name, { ok: true, data: result }),
                });

                // Handle manifest lifecycle: attach result as manifest with TTL.
                // Hub-first keeps Tools from reaching into Session internals, while
                // the direct fallback preserves the old local hot path if Hub/Session
                // registration is unavailable during boot.
                if (entry.lifecycle && typeof entry.lifecycle === 'object' && entry.lifecycle.manifest) {
                    const ttl = entry.lifecycle.manifest;
                    const summary = this._summarizeResult(result);
                    if (window.VP_HUB?.request) {
                        try {
                            await window.VP_HUB.request('session:attach-manifest', {
                                target: 'last',
                                text: summary,
                                ttl,
                                source: `tool:${name}`,
                            }, { source: 'tools' });
                        } catch (err) {
                            console.warn('[VP Tools] Hub session:attach-manifest failed; using legacy fallback:', err);
                            VP.session?.attachManifest?.('last', summary, {
                                ttl,
                                source: `tool:${name}`,
                            });
                        }
                    } else {
                        VP.session?.attachManifest?.('last', summary, {
                            ttl,
                            source: `tool:${name}`,
                        });
                    }
                }

                return { ok: true, data: result };
            } catch (err) {
                const error = err?.message || String(err);
                this._pushLog({
                    ...baseMeta,
                    tool: name,
                    status: 'error',
                    error,
                    args: this._cloneForLog(args),
                    resultSize: 0,
                });
                console.error(`[VP Tools] ❌ Exception in ${name}:`, err);
                this._emit('tools:executed', {
                    name,
                    ok: false,
                    source: baseMeta.source,
                    role: baseMeta.role,
                    error,
                });
                return { ok: false, error };
            }
        },

        getTrace(limit = this.maxTrace) {
            const n = Math.max(0, Number(limit) || this.maxTrace);
            return this._trace.slice(-n).map(this._cloneForLog);
        },

        clearTrace() {
            this._trace = [];
            this._emit('tools:trace-cleared', { ts: Date.now() });
        },

        _pushLog(entry) {
            const row = {
                id: ++this._seq,
                ...entry,
            };
            this._trace.push(row);
            if (this._trace.length > this.maxTrace) {
                this._trace.splice(0, this._trace.length - this.maxTrace);
            }
            return row;
        },

        _cloneForLog(value) {
            if (value == null) return value;
            try { return JSON.parse(JSON.stringify(value)); }
            catch { return String(value); }
        },

        _summarizeResult(result) {
            if (typeof result === 'string') return result;
            try { return JSON.stringify(result, null, 2); }
            catch { return String(result); }
        },
    };

    function registerToolsHubCommands() {
        const hub = window.VP_HUB;
        if (!hub?.handle) return;
        const info = hub.inspect?.();
        const hasCommand = (name) => !!info?.commands?.some?.(cmd => cmd.name === name);
        const hasModule = !!info?.modules?.some?.(mod => mod.id === 'tools');
        if (!hasModule && hub.registerModule) {
            try { hub.registerModule({ id: 'tools', title: 'VP Tools', version: '1.0.0' }); }
            catch (err) { console.warn('[VP Tools] Hub module registration failed:', err); }
        }
        if (!hasCommand('tools:get-state')) {
            hub.handle('tools:get-state', () => VPTools.getPublicState(), { moduleId: 'tools' });
        }
        if (!hasCommand('tools:list')) {
            hub.handle('tools:list', (payload = {}) => ({
                ok: true,
                tools: VPTools.list({
                    enabledOnly: payload.enabledOnly !== false,
                    includeSchema: payload.includeSchema !== false,
                    source: payload.source || null,
                    query: payload.query || '',
                }),
            }), { moduleId: 'tools' });
        }
        if (!hasCommand('tools:get')) {
            hub.handle('tools:get', (payload = {}) => {
                const name = String(payload.name || '').trim();
                if (!name) throw new Error('tools:get requires payload.name');
                const tool = VPTools.getPublicTool(name, { includeSchema: payload.includeSchema !== false });
                return { ok: !!tool, tool };
            }, { moduleId: 'tools' });
        }
        if (!hasCommand('tools:execute')) {
            hub.handle('tools:execute', async (payload = {}) => {
                const name = String(payload.name || '').trim();
                if (!name) throw new Error('tools:execute requires payload.name');
                return VPTools.execute(name, payload.args || {}, {
                    ...(payload.meta || {}),
                    source: payload.source || payload.meta?.source || 'hub',
                });
            }, { moduleId: 'tools' });
        }
        if (!hasCommand('tools:enable')) {
            hub.handle('tools:enable', (payload = {}) => {
                const name = String(payload.name || '').trim();
                if (!name) throw new Error('tools:enable requires payload.name');
                return { ok: VPTools.enable(name), tool: VPTools.getPublicTool(name) };
            }, { moduleId: 'tools' });
        }
        if (!hasCommand('tools:disable')) {
            hub.handle('tools:disable', (payload = {}) => {
                const name = String(payload.name || '').trim();
                if (!name) throw new Error('tools:disable requires payload.name');
                return { ok: VPTools.disable(name), tool: VPTools.getPublicTool(name) };
            }, { moduleId: 'tools' });
        }
        if (!hasCommand('tools:get-trace')) {
            hub.handle('tools:get-trace', (payload = {}) => ({ ok: true, trace: VPTools.getTrace(payload.limit) }), { moduleId: 'tools' });
        }
        if (!hasCommand('tools:clear-trace')) {
            hub.handle('tools:clear-trace', () => { VPTools.clearTrace(); return { ok: true }; }, { moduleId: 'tools' });
        }
        if (!hasCommand('tools:build-openai-tools')) {
            hub.handle('tools:build-openai-tools', () => ({ ok: true, tools: VPTools.buildOpenAITools() }), { moduleId: 'tools' });
        }
    }

    // Expose globally
    window.VPTools = VPTools;
    window.VisualProjector.tools = VPTools;

    registerToolsHubCommands();

    console.log('[VP Tools] Registry initialized.');

})();
