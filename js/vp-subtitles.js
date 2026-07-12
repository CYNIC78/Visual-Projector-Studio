// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-subtitles.js — Subtitle Player for VP Studio               ║
// ║                                                                ║
// ║  Self-contained subtitle display system:                       ║
// ║    - Queue-based playback with text chunking                   ║
// ║    - Streaming delta support (pushDelta / flushStream)         ║
// ║    - VP command execution ([IMG:], [FX:]) inside stream        ║
// ║    - Role-aware display (user / assistant / system)            ║
// ║    - Markdown stripping, sentence boundary detection           ║
// ║                                                                ║
// ║  Load order: AFTER visual-projector.js, BEFORE                 ║
// ║  projector-session.js (needs VP facade + before tool loop).    ║
// ║                                                                ║
// ║  Dependencies (via VP facade):                                 ║
// ║    VP.state, VP.tags, VP.commands, VP.playback,               ║
// ║    VP.setCurrent, VP.showToast, VP.escapeRegex,                ║
// ║    VP._maybeShowEmptyHint                                      ║
// ╚════════════════════════════════════════════════════════════════╝

(function (VP) {
    'use strict';

    if (!VP || !VP.state) {
        console.error('[VP Subtitles] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const State = VP.state;
    const VPTags = VP.tags;
    const VPCommandBus = VP.commands;
    const Playback = VP.playback;
    const setCurrent = VP.setCurrent;
    const showToast = VP.showToast;
    const escapeRegex = VP.escapeRegex;
    const maybeShowEmptyHint = VP._maybeShowEmptyHint;

    // ────────────────────────────────────────────────────────────────
    //  SUBTITLE ROLE MODEL
    //  Maps a playback role to its display identity:
    //  label (from profiles/persona when available), icon and palette.
    //  Adding a new role (e.g. 'narrator') only needs an entry here.
    // ────────────────────────────────────────────────────────────────
    const SUBTITLE_ROLE_STYLES = {
        user:      { icon: '👤', palette: 'rgba(180,170,255,0.95)', accent: 'rgba(180,170,255,0.65)' },
        assistant: { icon: '🤖', palette: 'rgba(255,230,180,0.95)', accent: 'rgba(255,230,180,0.55)' },
        system:    { icon: '🎭', palette: 'rgba(137,180,250,0.96)', accent: 'rgba(137,180,250,0.72)' },
    };

    function resolveSubtitleSpeakerName(role) {
        try {
            if (role === 'user') {
                const name = String(State.config?.userName || '').trim();
                return name || 'You';
            }
            if (role === 'assistant') {
                const chats = window.VisualProjector?.chats;
                const speaker = chats?.getActiveSpeaker?.();
                const name = speaker ? chats?.getParticipantDisplayName?.(speaker) : '';
                return String(name || '').trim() || 'AI';
            }
            if (role === 'system') return 'Event';
        } catch {}
        return role === 'user' ? 'You' : role === 'system' ? 'Event' : 'AI';
    }

    function subtitleRoleIdentity(role) {
        const key = SUBTITLE_ROLE_STYLES[role] ? role : 'assistant';
        const style = SUBTITLE_ROLE_STYLES[key];
        return { key, icon: style.icon, palette: style.palette, accent: style.accent, name: resolveSubtitleSpeakerName(key) };
    }

    const SubtitlePlayer = {
        queue: [],
        currentChunk: null,
        hideTimer: null,
        userCueTimer: null,
        streamBuffer: '',
        mode: 'idle',
        activeRole: null,
        pendingAssistantBuffer: '',

        play(text, role = 'assistant') {
            if (!text) return;
            this.stop();
            this.mode = 'playback';
            this.activeRole = role;

            const cmdRegex = VPTags.command();
            let lastIndex = 0, match;
            while ((match = cmdRegex.exec(text)) !== null) {
                const textPart = text.slice(lastIndex, match.index);
                if (textPart.trim()) this.enqueueChunks(this.chunkText(textPart));
                const item = VPCommandBus.toQueueItem(VPTags.parseMatch(match));
                if (item) this.queue.push(item);
                lastIndex = match.index + match[0].length;
            }
            const tail = text.slice(lastIndex);
            if (tail.trim()) this.enqueueChunks(this.chunkText(tail));
            this.playNext();
        },

        playLiveUserCue(text) {
            const clean = this.stripMarkdown(VPTags.strip(text || '')).trim();
            if (!clean) return;
            clearTimeout(this.userCueTimer);
            this.userCueTimer = null;
            if (this.mode === 'idle' && !this.currentChunk && this.queue.length === 0) {
                this.activeRole = 'user';
                this.showOverlay(clean);
                const words = clean.split(/\s+/).filter(Boolean).length;
                const wpm = State.config.subtitleWPM || 220;
                const speed = State.config.subtitleSpeed || 1.0;
                const duration = Math.max(900 / speed, Math.min(3200 / speed, (words / wpm) * 60_000 / speed));
                this.userCueTimer = setTimeout(() => {
                    if (this.mode === 'idle' && !this.currentChunk && this.queue.length === 0 && this.activeRole === 'user') {
                        this.activeRole = null;
                        this.hideOverlay();
                    }
                    this.userCueTimer = null;
                }, duration);
            }
        },

        pushDelta(delta, role = 'assistant') {
            if (!delta) return;
            if (role === 'assistant') {
                clearTimeout(this.userCueTimer);
                this.userCueTimer = null;
            }
            if (role === 'assistant' && this.activeRole === 'user' &&
                (this.mode === 'playback' || this.queue.length > 0 || this.currentChunk)) {
                this.pendingAssistantBuffer += delta;
                return;
            }
            if (this.mode === 'idle') { this.mode = 'streaming'; this.activeRole = role; this.streamBuffer = ''; }
            this.streamBuffer += delta;
            this.extractAndEnqueueStreaming();
            if (!this.currentChunk) this.playNext();
        },

        extractAndEnqueueStreaming() {
            const cmdRegex = VPTags.command();
            while (true) {
                const match = cmdRegex.exec(this.streamBuffer);
                if (!match) {
                    const { chunks, remainder } = this.extractCompleteChunks(this.streamBuffer);
                    this.streamBuffer = remainder;
                    this.enqueueChunks(chunks);
                    break;
                }
                const textBefore = this.streamBuffer.slice(0, match.index);
                if (textBefore.trim()) this.enqueueChunks(this.chunkText(textBefore));
                const item = VPCommandBus.toQueueItem(VPTags.parseMatch(match));
                if (item) this.queue.push(item);
                this.streamBuffer = this.streamBuffer.slice(match.index + match[0].length);
                cmdRegex.lastIndex = 0;
            }
        },

        flushStream() {
            clearTimeout(this.userCueTimer);
            this.userCueTimer = null;
            if (this.activeRole === 'user' && this.pendingAssistantBuffer) return;
            if (this.streamBuffer.trim()) {
                const finalChunks = this.chunkText(this.streamBuffer);
                this.enqueueChunks(finalChunks);
                this.streamBuffer = '';
                if (!this.currentChunk) this.playNext();
            }
            this.mode = this.queue.length > 0 || this.currentChunk ? 'playback' : 'idle';
        },

        stop() {
            clearTimeout(this.hideTimer);
            clearTimeout(this.userCueTimer);
            this.hideTimer = null;
            this.userCueTimer = null;
            this.queue = [];
            this.currentChunk = null;
            this.streamBuffer = '';
            this.pendingAssistantBuffer = '';
            this.mode = 'idle';
            this.activeRole = null;
            this.hideOverlay();
        },

        clear() { this.hideOverlay(); },

        enqueueChunks(chunks) { chunks.forEach(c => { if (c.trim()) this.queue.push(c.trim()); }); },

        playNext() {
            clearTimeout(this.hideTimer);
            const item = this.queue.shift();
            if (!item) {
                this.currentChunk = null;
                if (this.activeRole === 'user' && this.pendingAssistantBuffer) {
                    const buffered = this.pendingAssistantBuffer;
                    this.pendingAssistantBuffer = '';
                    this.streamBuffer = ''; this.activeRole = 'assistant'; this.mode = 'streaming';
                    this.hideOverlay();
                    this.pushDelta(buffered, 'assistant');
                    return;
                }
                if (this.mode === 'playback') Playback.onPlaybackComplete();
                return;
            }

            // === DIRECTOR COMMAND BUS ===
            if (typeof item === 'object' && item.type === 'vp_command') {
                Promise.resolve(VPCommandBus.execute(item.command, {
                    source: 'subtitle-player',
                    role: this.activeRole || 'assistant',
                    showToast: true,
                    setCurrentSource: 'model',
                })).then((result) => {
                    const delay = Number(result?.delayMs || 0);
                    this.hideTimer = setTimeout(() => this.playNext(), Math.max(0, delay));
                }).catch((err) => {
                    console.error('[VP RP] command bus failed (contained):', err);
                    this.playNext();
                });
                return;
            }

            // === FRAME CHANGE ===
            if (typeof item === 'object' && item.type === 'frame') {
                const ok = setCurrent(item.tag, 'model', true, item.transition);
                if (ok) showToast(`▶ ${item.tag}`, 'info');
                this.hideTimer = setTimeout(() => this.playNext(), 400);
                return;
            }
            // === DIRECTORY COMMAND (routed to gallery's TabsManager) ===
            if (typeof item === 'object' && item.type === 'dir_cmd') {
                try {
                    const TM = window.VisualProjector?.gallery?.TabsManager;
                    if (TM) TM.executeCommand(item.entityType, item.action, item.name);
                } catch (e) { console.error('[VP RP] dir_cmd failed (contained):', e); }
                this.playNext();
                return;
            }
            // === FX EFFECT ===
            if (typeof item === 'object' && item.type === 'fx') {
                try { if (typeof FX !== 'undefined') FX.fire(item.name); }
                catch (e) { console.error('[VP RP] fx failed (contained):', e); }
                this.playNext();
                return;
            }

            // === TEXT CHUNK ===
            const chunk = item;
            this.currentChunk = chunk;
            this.showOverlay(chunk);

            const words = chunk.split(/\s+/).filter(Boolean).length;
            const wpm = State.config.subtitleWPM || 220;
            const speed = State.config.subtitleSpeed || 1.0;
            let duration = Math.max(1500 / speed, (words / wpm) * 60_000 / speed);
            if (State.playback.mode === 'playing' && State.playback.cursor === (State.coverTag ? 1 : 0)) {
                duration = Math.max(duration, 3000 / speed);
            }

            this.hideTimer = setTimeout(() => {
                if (this.queue.length > 0) { this.playNext(); return; }
                if (this.activeRole === 'user' && this.pendingAssistantBuffer) {
                    const buffered = this.pendingAssistantBuffer;
                    this.pendingAssistantBuffer = '';
                    this.streamBuffer = ''; this.activeRole = 'assistant'; this.mode = 'streaming';
                    this.currentChunk = null; this.hideOverlay();
                    this.pushDelta(buffered, 'assistant');
                    return;
                }
                
                // Studio 2.0: Always clear the chunk and hide the overlay when the queue is empty,
                // even in streaming mode. This prevents the last chunk from "sticking".
                this.currentChunk = null;
                this.hideOverlay();
                
                if (this.mode === 'streaming') return;
                Playback.onPlaybackComplete();
            }, duration);
        },

        stripMarkdown(text) {
            if (!text) return '';
            const protectedTags = [];
            text = text.replace(VPTags.all(), (match) => { protectedTags.push(match); return `\u0001${protectedTags.length - 1}\u0001`; });
            text = text.replace(/```[\s\S]*?```/g, '');
            text = text.replace(/```[\s\S]*$/g, '');
            text = text.replace(/^\|.*\|[ \t]*\n\|[\s|:\-]+\|[ \t]*(?:\|.*\|[ \t]*\n?)*/gm, '');
            text = text.replace(/^[ \t]*(?:-{3,}|\*{3,}|_{3,})[ \t]*$/gm, '');
            text = text.replace(/^#{1,6}[ \t]+/gm, '');
            text = text.replace(/^[ \t]*(?:>[ \t]*)+/gm, '');
            text = text.replace(/^[ \t]*[-*+][ \t]+/gm, '');
            text = text.replace(/^[ \t]*\d+\.[ \t]+/gm, '');
            text = text.replace(/\[([^\]]+)\]\([^)]+\)/g, '$1');
            text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1');
            text = text.replace(/___([^_]+)___/g, '$1');
            text = text.replace(/\*\*([^*]+)\*\*/g, '$1');
            text = text.replace(/__([^_]+)__/g, '$1');
            text = text.replace(/~~([^~]+)~~/g, '$1');
            text = text.replace(/`([^`]+)`/g, '$1');
            text = text.replace(/(^|[^\s(])\*(?!\s)([^*\n]+?)(?<!\s)\*(?=[\s).,!?;:]|$)/g, '$1$2');
            text = text.replace(/(^|[^\s(])_(?!\s)([^_\n]+?)(?<!\s)_(?=[\s).,!?;:]|$)/g, '$1$2');
            text = text.replace(/\u0001(\d+)\u0001/g, (_, idx) => protectedTags[+idx]);
            text = text.replace(/[ \t]+/g, ' ').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
            return text;
        },

        chunkText(text) {
            if (!text) return [];
            if (typeof FX !== 'undefined' && FX.enabled && FX.emojiMap) {
                const emojiList = Object.keys(FX.emojiMap);
                for (const emoji of emojiList) {
                    const regex = new RegExp(`(^|[\\s.!?,;:])${escapeRegex(emoji)}(?=[\\s.!?,;:]|$)`, 'g');
                    if (regex.test(text)) FX.fire(FX.emojiMap[emoji]);
                }
            }
            text = this.stripMarkdown(text);
            if (!text) return [];
            const MAX_WORDS_PER_CHUNK = 14;
            const result = [];
            const tagPlaceholders = [];
            let safeText = text.replace(VPTags.all(), (match) => { tagPlaceholders.push(match); return `\uE000${tagPlaceholders.length - 1}\uE001`; });
            const rawSentences = safeText.split(/(?<=[.!?…])\s+/).filter(s => s.trim());
            const sentences = rawSentences.map(s => s.replace(/\uE000(\d+)\uE001/g, (_, idx) => tagPlaceholders[+idx]));

            for (const sentence of sentences) {
                const words = sentence.split(/\s+/).filter(Boolean);
                if (words.length <= MAX_WORDS_PER_CHUNK) { result.push(sentence); continue; }
                const parts = sentence.split(/,\s*/);
                let currentParts = [], currentWords = 0;
                for (const part of parts) {
                    const partWords = part.split(/\s+/).filter(Boolean).length;
                    if (currentWords + partWords <= MAX_WORDS_PER_CHUNK) { currentParts.push(part); currentWords += partWords; }
                    else { if (currentParts.length) result.push(currentParts.join(', ')); currentParts = [part]; currentWords = partWords; }
                }
                if (currentParts.length) result.push(currentParts.join(', '));
            }
            const final = [];
            for (const chunk of result) {
                const words = chunk.split(/\s+/).filter(Boolean);
                if (words.length <= MAX_WORDS_PER_CHUNK) final.push(chunk);
                else for (let i = 0; i < words.length; i += MAX_WORDS_PER_CHUNK) final.push(words.slice(i, i + MAX_WORDS_PER_CHUNK).join(' '));
            }
            return final;
        },

        extractCompleteChunks(buffer) {
            const lastBoundary = this.findLastSentenceBoundary(buffer);
            if (lastBoundary === -1) return { chunks: [], remainder: buffer };
            const complete = buffer.slice(0, lastBoundary + 1);
            const remainder = buffer.slice(lastBoundary + 1);
            return { chunks: this.chunkText(complete), remainder };
        },

        findLastSentenceBoundary(buffer) {
            for (let i = buffer.length - 1; i >= 0; i--) {
                const ch = buffer[i];
                if (ch !== '.' && ch !== '!' && ch !== '?' && ch !== '…') continue;
                if (ch === '.') {
                    let j = i - 1;
                    while (j >= 0 && /\d/.test(buffer[j])) j--;
                    if (j < i - 1) {
                        let k = j;
                        while (k >= 0 && (buffer[k] === ' ' || buffer[k] === '\t')) k--;
                        if (k < 0 || buffer[k] === '\n') continue;
                        if (buffer[k] === '#') {
                            while (k >= 0 && buffer[k] === '#') k--;
                            if (k < 0 || buffer[k] === '\n' || /\s/.test(buffer[k])) continue;
                        }
                    }
                }
                return i;
            }
            return -1;
        },

        showOverlay(text) {
            if (!this.canShowSubtitles()) return;
            const screen = State.ui.screen;
            if (!screen) return;
            screen.querySelectorAll('.vp-screen-empty').forEach(el => el.remove());
            let overlay = screen.querySelector('.vp-subtitle-overlay');
            if (!overlay) { overlay = document.createElement('div'); overlay.className = 'vp-subtitle-overlay'; screen.appendChild(overlay); }
            const id = subtitleRoleIdentity(this.activeRole || 'assistant');
            overlay.classList.remove('vp-subtitle--user', 'vp-subtitle--assistant', 'vp-subtitle--system');
            overlay.classList.add(`vp-subtitle--${id.key}`);

            const isUser = id.key === 'user';
            const isSystem = id.key === 'system';
            const roleBadge = document.createElement('div');
            roleBadge.className = 'vp-subtitle-role';
            // Name only in subtitles (role icons live in the player bar).
            roleBadge.textContent = id.name;
            roleBadge.style.cssText = `font-size:11px; letter-spacing:.5px; margin-bottom:4px; opacity:0.9; font-weight:600; color:${id.palette};`;

            const span = document.createElement('span');
            span.className = 'vp-subtitle-text';
            span.textContent = text;
            if (isUser) {
                span.style.borderLeft = `3px solid ${id.accent}`;
                span.style.paddingLeft = '10px';
                span.style.fontStyle = 'italic';
                span.style.color = 'rgba(200,195,255,0.98)';
            } else if (isSystem) {
                span.style.borderLeft = `3px solid ${id.accent}`;
                span.style.paddingLeft = '10px';
                span.style.color = 'rgba(215,225,255,0.98)';
                span.style.background = 'rgba(18,24,42,0.74)';
            }

            overlay.innerHTML = '';
            overlay.appendChild(roleBadge);
            overlay.appendChild(span);
            void span.offsetWidth;
            requestAnimationFrame(() => span.classList.add('vp-subtitle-visible'));
        },

        hideOverlay() {
            const screen = State.ui.screen;
            const overlay = screen?.querySelector('.vp-subtitle-overlay');
            if (overlay) overlay.remove();
            if (screen && !State.current && this.mode === 'idle') maybeShowEmptyHint(screen);
        },

        canShowSubtitles() {
            const screen = State.ui.screen;
            if (!screen) return false;
            return screen.offsetWidth >= 280 && screen.offsetHeight >= 200;
        },
    };

    // Expose globally
    window.SubtitlePlayer = SubtitlePlayer;
    VP.subtitles = SubtitlePlayer;

    console.log('[VP Subtitles] SubtitlePlayer initialized.');

})(window.VisualProjector);
