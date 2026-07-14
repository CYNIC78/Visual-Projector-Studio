/**
 * @fileoverview VPCommandBus — EventBus-backed command registry for VP Studio.
 * Handles [IMG:], [FX:], [CAT:], [TAB:], [ACTIVITY_*] commands.
 * Pure delegation to EventBus, no global state.
 */

'use strict';

/**
 * @typedef {Object} CommandEntry
 * @property {string} type
 * @property {string} target
 * @property {string} description
 * @property {boolean} queueable
 * @property {Function} handler
 * @property {any} [meta]
 */

/**
 * @typedef {Object} CommandLogEntry
 * @property {number} id
 * @property {number} time
 * @property {string} source
 * @property {string} role
 * @property {string} raw
 * @property {string} type
 * @property {string} originalType
 * @property {string} body
 * @property {any} payload
 * @property {string} target
 * @property {'success' | 'failed' | 'error' | 'invalid' | 'unknown' | 'unhandled'} status
 * @property {any} [result]
 * @property {string} [error]
 */

/**
 * @typedef {Object} VPCommandBusAPI
 * @property {(type: string, spec: Object | Function) => boolean} register
 * @property {(type: string) => boolean} unregister
 * @property {(type: string) => boolean} has
 * @property {() => CommandEntry[]} getRegistry
 * @property {(limit?: number) => CommandLogEntry[]} getLog
 * @property {() => void} clearLog
 * @property {(command: any, meta?: Object) => Promise<Object>} execute
 * @property {(text: string, meta?: Object) => Promise<Object[]>} executeText
 */

const VPCommandBus = {
  _registry: new Map(),
  _log: [],
  _seq: 0,
  maxLog: 300,
  _eventBus: null,
  _VPTags: null,
  _State: null,

  /**
   * @param {Object} deps
   * @param {EventBus} deps.eventBus
   * @param {VPTags} deps.VPTags
   * @param {ProjectorState} deps.State
   */
  init(deps) {
    this._eventBus = deps.eventBus;
    this._VPTags = deps.VPTags;
    this._State = deps.State;
  },

  // ─── Registry ───
  /**
   * @param {string} type
   * @param {Object | Function} spec
   * @returns {boolean}
   */
  register(type, spec = {}) {
    const normalized = this._VPTags?.normalizeType(type);
    if (!normalized) return false;
    const entry = {
      type: normalized,
      target: spec.target || 'unknown',
      description: spec.description || '',
      queueable: spec.queueable !== false,
      handler: typeof spec === 'function' ? spec : spec.handler,
      meta: spec.meta || null,
    };
    this._registry.set(normalized, entry);
    return true;
  },

  unregister(type) {
    return this._registry.delete(this._VPTags?.normalizeType(type));
  },

  has(type) {
    return this._registry.has(this._VPTags?.normalizeType(type));
  },

  getRegistry() {
    return Array.from(this._registry.values()).map(entry => ({
      type: entry.type,
      target: entry.target,
      description: entry.description,
      queueable: !!entry.queueable,
      meta: this._cloneForLog(entry.meta),
    }));
  },

  // ─── Logging ───
  getLog(limit = this.maxLog) {
    const n = Math.max(0, Number(limit) || this.maxLog);
    return this._log.slice(-n).map(this._cloneForLog);
  },

  clearLog() { this._log = []; },

  _pushLog(entry) {
    const row = { id: ++this._seq, time: Date.now(), ...entry };
    this._log.push(row);
    if (this._log.length > this.maxLog) this._log.splice(0, this._log.length - this.maxLog);
    return row;
  },

  _cloneForLog(value) {
    if (value == null) return value;
    try { return JSON.parse(JSON.stringify(value)); }
    catch { return String(value); }
  },

  // ─── Payload Normalization ───
  _payloadFor(type, body) {
    if (type === 'IMG') {
      const img = this._VPTags?.parseImageBody(body);
      if (!img?.tag) return { ok: false, error: 'Empty image tag' };
      return { ok: true, payload: { tag: img.tag, transition: img.transition || null } };
    }
    if (type === 'FX') {
      const name = this._VPTags?.cleanBody(body);
      if (!name) return { ok: false, error: 'Empty FX name' };
      return { ok: true, payload: { name } };
    }
    if (type === 'CAT' || type === 'TAB') {
      const dir = this._VPTags?.parseDirBody(body);
      if (!dir) return { ok: false, error: 'Invalid directory command; expected [TAB:open:name] or [CAT:collapse:name]' };
      return { ok: true, payload: { entityType: type, action: dir.action, name: dir.name } };
    }
    if (this._VPTags?._ACTIVITY_TYPES?.has(type)) {
      return { ok: true, payload: { arg: this._VPTags?.cleanBody(body) } };
    }
    return { ok: true, payload: { body: this._VPTags?.cleanBody(body) } };
  },

  // ─── Normalization ───
  /**
   * @param {any} command
   * @returns {{ok: boolean, command?: Object, error?: string, raw?: string, type?: string, originalType?: string, body?: string}}
   */
  normalize(command) {
    if (!command) return { ok: false, error: 'Empty command' };
    if (command.__vpCommand) return { ok: true, command };

    let parsed = command;
    if (typeof command === 'string') {
      const found = this._VPTags?.commands(command);
      parsed = found?.[0] || null;
    }
    if (!parsed || typeof parsed !== 'object') return { ok: false, error: 'Command is not parseable', raw: String(command || '') };

    const type = this._VPTags?.normalizeType(parsed.type || parsed.originalType || '');
    const originalType = String(parsed.originalType || parsed.type || type || '').trim().toUpperCase();
    const body = this._VPTags?.cleanBody(parsed.body ?? parsed.arg ?? '');
    const raw = parsed.raw || (type ? `[${type}${body ? ':' + body : ''}]` : '');
    if (!type) return { ok: false, error: 'Missing command type', raw, body };

    const payloadResult = this._payloadFor(type, body);
    if (!payloadResult.ok) return { ok: false, error: payloadResult.error, raw, type, originalType, body };

    return {
      ok: true,
      command: {
        __vpCommand: true,
        raw,
        originalType,
        type,
        body,
        payload: payloadResult.payload,
      },
    };
  },

  toQueueItem(command) {
    const rawType = command?.type || command?.originalType || '';
    const type = this._VPTags?.normalizeType(rawType);
    const entry = this._registry.get(type);
    if (!entry || entry.queueable === false) return null;
    return { type: 'vp_command', command };
  },

  // ─── Execution ───
  /**
   * @param {any} command
   * @param {Object} meta
   * @returns {Promise<Object>}
   */
  async execute(command, meta = {}) {
    const normalized = this.normalize(command);
    const baseMeta = {
      source: meta.source || 'unknown',
      role: meta.role || null,
      raw: normalized.command?.raw || normalized.raw || command?.raw || String(command || ''),
      type: normalized.command?.type || normalized.type || null,
      originalType: normalized.command?.originalType || normalized.originalType || null,
      body: normalized.command?.body || normalized.body || '',
      payload: this._cloneForLog(normalized.command?.payload || null),
    };

    if (!normalized.ok) {
      const row = this._pushLog({ ...baseMeta, status: 'invalid', target: null, error: normalized.error || 'Invalid command' });
      console.warn('[VP CommandBus] Invalid command:', row);
      return { ...row, ok: false, delayMs: 0 };
    }

    const cmd = normalized.command;
    const entry = this._registry.get(cmd.type);
    if (!entry) {
      const row = this._pushLog({ ...baseMeta, status: 'unknown', target: null, error: `Command ${cmd.type} is not registered` });
      console.warn(`[VP CommandBus] Unknown command: ${cmd.raw}`);
      return { ...row, ok: false, delayMs: 0 };
    }

    if (typeof entry.handler !== 'function') {
      const row = this._pushLog({ ...baseMeta, status: 'unhandled', target: entry.target, error: `Command ${cmd.type} has no handler` });
      console.warn(`[VP CommandBus] Unhandled command: ${cmd.raw}`);
      return { ...row, ok: false, delayMs: 0 };
    }

    try {
      const result = await entry.handler(cmd, meta, entry);
      const ok = !(result && result.ok === false);
      const row = this._pushLog({
        ...baseMeta,
        target: entry.target,
        status: ok ? 'success' : 'failed',
        result: this._cloneForLog(result || null),
        error: ok ? null : (result?.error || 'Command handler returned failure'),
      });
      if (!ok) console.warn('[VP CommandBus] Command failed:', row);
      return { ...row, ok, delayMs: Number(result?.delayMs || 0) };
    } catch (err) {
      const row = this._pushLog({
        ...baseMeta,
        target: entry.target,
        status: 'error',
        error: err?.message || String(err),
      });
      console.error('[VP CommandBus] Command handler error:', err);
      return { ...row, ok: false, delayMs: 0 };
    }
  },

  /**
   * @param {string} text
   * @param {Object} meta
   * @returns {Promise<Object[]>}
   */
  async executeText(text, meta = {}) {
    const commands = this._VPTags?.commands(text) || [];
    const types = meta.types ? new Set(meta.types.map(t => this._VPTags?.normalizeType(t))) : null;
    const out = [];
    for (const cmd of commands) {
      const type = this._VPTags?.normalizeType(cmd.type);
      const entry = this._registry.get(type);
      if (types && !types.has(type)) continue;
      if (entry?.queueable === false && !meta.allowNonQueueable) continue;
      out.push(await this.execute(cmd, meta));
    }
    return out;
  },

  // ─── Built-in Registrations (called by ProjectorModule) ───
  registerBuiltins(handlers) {
    // IMG
    this.register('IMG', {
      target: 'projector',
      description: 'Switch projector to a visual asset: [IMG:tag]',
      queueable: true,
      handler: handlers.onImage,
    });

    // FX
    this.register('FX', {
      target: 'fx-core',
      description: 'Trigger a visual effect: [FX:name] or [FX:name:intensity]',
      queueable: true,
      handler: handlers.onFx,
    });

    // CAT / TAB
    const executeDir = async (cmd) => {
      const { entityType, action, name } = cmd.payload || {};
      if (typeof handlers.onDirectory === 'function') {
        handlers.onDirectory(entityType || cmd.type, action, name);
      }
      return { ok: true, entityType: entityType || cmd.type, action, name, delayMs: 0 };
    };
    this.register('CAT', { target: 'gallery-tabs', description: 'Open/collapse a category: [CAT:open:name] / [CAT:collapse:name]', queueable: true, handler: executeDir });
    this.register('TAB', { target: 'gallery-tabs', description: 'Open/collapse a tab: [TAB:open:name] / [TAB:collapse:name]', queueable: true, handler: executeDir });

    // Activity commands
    for (const type of this._VPTags?._ACTIVITY_TYPES || []) {
      this.register(type, {
        target: 'games',
        description: 'Activity/game command. Full-text processing is delegated to VP_GAMES.',
        queueable: false,
        async handler(cmd, meta) {
          if (typeof handlers.onActivity === 'function') {
            await handlers.onActivity(cmd.raw, meta);
          }
          return { ok: true, delayMs: 0 };
        },
      });
    }
  },
};

// Export
export default VPCommandBus;
export { VPCommandBus };