// ╔════════════════════════════════════════════════════════════════╗
// ║  vp-core-tools.js — Core perception tools for VP Studio        ║
// ║                                                                ║
// ║  Read-only tools: nothing modifies world state. Actions stay   ║
// ║  as tags ([IMG:], <diary>). Tools are for perception only:     ║
// ║  recall, search, dice, inspect.                                ║
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
        handler(args) {
            const query = String(args.query || '').trim().toLowerCase();
            if (!query) return { ok: false, error: 'Empty search query' };

            const limit = Math.min(30, Math.max(1, parseInt(args.limit, 10) || 10));
            const gallery = VP.state?.gallery;
            if (!gallery || gallery.size === 0) {
                return { ok: true, results: [], note: 'Gallery is empty.' };
            }

            const results = [];
            for (const [tag, asset] of gallery) {
                if (tag.startsWith('__')) continue; // skip internal assets
                const desc = String(asset.description || '').toLowerCase();
                const tagLower = tag.toLowerCase();
                if (tagLower.includes(query) || desc.includes(query)) {
                    results.push({
                        tag,
                        description: asset.description || '',
                        hasImage: !!(asset.blob || asset.url || asset.base64),
                    });
                }
                if (results.length >= limit) break;
            }

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
        handler(args) {
            const query = String(args.query || '').trim().toLowerCase();
            if (!query) return { ok: false, error: 'Empty search query' };

            const limit = Math.min(20, Math.max(1, parseInt(args.limit, 10) || 5));
            const messages = VP.chats?.getActiveChatMessages?.() || [];
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
        handler() {
            const messages = VP.chats?.getActiveChatMessages?.() || [];
            const now = Date.now();
            const timestamps = messages.map(m => m.timestamp || 0).filter(Boolean);
            const firstTs = timestamps.length ? Math.min(...timestamps) : null;
            const lastTs = timestamps.length ? Math.max(...timestamps) : null;

            const speaker = VP.chats?.getActiveSpeaker?.();
            const speakerName = speaker ? (VP.chats?.getParticipantDisplayName?.(speaker) || speaker.alias || 'Unknown') : null;

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
        handler(args) {
            const chats = VP.chats;
            if (!chats) return { ok: false, error: 'Chats module not available.' };

            const name = String(args.name || '').trim().toLowerCase();

            if (!name) {
                // Return active speaker
                const speaker = chats.getActiveSpeaker?.();
                if (!speaker) return { ok: true, note: 'No active speaker.', character: null };
                const profile = chats.getParticipantProfile?.(speaker);
                const displayName = chats.getParticipantDisplayName?.(speaker);
                return {
                    ok: true,
                    character: {
                        name: displayName || speaker.alias || 'Unknown',
                        description: profile?.description || '',
                        persona: profile?.systemPrompt || '',
                        isSpeaker: true,
                    },
                };
            }

            // Search profiles by name
            const profiles = chats.getProfilesStore?.()?.items || [];
            const match = profiles.find(p =>
                String(p.name || '').toLowerCase().includes(name)
            );
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
        handler(args) {
            const mood = String(args.mood || '').trim().toLowerCase();
            const who = String(args.who || '').trim().toLowerCase();
            if (!mood && !who) return { ok: false, error: 'Provide mood or who parameter' };

            const limit = Math.min(15, Math.max(1, parseInt(args.limit, 10) || 5));
            const gallery = VP.state?.gallery;
            if (!gallery || gallery.size === 0) {
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

            for (const [tag, asset] of gallery) {
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
        handler() {
            const chats = VP.chats;
            const speaker = chats?.getActiveSpeaker?.();
            const speakerName = speaker ? (chats?.getParticipantDisplayName?.(speaker) || speaker.alias || 'Unknown') : null;
            const profile = speaker ? chats?.getParticipantProfile?.(speaker) : null;
            
            const currentTag = VP.state?.current?.tag || null;
            const currentAsset = currentTag ? VP.state?.gallery?.get(currentTag) : null;
            
            const messages = chats?.getActiveChatMessages?.() || [];
            const recentMessages = messages.slice(-5).map(m => ({
                role: m.role,
                speaker: m.speakerId || null,
                text: String(m.raw || m.text || '').slice(0, 100),
            }));

            const chat = chats?.getActiveChat?.();
            const scenario = chat?.scenario?.enabled ? chat.scenario?.text?.slice(0, 200) : null;
            const participants = chat?.participants?.map(p => ({
                alias: chats?.getParticipantDisplayName?.(p) || p.alias,
                profile: p.profileId,
            })) || [];

            return {
                ok: true,
                currentFrame: currentTag ? {
                    tag: currentTag,
                    description: currentAsset?.description || '',
                } : null,
                activeSpeaker: speakerName,
                profileKind: profile?.meta?.kind || null,
                scenario,
                participants,
                recentMessages,
                totalMessages: messages.length,
            };
        },
    });

    console.log('[VP Core Tools] 7 tools registered: roll_dice, gallery_search, recall_scene, timeline_check, character_note, asset_suggest, scene_describe');

})();
