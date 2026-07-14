/**
 * @fileoverview Typed Event Bus — decoupled communication between modules.
 * Pure ESM, no dependencies. All types in JSDoc for IDE support.
 */

(function () {
  'use strict';

  /**
   * @template T
   * @typedef {Object} _Handler
   * @property {(payload: T) => void | Promise<void>} fn
   * @property {boolean} once
   */

  /** @type {Map<string, Set<_Handler<any>>>} */
  const _subs = new Map();

  /**
   * @template T
   * @param {string} eventName
   * @param {T} payload
   */
  function emit(eventName, payload) {
    const handlers = _subs.get(eventName);
    if (!handlers) return;
    for (const h of handlers) {
      try {
        const result = h.fn(payload);
        if (result instanceof Promise) {
          result.catch(err => console.error(`[EventBus] async handler error (${eventName}):`, err));
        }
      } catch (err) {
        console.error(`[EventBus] handler error (${eventName}):`, err);
      }
    }
  }

  /**
   * @template T
   * @param {string} eventName
   * @param {(payload: T) => void | Promise<void>} handler
   * @returns {() => void} unsubscribe
   */
  function on(eventName, handler) {
    if (!_subs.has(eventName)) _subs.set(eventName, new Set());
    const entry = { fn: handler, once: false };
    _subs.get(eventName).add(entry);
    return () => off(eventName, handler);
  }

  /**
   * @template T
   * @param {string} eventName
   * @param {(payload: T) => void | Promise<void>} handler
   * @returns {() => void} unsubscribe
   */
  function once(eventName, handler) {
    if (!_subs.has(eventName)) _subs.set(eventName, new Set());
    const entry = { fn: handler, once: true };
    _subs.get(eventName).add(entry);
    return () => off(eventName, handler);
  }

  /**
   * @param {string} eventName
   * @param {Function} handler
   */
  function off(eventName, handler) {
    const handlers = _subs.get(eventName);
    if (!handlers) return;
    for (const h of handlers) {
      if (h.fn === handler) {
        handlers.delete(h);
        break;
      }
    }
    if (handlers.size === 0) _subs.delete(eventName);
  }

  /**
   * @param {string} [eventName]
   */
  function clear(eventName) {
    if (eventName) _subs.delete(eventName);
    else _subs.clear();
  }

  /**
   * @returns {string[]}
   */
  function getEventNames() {
    return Array.from(_subs.keys());
  }

  /**
   * @param {string} eventName
   * @returns {number}
   */
  function getListenerCount(eventName) {
    return _subs.get(eventName)?.size || 0;
  }

  /** @type {EventBus} */
  export const EventBus = {
    emit,
    on,
    once,
    off,
    clear,
    getEventNames,
    getListenerCount,
  };
})();