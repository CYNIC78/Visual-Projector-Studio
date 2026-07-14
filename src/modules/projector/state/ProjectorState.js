/**
 * @fileoverview Projector State — pure data + mutations for the projector engine.
 * No DOM, no side effects. Used by ProjectorModule and panels via EventBus.
 */

'use strict';

/**
 * @typedef {Object} AssetRecord
 * @property {string} tag
 * @property {string} filename
 * @property {string} path
 * @property {Blob} [blob]
 * @property {string} [url]
 * @property {string} [thumbUrl]
 * @property {string} [base64]
 * @property {string} description
 * @property {boolean} hidden
 * @property {'user' | 'generated' | 'imported' | 'pasted'} source
 * @property {string} [folderContext]
 * @property {string} [tabId]
 * @property {Object} [collageMeta]
 */

/**
 * @typedef {Object} HistoryFrame
 * @property {string} tag
 * @property {Blob} [blob]
 * @property {string} [url]
 * @property {string} filename
 * @property {number} timestamp
 * @property {'user' | 'model' | 'replay' | 'cover' | 'prepared'} source
 */

/**
 * @typedef {Object} PlaybackMessage
 * @property {number} id
 * @property {'user' | 'assistant' | 'system'} role
 * @property {string} text
 * @property {number} timestamp
 * @property {string | null} frameTagAtStart
 * @property {Object[]} [tool_calls]
 * @property {any[]} [tool_results]
 */

/**
 * @typedef {Object} PlaybackState
 * @property {PlaybackMessage[]} messages
 * @property {number} cursor
 * @property {'live' | 'paused' | 'playing'} mode
 * @property {boolean} streaming
 * @property {string | null} activeRole
 * @property {string | null} activeStartFrame
 */

// ─── Default Config Schema (for reference) ───
/**
 * @typedef {Object} ProjectorConfig
 * @property {number} contextDepth
 * @property {number} maxHistory
 * @property {number} fadeDuration
 * @property {'random'|'fade'|'crossfade'|'slide_left'|'slide_up'|'zoom'|'pop'|'flip'} transitionType
 * @property {number} assetCornerRadius
 * @property {'title'|'debug'|'hidden'} frameLabelMode
 * @property {number} subtitleWPM
 * @property {number} subtitleSpeed
 * @property {boolean} effectsEnabled
 * @property {boolean} showUserInPlayback
 * @property {boolean} allowUserCommands
 * @property {boolean} allowDirectoryCommands
 * @property {boolean} mergeUserDrafts
 * @property {number} userDraftMergeWindowMs
 * @property {number} maxPlaybackMessages
 */

// ─── Internal State ───
/** @type {AssetRecord | null} */
let _current = null;
/** @type {string | null} */
let _coverTag = null;
/** @type {string} */
let _coverLabel = 'cover';
/** @type {string | null} */
let _preparedTag = null;

/** @type {HistoryFrame[]} */
let _history = [];

/** @type {PlaybackState} */
let _playback = {
  messages: [],
  cursor: -1,
  mode: 'live',
  streaming: false,
  activeRole: null,
  activeStartFrame: null,
};

/** @type {Map<string, AssetRecord>} */
let _gallery = new Map(); // reference to gallery assets (set via setGalleryRef)

/** @type {Object<string, {to: string, expiresAt: number, reason: string}>} */
let _tagAliases = {};

/** @type {Object<string, number>} */
let _folderIndexCounter = {};

/** @type {ProjectorConfig} */
let _config = {
  contextDepth: 3,
  maxHistory: 20,
  fadeDuration: 0.3,
  transitionType: 'random',
  assetCornerRadius: 8,
  frameLabelMode: 'title',
  subtitleWPM: 160,
  subtitleSpeed: 1.0,
  effectsEnabled: true,
  showUserInPlayback: true,
  allowUserCommands: false,
  allowDirectoryCommands: false,
  mergeUserDrafts: true,
  userDraftMergeWindowMs: 3000,
  maxPlaybackMessages: 50,
};

// ─── Helpers ───
const _transitionTypes = ['crossfade', 'slide_left', 'slide_up', 'zoom', 'pop', 'flip'];

/**
 * @param {string} type
 * @returns {string}
 */
function _pickRandomTransition(type) {
  if (type !== 'random') return type;
  return _transitionTypes[Math.floor(Math.random() * _transitionTypes.length)];
}

// ─── Public API ───
/** @type {ProjectorStateAPI} */
export const ProjectorState = {
  // ─── Config ───
  /**
   * @param {Partial<ProjectorConfig>} cfg
   */
  setConfig(cfg) {
    _config = { ..._config, ...cfg };
  },

  getConfig() {
    return { ..._config };
  },

  // ─── Gallery Reference ───
  /**
   * @param {Map<string, AssetRecord>} galleryMap
   */
  setGalleryRef(galleryMap) {
    _gallery = galleryMap;
  },

  getGalleryRef() {
    return _gallery;
  },

  // ─── Tag Aliases ───
  /**
   * @param {string} oldTag
   * @param {string} newTag
   * @param {string} [reason]
   * @param {number} [ttlMs]
   */
  registerTagAlias(oldTag, newTag, reason = 'asset-rename', ttlMs = 10 * 60 * 1000) {
    if (!oldTag || !newTag || oldTag === newTag) return;
    _tagAliases[oldTag] = { to: newTag, expiresAt: Date.now() + ttlMs, reason };
  },

  getTagAliases() {
    return { ..._tagAliases };
  },

  clearExpiredAliases() {
    const now = Date.now();
    for (const [k, v] of Object.entries(_tagAliases)) {
      if (v.expiresAt && v.expiresAt < now) delete _tagAliases[k];
    }
  },

  // ─── Folder Index Counter ───
  getNextFolderIndex(folder) {
    _folderIndexCounter[folder] = (_folderIndexCounter[folder] || 0) + 1;
    return _folderIndexCounter[folder];
  },

  // ─── Current Frame ───
  /**
   * @returns {AssetRecord | null}
   */
  getCurrent() {
    return _current;
  },

  /**
   * @returns {string | null}
   */
  getCurrentTag() {
    return _current?.tag || null;
  },

  /**
   * @param {string} tag
   * @param {'user' | 'model' | 'replay' | 'cover' | 'prepared'} source
   * @param {boolean} [force]
   * @param {string} [transition]
   * @returns {boolean}
   */
  setCurrent(tag, source = 'user', force = false, transition = null) {
    const requestedTag = tag;
    tag = this.resolveImageTag(tag) || tag;

    const effectiveTransition = _pickRandomTransition(transition || _config.transitionType);

    if (!force && _current?.tag === tag) {
      return true; // already current
    }

    const asset = _gallery.get(tag);
    if (!asset) {
      console.warn(`[ProjectorState] Tag not found: "${requestedTag}"`);
      return false;
    }

    if (requestedTag !== tag) {
      console.log(`[ProjectorState] Resolved "${requestedTag}" -> "${tag}"`);
    }

    _current = asset;
    _currentTransition = effectiveTransition;

    // History management
    if (source === 'user') {
      _history = _history.filter(h => h.source !== 'user');
      _history.push({ tag: asset.tag, blob: asset.blob, url: asset.url, filename: asset.filename || asset.tag, timestamp: Date.now(), source });
      if (_history.length > _config.maxHistory) _history.shift();
    } else if (!['replay', 'cover', 'prepared'].includes(source)) {
      const isSameTag = _history[_history.length - 1]?.tag === tag;
      if (!isSameTag) {
        _history.push({ tag: asset.tag, blob: asset.blob, url: asset.url, filename: asset.filename || asset.tag, timestamp: Date.now(), source });
        if (_history.length > _config.maxHistory) _history.shift();
      }
    }

    // Notify via event bus (will be emitted by module)
    return true;
  },

  /** @type {string | null} */
  _currentTransition = 'crossfade',

  getCurrentTransition() {
    return _currentTransition;
  },

  clearCurrent() {
    _current = null;
    _history = _history.filter(h => h.source !== 'user');
    if (_playback.messages.length === 0) _preparedTag = null;
    return true;
  },

  isAssetReady(asset) {
    return !!(asset.description && asset.description.trim().length > 0);
  },

  // ─── Cover / Prepared ───
  getCoverTag() { return _coverTag; },
  getCoverLabel() { return _coverLabel; },
  getPreparedTag() { return _preparedTag; },

  /**
   * @param {string | null} tag
   * @param {string} [label]
   */
  setCover(tag, label) {
    if (!tag) {
      _coverTag = null;
      _preparedTag = null;
      return;
    }
    if (!_gallery.has(tag)) return;

    const previousCurrentTag = _current?.tag || null;
    const shouldShowOnProjector = _playback.messages.length === 0;

    _coverTag = tag;
    if (label) _coverLabel = label;

    if (_playback.messages.length === 0) {
      if (previousCurrentTag && previousCurrentTag !== tag) {
        _preparedTag = previousCurrentTag;
      } else {
        _preparedTag = null;
      }
      if (shouldShowOnProjector) _playback.cursor = 0;
    }
  },

  setPrepared(tag) {
    if (!tag || !_gallery.has(tag)) return;
    _preparedTag = tag;
  },

  clearCover() {
    _coverTag = null;
    _preparedTag = null;
    _playback.cursor = _playback.messages.length === 0 ? 0 : -1;
  },

  // ─── History ───
  getHistory() { return [..._history]; },

  setHistory(history) {
    _history = [...history].slice(-_config.maxHistory);
  },

  // ─── Playback ───
  getPlayback() { return { ..._playback }; },

  getPlaybackMessages() { return [..._playback.messages]; },

  getPlaybackCursor() { return _playback.cursor; },

  getPlaybackMode() { return _playback.mode; },

  getPlaybackTotalSlots() { return _playback.messages.length + (_coverTag ? 1 : 0); },

  getCurrentPlaybackMessage() {
    if (_playback.cursor < 0) return null;
    if (_coverTag && _playback.cursor === 0) return null;
    const msgIdx = _coverTag ? _playback.cursor - 1 : _playback.cursor;
    return _playback.messages[msgIdx] || null;
  },

  // Studio 2.0: Explicit turn management
  playbackOpen(role, metadata = {}) {
    if (_playback.mode !== 'live') {
      this.playbackGoLive();
    }
    _playback.streaming = true;
    _playback.activeRole = role;
    _playback.activeStartFrame = metadata.startFrame || _current?.tag || null;
    if (role === 'user' && metadata.text) {
      // Will be handled by subtitle module via event
    }
  },

  playbackPush(delta) {
    if (!_playback.streaming) return;
    // Fire FX triggers on the fly during streaming
    // Subtitle module will handle via event
  },

  playbackCommit(fullText, metadata = {}) {
    const role = metadata.role || _playback.activeRole || 'assistant';
    if (_playback.streaming) {
      // Subtitle flush handled by event
    } else if (fullText && fullText.trim() && role === 'assistant') {
      // Subtitle play handled by event
    }

    // History sync is managed by Session module via event
    _playback.streaming = false;
    _playback.activeRole = null;
    _playback.activeStartFrame = null;
  },

  playbackAbort() {
    _playback.streaming = false;
    _playback.activeRole = null;
    _playback.activeStartFrame = null;
  },

  playbackGoTo(index) {
    if (_playback.messages.length === 0) return;
    const totalSlots = this.getPlaybackTotalSlots();
    index = Math.max(-1, Math.min(index, totalSlots - 1));
    if (_playback.mode === 'playing') {
      // Subtitle stop via event
    }
    _playback.cursor = index;
    if (index === -1) {
      _playback.mode = 'live';
      // Subtitle stop via event
    } else {
      _playback.mode = 'paused';
      // Subtitle stop via event
      if (_coverTag && index === 0) {
        const coverAsset = _gallery.get(_coverTag);
        if (coverAsset) {
          this.setCurrent(coverAsset.tag, 'replay', true);
          // FX clear via event
        }
      } else {
        const msg = this.getCurrentPlaybackMessage();
        if (msg && msg.frameTagAtStart && _gallery.has(msg.frameTagAtStart)) {
          this.setCurrent(msg.frameTagAtStart, 'replay', true);
        }
      }
    }
  },

  playbackPlay() {
    if (_playback.messages.length === 0) return;
    if (_playback.cursor === -1) _playback.cursor = this.getPlaybackTotalSlots() - 1;
    // Subtitle stop via event
    // FX clear via event
    _playback.mode = 'playing';

    if (_coverTag && _playback.cursor === 0) {
      const coverAsset = _gallery.get(_coverTag);
      if (coverAsset) this.setCurrent(coverAsset.tag, 'replay', true);
      setTimeout(() => { if (_playback.mode === 'playing') this.playbackOnComplete(); }, 2500);
      return;
    }
    const msg = this.getCurrentPlaybackMessage();
    if (!msg) { this.playbackGoLive(); return; }
    if (msg.frameTagAtStart && _gallery.has(msg.frameTagAtStart)) this.setCurrent(msg.frameTagAtStart, 'replay', true);
    setTimeout(() => { if (_playback.mode === 'playing') this._playSubtitle(msg); }, 100);
  },

  _playSubtitle(msg) {
    // Emitted via event bus by module
  },

  playbackPause() {
    if (_playback.mode !== 'playing') return;
    // Subtitle stop via event
    _playback.mode = 'paused';
  },

  playbackGoLive() {
    // Subtitle stop via event
    _playback.cursor = -1;
    _playback.mode = 'live';
  },

  playbackOnComplete() {
    if (_playback.mode !== 'playing') return;
    const totalSlots = this.getPlaybackTotalSlots();
    if (_playback.cursor !== -1 && _playback.cursor < totalSlots - 1) {
      const nextIndex = _playback.cursor + 1;
      _playback.cursor = nextIndex;
      const nextMsg = this.getCurrentPlaybackMessage();
      if (nextMsg && nextMsg.frameTagAtStart && _gallery.has(nextMsg.frameTagAtStart)) {
        this.setCurrent(nextMsg.frameTagAtStart, 'replay', true);
      }
      setTimeout(() => { if (_playback.mode === 'playing' && nextMsg) this._playSubtitle(nextMsg); }, 800);
      return;
    }
    this.playbackGoLive();
  },

  // Studio 2.0: Sync from Session
  /**
   * @param {PlaybackMessage[]} sessionMessages
   */
  playbackSync(sessionMessages) {
    if (!Array.isArray(sessionMessages)) return;

    const synced = sessionMessages
      .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
      .filter(m => (m.raw && m.raw.trim()) || (m.text && m.text.trim()))
      .map(m => {
        let text = m.raw || m.text || '';

        // Artistic translation for technical Scene Events
        if (m.role === 'system' && text.includes('[SCENE EVENT:')) {
          const typeMatch = text.match(/SCENE EVENT:\s*([^\]]+)/i);
          const type = typeMatch ? typeMatch[1].replace(/_/g, ' ') : 'EVENT';
          const summaryMatch = text.match(/(?:Summary|Outcome|Replay summary):\s*(.*)/i);
          const body = summaryMatch ? summaryMatch[1].trim() : type;
          const cleanBody = body.replace(/^[^\p{L}\p{N}"'(]+/u, '').trim();
          text = `[ ${cleanBody} ]`;
        }

        return {
          id: m.id || (Date.now() + Math.random()),
          role: m.role,
          text,
          timestamp: m.createdAt || Date.now(),
          frameTagAtStart: m.frameTagAtStart || null,
          tool_calls: m.tool_calls || null,
          tool_results: m.tool_results || null,
        };
      })
      .slice(-_config.maxPlaybackMessages);

    _playback.messages = synced;
    if (_playback.mode === 'live') _playback.cursor = -1;
  },

  // ─── Manifest / Context Builders ───
  buildManifest(templateOverride = null) {
    // Delegated to ManifestBuilder module
    return '';
  },

  buildFrameContextPreview(templateOverride = null) {
    // Delegated to ManifestBuilder module
    return '';
  },

  // ─── Visual Context Frames ───
  buildVisualContextFrames() {
    const depth = _config.contextDepth;
    let frames = [];

    const hasCover = !!_coverTag;
    const coverIsCurrent = !!(hasCover && _current?.tag === _coverTag);

    if (hasCover) {
      const cover = _gallery.get(_coverTag);
      if (cover) {
        frames.push({
          tag: cover.tag, blob: cover.blob, url: cover.url, thumbUrl: cover.thumbUrl,
          filename: cover.filename || cover.tag, source: 'cover', collageMeta: cover.collageMeta || null,
        });
      }
    }

    if (!coverIsCurrent && depth > 0 && _history.length > 0) {
      const history = _history
        .slice(-depth)
        .filter(h => h && h.tag && (!_coverTag || h.tag !== _coverTag));
      frames = frames.concat(history);
    }

    return frames;
  },

  // ─── Full Snapshot (for persistence) ───
  getSnapshot() {
    return {
      currentTag: _current?.tag || null,
      coverTag: _coverTag,
      coverLabel: _coverLabel,
      preparedTag: _preparedTag,
      history: _history.map(h => ({
        tag: h.tag, filename: h.filename || h.tag, timestamp: h.timestamp || Date.now(), source: h.source || 'user',
      })),
      playbackMessages: _playback.messages.map(m => ({
        id: m.id, role: m.role || 'assistant', text: m.text || '', timestamp: m.timestamp || Date.now(), frameTagAtStart: m.frameTagAtStart ?? null,
      })),
    };
  },

  applySnapshot(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return false;

    const restoredHistory = (snapshot.history || [])
      .map(h => {
        const asset = _gallery.get(h.tag);
        if (!asset) return null;
        return { tag: asset.tag, blob: asset.blob, url: asset.url, filename: asset.filename || h.filename || asset.tag, timestamp: h.timestamp || Date.now(), source: h.source || 'user' };
      })
      .filter(Boolean)
      .slice(-(_config.maxHistory || 20));

    const restoredPlayback = (snapshot.playbackMessages || [])
      .filter(m => m && (m.text || '').trim())
      .map(m => ({
        id: m.id || (Date.now() + Math.random()),
        role: m.role || 'assistant',
        text: String(m.text || ''),
        timestamp: m.timestamp || Date.now(),
        frameTagAtStart: m.frameTagAtStart ?? null,
        tool_calls: m.tool_calls || null,
        tool_results: m.tool_results || null,
      }))
      .slice(-(_config.maxPlaybackMessages || 50));

    _coverTag = (snapshot.coverTag && _gallery.has(snapshot.coverTag)) ? snapshot.coverTag : null;
    _coverLabel = snapshot.coverLabel || 'cover';
    _preparedTag = (snapshot.preparedTag && _gallery.has(snapshot.preparedTag)) ? snapshot.preparedTag : null;
    _current = (snapshot.currentTag && _gallery.has(snapshot.currentTag)) ? _gallery.get(snapshot.currentTag) : null;
    _history = restoredHistory;
    _playback.messages = restoredPlayback;
    _playback.cursor = -1;
    _playback.mode = 'live';
    return true;
  },
};