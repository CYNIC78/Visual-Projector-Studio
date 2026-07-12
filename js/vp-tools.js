// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-tools.js — Native Tool Calling Registry                    ║
// ║  VP Studio's tool system: register, execute, and loop tools    ║
// ║  compatible with OpenAI function calling protocol.             ║
// ║                                                                ║
// ║  Philosophy (see TOOLS_ROADMAP.md):                            ║
// ║    Tags [IMG:], <diary> = ACTIONS (public, replayable)         ║
// ║    Tools (tool_calls) = PERCEPTION (private model phase)       ║
// ║    Manifests 📎 = TEMPORARY CONTEXT with TTL                   ║
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

        register(def) {
            if (!def || !def.name || typeof def.handler !== 'function') {
                console.warn('[VP Tools] Invalid tool definition:', def);
                return false;
            }
            if (this._registry.has(def.name)) {
                console.warn(`[VP Tools] Tool "${def.name}" already registered. Overwriting.`);
            }
            const entry = {
                name: def.name,
                description: def.description || '',
                icon: def.icon || '🔧',
                schema: def.schema || { type: 'object', properties: {} },
                handler: def.handler,
                summarize: def.summarize || null, // Optional summarizer
                lifecycle: def.lifecycle || 'ephemeral',
                source: def.source || 'core',
                enabled: def.enabled !== false,
            };
            this._registry.set(def.name, entry);
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

        list({ enabledOnly = true } = {}) {
            const out = [];
            for (const entry of this._registry.values()) {
                if (enabledOnly && entry.enabled === false) continue;
                out.push({
                    name: entry.name,
                    description: entry.description,
                    icon: entry.icon,
                    schema: entry.schema,
                    lifecycle: entry.lifecycle,
                    source: entry.source,
                    enabled: entry.enabled,
                });
            }
            return out;
        },

        get(name) {
            return this._registry.get(name) || null;
        },

        enable(name) {
            const entry = this._registry.get(name);
            if (entry) entry.enabled = true;
        },

        disable(name) {
            const entry = this._registry.get(name);
            if (entry) entry.enabled = false;
        },

        // Remove all tools from a specific source (used on game unload)
        unregisterBySource(source) {
            const toRemove = [];
            for (const [name, entry] of this._registry) {
                if (entry.source === source) toRemove.push(name);
            }
            toRemove.forEach(name => this._registry.delete(name));
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

                // Handle manifest lifecycle: attach result as manifest with TTL
                if (entry.lifecycle && typeof entry.lifecycle === 'object' && entry.lifecycle.manifest) {
                    const ttl = entry.lifecycle.manifest;
                    const summary = this._summarizeResult(result);
                    if (VP.session?.attachManifest) {
                        VP.session.attachManifest('last', summary, {
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
                return { ok: false, error };
            }
        },

        getTrace(limit = this.maxTrace) {
            const n = Math.max(0, Number(limit) || this.maxTrace);
            return this._trace.slice(-n).map(this._cloneForLog);
        },

        clearTrace() { this._trace = []; },

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

    // Expose globally
    window.VPTools = VPTools;
    window.VisualProjector.tools = VPTools;

    console.log('[VP Tools] Registry initialized.');

})();
