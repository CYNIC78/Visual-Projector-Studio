/**
 * @fileoverview Module Manager — DI container, lifecycle, topological sort.
 * Modules register via register(id, definition). Manager calls init/start/stop/dispose in order.
 */

'use strict';

/** @type {Map<string, VPModule>} */
const _registry = new Map();
/** @type {Map<string, any>} */
const _instances = new Map();
/** @type {ModuleContext | null} */
let _context = null;
/** @type {Logger} */
let _logger = null;

// ─── Topological Sort (Kahn's Algorithm) ───
/**
 * @returns {VPModule[]}
 */
function _topoSort() {
  const nodes = new Map();
  const indeg = new Map();

  // Build graph
  for (const [id, mod] of _registry) {
    nodes.set(id, mod);
    indeg.set(id, 0);
  }
  for (const [id, mod] of _registry) {
    for (const dep of mod.dependencies || []) {
      if (nodes.has(dep)) {
        indeg.set(dep, (indeg.get(dep) || 0) + 1);
      } else {
        console.warn(`[ModuleManager] Module "${id}" depends on missing "${dep}"`);
      }
    }
  }

  // Kahn's algorithm
  const queue = [];
  for (const [id, deg] of indeg) if (deg === 0) queue.push(id);

  const sorted = [];
  while (queue.length) {
    const id = queue.shift();
    const mod = nodes.get(id);
    if (mod) sorted.push(mod);
    for (const dep of mod.dependencies || []) {
      if (indeg.has(dep)) {
        const d = indeg.get(dep) - 1;
        indeg.set(dep, d);
        if (d === 0) queue.push(dep);
      }
    }
  }

  if (sorted.length !== nodes.size) {
    // Cycle detected — fallback to registration order
    console.warn('[ModuleManager] Circular dependency detected, using registration order');
    return Array.from(_registry.values());
  }
  return sorted;
}

// ─── Module Context Factory ───
/**
 * @param {string} moduleId
 * @returns {ModuleContext}
 */
function _createContext(moduleId) {
  const mod = _registry.get(moduleId);
  return {
    eventBus: _context.eventBus,
    storage: _context.storage.namespace(moduleId),
    config: _context.config.scope(moduleId),
    native: _context.native,
    modules: {
      get: (id) => _instances.get(id),
      getAll: () => Array.from(_instances.values()),
      getInstance: (id) => _instances.get(id),
    },
    logger: _logger.create(moduleId),
  };
}

// ─── Public API ───
/** @type {ModuleManager} */
export const ModuleManager = {
  /**
   * Register a module
   * @param {VPModule} mod
   * @returns {boolean}
   */
  register(mod) {
    if (!mod || !mod.id || typeof mod.init !== 'function') {
      console.error('[ModuleManager] Invalid module definition:', mod);
      return false;
    }
    if (_registry.has(mod.id)) {
      console.warn(`[ModuleManager] Module "${mod.id}" already registered, overwriting`);
    }
    _registry.set(mod.id, mod);
    return true;
  },

  /**
   * Unregister a module (for hot-reload)
   * @param {string} id
   */
  unregister(id) {
    _registry.delete(id);
    _instances.delete(id);
  },

  /**
   * Get module definition
   * @param {string} id
   * @returns {VPModule | undefined}
   */
  getDefinition(id) {
    return _registry.get(id);
  },

  /**
   * Get all registered definitions
   * @returns {VPModule[]}
   */
  getAllDefinitions() {
    return Array.from(_registry.values());
  },

  /**
   * Get module instance (after init)
   * @param {string} id
   * @returns {any}
   */
  getInstance(id) {
    return _instances.get(id);
  },

  /**
   * Initialize all modules with shared context
   * @param {ModuleContext} context
   */
  async init(context) {
    _context = context;
    _logger = context.logger.child('ModuleManager');

    const sorted = _topoSort();
    _logger.info(`Starting init for ${sorted.length} modules: ${sorted.map(m => m.id).join(', ')}`);

    for (const mod of sorted) {
      const ctx = _createContext(mod.id);
      try {
        await mod.init(ctx);
        _instances.set(mod.id, mod);
        _logger.debug(`Initialized: ${mod.id}`);
      } catch (err) {
        console.error(`[ModuleManager] Init failed for ${mod.id}:`, err);
        throw err;
      }
    }
    _logger.info('All modules initialized');
  },

  /**
   * Start all modules (after init)
   */
  async start() {
    if (!_context) throw new Error('ModuleManager.init() must be called first');
    const sorted = _topoSort();
    _logger.info(`Starting ${sorted.length} modules...`);

    for (const mod of sorted) {
      if (!mod.start) continue;
      const ctx = _createContext(mod.id);
      try {
        await mod.start(ctx);
        _logger.debug(`Started: ${mod.id}`);
      } catch (err) {
        console.error(`[ModuleManager] Start failed for ${mod.id}:`, err);
        throw err;
      }
    }
    _logger.info('All modules started');
  },

  /**
   * Stop all modules (graceful shutdown)
   */
  async stop() {
    if (!_context) return;
    const sorted = _topoSort().reverse(); // reverse order
    _logger.info('Stopping modules...');

    for (const mod of sorted) {
      if (!mod.stop) continue;
      const ctx = _createContext(mod.id);
      try {
        await mod.stop(ctx);
        _logger.debug(`Stopped: ${mod.id}`);
      } catch (err) {
        console.warn(`[ModuleManager] Stop failed for ${mod.id}:`, err);
      }
    }
    _logger.info('All modules stopped');
  },

  /**
   * Dispose all modules (hard cleanup, hot-reload)
   */
  async dispose() {
    if (!_context) return;
    const sorted = _topoSort().reverse();
    _logger.info('Disposing modules...');

    for (const mod of sorted) {
      if (!mod.dispose) continue;
      const ctx = _createContext(mod.id);
      try {
        await mod.dispose(ctx);
        _logger.debug(`Disposed: ${mod.id}`);
      } catch (err) {
        console.warn(`[ModuleManager] Dispose failed for ${mod.id}:`, err);
      }
    }
    _instances.clear();
    _logger.info('All modules disposed');
  },

  /**
   * Hot-reload a single module
   * @param {string} id
   * @param {VPModule} newDef
   */
  async reload(id, newDef) {
    const oldMod = _registry.get(id);
    if (!oldMod) throw new Error(`Module "${id}" not registered`);

    _logger.info(`Hot-reloading ${id}...`);

    // Dispose old
    if (oldMod.dispose) {
      const ctx = _createContext(id);
      try { await oldMod.dispose(ctx); } catch (e) { console.warn(`[ModuleManager] Dispose old ${id}:`, e); }
    }

    // Register new
    _registry.set(id, newDef);
    _instances.delete(id);

    // Init new
    const ctx = _createContext(id);
    await newDef.init(ctx);
    if (newDef.start) await newDef.start(ctx);
    _instances.set(id, newDef);

    _logger.info(`Reloaded ${id}`);
  },
};