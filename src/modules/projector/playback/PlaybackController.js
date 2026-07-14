/**
 * @fileoverview PlaybackController — explicit turn management for streaming and tool calls.
 * Replaces implicit "fetch sniffing" logic. Used by Session module.
 */

'use strict';

/**
 * @typedef {Object} PlaybackState
 * @property {PlaybackMessage[]} messages
 * @property {number} cursor
 * @property {'live' | 'paused' | 'playing'} mode
 * @property {boolean} streaming
 * @property {string | null} activeRole
 * @property {string | null} activeStartFrame
 * @property {string | null} lastUserFingerprint
 * @property {number} maxPlaybackMessages
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

class PlaybackController {
  /**
   * @param {Object} deps
   * @param {Function} deps.emit - EventBus emit
   * @param {Function} deps.on - EventBus on
   * @param {Function} deps.getGallery - () => Map<string, AssetRecord>
   * @param {Function} deps.getCurrent - () => AssetRecord | null
   * @param {Function} deps.setCurrent - (tag, source, force, transition) => boolean
   * @param {Function} deps.getConfig - () => ProjectorConfig
   * @param {Function} deps.getPlaybackState - () => PlaybackState
   * @param {Function} deps.setPlaybackState - (state: Partial<PlaybackState>) => void
   */
  constructor(deps) {
    this._emit = deps.emit;
    this._getGallery = deps.getGallery;
    this._getCurrent = deps.getCurrent;
    this._setCurrent = deps.setCurrent;
    this._getConfig = deps.getConfig;
    this._getPlaybackState = deps.getPlaybackState;
    this._setPlaybackState = deps.setPlaybackState;
  }

  // ─── State Accessors ───
  _state() { return this._getPlaybackState(); }
  _gallery() { return this._getGallery(); }
  _current() { return this._getCurrent(); }
  _config() { return this._getConfig(); }

  _mutate(patch) {
    this._setPlaybackState(patch);
  }

  get totalSlots() {
    const s = this._state();
    return s.messages.length + (this._currentCoverTag() ? 1 : 0);
  }

  _currentCoverTag() {
    // Will be provided by ProjectorModule via state
    return this._state().coverTag || null;
  }

  getCurrentMessage() {
    const s = this._state();
    if (s.cursor < 0) return null;
    const coverTag = this._currentCoverTag();
    if (coverTag && s.cursor === 0) return null;
    const msgIdx = coverTag ? s.cursor - 1 : s.cursor;
    return s.messages[msgIdx] || null;
  }

  // ─── Studio 2.0: Explicit Turn Management ───
  /**
   * @param {'user' | 'assistant'} role
   * @param {Object} metadata
   * @param {string} [metadata.startFrame]
   * @param {string} [metadata.text]
   */
  open(role, metadata = {}) {
    console.log(`[Playback] Turn opened: ${role}`);
    if (this._state().mode !== 'live') this.goLive();
    this._mutate({ streaming: true, activeRole: role, activeStartFrame: metadata.startFrame || this._current()?.tag || null });
    if (role === 'user' && metadata.text) {
      this._emit('playback:user-cue', { text: metadata.text });
    }
  }

  /**
   * @param {string} delta
   */
  push(delta) {
    if (!this._state().streaming) return;
    // Fire FX triggers on the fly during streaming
    this._emit('playback:push', { delta, isThinking: delta.startsWith('... [Thinking') });
  }

  /**
   * @param {string} fullText
   * @param {Object} metadata
   * @param {'user' | 'assistant' | 'system'} [metadata.role]
   * @param {string} [metadata.startFrame]
   */
  commit(fullText, metadata = {}) {
    const role = metadata.role || this._state().activeRole || 'assistant';
    if (this._state().streaming) {
      this._emit('playback:flush');
    } else if (fullText && fullText.trim() && role === 'assistant') {
      this._emit('playback:play', { text: fullText, role });
    }
    // History sync is managed by Session module via event
    this._mutate({ streaming: false, activeRole: null, activeStartFrame: null });
  }

  /**
   * Overwrite projector history with actual session messages
   * @param {PlaybackMessage[]} sessionMessages
   */
  sync(sessionMessages) {
    if (!Array.isArray(sessionMessages)) return;
    const synced = sessionMessages
      .filter(m => (m.role === 'user' || m.role === 'assistant' || m.role === 'system'))
      .filter(m => (m.raw && m.raw.trim()) || (m.text && m.text.trim()))
      .map(m => {
        let text = m.raw || m.text || '';
        // Artistic translation for technical Scene Events in subtitles
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
      .slice(-this._config().maxPlaybackMessages);

    this._mutate({ messages: synced, mode: 'live', cursor: -1 });
    console.log(`[Playback] History synced. Total: ${synced.length}`);
  }

  abort() {
    this._emit('playback:stop');
    this._mutate({ streaming: false, activeRole: null, activeStartFrame: null });
  }

  goTo(index) {
    const s = this._state();
    if (s.messages.length === 0) return;
    const total = this.totalSlots;
    index = Math.max(-1, Math.min(index, total - 1));
    if (s.mode === 'playing') this._emit('playback:stop');
    this._mutate({ cursor: index });
    if (index === -1) {
      this._mutate({ mode: 'live' });
      this._emit('playback:stop');
    } else {
      this._mutate({ mode: 'paused' });
      this._emit('playback:stop');
      const coverTag = this._currentCoverTag();
      if (coverTag && index === 0) {
        const coverAsset = this._gallery().get(coverTag);
        if (coverAsset) this._setCurrent(coverAsset.tag, 'replay', true);
        this._emit('fx:clear-mood');
        this._emit('fx:clear-transients');
      } else {
        const msg = this.getCurrentMessage();
        if (msg && msg.frameTagAtStart && this._gallery().has(msg.frameTagAtStart)) {
          this._setCurrent(msg.frameTagAtStart, 'replay', true);
        }
      }
    }
  }

  play() {
    const s = this._state();
    if (s.messages.length === 0) return;
    if (s.cursor === -1) s.cursor = this.totalSlots - 1;
    this._emit('playback:stop');
    this._emit('fx:clear-mood');
    this._emit('fx:clear-transients');
    this._mutate({ mode: 'playing' });

    const coverTag = this._currentCoverTag();
    if (coverTag && s.cursor === 0) {
      const coverAsset = this._gallery().get(coverTag);
      if (coverAsset) this._setCurrent(coverAsset.tag, 'replay', true);
      setTimeout(() => { if (this._state().mode === 'playing') this.onPlaybackComplete(); }, 2500);
      return;
    }
    const msg = this.getCurrentMessage();
    if (!msg) { this.goLive(); return; }
    if (msg.frameTagAtStart && this._gallery().has(msg.frameTagAtStart)) this._setCurrent(msg.frameTagAtStart, 'replay', true);
    setTimeout(() => { if (this._state().mode === 'playing') this._emit('playback:play', { text: msg.text, role: msg.role || 'assistant' }); }, 100);
  }

  pause() {
    if (this._state().mode !== 'playing') return;
    this._emit('playback:stop');
    this._mutate({ mode: 'paused' });
  }

  goLive() {
    this._emit('playback:stop');
    this._mutate({ cursor: -1, mode: 'live' });
  }

  onPlaybackComplete() {
    const s = this._state();
    if (s.mode !== 'playing') return;
    const total = this.totalSlots;
    if (s.cursor !== -1 && s.cursor < total - 1) {
      const nextIndex = s.cursor + 1;
      this._mutate({ cursor: nextIndex });
      const nextMsg = this.getCurrentMessage();
      if (nextMsg && nextMsg.frameTagAtStart && this._gallery().has(nextMsg.frameTagAtStart)) {
        this._setCurrent(nextMsg.frameTagAtStart, 'replay', true);
      }
      setTimeout(() => { if (this._state().mode === 'playing' && nextMsg) this._emit('playback:play', { text: nextMsg.text, role: nextMsg.role || 'assistant' }); }, 800);
      return;
    }
    this.goLive();
  }

  _config() {
    return this._getConfig();
  }

  _gallery() {
    // Provided by ProjectorModule
    return new Map();
  }
}

export { PlaybackController };