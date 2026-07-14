/**
 * @fileoverview AutoTagger — AI-powered asset tagging using VLM.
 * Integrates with GalleryModule, uses Vision model via OpenAI-compatible API.
 */

'use strict';

/**
 * @typedef {Object} TagResult
 * @property {string} tag
 * @property {string} description
 * @property {number} confidence
 */

const AutoTagger = {
  _running: false,
  _cancelled: false,
  _total: 0,
  _done: 0,
  _failed: 0,
  _current: null,
  _lastDesc: '',

  /**
   * @param {Object} deps
   * @param {Function} deps.emit - EventBus emit
   * @param {Function} deps.getGalleryState - () => GalleryState
   * @param {Function} deps.getModelConfig - () => ModelConfig
   * @param {Function} deps.getAssetPipeline - () => AssetPipeline
   */
  init(deps) {
    this._emit = deps.emit;
    this._getState = deps.getGalleryState;
    this._getModelConfig = deps.getModelConfig;
    this._getAssetPipeline = deps.getAssetPipeline;
  },

  /**
   * @param {string[]} [tags] - Specific tags to tag, or all untagged
   * @returns {Promise<void>}
   */
  async tagAll(tags = null) {
    if (this._running) return;
    const state = this._getState();
    if (!state) return;

    this._running = true; this._cancelled = false;
    this._total = 0; this._done = 0; this._failed = 0;

    const assets = tags
      ? tags.map(t => state.assets.get(t)).filter(Boolean)
      : Array.from(state.assets.values()).filter(a => !a.description || !a.description.trim());

    this._total = assets.length;
    if (this._total === 0) { this._running = false; this._emit('toast', { message: 'Нечего теггать', type: 'info' }); return; }

    this._emit('toast', { message: `Запускаю автотеггинг: ${this._total} ассет(ов)…`, type: 'info' });

    for (const asset of assets) {
      if (this._cancelled) break;
      this._current = asset.tag;
      try {
        await this._tagSingle(asset);
        this._done++;
      } catch (err) {
        this._failed++;
        console.warn('[AutoTagger] Failed:', asset.tag, err);
      }
      this._emit('tagger:progress', { done: this._done, total: this._total, failed: this._failed, current: this._current });
    }

    this._running = false;
    this._emit('toast', { message: `Автотеггинг завершён: ${this._done} ок, ${this._failed} ошибок`, type: this._failed ? 'warning' : 'success' });
    this._emit('tagger:complete', { done: this._done, failed: this._failed });
  },

  /**
   * @param {string} tag
   * @returns {Promise<void>}
   */
  async retagSingle(tag) {
    const state = this._getState();
    if (!state) return;
    const asset = state.assets.get(tag);
    if (!asset) return;
    await this._tagSingle(asset);
    this._emit('toast', { message: `Перетеггнут: ${tag}`, type: 'success' });
  },

  cancel() {
    this._cancelled = true;
  },

  /**
   * @param {AssetRecord} asset
   * @returns {Promise<void>}
   */
  async _tagSingle(asset) {
    const config = this._getModelConfig?.() || {};
    const endpoint = config.visionEndpoint || config.endpoint;
    const apiKey = config.apiKey;
    const model = config.visionModel || config.model;

    if (!endpoint || !model) throw new Error('Vision model not configured');

    // Prepare image
    let imageUrl = asset.url || asset.base64;
    if (!imageUrl && asset.blob) imageUrl = URL.createObjectURL(asset.blob);

    const prompt = `Describe this image in detail for a visual asset database. 
Provide:
1. A short tag (lowercase, underscores, max 32 chars) - e.g. "forest_path_morning"
2. A detailed visual description (2-3 sentences) for context injection

Return JSON only:
{
  "tag": "...",
  "description": "..."
}`;

    const messages = [
      { role: 'system', content: 'You are a precise visual asset tagger.' },
      { role: 'user', content: [
        { type: 'text', text: prompt },
        { type: 'image_url', image_url: { url: imageUrl } },
      ]},
    ];

    const headers = { 'Content-Type': 'application/json' };
    if (apiKey) headers.Authorization = apiKey.toLowerCase().startsWith('bearer ') ? apiKey : `Bearer ${apiKey}`;

    const res = await fetch(endpoint, {
      method: 'POST', headers,
      body: JSON.stringify({ model, messages, temperature: 0.3, max_tokens: 500, stream: false }),
    });

    if (!res.ok) {
      const err = await res.text().catch(() => '');
      throw new Error(`Vision API error: ${res.status} ${err}`);
    }

    const data = await res.json();
    const content = data.choices?.[0]?.message?.content || '{}';
    let result;
    try { result = JSON.parse(content); } catch { result = {}; }

    const newTag = this._sanitizeTag(result.tag || asset.tag);
    const desc = String(result.description || '').trim();

    if (newTag && newTag !== asset.tag) {
      // Rename via gallery module
      const state = this._getState();
      state.assets.delete(asset.tag);
      asset.tag = newTag;
      state.assets.set(newTag, asset);
    }
    if (desc) asset.description = desc;
  },

  _sanitizeTag(str) {
    return String(str == null ? '' : str)
      .toLowerCase()
      .replace(/[\s\-\.]+/g, '_')
      .replace(/[^a-z0-9_]/g, '')
      .replace(/^_+|_+$/g, '')
      .slice(0, 32);
  },

  getStatus() {
    return { running: this._running, cancelled: this._cancelled, total: this._total, done: this._done, failed: this._failed, current: this._current, lastDesc: this._lastDesc };
  },
};

export { AutoTagger };