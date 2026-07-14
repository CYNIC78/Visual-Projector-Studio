/**
 * @fileoverview Lightweight prefixed logger with levels.
 * Zero dependencies, works in browser + Neutralino.
 */

'use strict';

/** @type {'debug' | 'info' | 'warn' | 'error'} */
let _level = 'info';
const _levels = { debug: 0, info: 1, warn: 2, error: 3 };

/** @type {string} */
let _globalPrefix = '[VP]';

/**
 * @param {string} prefix
 * @returns {Logger}
 */
function createLogger(prefix) {
  const fullPrefix = `${_globalPrefix} ${prefix}`;

  /**
   * @param {'debug' | 'info' | 'warn' | 'error'} level
   * @param {string} msg
   * @param {any} [meta]
   */
  function log(level, msg, meta) {
    if (_levels[level] < _levels[_level]) return;
    const args = [`${fullPrefix} ${msg}`];
    if (meta !== undefined) args.push(meta);
    console[level](...args);
  }

  /** @type {Logger} */
  const logger = {
    debug: (msg, meta) => log('debug', msg, meta),
    info: (msg, meta) => log('info', msg, meta),
    warn: (msg, meta) => log('warn', msg, meta),
    error: (msg, meta) => log('error', msg, meta),
    setLevel: (l) => { _level = l; },
    child: (childPrefix) => createLogger(`${prefix}:${childPrefix}`),
  };
  return logger;
}

/** @type {Logger} */
export const Logger = {
  /** @param {string} prefix */
  create: createLogger,
  /** @param {'debug' | 'info' | 'warn' | 'error'} level */
  setGlobalLevel: (level) => { _level = level; },
  /** @param {string} prefix */
  setGlobalPrefix: (prefix) => { _globalPrefix = prefix; },
  /** @returns {Logger} */
  getRoot: () => createLogger(''),
};