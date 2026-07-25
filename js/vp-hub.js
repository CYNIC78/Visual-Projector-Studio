// VP Studio Hub v1
// Small in-memory transport for module events and commands.
// Intentional constraints:
// - no DOM ownership;
// - no storage writes;
// - no business logic;
// - duplicate command registration is an error;
// - unknown command request is an error.
(function initVpHub(global) {
    'use strict';

    const HUB_VERSION = '1.0.0';

    function createVpHub(options = {}) {
        const label = options.label || 'VP_HUB';
        const events = new Map();
        const commands = new Map();
        const modules = new Map();
        const eventErrors = [];
        const trace = [];
        const maxTrace = Math.max(50, Math.min(1000, Number(options.maxTrace) || 250));
        let traceSeq = 0;

        function fail(message) {
            throw new Error(`[${label}] ${message}`);
        }

        function assertName(kind, name) {
            if (typeof name !== 'string' || !name.trim()) {
                fail(`${kind} name must be a non-empty string`);
            }
            return name.trim();
        }

        function assertFunction(kind, fn) {
            if (typeof fn !== 'function') {
                fail(`${kind} must be a function`);
            }
            return fn;
        }

        function normalizeModuleId(moduleId) {
            if (moduleId == null || moduleId === '') return null;
            if (typeof moduleId !== 'string') fail('moduleId must be a string');
            return moduleId.trim() || null;
        }

        function isBinaryLike(value) {
            if (!value || typeof value !== 'object') return false;
            if (typeof Blob !== 'undefined' && value instanceof Blob) return true;
            if (typeof File !== 'undefined' && value instanceof File) return true;
            if (typeof ArrayBuffer !== 'undefined' && value instanceof ArrayBuffer) return true;
            if (typeof ArrayBuffer !== 'undefined' && ArrayBuffer.isView && ArrayBuffer.isView(value)) return true;
            return false;
        }

        function assertHubSafePayload(value, context, seen = new Set(), path = 'payload') {
            if (value == null) return;
            const type = typeof value;
            if (type === 'function' || type === 'symbol') {
                fail(`${context} contains unsupported ${type} at ${path}`);
            }
            if (type === 'string') {
                if (/^data:[^,]*;base64,/i.test(value.trim())) {
                    fail(`${context} contains base64 data URL at ${path}; pass a path/id reference instead`);
                }
                return;
            }
            if (type !== 'object') return;
            if (isBinaryLike(value)) {
                fail(`${context} contains binary data at ${path}; pass a path/id reference instead`);
            }
            if (seen.has(value)) return;
            seen.add(value);

            if (Array.isArray(value)) {
                value.forEach((item, index) => assertHubSafePayload(item, context, seen, `${path}[${index}]`));
                return;
            }

            const proto = Object.getPrototypeOf(value);
            if (proto && proto !== Object.prototype) {
                // Dates, URLs and Errors are references/metadata; binary-like objects are blocked above.
                if (typeof Date !== 'undefined' && value instanceof Date) return;
                if (typeof URL !== 'undefined' && value instanceof URL) return;
                if (typeof Error !== 'undefined' && value instanceof Error) return;
            }
            for (const key of Object.keys(value)) {
                assertHubSafePayload(value[key], context, seen, `${path}.${key}`);
            }
        }

        function summarizeValue(value, depth = 0, seen = new Set()) {
            if (value == null) return { type: String(value), value };
            const type = typeof value;
            if (type === 'string') {
                const trimmed = /^data:[^,]*;base64,/i.test(value) ? '[base64-data-url]' : value.slice(0, 180);
                return { type: 'string', length: value.length, preview: trimmed };
            }
            if (type === 'number' || type === 'boolean') return { type, value };
            if (type === 'function' || type === 'symbol') return { type };
            if (isBinaryLike(value)) return { type: 'binary-like' };
            if (seen.has(value)) return { type: 'circular' };
            seen.add(value);
            if (Array.isArray(value)) {
                return {
                    type: 'array',
                    length: value.length,
                    sample: depth < 2 ? value.slice(0, 5).map(item => summarizeValue(item, depth + 1, seen)) : undefined,
                };
            }
            if (typeof Date !== 'undefined' && value instanceof Date) return { type: 'date', value: value.toISOString() };
            if (typeof URL !== 'undefined' && value instanceof URL) return { type: 'url', value: String(value) };
            if (typeof Error !== 'undefined' && value instanceof Error) return { type: 'error', message: value.message || String(value) };
            const keys = Object.keys(value);
            const out = { type: 'object', keys: keys.slice(0, 20) };
            if (depth < 2) {
                out.sample = {};
                for (const key of keys.slice(0, 8)) out.sample[key] = summarizeValue(value[key], depth + 1, seen);
            }
            return out;
        }

        function pushTrace(entry) {
            const row = Object.freeze({
                id: ++traceSeq,
                ts: Date.now(),
                ...entry,
            });
            trace.push(row);
            if (trace.length > maxTrace) trace.splice(0, trace.length - maxTrace);
            return row;
        }

        function toPublicDescriptor(descriptor) {
            return Object.freeze({
                id: descriptor.id,
                version: descriptor.version || null,
                title: descriptor.title || descriptor.name || descriptor.id,
                hasInit: typeof descriptor.init === 'function',
                hasMount: typeof descriptor.mount === 'function',
                hasUnmount: typeof descriptor.unmount === 'function'
            });
        }

        function ensureEventSet(eventName) {
            let set = events.get(eventName);
            if (!set) {
                set = new Set();
                events.set(eventName, set);
            }
            return set;
        }

        function on(eventName, listener, options = {}) {
            eventName = assertName('event', eventName);
            listener = assertFunction('event listener', listener);
            const moduleId = normalizeModuleId(options.moduleId || options.owner || null);
            const entry = Object.freeze({
                eventName,
                listener,
                moduleId,
                once: !!options.once
            });
            const set = ensureEventSet(eventName);
            set.add(entry);

            let active = true;
            return function off() {
                if (!active) return false;
                active = false;
                const current = events.get(eventName);
                if (!current) return false;
                const deleted = current.delete(entry);
                if (!current.size) events.delete(eventName);
                return deleted;
            };
        }

        function once(eventName, listener, options = {}) {
            return on(eventName, listener, { ...options, once: true });
        }

        function emit(eventName, payload, meta = {}) {
            const startedAt = Date.now();
            eventName = assertName('event', eventName);
            assertHubSafePayload(payload, `event ${eventName}`);
            assertHubSafePayload(meta, `event ${eventName} meta`);
            const set = events.get(eventName);
            if (!set || !set.size) {
                pushTrace({
                    type: 'event',
                    name: eventName,
                    ok: true,
                    delivered: 0,
                    elapsedMs: Date.now() - startedAt,
                    moduleId: meta.moduleId || meta.source || null,
                    payload: summarizeValue(payload),
                    meta: summarizeValue(meta),
                });
                return 0;
            }

            const entries = Array.from(set);
            const envelope = Object.freeze({
                name: eventName,
                payload,
                meta: Object.freeze({
                    ...meta,
                    emittedAt: meta.emittedAt || Date.now()
                })
            });

            let delivered = 0;
            for (const entry of entries) {
                if (!set.has(entry)) continue;
                try {
                    entry.listener(payload, envelope);
                    delivered += 1;
                } catch (error) {
                    eventErrors.push({
                        eventName,
                        moduleId: entry.moduleId,
                        message: error && error.message ? error.message : String(error),
                        error,
                        ts: Date.now()
                    });
                    if (options.throwOnEventError) throw error;
                    if (global.console && typeof global.console.error === 'function') {
                        global.console.error(`[${label}] event listener failed: ${eventName}`, error);
                    }
                } finally {
                    if (entry.once) set.delete(entry);
                }
            }
            if (!set.size) events.delete(eventName);
            pushTrace({
                type: 'event',
                name: eventName,
                ok: true,
                delivered,
                elapsedMs: Date.now() - startedAt,
                moduleId: meta.moduleId || meta.source || null,
                payload: summarizeValue(payload),
                meta: summarizeValue(meta),
            });
            return delivered;
        }

        function handle(commandName, handler, options = {}) {
            commandName = assertName('command', commandName);
            handler = assertFunction('command handler', handler);
            if (commands.has(commandName)) {
                const existing = commands.get(commandName);
                fail(`command already registered: ${commandName}` + (existing.moduleId ? ` by ${existing.moduleId}` : ''));
            }
            const moduleId = normalizeModuleId(options.moduleId || options.owner || null);
            const entry = Object.freeze({ commandName, handler, moduleId });
            commands.set(commandName, entry);

            let active = true;
            return function unhandle() {
                if (!active) return false;
                active = false;
                const current = commands.get(commandName);
                if (current !== entry) return false;
                commands.delete(commandName);
                return true;
            };
        }

        async function request(commandName, payload, meta = {}) {
            const startedAt = Date.now();
            commandName = assertName('command', commandName);
            try {
                assertHubSafePayload(payload, `command ${commandName} payload`);
                assertHubSafePayload(meta, `command ${commandName} meta`);
                const entry = commands.get(commandName);
                if (!entry) fail(`unknown command: ${commandName}`);
                const result = await entry.handler(payload, Object.freeze({
                    name: commandName,
                    meta: Object.freeze({
                        ...meta,
                        requestedAt: meta.requestedAt || Date.now()
                    })
                }));
                assertHubSafePayload(result, `command ${commandName} result`);
                pushTrace({
                    type: 'request',
                    name: commandName,
                    ok: true,
                    moduleId: entry.moduleId || null,
                    source: meta.source || meta.moduleId || null,
                    elapsedMs: Date.now() - startedAt,
                    payload: summarizeValue(payload),
                    result: summarizeValue(result),
                });
                return result;
            } catch (error) {
                pushTrace({
                    type: 'request',
                    name: commandName,
                    ok: false,
                    source: meta?.source || meta?.moduleId || null,
                    elapsedMs: Date.now() - startedAt,
                    payload: summarizeValue(payload),
                    error: error && error.message ? error.message : String(error),
                });
                throw error;
            }
        }

        function registerModule(descriptor) {
            if (!descriptor || typeof descriptor !== 'object') fail('module descriptor must be an object');
            const id = assertName('module', descriptor.id);
            if (modules.has(id)) fail(`module already registered: ${id}`);
            const frozen = Object.freeze({ ...descriptor, id });
            modules.set(id, frozen);
            emit('hub:module-registered', toPublicDescriptor(frozen), { source: label });

            let active = true;
            return function unregisterModule() {
                if (!active) return false;
                active = false;
                return disposeModule(id);
            };
        }

        function disposeModule(moduleId) {
            moduleId = assertName('module', moduleId);
            const descriptor = modules.get(moduleId) || null;

            if (descriptor && typeof descriptor.unmount === 'function') {
                descriptor.unmount();
            }

            let removedListeners = 0;
            for (const [eventName, set] of Array.from(events.entries())) {
                for (const entry of Array.from(set)) {
                    if (entry.moduleId === moduleId) {
                        set.delete(entry);
                        removedListeners += 1;
                    }
                }
                if (!set.size) events.delete(eventName);
            }

            let removedCommands = 0;
            for (const [commandName, entry] of Array.from(commands.entries())) {
                if (entry.moduleId === moduleId) {
                    commands.delete(commandName);
                    removedCommands += 1;
                }
            }

            const removedModule = modules.delete(moduleId);
            emit('hub:module-disposed', Object.freeze({
                id: moduleId,
                removedModule,
                removedListeners,
                removedCommands
            }), { source: label });

            return removedModule || removedListeners > 0 || removedCommands > 0;
        }

        function inspect() {
            const eventList = Array.from(events.entries()).map(([name, set]) => ({
                name,
                listeners: set.size,
                modules: Array.from(new Set(Array.from(set).map((entry) => entry.moduleId).filter(Boolean))).sort()
            })).sort((a, b) => a.name.localeCompare(b.name));

            const commandList = Array.from(commands.values()).map((entry) => ({
                name: entry.commandName,
                moduleId: entry.moduleId
            })).sort((a, b) => a.name.localeCompare(b.name));

            const moduleList = Array.from(modules.values()).map(toPublicDescriptor)
                .sort((a, b) => a.id.localeCompare(b.id));

            const listenerCount = eventList.reduce((sum, item) => sum + item.listeners, 0);

            const commandsByModule = Array.from(commandList.reduce((map, cmd) => {
                const key = cmd.moduleId || '(unowned)';
                if (!map.has(key)) map.set(key, []);
                map.get(key).push(cmd.name);
                return map;
            }, new Map()).entries()).map(([moduleId, names]) => Object.freeze({
                moduleId,
                count: names.length,
                commands: Object.freeze(names.slice().sort()),
            })).sort((a, b) => a.moduleId.localeCompare(b.moduleId));

            const eventsByModule = Array.from(events.entries()).reduce((map, [name, set]) => {
                for (const entry of set) {
                    const key = entry.moduleId || '(anonymous)';
                    if (!map.has(key)) map.set(key, { listenerCount: 0, events: new Set() });
                    const row = map.get(key);
                    row.listenerCount += 1;
                    row.events.add(name);
                }
                return map;
            }, new Map());
            const eventListenersByModule = Array.from(eventsByModule.entries()).map(([moduleId, row]) => Object.freeze({
                moduleId,
                listenerCount: row.listenerCount,
                events: Object.freeze(Array.from(row.events).sort()),
            })).sort((a, b) => a.moduleId.localeCompare(b.moduleId));

            const requestSources = Array.from(trace.reduce((map, item) => {
                if (item.type !== 'request') return map;
                const key = item.source || '(unknown)';
                if (!map.has(key)) map.set(key, { count: 0, errors: 0 });
                const row = map.get(key);
                row.count += 1;
                if (item.ok === false) row.errors += 1;
                return map;
            }, new Map()).entries()).map(([source, row]) => Object.freeze({
                source,
                count: row.count,
                errors: row.errors,
            })).sort((a, b) => b.count - a.count || a.source.localeCompare(b.source));

            const recentErrors = trace.filter(item => item.ok === false).slice(-20).map(item => Object.freeze({
                id: item.id,
                ts: item.ts,
                type: item.type,
                name: item.name,
                source: item.source || null,
                moduleId: item.moduleId || null,
                error: item.error || null,
            }));

            const unknownCommandErrors = recentErrors.filter(item => /unknown command/i.test(item.error || '')).slice(-10);

            return Object.freeze({
                version: HUB_VERSION,
                label,
                events: Object.freeze(eventList),
                commands: Object.freeze(commandList),
                modules: Object.freeze(moduleList),
                counts: Object.freeze({
                    modules: moduleList.length,
                    commands: commandList.length,
                    events: eventList.length,
                    listeners: listenerCount,
                    trace: trace.length,
                    eventErrors: eventErrors.length,
                }),
                commandsByModule: Object.freeze(commandsByModule),
                eventListenersByModule: Object.freeze(eventListenersByModule),
                requestSources: Object.freeze(requestSources),
                traceSize: trace.length,
                maxTrace,
                lastTrace: trace.length ? trace[trace.length - 1] : null,
                lastError: trace.slice().reverse().find(item => item.ok === false) || null,
                recentErrors: Object.freeze(recentErrors),
                unknownCommandErrors: Object.freeze(unknownCommandErrors),
                eventErrors: Object.freeze(eventErrors.slice(-20).map((item) => Object.freeze({
                    eventName: item.eventName,
                    moduleId: item.moduleId,
                    message: item.message,
                    ts: item.ts
                })))
            });
        }

        function getTrace(options = {}) {
            const limitRaw = typeof options === 'number' ? options : options.limit;
            const limit = Math.max(1, Math.min(maxTrace, Number(limitRaw) || 50));
            const type = typeof options === 'object' ? options.type || null : null;
            const name = typeof options === 'object' ? options.name || null : null;
            const onlyErrors = typeof options === 'object' ? options.errors === true : false;
            let rows = trace;
            if (type) rows = rows.filter(item => item.type === type);
            if (name) rows = rows.filter(item => item.name === name);
            if (onlyErrors) rows = rows.filter(item => item.ok === false);
            return Object.freeze(rows.slice(-limit));
        }

        function clearTrace() {
            const count = trace.length;
            trace.length = 0;
            return count;
        }

        function resetForTests() {
            events.clear();
            commands.clear();
            modules.clear();
            eventErrors.length = 0;
            trace.length = 0;
            traceSeq = 0;
        }

        return Object.freeze({
            version: HUB_VERSION,
            on,
            once,
            emit,
            handle,
            request,
            registerModule,
            disposeModule,
            inspect,
            getTrace,
            clearTrace,
            __resetForTests: resetForTests
        });
    }

    if (!global.VP_HUB) {
        global.VP_HUB = createVpHub();
    }
    if (!global.VP_CREATE_HUB) {
        global.VP_CREATE_HUB = createVpHub;
    }
})(typeof globalThis !== 'undefined' ? globalThis : window);
