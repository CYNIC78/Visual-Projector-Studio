/**
 * @fileoverview VPTags — Robust, Unicode-safe command parser for VP Studio.
 * Single source of truth for command-tag parsing. Pure functions, no side effects.
 */

'use strict';

/**
 * @typedef {Object} ParsedCommand
 * @property {string} raw
 * @property {string} originalType
 * @property {string} type
 * @property {string} body
 */

/**
 * @typedef {Object} ImageCommand
 * @property {string} tag
 * @property {string | null} transition
 */

const VPTags = {
  // ─── Constants ───
  _TYPE_PATTERN: 'IMG|SET|PLAY|FRAME|IMAGE|FX|CAT|TAB|ACTIVITY_REQUEST|ACTIVITY_CHALLENGE|ACTIVITY_START|ACTIVITY_AUTO|ACTIVITY_ACCEPT|ACTIVITY_DECLINE',
  _IMAGE_TYPES: new Set(['IMG', 'SET', 'PLAY', 'FRAME', 'IMAGE']),
  _ACTIVITY_TYPES: new Set(['ACTIVITY_REQUEST', 'ACTIVITY_CHALLENGE', 'ACTIVITY_START', 'ACTIVITY_AUTO', 'ACTIVITY_ACCEPT', 'ACTIVITY_DECLINE']),
  _ACTION_ALIASES: {
    open: 'open', opened: 'open', expand: 'open', show: 'open', reveal: 'open', load: 'open',
    открыть: 'open', открой: 'open', открыть_папку: 'open', развернуть: 'open', разверни: 'open', показать: 'open', покажи: 'open',
    collapse: 'collapse', collapsed: 'collapse', close: 'collapse', fold: 'collapse', hide: 'collapse', unload: 'collapse',
    свернуть: 'collapse', сверни: 'collapse', закрыть: 'collapse', закрой: 'collapse', скрыть: 'collapse', спрячь: 'collapse',
  },

  // ─── Regex Builders ───
  _rx(flags = 'giu') {
    return new RegExp(`\\[\\s*(${this._TYPE_PATTERN})\\s*(?::|：)?\\s*([^\\]\\r\n]*)?\\]`, flags);
  },
  one(type) {
    const normalized = this.normalizeType(type);
    const types = normalized === 'IMG' ? 'IMG|SET|PLAY|FRAME|IMAGE' : normalized;
    return new RegExp(`\\[\\s*(${types})\\s*(?::|：)\\s*([^\\]\\r\n]+?)\\]`, 'giu');
  },
  all() { return this._rx('giu'); },
  command() { return this._rx('giu'); },
  dir() { return /\[\s*(CAT|TAB)\s*(?::|：)\s*([^:\]\u3000\r\n]+?)\s*(?::|：)\s*([^\]\r\n]+?)\s*\]/giu; },

  // ─── Cleaners / Normalizers ───
  /**
   * @param {any} value
   * @returns {string}
   */
  cleanBody(value) {
    return String(value == null ? '' : value)
      .normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '')
      .replace(/[“”]/g, '"')
      .replace(/[‘’]/g, "'")
      .trim()
      .replace(/^['"`]+|['"`]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  },

  /**
   * @param {string} type
   * @returns {string}
   */
  normalizeType(type) {
    const t = String(type || '').normalize('NFKC').trim().toUpperCase().replace(/[\s\-]+/g, '_');
    return this._IMAGE_TYPES.has(t) ? 'IMG' : t;
  },

  /**
   * @param {string} action
   * @returns {string}
   */
  normalizeAction(action) {
    const a = String(action || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\s\-]+/g, '_');
    return this._ACTION_ALIASES[a] || a;
  },

  /**
   * @param {string} value
   * @returns {string}
   */
  normalizeLookup(value) {
    return String(value || '')
      .normalize('NFKC')
      .trim()
      .toLowerCase()
      .replace(/ё/g, 'е')
      .replace(/[\s\-]+/g, '_')
      .replace(/[^\p{L}\p{N}_]+/gu, '')
      .replace(/_+/g, '_')
      .replace(/^_+|_+$/g, '');
  },

  /**
   * @param {string} value
   * @returns {string}
   */
  sanitizeLooseTag(value) {
    return this.normalizeLookup(value)
      .replace(/[^a-z0-9_]+/g, '')
      .replace(/^_+|_+$/g, '');
  },

  // ─── Levenshtein Distance (for fuzzy matching) ───
  /**
   * @param {string} a
   * @param {string} b
   * @returns {number}
   */
  distance(a, b) {
    a = String(a || ''); b = String(b || '');
    if (a === b) return 0;
    if (!a) return b.length;
    if (!b) return a.length;
    const prev = Array.from({ length: b.length + 1 }, (_, i) => i);
    const curr = new Array(b.length + 1);
    for (let i = 1; i <= a.length; i++) {
      curr[0] = i;
      for (let j = 1; j <= b.length; j++) {
        curr[j] = a[i - 1] === b[j - 1]
          ? prev[j - 1]
          : Math.min(prev[j - 1] + 1, prev[j] + 1, curr[j - 1] + 1);
      }
      for (let j = 0; j <= b.length; j++) prev[j] = curr[j];
    }
    return prev[b.length];
  },

  // ─── Parsers ───
  /**
   * @param {RegExpExecArray | null} match
   * @returns {ParsedCommand | null}
   */
  parseMatch(match) {
    if (!match) return null;
    const type = this.normalizeType(match[1] || '');
    if (!type || !new RegExp(`^(?:${this._TYPE_PATTERN})$`, 'i').test(match[1] || '')) return null;
    return { raw: match[0] || '', originalType: String(match[1] || '').trim().toUpperCase(), type, body: this.cleanBody(match[2] || '') };
  },

  /**
   * @param {string} body
   * @returns {ImageCommand | null}
   */
  parseImageBody(body) {
    const parts = String(body || '').split(/\s*[:：]\s*/);
    const rawTag = this.cleanBody(parts.shift() || '');
    const transition = this.cleanBody(parts.join(':')) || null;
    const tag = this.resolveImageTag(rawTag) || rawTag;
    return tag ? { tag, transition } : null;
  },

  /**
   * @param {string} body
   * @returns {{action: string, name: string} | null}
   */
  parseDirBody(body) {
    const parts = String(body || '').split(/\s*[:：]\s*/);
    if (parts.length < 2) return null;
    const action = this.normalizeAction(parts.shift());
    const name = this.cleanBody(parts.join(':'));
    if (!name || (action !== 'open' && action !== 'collapse')) return null;
    return { action, name };
  },

  // ─── High-level Extractors ───
  /**
   * @param {string} text
   * @returns {string}
   */
  strip(text) { return String(text == null ? '' : text).replace(this.all(), ''); },

  /**
   * @param {string} text
   * @returns {ParsedCommand[]}
   */
  commands(text) {
    const out = [];
    const re = this.command();
    let m;
    while ((m = re.exec(String(text == null ? '' : text))) !== null) {
      const cmd = this.parseMatch(m);
      if (cmd) out.push(cmd);
    }
    return out;
  },

  /**
   * @param {string} raw
   * @returns {{tag: string, extra: string | null}}
   */
  split(raw) {
    const parsed = this.parseImageBody(raw);
    if (parsed) return { tag: parsed.tag, extra: parsed.transition };
    const s = this.cleanBody(raw);
    return { tag: s, extra: null };
  },

  /**
   * @param {string} text
   * @returns {{raw: string, tag: string, extra: string | null, command: string}[]}
   */
  images(text) {
    return this.commands(text)
      .filter(cmd => cmd.type === 'IMG')
      .map(cmd => {
        const img = this.parseImageBody(cmd.body);
        return img ? { raw: cmd.body, tag: img.tag, extra: img.transition, command: cmd.raw } : null;
      })
      .filter(Boolean);
  },

  /**
   * @param {string} text
   * @returns {string[]}
   */
  fx(text) {
    return this.commands(text)
      .filter(cmd => cmd.type === 'FX')
      .map(cmd => this.cleanBody(cmd.body))
      .filter(Boolean);
  },

  /**
   * @param {string} text
   * @returns {ParsedCommand[]}
   */
  activity(text) {
    return this.commands(text).filter(cmd => this._ACTIVITY_TYPES.has(cmd.type));
  },

  /**
   * @param {string} text
   * @returns {number}
   */
  findOpenCommandStart(text) {
    const s = String(text == null ? '' : text);
    const idx = s.lastIndexOf('[');
    if (idx === -1 || s.indexOf(']', idx) !== -1) return -1;
    const tail = s.slice(idx);
    if (new RegExp(`^\[\\s*(?:${this._TYPE_PATTERN})(?:\s*(?::|：)[^\]]*)?$`, 'iu').test(tail)) return idx;
    const inner = tail.slice(1).trimStart().normalize('NFKC').toUpperCase().replace(/[\s\-]+/g, '_');
    if (!inner) return idx;
    const head = (inner.match(/^[A-Z_]+/) || [''])[0];
    if (!head) return -1;
    const types = this._TYPE_PATTERN.split('|');
    return types.some(t => t.startsWith(head)) ? idx : -1;
  },

  // ─── Tag Resolution (requires gallery reference) ───
  /**
   * @param {string} rawTag
   * @param {Map<string, any>} gallery
   * @param {Object<string, {to: string, expiresAt: number, reason: string}>} tagAliases
   * @returns {string | null}
   */
  resolveImageTag(rawTag, gallery, tagAliases) {
    let tag = this.cleanBody(rawTag);
    if (!tag || !gallery) return tag || null;

    // 1. Exact match
    if (gallery.has(tag)) return tag;

    // 2. Permanent Aliases (chain resolver)
    const aliases = tagAliases || {};
    let currentLookup = tag;
    let depth = 0;
    while (aliases[currentLookup] && depth < 10) {
      const target = aliases[currentLookup].to;
      if (gallery.has(target)) return target;
      currentLookup = target;
      depth++;
    }

    // 3. Fallback: Fuzzy matching and typos
    const loose = this.normalizeLookup(tag);
    const ascii = this.sanitizeLooseTag(tag);
    if (ascii && gallery.has(ascii)) return ascii;

    for (const [from, rec] of Object.entries(aliases)) {
      if (this.normalizeLookup(from) === loose && rec?.to && gallery.has(rec.to)) return rec.to;
    }

    for (const tag of gallery.keys()) {
      if (this.normalizeLookup(tag) === loose) return tag;
    }

    // Conservative typo repair: only for sufficiently distinctive tags.
    if (loose.length < 5) return null;
    let best = null;
    let bestDist = Infinity;
    for (const tag of gallery.keys()) {
      const candidate = this.normalizeLookup(tag);
      if (!candidate) continue;
      const dist = this.distance(loose, candidate);
      if (dist < bestDist) { bestDist = dist; best = tag; }
    }
    const maxDist = loose.length <= 8 ? 1 : 2;
    return best && bestDist <= maxDist && (bestDist / Math.max(loose.length, 1)) <= 0.2 ? best : null;
  },
};

// Export for both ESM and global (legacy)
if (typeof window !== 'undefined') window.VPTags = VPTags;
export default VPTags;
export { VPTags };