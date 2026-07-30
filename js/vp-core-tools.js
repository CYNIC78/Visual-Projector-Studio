// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-core-tools.js — Core perception tools for VP Studio        ║
// ║                                                                ║
// ║  Read-only tools: nothing modifies world state. Actions stay   ║
// ║  as tags ([IMG:], <diary>). Tools are for perception only:     ║
// ║  recall, search, dice, inspect.                                ║
// ║                                                                ║
// ║  v25 sanctioned exception (owner 2026-07-29, see               ║
// ║  docs/agentic-loop-design.md §5): hybrid ACTION+PERCEPTION     ║
// ║  tools are allowed when the primary value is the RETURNED      ║
// ║  observation — scene_navigate performs [TAB/CAT] transitions   ║
// ║  and gives back the fresh world slice + regenerated collage    ║
// ║  as a vision attachment.                                       ║
// ║                                                                ║
// ║  Load order: AFTER projector-gallery.js, BEFORE                ║
// ║  projector-session.js (needs gallery data + before tool loop).  ║
// ╚════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.tools) {
        console.error('[VP Core Tools] VPTools registry not found. Load vp-tools.js first.');
        return;
    }

    const Tools = VP.tools;
    const Hub = window.VP_HUB;

    async function hubRequest(name, payload = {}, fallback = null) {
        if (Hub?.request) {
            try { return await Hub.request(name, payload); }
            catch (err) { console.warn(`[VP Core Tools] Hub request failed: ${name}`, err); }
        }
        return typeof fallback === 'function' ? fallback() : fallback;
    }

    async function listGalleryAssetsForTools(payload = {}) {
        const res = await hubRequest('gallery:list-assets', payload, null);
        if (res?.items) return { total: res.total ?? res.items.length, items: res.items };
        const includeHidden = payload.includeHidden === true;
        const query = String(payload.query || '').trim().toLowerCase();
        const limit = Math.max(1, Math.min(1000, Number(payload.limit) || 200));
        const items = Array.from(VP.state?.gallery?.values?.() || [])
            .filter(a => includeHidden || !a.hidden)
            .filter(a => {
                if (!query) return true;
                return `${a.tag || ''} ${a.filename || ''} ${a.description || ''}`.toLowerCase().includes(query);
            })
            .slice(0, limit)
            .map(a => ({ tag: a.tag, filename: a.filename, description: a.description || '', hidden: !!a.hidden, tabId: a.tabId || null, source: a.source || null }));
        return { total: items.length, items };
    }

    async function getActiveMessagesForTools(limit = 500) {
        const res = await hubRequest('chats:get-active-messages', { limit }, null);
        if (res?.messages) return res.messages.map(m => ({
            id: m.id,
            role: m.role,
            speakerId: m.speakerId,
            raw: m.textPreview || '',
            text: m.textPreview || '',
            timestamp: m.createdAt || m.timestamp || null,
        }));
        return VP.chats?.getActiveChatMessages?.() || [];
    }

    async function getActiveChatForTools() {
        const res = await hubRequest('chats:get-active', {}, null);
        if (res?.chat) return res.chat;
        return VP.chats?.getActiveChat?.() || null;
    }

    async function getActiveSpeakerForTools() {
        const chat = await getActiveChatForTools();
        const participant = (chat?.participants || []).find(p => p.id === chat.activeSpeakerId) || chat?.participants?.[0] || null;
        if (participant) return participant;
        const speaker = VP.chats?.getActiveSpeaker?.();
        return speaker ? {
            id: speaker.id,
            profileId: speaker.profileId,
            name: VP.chats?.getParticipantDisplayName?.(speaker) || speaker.alias || 'Unknown',
            profile: VP.chats?.getParticipantProfile?.(speaker) || null,
        } : null;
    }

    // ════════════════════════════════════════════════════════════════
    //  ROLL_DICE — honest RNG for RPG scenes
    //  "2d6+1", "1d20", "3d8-2", etc.
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'roll_dice',
        icon: '🎲',
        description: 'Roll dice using standard RPG notation. Returns individual dice and total. Use for combat, skill checks, random outcomes — never fake a roll in narrative.',
        schema: {
            type: 'object',
            properties: {
                formula: {
                    type: 'string',
                    description: 'Dice formula like "2d6+1", "1d20", "3d8-2", "4d6k3" (keep highest 3).',
                },
                reason: {
                    type: 'string',
                    description: 'Optional context for the roll (e.g. "attack", "perception check").',
                },
            },
            required: ['formula'],
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        summarize(res) {
            return `Dice: ${res.total} (${res.formula})`;
        },
        handler(args) {
            const formula = String(args.formula || '').trim().toLowerCase().replace(/\s+/g, '');
            if (!formula) return { ok: false, error: 'Empty dice formula' };

            // Parse dice notation: XdY[kh|kl][+/-]Z
            const match = formula.match(/^(\d+)d(\d+)(?:kh|kl)?([+-]\d+)?$/);
            if (!match) return { ok: false, error: `Invalid formula: "${args.formula}". Use format like "2d6+1".` };

            const count = Math.min(20, parseInt(match[1], 10));
            const sides = Math.min(100, parseInt(match[2], 10));
            const modifier = match[3] ? parseInt(match[3], 10) : 0;

            const rolls = [];
            for (let i = 0; i < count; i++) {
                rolls.push(1 + Math.floor(Math.random() * sides));
            }

            let total = rolls.reduce((a, b) => a + b, 0) + modifier;
            return {
                ok: true,
                formula: args.formula,
                rolls,
                modifier,
                total,
                reason: args.reason || null,
            };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  GALLERY_SEARCH — find visual assets by tags/descriptions
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'gallery_search',
        icon: '🔍',
        description: 'Search the gallery for visual assets by tag name or description. Returns matching assets with their tags and descriptions. Use to find the right [IMG:tag] for a scene.',
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search term — matches against asset tags and descriptions (case-insensitive).',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum results to return (default 10, max 30).',
                },
            },
            required: ['query'],
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        summarize(res) {
            return `Search: Found ${res.total} assets for "${res.query}"`;
        },
        async handler(args) {
            const query = String(args.query || '').trim().toLowerCase();
            if (!query) return { ok: false, error: 'Empty search query' };

            const limit = Math.min(30, Math.max(1, parseInt(args.limit, 10) || 10));
            const listed = await listGalleryAssetsForTools({ query, limit, includeHidden: false });
            const results = (listed.items || [])
                .filter(asset => !String(asset.tag || '').startsWith('__'))
                .slice(0, limit)
                .map(asset => ({
                    tag: asset.tag,
                    description: asset.description || '',
                    hasImage: true,
                    source: asset.source || null,
                    tabId: asset.tabId || null,
                }));

            return { ok: true, query: args.query, results, total: results.length };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  RECALL_SCENE — search chat history for past events
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'recall_scene',
        icon: '📜',
        description: 'Search the active chat history for past messages. Useful to remember what happened earlier in the scene, find specific quotes, or check past events that may have been pushed out of the immediate context window.',
        schema: {
            type: 'object',
            properties: {
                query: {
                    type: 'string',
                    description: 'Search term — matches against message content (case-insensitive).',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum messages to return (default 5, max 20).',
                },
            },
            required: ['query'],
        },
        lifecycle: { manifest: 3 },
        source: 'core',
        group: 'core',
        summarize(res) {
            return `Recall: Found ${res.total} past messages matching query.`;
        },
        async handler(args) {
            const query = String(args.query || '').trim().toLowerCase();
            if (!query) return { ok: false, error: 'Empty search query' };

            const limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 5));
            const messages = await getActiveMessagesForTools(500);
            if (!messages.length) return { ok: true, results: [], note: 'No chat history available.' };

            const results = [];
            for (let i = messages.length - 1; i >= 0; i--) {
                const m = messages[i];
                const text = String(m.raw || m.text || '').toLowerCase();
                if (text.includes(query)) {
                    results.push({
                        index: i,
                        role: m.role,
                        speaker: m.speakerId || null,
                        text: String(m.raw || m.text || '').slice(0, 300),
                        timestamp: m.timestamp || null,
                    });
                }
                if (results.length >= limit) break;
            }

            return { ok: true, query: args.query, results, total: results.length, searched: messages.length };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  TIMELINE_CHECK — scene time, message counters, session info
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'timeline_check',
        icon: '⏲️',
        description: 'Get current scene timeline info: message count, session duration, active speaker, time since last message. Useful for pacing and scene management.',
        schema: {
            type: 'object',
            properties: {},
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        async handler() {
            const messages = await getActiveMessagesForTools(500);
            const now = Date.now();
            const timestamps = messages.map(m => m.timestamp || 0).filter(Boolean);
            const firstTs = timestamps.length ? Math.min(...timestamps) : null;
            const lastTs = timestamps.length ? Math.max(...timestamps) : null;

            const speaker = await getActiveSpeakerForTools();
            const speakerName = speaker ? (speaker.name || speaker.alias || 'Unknown') : null;

            return {
                ok: true,
                messageCount: messages.length,
                userCount: messages.filter(m => m.role === 'user').length,
                assistantCount: messages.filter(m => m.role === 'assistant').length,
                activeSpeaker: speakerName,
                sceneStartedAt: firstTs,
                lastMessageAt: lastTs,
                sceneDurationMs: firstTs ? now - firstTs : null,
                msSinceLastMessage: lastTs ? now - lastTs : null,
            };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  CHARACTER_NOTE — look up participant profile info
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'character_note',
        icon: '👤',
        description: 'Look up a character\'s profile information: name, description, persona, current state. Use to recall who someone is, their personality, or relationships.',
        schema: {
            type: 'object',
            properties: {
                name: {
                    type: 'string',
                    description: 'Character name (partial match, case-insensitive). If omitted, returns the active speaker.',
                },
            },
        },
        lifecycle: { manifest: 4 },
        source: 'core',
        group: 'core',
        async handler(args) {
            const name = String(args.name || '').trim().toLowerCase();

            if (!name) {
                const speaker = await getActiveSpeakerForTools();
                if (!speaker) return { ok: true, note: 'No active speaker.', character: null };
                const profile = speaker.profile || null;
                return {
                    ok: true,
                    character: {
                        name: speaker.name || speaker.alias || profile?.name || 'Unknown',
                        description: profile?.description || '',
                        persona: profile?.systemPrompt || '',
                        isSpeaker: true,
                    },
                };
            }

            const res = await hubRequest('chats:list-profiles', { query: name, limit: 20 }, null);
            const profiles = res?.items || VP.chats?.getProfilesStore?.()?.items || [];
            const match = profiles.find(p => String(p.name || '').toLowerCase().includes(name));
            if (!match) return { ok: true, note: `No character found matching "${args.name}".`, character: null };

            return {
                ok: true,
                character: {
                    name: match.name,
                    description: match.description || '',
                    persona: match.systemPrompt || '',
                    color: match.color || null,
                    isSpeaker: false,
                },
            };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  ASSET_SUGGEST — suggest a visual asset based on scene context
    //  Model doesn't know what's in hidden tabs — this helps it find
    //  the right [IMG:tag] for the current moment.
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'asset_suggest',
        icon: '💡',
        description: 'Suggest a visual asset (image) that fits the current scene mood or action. Returns matching asset tags with descriptions. Use when you want to set a visual frame with [IMG:tag] but need to find the right asset. Searches ALL gallery including hidden tabs.',
        schema: {
            type: 'object',
            properties: {
                mood: {
                    type: 'string',
                    description: 'Current mood or action: "happy", "tense", "romantic", "battle", "sad", "mysterious", "surprised", "neutral".',
                },
                who: {
                    type: 'string',
                    description: 'Character name to find assets for (e.g. "emily", "lexy").',
                },
                limit: {
                    type: 'number',
                    description: 'Maximum suggestions (default 5, max 15).',
                },
            },
            required: ['mood'],
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        async handler(args) {
            const mood = String(args.mood || '').trim().toLowerCase();
            const who = String(args.who || '').trim().toLowerCase();
            if (!mood && !who) return { ok: false, error: 'Provide mood or who parameter' };

            const limit = Math.min(15, Math.max(1, parseInt(args.limit, 10) || 5));
            const galleryList = await listGalleryAssetsForTools({ includeHidden: true, limit: 1000 });
            const gallery = galleryList.items || [];
            if (!gallery.length) {
                return { ok: true, suggestions: [], note: 'Gallery is empty.' };
            }

            const moodKeywords = {
                happy: ['smile', 'laugh', 'joy', 'happy', 'grin', 'cheerful', 'laughing', 'smiling'],
                sad: ['cry', 'tear', 'sad', 'upset', 'frown', 'unhappy', 'crying'],
                tense: ['angry', 'tense', 'serious', 'determined', 'fierce', 'battle', 'fight'],
                romantic: ['love', 'kiss', 'romantic', 'cuddle', 'heart', 'affection'],
                mysterious: ['shadow', 'dark', 'mysterious', 'night', 'fog', 'secret'],
                surprised: ['shock', 'surprise', 'wow', 'gasp', 'wide'],
                neutral: ['idle', 'stand', 'portrait', 'normal', 'default', 'pose'],
            };

            const keywords = moodKeywords[mood] || [mood];
            const results = [];

            for (const asset of gallery) {
                const tag = asset.tag;
                if (tag.startsWith('__')) continue;
                const desc = String(asset.description || '').toLowerCase();
                const tagLower = tag.toLowerCase();
                
                const whoMatch = who && (tagLower.includes(who) || desc.includes(who));
                const moodMatch = keywords.some(kw => tagLower.includes(kw) || desc.includes(kw));
                
                if (whoMatch || moodMatch) {
                    results.push({
                        tag,
                        description: asset.description || '',
                        matchedBy: whoMatch ? 'character' : 'mood',
                    });
                }
                if (results.length >= limit) break;
            }

            return { ok: true, mood, who: who || null, suggestions: results, total: results.length };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  SCENE_NAVIGATE — hybrid ACTION+PERCEPTION (v25; design:
    //  docs/agentic-loop-design.md §5). Performs a [TAB:]/[CAT:] gallery
    //  transition through the director bus (v17 solo-sweep + fuzzy match
    //  come free), WAITS for the Gallery View collage to re-render, and
    //  returns the fresh world slice plus the new collage as a vision
    //  attachment. The session tool-loop (projector-session.js) turns
    //  attachments into a dedicated vision message — the model enters the
    //  room and literally sees it after one honest pause.
    // ════════════════════════════════════════════════════════════════

    const _sceneNavSleep = (ms) => new Promise(r => setTimeout(r, ms));
    const SCENE_NAV_COLL_WAIT_MS = 15000;

    function _sceneNavSlice() {
        const gd = VP.state?.galleryData || {};
        return {
            tabs: Array.isArray(gd.tabs) ? gd.tabs : [],
            cats: Array.isArray(gd.categories) ? gd.categories : [],
            assets: VP.state?.gallery ? Array.from(VP.state.gallery.values()) : [],
        };
    }

    // executeCommand fires collage regeneration synchronously and the queue
    // may chain a restart — two consecutive calm samples = truly settled.
    async function _sceneNavAwaitCollage(timeoutMs = SCENE_NAV_COLL_WAIT_MS) {
        const t0 = Date.now();
        let calm = 0;
        let last = null;
        while (Date.now() - t0 < timeoutMs) {
            last = VP.gallery?.getCollagePublicState?.() || null;
            if (!last) return { state: null, timedOut: false };
            if (!last.running && !last.queued) {
                if (++calm >= 2) return { state: last, timedOut: false };
            } else calm = 0;
            await _sceneNavSleep(150);
        }
        return { state: last, timedOut: true };
    }

    function _sceneNavBlobToDataUrl(blob) {
        return new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onloadend = () => resolve(reader.result);
            reader.onerror = reject;
            reader.readAsDataURL(blob);
        });
    }

    async function _sceneNavAssetToDataUrl(asset) {
        try {
            if (!asset) return '';
            if (typeof asset.base64 === 'string' && asset.base64.startsWith('data:image/')) return asset.base64;
            if (typeof asset.url === 'string' && asset.url.startsWith('data:image/')) return asset.url;
            if (asset.blob && typeof asset.blob.arrayBuffer === 'function') return await _sceneNavBlobToDataUrl(asset.blob);
            if (typeof asset.url === 'string') {
                const resp = await fetch(asset.url);
                if (resp?.ok) return await _sceneNavBlobToDataUrl(await resp.blob());
            }
        } catch (err) {
            console.warn('[VP Core Tools] scene_navigate: collage asset -> dataUrl failed:', err);
        }
        return '';
    }

    Tools.register({
        name: 'scene_navigate',
        icon: '🚪',
        // v26 diet (~-30% tokens): same rails, tighter prose
        description: 'Enter/leave a scene tab or reveal/pack a pack (gallery rooms) and SEE the result: waits for the fresh Gallery View collage and returns it as an image plus visible [IMG:] tags. Use when the story moves location — call INSTEAD of [TAB:…]/[CAT:…] text commands. One transition per call; chain to keep walking.',
        schema: {
            type: 'object',
            properties: {
                entity: {
                    type: 'string',
                    enum: ['tab', 'pack'],
                    description: '"tab" = a scene room (solo: one open at a time, opening sweeps others into the hall); "pack" = a category shelf of scenes.',
                },
                action: {
                    type: 'string',
                    enum: ['open', 'close'],
                    description: 'open = enter the room / reveal the pack; close = step back into the hall / pack away.',
                },
                name: {
                    type: 'string',
                    description: 'Name of the scene tab or pack. Exact or near name — fuzzy match applies.',
                },
            },
            required: ['entity', 'action', 'name'],
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        summarize(res) {
            const t = res?.transition || {};
            if (res?.matched === false) return `Scene ➜ "${t.name || '?'}" — nothing matched`;
            if (t.action === 'close') return `Scene ⏏ ${t.name || '?'} — back in the hall`;
            const f = res?.focusScene;
            if (f) return `Scene ➜ ${f.name} (${f.framesVisible} frames, fresh view)`;
            return `Scene ➜ ${t.name || '?'}`;
        },
        async handler(args) {
            if (!VP.commands?.execute) return { ok: false, error: 'Director command bus unavailable' };
            const kind = String(args.entity || '').trim().toLowerCase() === 'pack' ? 'CAT' : 'TAB';
            const verb = String(args.action || '').trim().toLowerCase() === 'close' ? 'close' : 'open';
            const target = String(args.name || '').trim();
            if (!target) return { ok: false, error: 'Empty scene name' };

            const ciEq = (a, b) => String(a || '').trim().toLowerCase() === String(b || '').trim().toLowerCase();
            const ciNear = (a, b) => {
                const A = String(a || '').toLowerCase(), B = String(b || '').toLowerCase();
                return !!A && !!B && (A.includes(B) || B.includes(A));
            };

            const before = _sceneNavSlice();
            const wasOpen = before.tabs.filter(t => t.state === 'open').map(t => t.name).join('|');

            await VP.commands.execute(`[${kind}:${verb}:${target}]`, { source: 'tool:scene_navigate', showToast: true });

            const after = _sceneNavSlice();
            const subject = kind === 'TAB'
                ? (after.tabs.find(t => ciEq(t.name, target)) || after.tabs.find(t => ciNear(t.name, target)) || null)
                : (after.cats.find(c => ciEq(c.name, target)) || after.cats.find(c => ciNear(c.name, target)) || null);

            const openNow = after.tabs.filter(t => t.state === 'open').map(t => t.name);
            let matched = !!subject;
            if (kind === 'TAB' && subject) {
                matched = verb === 'open' ? subject.state === 'open' : subject.state !== 'open';
            }
            // Fuzzy safety net: the bus may have resolved a near name that slipped
            // our own matching — if the set of open scenes changed, trust the world.
            if (!matched && kind === 'TAB' && verb === 'open' && openNow.length && openNow.join('|') !== wasOpen) {
                matched = true;
            }

            let focusScene = null;
            let collageFresh = null;
            const attachments = [];

            if (matched && kind === 'TAB' && verb === 'open') {
                // The honest pause: wait for the Gallery View re-render so the
                // model receives the NEW room, not the stale one (owner's core
                // requirement for the loop, 2026-07-29).
                const settle = await _sceneNavAwaitCollage();
                collageFresh = !settle.timedOut;

                const tab = after.tabs.find(t => t.state === 'open') || subject;
                if (tab) {
                    const pack = (after.cats.find(c => c.id === tab.categoryId)?.name) || null;
                    const tags = after.assets.filter(a => a.tabId === tab.id).map(a => a.tag).filter(Boolean);
                    focusScene = {
                        name: tab.name,
                        pack,
                        framesVisible: tags.length,
                        tags: tags.slice(0, 24),
                        truncatedTags: tags.length > 24,
                    };
                    // v27: the law of the entered state repeats at the entry moment
                    const tabRules = String(tab.rules || '').trim();
                    if (tabRules) focusScene.rules = tabRules.length > 300 ? tabRules.slice(0, 299) + '…' : tabRules;
                }

                const collageAsset = VP.state?.gallery?.get?.('__SCENERY_COLLAGE__');
                const dataUrl = await _sceneNavAssetToDataUrl(collageAsset);
                if (dataUrl) {
                    attachments.push({
                        kind: 'image',
                        tag: '__SCENERY_COLLAGE__',
                        dataUrl,
                        caption: `FRESH GALLERY VIEW after entering "${focusScene?.name || target}"${focusScene?.pack ? ` (pack "${focusScene.pack}")` : ''}: this collage shows the room's frames${focusScene?.tags?.length ? ` — visible [IMG:] tags: ${focusScene.tags.join(', ')}` : ''}.${collageFresh === false ? ' (It was still re-rendering at timeout — latest available render attached.)' : ''}`,
                    });
                }
            }

            const menu = after.tabs.filter(t => t.state === 'collapsed').map(t => t.name);
            return {
                ok: true,
                transition: { entity: kind, action: verb, name: target, resolved: subject?.name || null },
                matched,
                openScenes: openNow,
                closedScenes: menu,
                focusScene,
                collageFresh,
                attachments,
                note: matched
                    ? 'The world is already updated — you ARE in the new place now. Study the attached fresh collage (if present) and continue THIS same reply: describe what you see and react in character. Show frames with [IMG:tag] from the visible tags. Do NOT navigate to the same destination again this turn.'
                    : `No scene matched "${target}". Nothing changed. Closed scenes available: ${menu.join(', ') || '(none)'}.`,
            };
        },
    });

    // ════════════════════════════════════════════════════════════════
    //  SCENE_DESCRIBE — describe the current scene state
    //  Combines projector frame, active speaker, recent context.
    // ════════════════════════════════════════════════════════════════
    Tools.register({
        name: 'scene_describe',
        icon: '🎭',
        description: 'Get a summary of the current scene: active frame/image, who is speaking, recent message context, participants, scenario. Use to orient yourself before responding.',
        schema: {
            type: 'object',
            properties: {},
        },
        lifecycle: 'ephemeral',
        source: 'core',
        group: 'core',
        async handler() {
            const speaker = await getActiveSpeakerForTools();
            const speakerName = speaker ? (speaker.name || speaker.alias || 'Unknown') : null;
            const profile = speaker?.profile || null;
            const projector = await hubRequest('projector:get-state', {}, null);
            const currentTag = projector?.currentTag || VP.state?.current?.tag || null;
            const currentAssetRes = currentTag ? await hubRequest('gallery:get-asset', { tag: currentTag }, null) : null;
            const currentAsset = currentAssetRes?.asset || null;
            const messages = await getActiveMessagesForTools(50);
            const recentMessages = messages.slice(-5).map(m => ({
                role: m.role,
                speaker: m.speakerId || null,
                text: String(m.raw || m.text || m.textPreview || '').slice(0, 100),
            }));

            const chat = await getActiveChatForTools();
            const scenario = chat?.scenario?.enabled ? `(scenario enabled, ${chat.scenario.textLength || 0} chars)` : null;
            const participants = chat?.participants?.map(p => ({
                alias: p.name || p.alias,
                profile: p.profileId,
            })) || [];

            return {
                ok: true,
                currentFrame: currentTag ? {
                    tag: currentTag,
                    description: currentAsset?.description || '',
                } : null,
                activeSpeaker: speakerName,
                profileKind: profile?.kind || profile?.meta?.kind || null,
                scenario,
                participants,
                recentMessages,
                totalMessages: messages.length,
            };
        },
    });

    console.log('[VP Core Tools] 8 tools registered: roll_dice, gallery_search, recall_scene, timeline_check, character_note, asset_suggest, scene_navigate, scene_describe');

})();
