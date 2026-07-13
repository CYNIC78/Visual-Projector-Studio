// ╔══════════════════════════════════════════════════════════════════╗
// ║  projector-chats.js                                             ║
// ║  Visual Projector — chat/profile runtime store (v1 foundation)  ║
// ║                                                                  ║
// ║  Chat-centric model:                                             ║
// ║    Chat → messages, draft, projector snapshot, participants      ║
// ║    Profile → reusable persona / role template                    ║
// ║    Participant → profile inside a concrete chat                  ║
// ╚══════════════════════════════════════════════════════════════════╝

(function () {
    'use strict';

    const VP = window.VisualProjector;
    if (!VP || !VP.state) {
        console.error('[VP Chats] window.VisualProjector not found. Load visual-projector.js first.');
        return;
    }

    const S = VP.state;
    const DB = window.VP_DB;
    const LEGACY_SESSION_KEY = 'vp-session-v1';

    let _bootStarted = false;
    let _bootDone = false;
    let _resolveReady = null;
    let _rejectReady = null;
    let _profilesPersistTimer = null;
    let _chatPersistTimer = null;

    const ready = new Promise((resolve, reject) => {
        _resolveReady = resolve;
        _rejectReady = reject;
    });

    const uid = (prefix = 'id') => `${prefix}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 7)}`;
    const now = () => Date.now();
    const clone = (x) => JSON.parse(JSON.stringify(x));

    const BUILTIN_PROFILE_ID = 'prof_builtin_assistant';

    function ensureStores() {
        if (!S.profiles || typeof S.profiles !== 'object') S.profiles = { items: [] };
        if (!Array.isArray(S.profiles.items)) S.profiles.items = [];

        if (!S.chats || typeof S.chats !== 'object') S.chats = { activeChatId: null, items: [] };
        if (!Array.isArray(S.chats.items)) S.chats.items = [];
        if (!('activeChatId' in S.chats)) S.chats.activeChatId = null;
    }

    function builtinProfileTemplate() {
        const t = now();
        return {
            id: BUILTIN_PROFILE_ID,
            name: 'Assistant',
            avatar: null,
            color: '#6c5fa6',
            description: 'Default standalone assistant',
            systemPrompt: '',
            modelDefaults: {
                model: '',
                temperature: null,
                maxTokens: null,
                stream: null,
            },
            meta: {
                kind: 'character',
                builtin: true,
                createdAt: t,
                updatedAt: t,
            },
        };
    }

    function normalizeProfile(profile) {
        const t = now();
        return {
            id: profile?.id || uid('prof'),
            name: String(profile?.name || 'Profile').trim() || 'Profile',
            avatar: profile?.avatar ?? null,
            color: profile?.color || '#6c5fa6',
            description: String(profile?.description || ''),
            systemPrompt: String(profile?.systemPrompt || ''),
            modelDefaults: {
                model: profile?.modelDefaults?.model || '',
                temperature: profile?.modelDefaults?.temperature ?? null,
                maxTokens: profile?.modelDefaults?.maxTokens ?? null,
                stream: profile?.modelDefaults?.stream ?? null,
            },
            meta: {
                kind: profile?.meta?.kind || 'character',
                builtin: !!profile?.meta?.builtin,
                createdAt: profile?.meta?.createdAt || t,
                updatedAt: profile?.meta?.updatedAt || t,
            },
        };
    }

    function ensureBuiltinProfile() {
        let p = S.profiles.items.find(x => x.id === BUILTIN_PROFILE_ID);
        if (!p) {
            p = builtinProfileTemplate();
            S.profiles.items.unshift(p);
        }
        return p;
    }

    function normalizeParticipant(participant, fallbackProfileId = BUILTIN_PROFILE_ID) {
        return {
            id: participant?.id || uid('part'),
            profileId: participant?.profileId || fallbackProfileId,
            alias: participant?.alias ?? null,
            enabled: participant?.enabled !== false,
            promptPatch: String(participant?.promptPatch || ''),
            modelOverrides: {
                model: participant?.modelOverrides?.model ?? null,
                temperature: participant?.modelOverrides?.temperature ?? null,
                maxTokens: participant?.modelOverrides?.maxTokens ?? null,
                stream: participant?.modelOverrides?.stream ?? null,
            },
        };
    }

    function normalizeProjectorSnapshot(snapshot) {
        return {
            currentTag: snapshot?.currentTag || null,
            coverTag: snapshot?.coverTag || null,
            preparedTag: snapshot?.preparedTag || null,
            history: Array.isArray(snapshot?.history) ? snapshot.history.map(h => ({
                tag: h?.tag || null,
                filename: h?.filename || h?.tag || '',
                timestamp: h?.timestamp || now(),
                source: h?.source || 'user',
            })).filter(h => h.tag) : [],
            playbackMessages: Array.isArray(snapshot?.playbackMessages) ? snapshot.playbackMessages.map(m => ({
                id: m?.id || uid('play'),
                role: m?.role || 'assistant',
                text: String(m?.text || ''),
                timestamp: m?.timestamp || now(),
                frameTagAtStart: m?.frameTagAtStart ?? null,
                // Studio 2.0: Preserve tool call data in playback history
                tool_calls: m?.tool_calls || null,
                tool_results: m?.tool_results || null,
            })).filter(m => m.text.trim()) : [],
        };
    }

    function normalizeChatMessage(message, defaultSpeakerId = null) {
        const role = message?.role || 'assistant';
        return {
            id: message?.id || uid('msg'),
            role,
            speakerId: role === 'assistant' ? (message?.speakerId || defaultSpeakerId || null) : null,
            raw: String(message?.raw ?? message?.text ?? ''),
            clean: String(message?.clean ?? message?.raw ?? message?.text ?? ''),
            status: message?.status || 'done',
            createdAt: message?.createdAt || now(),
            // Studio 2.7: Preserve internal prompt for accurate Regeneration
            internalPrompt: message?.internalPrompt || null,
            // Studio 2.0: Critical - Preserve tool data in chat log history
            tool_calls: Array.isArray(message?.tool_calls) ? message.tool_calls : null,
            tool_results: Array.isArray(message?.tool_results) ? message.tool_results : null,
            // Attached context manifests
            manifests: Array.isArray(message?.manifests)
                ? message.manifests
                    .filter(x => x && String(x.text || '').trim())
                    .map(x => ({
                        id: x.id || uid('mnf'),
                        source: String(x.source || 'user'),
                        text: String(x.text),
                        ttl: Number.isFinite(+x.ttl) && +x.ttl > 0 ? Math.floor(+x.ttl) : null,
                        createdAt: x.createdAt || now(),
                    }))
                : [],
        };
    }

    function normalizeChat(chat) {
        const t = now();
        const fallbackProfile = ensureBuiltinProfile();
        const participants = Array.isArray(chat?.participants) && chat.participants.length
            ? chat.participants.map(p => normalizeParticipant(p, fallbackProfile.id))
            : [normalizeParticipant(null, fallbackProfile.id)];
        const activeSpeakerId = participants.some(p => p.id === chat?.activeSpeakerId)
            ? chat.activeSpeakerId
            : participants[0].id;

        return {
            id: chat?.id || uid('chat'),
            title: String(chat?.title || 'New chat').trim() || 'New chat',
            kind: chat?.kind || (participants.length > 1 ? 'group' : 'solo'),
            participants,
            activeSpeakerId,
            messages: Array.isArray(chat?.messages)
                ? chat.messages.map(m => normalizeChatMessage(m, activeSpeakerId))
                : [],
            note: String(chat?.note || ''),
            scenario: {
                enabled: chat?.scenario?.enabled !== false,
                title: String(chat?.scenario?.title || '').trim(),
                text: String(chat?.scenario?.text || '').trim(),
            },
            projector: normalizeProjectorSnapshot(chat?.projector || {}),
            ui: {
                draft: String(chat?.ui?.draft || ''),
                pinnedParticipantIds: Array.isArray(chat?.ui?.pinnedParticipantIds) ? [...chat.ui.pinnedParticipantIds] : [],
            },
            meta: {
                createdAt: chat?.meta?.createdAt || t,
                updatedAt: chat?.meta?.updatedAt || t,
                lastMessageAt: chat?.meta?.lastMessageAt || t,
            },
        };
    }

    function normalizeStores() {
        ensureStores();
        S.profiles.items = S.profiles.items.map(normalizeProfile);
        ensureBuiltinProfile();
        S.chats.items = S.chats.items.map(normalizeChat);
        if (!S.chats.items.length) {
            const builtin = ensureBuiltinProfile();
            S.chats.items.push(createEmptyChatFromProfile(builtin.id, 'Main chat'));
        }
        if (!S.chats.items.some(c => c.id === S.chats.activeChatId)) {
            S.chats.activeChatId = S.chats.items[0]?.id || null;
        }
    }

    function touchChatMeta(chat, { bumpLastMessageAt = false } = {}) {
        if (!chat) return;
        const t = now();
        chat.meta = chat.meta || {};
        if (!chat.meta.createdAt) chat.meta.createdAt = t;
        chat.meta.updatedAt = t;
        if (bumpLastMessageAt) chat.meta.lastMessageAt = t;
        else if (!chat.meta.lastMessageAt) chat.meta.lastMessageAt = t;
    }

    async function persistProfilesNow() {
        if (DB?.setProfiles) await DB.setProfiles({ items: clone(S.profiles.items) });
    }

    function schedulePersistProfiles() {
        clearTimeout(_profilesPersistTimer);
        _profilesPersistTimer = setTimeout(() => {
            persistProfilesNow().catch(err => console.warn('[VP Chats] Failed to persist profiles:', err));
        }, 3000);
    }

    async function persistChatStoreNow() {
        if (DB?.setChatStore) {
            await DB.setChatStore({
                activeChatId: S.chats.activeChatId,
                items: clone(S.chats.items),
            });
        }
    }

    function schedulePersistChatStore() {
        clearTimeout(_chatPersistTimer);
        _chatPersistTimer = setTimeout(() => {
            persistChatStoreNow().catch(err => console.warn('[VP Chats] Failed to persist chat store:', err));
        }, 3000);
    }

    function getProfileById(profileId) {
        ensureStores();
        return S.profiles.items.find(p => p.id === profileId) || null;
    }

    function getChatById(chatId) {
        ensureStores();
        return S.chats.items.find(c => c.id === chatId) || null;
    }

    function getActiveChat() {
        ensureStores();
        return getChatById(S.chats.activeChatId) || null;
    }

    function getActiveParticipants() {
        return getActiveChat()?.participants || [];
    }

    function getActiveSpeaker() {
        const chat = getActiveChat();
        if (!chat) return null;
        return chat.participants.find(p => p.id === chat.activeSpeakerId) || chat.participants[0] || null;
    }

    function getActiveChatMessages() {
        return getActiveChat()?.messages || [];
    }

    function getActiveChatDraft() {
        return getActiveChat()?.ui?.draft || '';
    }

    function setActiveChatDraft(draft) {
        const chat = getActiveChat();
        if (!chat) return false;
        if (!chat.ui) chat.ui = { draft: '', pinnedParticipantIds: [] };
        chat.ui.draft = String(draft || '');
        touchChatMeta(chat);
        schedulePersistChatStore();
        return true;
    }

    function setActiveChatMessages(messages) {
        const chat = getActiveChat();
        if (!chat) return [];
        chat.messages = (messages || []).map(m => normalizeChatMessage(m, chat.activeSpeakerId));
        touchChatMeta(chat, { bumpLastMessageAt: chat.messages.length > 0 });
        schedulePersistChatStore();
        return chat.messages;
    }

    function addActiveChatMessage(message) {
        const chat = getActiveChat();
        if (!chat) return null;
        const normalized = normalizeChatMessage(message, chat.activeSpeakerId);
        chat.messages.push(normalized);
        touchChatMeta(chat, { bumpLastMessageAt: true });
        schedulePersistChatStore();
        return normalized;
    }

    function updateActiveChatMessage(id, patch) {
        const chat = getActiveChat();
        if (!chat) return null;
        const msg = chat.messages.find(m => m.id === id);
        if (!msg) return null;
        Object.assign(msg, patch || {});
        if ('raw' in (patch || {}) && !('clean' in (patch || {}))) msg.clean = msg.raw;
        touchChatMeta(chat, { bumpLastMessageAt: true });
        schedulePersistChatStore();
        return msg;
    }

    function deleteActiveChatMessage(id) {
        const chat = getActiveChat();
        if (!chat) return false;
        const before = chat.messages.length;
        chat.messages = chat.messages.filter(m => m.id !== id);
        if (chat.messages.length !== before) {
            touchChatMeta(chat, { bumpLastMessageAt: true });
            schedulePersistChatStore();
            return true;
        }
        return false;
    }

    function createEmptyChatFromProfile(profileId, title = null) {
        const profile = getProfileById(profileId) || ensureBuiltinProfile();
        const participant = normalizeParticipant({ profileId: profile.id }, profile.id);
        const t = now();
        return normalizeChat({
            id: uid('chat'),
            title: title || profile.name || 'New chat',
            kind: 'solo',
            participants: [participant],
            activeSpeakerId: participant.id,
            messages: [],
            note: '',
            projector: {
                currentTag: null,
                coverTag: null,
                preparedTag: null,
                history: [],
                playbackMessages: [],
            },
            ui: { draft: '', pinnedParticipantIds: [] },
            meta: { createdAt: t, updatedAt: t, lastMessageAt: t },
        });
    }

    function buildLegacyDefaultChat(profileId, legacySession, legacyProjector) {
        const chat = createEmptyChatFromProfile(profileId, 'Main chat');
        const activeSpeakerId = chat.activeSpeakerId;
        const legacyMessages = Array.isArray(legacySession?.messages) ? legacySession.messages : [];
        chat.messages = legacyMessages.map(m => normalizeChatMessage({
            ...m,
            speakerId: m?.role === 'assistant' ? (m?.speakerId || activeSpeakerId) : null,
        }, activeSpeakerId));
        chat.ui.draft = String(legacySession?.draft || '');
        chat.projector = normalizeProjectorSnapshot(legacyProjector || {});
        touchChatMeta(chat, { bumpLastMessageAt: chat.messages.length > 0 });
        return chat;
    }

    async function loadLegacySessionState() {
        let saved = null;
        if (DB?.getSessionState) {
            try { saved = await DB.getSessionState(); } catch {}
        }
        if (!saved) {
            try { saved = JSON.parse(localStorage.getItem(LEGACY_SESSION_KEY) || 'null'); } catch {}
        }
        return saved;
    }

    async function loadLegacyProjectorState() {
        const snapshot = normalizeProjectorSnapshot((DB?.getProjectorState ? await DB.getProjectorState() : null) || {});
        if (DB?.getCurrentTag) snapshot.currentTag = await DB.getCurrentTag() || snapshot.currentTag || null;
        if (DB?.getCoverTag) snapshot.coverTag = await DB.getCoverTag() || snapshot.coverTag || null;
        if (DB?.getPreparedTag) snapshot.preparedTag = await DB.getPreparedTag() || snapshot.preparedTag || null;
        return snapshot;
    }

    function createProfile(data = {}) {
        ensureStores();
        const profile = normalizeProfile({
            ...data,
            id: data.id || uid('prof'),
            meta: {
                kind: data.meta?.kind || data.kind || 'character',
                builtin: !!data.meta?.builtin,
                createdAt: data.meta?.createdAt || now(),
                updatedAt: now(),
            },
        });
        S.profiles.items.push(profile);
        schedulePersistProfiles();
        return profile;
    }

    function updateProfile(profileId, patch = {}) {
        const profile = getProfileById(profileId);
        if (!profile) return null;
        Object.assign(profile, normalizeProfile({ ...profile, ...patch }));
        profile.meta.updatedAt = now();
        schedulePersistProfiles();
        return profile;
    }

    function detachProfileFromChats(profileId) {
        ensureStores();
        const builtin = ensureBuiltinProfile();
        const related = getChatsForProfile(profileId);
        if (!related.length) return { touchedChats: 0, deletedChats: 0, removedParticipants: 0 };

        let touchedChats = 0;
        let deletedChats = 0;
        let removedParticipants = 0;
        const deleteChatIds = new Set();

        for (const chat of related) {
            const matching = (chat.participants || []).filter(p => p.profileId === profileId);
            if (!matching.length) continue;
            const matchingIds = new Set(matching.map(p => p.id));

            // A chat cannot exist without participants. If every participant uses
            // this profile, deleting the profile deletes that solo/single-profile chat.
            if ((chat.participants || []).length <= matching.length) {
                deleteChatIds.add(chat.id);
                deletedChats++;
                removedParticipants += matching.length;
                continue;
            }

            chat.participants = chat.participants.filter(p => p.profileId !== profileId);
            removedParticipants += matching.length;
            if (!chat.participants.some(p => p.id === chat.activeSpeakerId)) {
                chat.activeSpeakerId = chat.participants[0]?.id || null;
            }
            chat.messages = (chat.messages || []).map(m => {
                if (m.role === 'assistant' && matchingIds.has(m.speakerId)) {
                    return { ...m, speakerId: chat.activeSpeakerId || null };
                }
                return m;
            });
            chat.ui = chat.ui || { draft: '', pinnedParticipantIds: [] };
            if (Array.isArray(chat.ui.pinnedParticipantIds)) {
                chat.ui.pinnedParticipantIds = chat.ui.pinnedParticipantIds.filter(id => !matchingIds.has(id));
            }
            chat.kind = chat.participants.length > 1 ? 'group' : 'solo';
            touchChatMeta(chat);
            touchedChats++;
        }

        if (deleteChatIds.size) {
            S.chats.items = S.chats.items.filter(chat => !deleteChatIds.has(chat.id));
            if (!S.chats.items.length) {
                S.chats.items.push(createEmptyChatFromProfile(builtin.id, 'Main chat'));
            }
            if (!S.chats.items.some(c => c.id === S.chats.activeChatId)) {
                S.chats.activeChatId = S.chats.items[0]?.id || null;
                applyActiveChatProjectorToRuntime();
            }
        }

        schedulePersistChatStore();
        return { touchedChats, deletedChats, removedParticipants };
    }

    function deleteProfile(profileId) {
        if (profileId === BUILTIN_PROFILE_ID) return false;
        const inUse = S.chats.items.some(chat => chat.participants.some(p => p.profileId === profileId));
        if (inUse) return false;
        const before = S.profiles.items.length;
        S.profiles.items = S.profiles.items.filter(p => p.id !== profileId);
        if (S.profiles.items.length !== before) {
            schedulePersistProfiles();
            return true;
        }
        return false;
    }

    function createChatFromProfile(profileId, opts = {}) {
        const profile = getProfileById(profileId) || ensureBuiltinProfile();
        const chat = createEmptyChatFromProfile(profile.id, opts.title || profile.name || 'New chat');
        S.chats.items.unshift(chat);
        if (opts.activate !== false) {
            S.chats.activeChatId = chat.id;
            if (S.gallery?.size) VP.applyProjectorSnapshot?.(chat.projector);
        }
        schedulePersistChatStore();
        return chat;
    }

    function duplicateChat(chatId, opts = {}) {
        const src = getChatById(chatId);
        if (!src) return null;

        const participantIdMap = new Map();
        const participants = src.participants.map(p => {
            const id = uid('part');
            participantIdMap.set(p.id, id);
            return normalizeParticipant({ ...clone(p), id }, p.profileId);
        });
        const activeSpeakerId = participantIdMap.get(src.activeSpeakerId) || participants[0]?.id || null;
        const duplicate = normalizeChat({
            ...clone(src),
            id: uid('chat'),
            title: `${src.title} (copy)`,
            participants,
            activeSpeakerId,
            messages: src.messages.map(m => ({
                ...clone(m),
                id: uid('msg'),
                speakerId: m.role === 'assistant' ? (participantIdMap.get(m.speakerId) || activeSpeakerId) : null,
            })),
            projector: {
                ...clone(src.projector),
                playbackMessages: (src.projector?.playbackMessages || []).map(m => ({ ...clone(m), id: uid('play') })),
            },
            meta: {
                createdAt: now(),
                updatedAt: now(),
                lastMessageAt: now(),
            },
        });

        S.chats.items.unshift(duplicate);
        if (opts.activate !== false) S.chats.activeChatId = duplicate.id;
        schedulePersistChatStore();
        return duplicate;
    }

    function renameChat(chatId, title) {
        const chat = getChatById(chatId);
        if (!chat) return false;
        const trimmed = String(title || '').trim();
        if (!trimmed) return false;
        chat.title = trimmed;
        touchChatMeta(chat);
        schedulePersistChatStore();
        return true;
    }

    function syncProjectorFromRuntime() {
        const chat = getActiveChat();
        if (!chat || !VP.getProjectorSnapshot) return false;
        chat.projector = normalizeProjectorSnapshot(VP.getProjectorSnapshot());
        touchChatMeta(chat);
        schedulePersistChatStore();
        return true;
    }

    function applyActiveChatProjectorToRuntime() {
        const chat = getActiveChat();
        if (!chat || !VP.applyProjectorSnapshot || !(S.gallery?.size > 0)) return false;
        const applied = !!VP.applyProjectorSnapshot(chat.projector);
        if (applied) VP.persistProjectorState?.();
        return applied;
    }

    function setActiveChat(chatId, opts = {}) {
        const next = getChatById(chatId);
        if (!next) return false;
        const prev = getActiveChat();
        if (prev && prev.id !== next.id && opts.syncProjector !== false) syncProjectorFromRuntime();
        S.chats.activeChatId = next.id;
        if (opts.applyProjector !== false) applyActiveChatProjectorToRuntime();
        schedulePersistChatStore();
        return true;
    }

    function setActiveSpeaker(participantId, chatId = null) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return false;
        if (!chat.participants.some(p => p.id === participantId)) return false;
        chat.activeSpeakerId = participantId;
        touchChatMeta(chat);
        schedulePersistChatStore();
        return true;
    }

    function addParticipantToChat(profileId, chatId = null, opts = {}) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        const profile = getProfileById(profileId);
        if (!chat || !profile) return null;

        const existing = chat.participants.find(p => p.profileId === profile.id);
        if (existing) {
            if (opts.activate !== false) setActiveSpeaker(existing.id, chat.id);
            return existing;
        }

        const participant = normalizeParticipant({ profileId: profile.id }, profile.id);
        chat.participants.push(participant);
        chat.kind = chat.participants.length > 1 ? 'group' : 'solo';
        if (opts.activate !== false) chat.activeSpeakerId = participant.id;
        touchChatMeta(chat);
        schedulePersistChatStore();
        return participant;
    }

    function removeParticipantFromChat(participantId, chatId = null) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return false;
        if ((chat.participants?.length || 0) <= 1) return false;
        const idx = chat.participants.findIndex(p => p.id === participantId);
        if (idx === -1) return false;
        chat.participants.splice(idx, 1);
        if (!chat.participants.some(p => p.id === chat.activeSpeakerId)) {
            chat.activeSpeakerId = chat.participants[0]?.id || null;
        }
        chat.messages = chat.messages.map(m => {
            if (m.role === 'assistant' && m.speakerId === participantId) {
                return { ...m, speakerId: chat.activeSpeakerId || null };
            }
            return m;
        });
        chat.kind = chat.participants.length > 1 ? 'group' : 'solo';
        touchChatMeta(chat);
        schedulePersistChatStore();
        return true;
    }

    function deleteChat(chatId) {
        const idx = S.chats.items.findIndex(c => c.id === chatId);
        if (idx === -1) return false;
        S.chats.items.splice(idx, 1);
        if (!S.chats.items.length) {
            const builtin = ensureBuiltinProfile();
            S.chats.items.push(createEmptyChatFromProfile(builtin.id, 'Main chat'));
        }
        if (!S.chats.items.some(c => c.id === S.chats.activeChatId)) {
            S.chats.activeChatId = S.chats.items[0].id;
            applyActiveChatProjectorToRuntime();
        }
        schedulePersistChatStore();
        return true;
    }

    function getPrimaryParticipant(chat) {
        return chat?.participants?.[0] || null;
    }

    function getPrimaryProfile(chat) {
        const participant = getPrimaryParticipant(chat);
        return participant ? getProfileById(participant.profileId) : null;
    }

    function getParticipantById(participantId, chat = null) {
        const scope = chat || getActiveChat();
        return scope?.participants?.find(p => p.id === participantId) || null;
    }

    function getParticipantProfile(participant, chat = null) {
        const p = participant && typeof participant === 'object' ? participant : getParticipantById(participant, chat);
        return p ? getProfileById(p.profileId) : null;
    }

    function getParticipantDisplayName(participant, chat = null) {
        const p = participant && typeof participant === 'object' ? participant : getParticipantById(participant, chat);
        const profile = getParticipantProfile(p, chat);
        return p?.alias || profile?.name || 'Assistant';
    }

    function safeProfileColor(profile, fallback = '#6c5fa6') {
        const c = String(profile?.color || '').trim();
        return /^#[0-9a-fA-F]{6}$/.test(c) ? c : fallback;
    }

    function createAvatarNode({ profile = null, label = '', className = '', active = false, overflow = null } = {}) {
        const el = document.createElement('div');
        el.className = `vp-chat-avatar ${className || ''}${active ? ' active' : ''}${overflow !== null ? ' overflow' : ''}`.trim();
        const name = String(label || profile?.name || 'A').trim() || 'A';
        const color = safeProfileColor(profile);
        el.style.background = color;
        el.style.borderColor = color;
        el.title = overflow !== null ? `+${overflow} more` : name;
        if (overflow !== null) {
            el.textContent = `+${overflow}`;
            return el;
        }
        if (profile?.avatar) {
            const img = document.createElement('img');
            img.src = profile.avatar;
            img.alt = name;
            el.appendChild(img);
        } else {
            el.textContent = name.slice(0, 1).toUpperCase();
        }
        return el;
    }

    function renderChatAvatarStack(host, chat) {
        if (!host || !chat) return;
        host.innerHTML = '';
        const participants = Array.isArray(chat.participants) ? chat.participants : [];
        const maxVisible = 3;
        const visible = participants.slice(0, maxVisible);
        visible.forEach((participant, index) => {
            const profile = getParticipantProfile(participant, chat);
            const label = getParticipantDisplayName(participant, chat);
            const node = createAvatarNode({
                profile,
                label,
                className: 'stacked',
                active: participant.id === chat.activeSpeakerId,
            });
            node.style.zIndex = String(20 - index);
            host.appendChild(node);
        });
        if (participants.length > maxVisible) {
            const node = createAvatarNode({ overflow: participants.length - maxVisible, className: 'stacked' });
            node.style.zIndex = '1';
            host.appendChild(node);
        }
    }

    function getChatsForProfile(profileId) {
        return (S.chats.items || []).filter(chat => chat.participants?.some(p => p.profileId === profileId));
    }

    function getLatestChatForProfile(profileId) {
        return getChatsForProfile(profileId).sort((a, b) => (b.meta?.updatedAt || 0) - (a.meta?.updatedAt || 0))[0] || null;
    }

    function getChatDisplayTitle(chat) {
        return String(chat?.title || getPrimaryProfile(chat)?.name || 'Chat').trim() || 'Chat';
    }

    function getChatSubtitle(chat) {
        const profile = getPrimaryProfile(chat);
        const count = Array.isArray(chat?.messages) ? chat.messages.length : 0;
        const draft = chat?.ui?.draft ? ' · draft' : '';
        const scenario = chat?.scenario?.enabled && chat.scenario?.text?.trim() ? ' · 🎬' : '';
        return `${profile?.name || 'Assistant'} · ${count} msg${count === 1 ? '' : 's'}${draft}${scenario}`;
    }

    function notifyChatUiChanged() {
        VP.updateProjectorUI?.();
        VP.gallery?.refreshGalleryPanelUI?.();
        if (VP.shell?.closeShellModals) VP.shell.closeShellModals();
        if (VP.shell?.render) VP.shell.render();
    }

    function setActiveSpeakerInteractive(participantId, chatId = null) {
        const ok = setActiveSpeaker(participantId, chatId);
        if (ok) {
            notifyChatUiChanged();
            const name = getParticipantDisplayName(participantId, getChatById(chatId || S.chats.activeChatId));
            VP.showToast?.(`Speaker: ${name}`, 'success');
        }
        return ok;
    }

    function addParticipantToCurrentChatInteractive(profileId) {
        const chat = getActiveChat();
        const profile = getProfileById(profileId);
        if (!chat || !profile) return null;
        const existing = chat.participants.find(p => p.profileId === profile.id);
        const participant = addParticipantToChat(profile.id, chat.id, { activate: true });
        notifyChatUiChanged();
        if (existing) VP.showToast?.(`Already in chat: ${profile.name}`, 'info');
        else VP.showToast?.(`Added to chat: ${profile.name}`, 'success');
        return participant;
    }

    function removeParticipantFromCurrentChatInteractive(participantId) {
        const chat = getActiveChat();
        if (!chat) return false;
        if ((chat.participants?.length || 0) <= 1) {
            VP.showToast?.('Chat must keep at least one participant', 'error');
            return false;
        }
        const name = getParticipantDisplayName(participantId, chat);
        const ok = removeParticipantFromChat(participantId, chat.id);
        if (ok) {
            notifyChatUiChanged();
            VP.showToast?.(`Removed from chat: ${name}`, 'success');
        }
        return ok;
    }

    function activateChat(chatId) {
        const changed = setActiveChat(chatId);
        if (changed) notifyChatUiChanged();
        return changed;
    }

    async function createChatInteractive(profileId = null) {
        const baseProfile = getProfileById(profileId) || getPrimaryProfile(getActiveChat()) || ensureBuiltinProfile();
        const proposed = baseProfile?.name || 'New chat';
        const title = await VP.showPrompt?.({
            title: 'New chat',
            message: 'Название нового чата:',
            value: proposed,
            placeholder: 'Chat title',
            confirmLabel: 'Create',
        });
        if (title === null || title === undefined) return null;
        const chat = createChatFromProfile(baseProfile.id, { title: String(title).trim() || proposed, activate: true });
        notifyChatUiChanged();
        VP.showToast?.(`New chat: ${chat.title}`, 'success');
        return chat;
    }

    function duplicateActiveChatInteractive(chatId = null) {
        const source = getChatById(chatId || S.chats.activeChatId);
        if (!source) return null;
        const copy = duplicateChat(source.id, { activate: true });
        notifyChatUiChanged();
        VP.showToast?.(`Chat duplicated: ${copy.title}`, 'success');
        return copy;
    }

    async function renameChatInteractive(chatId = null) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return false;
        const title = await VP.showPrompt?.({
            title: 'Rename chat',
            message: 'Новое название чата:',
            value: getChatDisplayTitle(chat),
            placeholder: 'Chat title',
            confirmLabel: 'Save',
            required: true,
        });
        if (title === null || title === undefined) return false;
        const ok = renameChat(chat.id, title);
        if (ok) {
            notifyChatUiChanged();
            VP.showToast?.('Chat renamed', 'success');
        }
        return ok;
    }

    async function deleteChatInteractive(chatId = null) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return false;
        const ans = await VP.showConfirm?.({
            title: 'Delete chat?',
            message: `Удалить чат «${getChatDisplayTitle(chat)}»?`,
            buttons: [
                { id: 'cancel', label: 'Cancel', ghost: true },
                { id: 'ok', label: 'Delete', danger: true },
            ],
        });
        if (ans !== 'ok') return false;
        const ok = deleteChat(chat.id);
        if (ok) {
            notifyChatUiChanged();
            VP.showToast?.('Chat deleted', 'success');
        }
        return ok;
    }

    function closeProfileEditorModal() {
        document.querySelectorAll('.vp-chat-profile-modal').forEach(el => el.remove());
        document.removeEventListener('keydown', onProfileModalEsc, true);
    }

    function onProfileModalEsc(e) {
        if (e.key === 'Escape') closeProfileEditorModal();
    }

    function openProfileEditorModal({ profileId = null, onSaved = null } = {}) {
        injectChatPanelStyles();
        closeProfileEditorModal();

        const existing = profileId ? getProfileById(profileId) : null;
        const isEdit = !!existing;
        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop global vp-chat-profile-modal';
        backdrop.style.setProperty('--vp-modal-width', '560px');

        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card vp-chat-profile-editor-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">${isEdit ? '👤 Edit Profile' : '👤 New Profile'}</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-chat-profile-form">
                    <div class="vp-chat-avatar-editor">
                        <div class="vp-chat-avatar-preview" data-role="avatar-preview"></div>
                        <div class="vp-chat-avatar-tools">
                            <div class="vp-chat-avatar-title">Avatar</div>
                            <div class="vp-chat-avatar-note">UI-only profile picture. Stored inside this world's <code>profiles.json</code>.</div>
                            <div class="vp-chat-profile-actions" style="justify-content:flex-start;padding-top:0;">
                                <button class="vp-btn vp-btn-ghost" data-act="avatar-upload" type="button">Upload</button>
                                <button class="vp-btn vp-btn-ghost" data-act="avatar-clear" type="button">Clear</button>
                            </div>
                            <input data-k="avatarFile" type="file" accept="image/*" style="display:none">
                        </div>
                    </div>
                    <label><span>Name</span><input data-k="name" type="text" placeholder="Profile name"></label>
                    <label><span>Description</span><input data-k="description" type="text" placeholder="Short profile description"></label>
                    <label><span>Kind</span>
                        <select data-k="kind">
                            <option value="character">Character</option>
                            <option value="narrator">Narrator</option>
                            <option value="gm">GM</option>
                            <option value="utility">Utility</option>
                        </select>
                    </label>
                    <label><span>Color</span>
                        <div class="vp-chat-profile-color-row">
                            <input data-k="colorPicker" type="color" title="Pick profile color">
                            <input data-k="color" type="text" placeholder="#6c5fa6" spellcheck="false">
                            <div class="vp-chat-profile-color-presets" data-role="color-presets"></div>
                        </div>
                    </label>
                    <label><span>Model</span><input data-k="model" type="text" placeholder="optional model override"></label>
                    <label><span>Temperature</span><input data-k="temperature" type="number" min="0" max="2" step="0.05" placeholder="optional"></label>
                    <label><span>Max tokens</span><input data-k="maxTokens" type="number" min="1" step="1" placeholder="optional"></label>
                    <label class="vp-chat-profile-check"><span>Stream</span><input data-k="stream" type="checkbox"></label>
                    <label class="vp-chat-profile-block"><span>System prompt</span><textarea data-k="systemPrompt" placeholder="Main system prompt for this profile. Supports {{char}} and {{user}}."></textarea></label>
                    <div class="vp-chat-profile-actions">
                        <button class="vp-btn vp-btn-ghost" data-act="cancel">Cancel</button>
                        <button class="vp-btn" data-act="save">${isEdit ? 'Save profile' : 'Create profile'}</button>
                    </div>
                </div>
            </div>`;

        backdrop.appendChild(card);
        document.body.appendChild(backdrop);

        const close = () => closeProfileEditorModal();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        card.querySelector('[data-act="cancel"]').addEventListener('click', close);
        setTimeout(() => document.addEventListener('keydown', onProfileModalEsc, true), 0);

        // Make profile editor modal draggable via its header
        const head = card.querySelector('.vp-shell-modal-head');
        let isDragging = false, startX, startY, startLeft, startTop;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.vp-shell-modal-close') || e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = card.getBoundingClientRect();
            const backdropRect = backdrop.getBoundingClientRect();
            startLeft = rect.left - backdropRect.left;
            startTop = rect.top - backdropRect.top;
            card.style.margin = '0';
            card.style.position = 'absolute';
            card.style.left = `${startLeft}px`;
            card.style.top = `${startTop}px`;
            e.preventDefault();

            const onMouseMove = (ev) => {
                if (!isDragging) return;
                card.style.left = `${startLeft + (ev.clientX - startX)}px`;
                card.style.top = `${startTop + (ev.clientY - startY)}px`;
            };
            const onMouseUp = () => {
                isDragging = false;
                document.removeEventListener('mousemove', onMouseMove);
                document.removeEventListener('mouseup', onMouseUp);
            };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        const fields = {
            name: card.querySelector('[data-k="name"]'),
            description: card.querySelector('[data-k="description"]'),
            kind: card.querySelector('[data-k="kind"]'),
            color: card.querySelector('[data-k="color"]'),
            colorPicker: card.querySelector('[data-k="colorPicker"]'),
            colorPresets: card.querySelector('[data-role="color-presets"]'),
            model: card.querySelector('[data-k="model"]'),
            temperature: card.querySelector('[data-k="temperature"]'),
            maxTokens: card.querySelector('[data-k="maxTokens"]'),
            stream: card.querySelector('[data-k="stream"]'),
            systemPrompt: card.querySelector('[data-k="systemPrompt"]'),
            avatarFile: card.querySelector('[data-k="avatarFile"]'),
            avatarPreview: card.querySelector('[data-role="avatar-preview"]'),
        };

        const normalizeHexColor = (value, fallback = '#6c5fa6') => {
            let v = String(value || '').trim();
            if (!v) return fallback;
            if (!v.startsWith('#')) v = '#' + v;
            if (/^#[0-9a-fA-F]{3}$/.test(v)) {
                v = '#' + v.slice(1).split('').map(ch => ch + ch).join('');
            }
            return /^#[0-9a-fA-F]{6}$/.test(v) ? v.toLowerCase() : fallback;
        };

        const setProfileColor = (value, { updatePreview = true } = {}) => {
            const color = normalizeHexColor(value, '#6c5fa6');
            fields.color.value = color;
            if (fields.colorPicker) fields.colorPicker.value = color;
            if (updatePreview) updateAvatarPreview();
            return color;
        };

        const colorPresets = ['#6c5fa6', '#89b4fa', '#74c7ec', '#94e2d5', '#a6e3a1', '#f9e2af', '#fab387', '#f38ba8', '#cba6f7', '#eba0ac'];
        if (fields.colorPresets) {
            fields.colorPresets.innerHTML = '';
            for (const color of colorPresets) {
                const btn = document.createElement('button');
                btn.type = 'button';
                btn.className = 'vp-chat-color-swatch';
                btn.style.background = color;
                btn.title = color;
                btn.addEventListener('click', () => setProfileColor(color));
                fields.colorPresets.appendChild(btn);
            }
        }

        fields.name.value = existing?.name || '';
        fields.description.value = existing?.description || '';
        fields.kind.value = existing?.meta?.kind || 'character';
        setProfileColor(existing?.color || '#6c5fa6', { updatePreview: false });
        fields.model.value = existing?.modelDefaults?.model || '';
        fields.temperature.value = existing?.modelDefaults?.temperature ?? '';
        fields.maxTokens.value = existing?.modelDefaults?.maxTokens ?? '';
        fields.stream.checked = existing?.modelDefaults?.stream === true;
        fields.systemPrompt.value = existing?.systemPrompt || '';

        let avatarValue = existing?.avatar || null;
        const updateAvatarPreview = () => {
            const preview = fields.avatarPreview;
            if (!preview) return;
            preview.innerHTML = '';
            preview.style.background = normalizeHexColor(fields.color.value, '#6c5fa6');
            if (avatarValue) {
                const img = document.createElement('img');
                img.src = avatarValue;
                img.alt = fields.name.value || existing?.name || 'Avatar';
                preview.appendChild(img);
            } else {
                preview.textContent = (fields.name.value || existing?.name || 'P').slice(0, 1).toUpperCase();
            }
        };
        const imageFileToAvatar = (file) => new Promise((resolve, reject) => {
            const reader = new FileReader();
            reader.onload = () => {
                const img = new Image();
                img.onload = () => {
                    const size = 256;
                    const canvas = document.createElement('canvas');
                    canvas.width = size;
                    canvas.height = size;
                    const ctx = canvas.getContext('2d');
                    const min = Math.min(img.width, img.height);
                    const sx = Math.max(0, (img.width - min) / 2);
                    const sy = Math.max(0, (img.height - min) / 2);
                    ctx.fillStyle = '#1e1e2e';
                    ctx.fillRect(0, 0, size, size);
                    ctx.drawImage(img, sx, sy, min, min, 0, 0, size, size);
                    resolve(canvas.toDataURL('image/jpeg', 0.82));
                };
                img.onerror = reject;
                img.src = reader.result;
            };
            reader.onerror = reject;
            reader.readAsDataURL(file);
        });
        card.querySelector('[data-act="avatar-upload"]').addEventListener('click', () => fields.avatarFile?.click());
        card.querySelector('[data-act="avatar-clear"]').addEventListener('click', () => { avatarValue = null; updateAvatarPreview(); });
        fields.avatarFile?.addEventListener('change', async () => {
            const file = fields.avatarFile.files?.[0];
            if (!file) return;
            try {
                avatarValue = await imageFileToAvatar(file);
                updateAvatarPreview();
            } catch (err) {
                console.error('[VP Chats] avatar load failed:', err);
                VP.showToast?.('Avatar load failed', 'error');
            }
        });
        fields.name.addEventListener('input', updateAvatarPreview);
        fields.color.addEventListener('input', () => {
            const raw = fields.color.value.trim();
            if (/^#?[0-9a-fA-F]{3}$/.test(raw) || /^#?[0-9a-fA-F]{6}$/.test(raw)) {
                setProfileColor(raw);
            }
        });
        fields.color.addEventListener('change', () => setProfileColor(fields.color.value));
        fields.colorPicker?.addEventListener('input', () => setProfileColor(fields.colorPicker.value));
        updateAvatarPreview();

        card.querySelector('[data-act="save"]').addEventListener('click', () => {
            const payload = {
                name: String(fields.name.value || '').trim() || (existing?.name || 'Profile'),
                description: String(fields.description.value || ''),
                color: normalizeHexColor(fields.color.value, '#6c5fa6'),
                avatar: avatarValue || null,
                systemPrompt: String(fields.systemPrompt.value || ''),
                meta: {
                    kind: fields.kind.value || 'character',
                    builtin: !!existing?.meta?.builtin,
                    createdAt: existing?.meta?.createdAt || now(),
                    updatedAt: now(),
                },
                modelDefaults: {
                    model: String(fields.model.value || ''),
                    temperature: fields.temperature.value === '' ? null : Number(fields.temperature.value),
                    maxTokens: fields.maxTokens.value === '' ? null : parseInt(fields.maxTokens.value, 10),
                    stream: fields.stream.checked,
                },
            };

            const profile = isEdit ? updateProfile(existing.id, payload) : createProfile(payload);
            if (!profile) {
                VP.showToast?.('Failed to save profile', 'error');
                return;
            }
            notifyChatUiChanged();
            VP.showToast?.(isEdit ? 'Profile updated' : `Profile created: ${profile.name}`, 'success');
            close();
            if (typeof onSaved === 'function') onSaved(profile);
        });

        requestAnimationFrame(() => fields.name.focus());
    }

    function createProfileInteractive(opts = {}) {
        openProfileEditorModal({ profileId: null, onSaved: opts.onSaved || null });
        return null;
    }

    function editProfileInteractive(profileId) {
        const profile = getProfileById(profileId);
        if (!profile) return null;
        openProfileEditorModal({ profileId: profile.id });
        return null;
    }

    async function deleteProfileInteractive(profileId) {
        const profile = getProfileById(profileId);
        if (!profile) return false;
        if (profile.id === BUILTIN_PROFILE_ID) {
            VP.showToast?.('Built-in Assistant profile cannot be deleted', 'info');
            return false;
        }
        const relatedChats = getChatsForProfile(profile.id);
        if (relatedChats.length > 0) {
            const singleProfileChats = relatedChats.filter(chat =>
                (chat.participants || []).every(p => p.profileId === profile.id)
            );
            const groupTouched = relatedChats.length - singleProfileChats.length;
            const lines = [
                `Профиль «${profile.name}» используется в ${relatedChats.length} chat${relatedChats.length === 1 ? '' : 's'}.`,
                '',
                'Удалить профиль и убрать его из всех чатов?',
            ];
            if (groupTouched > 0) lines.push(`• Из групповых чатов профиль будет удалён как участник: ${groupTouched}.`);
            if (singleProfileChats.length > 0) lines.push(`• Чаты, где это единственный профиль, будут удалены: ${singleProfileChats.length}.`);
            const ans = await VP.showConfirm?.({
                title: 'Delete profile from chats?',
                message: lines.join('\n'),
                buttons: [
                    { id: 'cancel', label: 'Cancel', ghost: true },
                    { id: 'ok', label: 'Delete profile', danger: true },
                ],
            });
            if (ans !== 'ok') return false;
            const stats = detachProfileFromChats(profile.id);
            const ok = deleteProfile(profile.id);
            if (ok) {
                notifyChatUiChanged();
                VP.showToast?.(`Profile deleted · removed from ${stats.touchedChats} chat(s), deleted ${stats.deletedChats} solo chat(s)`, 'success');
            }
            return ok;
        }
        const ans = await VP.showConfirm?.({
            title: 'Delete profile?',
            message: `Удалить профиль «${profile.name}»?`,
            buttons: [
                { id: 'cancel', label: 'Cancel', ghost: true },
                { id: 'ok', label: 'Delete', danger: true },
            ],
        });
        if (ans !== 'ok') return false;
        const ok = deleteProfile(profile.id);
        if (ok) {
            notifyChatUiChanged();
            VP.showToast?.('Profile deleted', 'success');
        }
        return ok;
    }

    async function openLatestOrCreateChatForProfile(profileId) {
        const profile = getProfileById(profileId);
        if (!profile) return null;
        const latest = getLatestChatForProfile(profile.id);
        if (latest) {
            activateChat(latest.id);
            VP.showToast?.(`Opened latest chat: ${latest.title}`, 'success');
            return latest;
        }
        return await createChatInteractive(profile.id);
    }

    function injectChatPanelStyles() {
        if (document.getElementById('vp-chats-style')) return;
        const style = document.createElement('style');
        style.id = 'vp-chats-style';
        style.textContent = `
            .vp-chats-panel { height:100%; display:flex; flex-direction:column; min-height:0; }
            .vp-chats-toolbar {
                flex:0 0 auto; display:flex; align-items:center; gap:6px; padding:8px;
                border-bottom:1px solid rgba(255,255,255,0.08); background:rgba(255,255,255,0.025);
            }
            .vp-chats-toolbar .spacer { flex:1; }
            .vp-chats-list { flex:1; min-height:0; overflow:auto; padding:8px; display:flex; flex-direction:column; gap:8px; }
            .vp-chats-empty {
                margin:auto; text-align:center; color:var(--text-secondary,#a6adc8); font-size:12px; line-height:1.5; max-width:280px;
            }
            .vp-chats-item {
                border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:9px 10px;
                background:rgba(255,255,255,0.04); cursor:pointer; display:flex; gap:10px; align-items:flex-start;
            }
            .vp-chats-item:hover { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.16); }
            .vp-chats-item.active { border-color:rgba(108,95,166,0.72); box-shadow:0 0 0 1px rgba(108,95,166,0.28) inset; background:rgba(108,95,166,0.14); }
            .vp-chats-avatar-stack { flex:0 0 auto; min-width:32px; max-width:86px; display:flex; align-items:center; padding-left:0; margin-top:1px; }
            .vp-chat-avatar {
                width:30px; height:30px; border-radius:999px; flex:0 0 30px; display:flex; align-items:center; justify-content:center;
                font-size:12px; font-weight:800; color:#fff; background:var(--accent,#6c5fa6); overflow:hidden;
                border:2px solid rgba(30,30,46,0.96); box-shadow:0 2px 8px rgba(0,0,0,0.28);
            }
            .vp-chat-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
            .vp-chat-avatar.stacked + .vp-chat-avatar.stacked { margin-left:-11px; }
            .vp-chat-avatar.active { box-shadow:0 0 0 1px rgba(255,255,255,0.46), 0 2px 8px rgba(0,0,0,0.32); }
            .vp-chat-avatar.overflow { background:rgba(255,255,255,0.10) !important; color:var(--text-secondary,#a6adc8); font-size:10px; border-color:rgba(30,30,46,0.96) !important; }
            .vp-chats-avatar {
                width:30px; height:30px; border-radius:999px; flex:0 0 30px; display:flex; align-items:center; justify-content:center;
                font-size:12px; font-weight:700; color:#fff; background:var(--accent,#6c5fa6);
            }
            .vp-chats-main { min-width:0; flex:1; }
            .vp-chats-title { font-size:13px; font-weight:700; color:var(--text-primary,#cdd6f4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-chats-sub { margin-top:2px; font-size:11px; color:var(--text-secondary,#a6adc8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-chats-actions { display:flex; gap:4px; flex:0 0 auto; }
            .vp-chats-mini {
                border:0; background:transparent; color:var(--text-secondary,#a6adc8); cursor:pointer; font-size:11px; padding:2px 4px; border-radius:4px;
            }
            .vp-chats-mini:hover { background:rgba(255,255,255,0.10); color:var(--text-primary,#cdd6f4); }
            .vp-profiles-item {
                border:1px solid rgba(255,255,255,0.08); border-radius:10px; padding:9px 10px;
                background:rgba(255,255,255,0.04); cursor:pointer; display:flex; gap:10px; align-items:flex-start;
            }
            .vp-profiles-item:hover { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.16); }
            .vp-profiles-avatar {
                width:30px; height:30px; border-radius:999px; flex:0 0 30px; display:flex; align-items:center; justify-content:center;
                font-size:12px; font-weight:700; color:#fff; background:var(--accent,#6c5fa6);
            }
            .vp-profiles-main { min-width:0; flex:1; }
            .vp-profiles-title { font-size:13px; font-weight:700; color:var(--text-primary,#cdd6f4); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-profiles-sub { margin-top:2px; font-size:11px; color:var(--text-secondary,#a6adc8); white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            .vp-profiles-badge {
                margin-top:5px; display:inline-block; font-size:10px; padding:2px 6px; border-radius:999px;
                background:rgba(255,255,255,0.08); color:var(--text-secondary,#a6adc8);
            }
            .vp-profiles-grid {
                --vp-profile-card-size: 170px;
                flex:1; min-height:0; overflow:auto; padding:10px;
                /* Fixed-width cards: panel resize only changes how many
                   columns fit — cards themselves never stretch or jump.
                   Rows grow independently to fit long descriptions. */
                display:flex; flex-wrap:wrap; gap:10px;
                align-content:flex-start; align-items:flex-start;
                justify-content:flex-start;
            }
            .vp-profile-card {
                position:relative; width:var(--vp-profile-card-size); flex:0 0 auto;
                border:1px solid rgba(255,255,255,0.08); border-radius:12px;
                background:rgba(255,255,255,0.04); cursor:pointer; padding:10px;
                display:flex; flex-direction:column; align-items:stretch; gap:8px; overflow:hidden;
                transition: transform .12s ease, background .12s ease, border-color .12s ease;
            }
            .vp-profile-card:hover { background:rgba(255,255,255,0.07); border-color:rgba(255,255,255,0.16); transform:translateY(-1px); }
            /* Hero: square avatar, centered, with the name overlaid on its
               bottom edge. Description stays below the hero. */
            .vp-profile-card-hero { position:relative; flex:0 0 auto; margin:0 auto; width:fit-content; }
            .vp-profile-card-avatar {
                width: calc(var(--vp-profile-card-size) * 0.62);
                height: calc(var(--vp-profile-card-size) * 0.62);
                min-width: 64px; min-height: 64px;
                border-radius: 12px; margin: 0;
                display: flex; align-items: center; justify-content: center; overflow: hidden;
                color: #fff; font-size: calc(var(--vp-profile-card-size) * 0.20); font-weight: 800; box-shadow: 0 8px 20px rgba(0,0,0,0.28);
                border: 1px solid rgba(255,255,255,0.14); flex: 0 0 auto;
            }
            .vp-profiles-grid.avatar-circle .vp-profile-card-avatar { border-radius:999px; }
            .vp-profiles-grid.avatar-square .vp-profile-card-avatar { border-radius:6px; }
            .vp-profile-card-avatar img { width:100%; height:100%; object-fit:cover; display:block; }
            .vp-profile-card-hero-name {
                position:absolute; left:0; right:0; bottom:0;
                padding:14px 8px 6px;
                border-radius:0 0 12px 12px;
                background:linear-gradient(180deg, transparent, rgba(0,0,0,0.62) 62%);
                color:#fff; font-size:12px; font-weight:800; text-align:center;
                text-shadow:0 1px 3px rgba(0,0,0,0.8);
                white-space:nowrap; overflow:hidden; text-overflow:ellipsis;
                pointer-events:none;
            }
            .vp-profiles-grid.avatar-square .vp-profile-card-hero-name { border-radius:0 0 6px 6px; }
            .vp-profiles-grid.avatar-circle .vp-profile-card-hero-name { border-radius:0 0 999px 999px; padding:14px 18px 6px; }
            .vp-profile-card-body { min-width:0; text-align:center; display:flex; flex-direction:column; gap:4px; }
            .vp-profile-card-title { color:var(--text-primary,#cdd6f4); font-size:13px; font-weight:800; white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
            /* Grid mode: name lives on the hero overlay, hide the duplicate body title. */
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-title { display:none; }
            .vp-profile-card-sub { color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.35; min-height:30px; overflow:hidden; display:-webkit-box; -webkit-line-clamp:2; -webkit-box-orient:vertical; }
            .vp-profile-card-meta { align-self:center; margin-top:2px; font-size:10px; padding:2px 7px; border-radius:999px; background:rgba(255,255,255,0.08); color:var(--text-secondary,#a6adc8); }
            /* Grid mode: actions live as corner overlays on the card
               (chat/new — top-left, edit/delete — top-right), shown on hover.
               Saves a full row of vertical space per card. */
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-actions {
                position:absolute; top:6px; left:6px; right:6px;
                display:flex; justify-content:space-between; align-items:flex-start;
                margin:0; pointer-events:none; z-index:5;
                opacity:0; transform:translateY(-3px);
                transition:opacity .15s ease, transform .15s ease;
            }
            .vp-profiles-grid:not(.list-mode) .vp-profile-card:hover .vp-profile-card-actions,
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-actions:focus-within { opacity:1; transform:none; pointer-events:auto; }
            .vp-profile-card-actions-left, .vp-profile-card-actions-right { display:flex; gap:4px; }
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-actions .vp-chats-mini {
                width:24px; height:24px; padding:0; display:inline-flex; align-items:center; justify-content:center;
                font-size:12px; line-height:1; border-radius:7px;
                background:rgba(15,15,25,0.72); border:1px solid rgba(255,255,255,0.16);
                backdrop-filter:blur(5px); -webkit-backdrop-filter:blur(5px);
                box-shadow:0 2px 8px rgba(0,0,0,0.35);
            }
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-actions .vp-chats-mini:hover { background:rgba(50,50,80,0.9); }
            .vp-chats-mini-danger { color:#f38ba8 !important; font-weight:700; }
            .vp-profiles-grid:not(.list-mode) .vp-profile-card-actions .vp-chats-mini-danger:hover {
                background:rgba(110,40,40,0.88) !important; border-color:rgba(243,139,168,0.45) !important; color:#ffd7e0 !important;
            }
            .vp-profiles-grid.hide-desc .vp-profile-card-sub { display:none; }
            .vp-profiles-grid.hide-meta .vp-profile-card-meta { display:none; }
            .vp-profiles-grid.hide-actions .vp-profile-card-actions { display:none; }
            .vp-profiles-grid.list-mode { display:flex; flex-direction:column; gap:8px; flex-wrap:nowrap; }
            .vp-profiles-grid.list-mode .vp-profile-card { width:auto; align-self:stretch; flex-direction:row; align-items:center; min-height:74px; padding:8px 10px; }
            .vp-profiles-grid.list-mode .vp-profile-card-hero { flex:0 0 auto; }
            .vp-profiles-grid.list-mode .vp-profile-card-hero-name { display:none; }
            .vp-profiles-grid.list-mode .vp-profile-card-avatar { width:44px; height:44px; min-height:0; font-size:17px; margin:0; border-radius:11px; }
            .vp-profiles-grid.list-mode.avatar-circle .vp-profile-card-avatar { border-radius:999px; }
            .vp-profiles-grid.list-mode.avatar-square .vp-profile-card-avatar { border-radius:5px; }
            .vp-profiles-grid.list-mode .vp-profile-card-body { text-align:left; flex:1; }
            .vp-profiles-grid.list-mode .vp-profile-card-sub { min-height:0; -webkit-line-clamp:1; }
            .vp-profiles-grid.list-mode .vp-profile-card-meta { align-self:flex-start; }
            .vp-profiles-grid.list-mode .vp-profile-card-actions { margin-top:0; justify-content:flex-end; flex:0 0 auto; }
            .vp-chat-profile-editor-card {
                resize: both;
                overflow: auto;
                min-width: 460px;
                min-height: 420px;
                max-width: calc(100vw - 48px);
                max-height: calc(100vh - 48px);
            }
            .vp-chat-profile-editor-card .vp-shell-modal-body {
                min-height: 0;
            }
            .vp-chat-editor-card {
                min-width: 420px;
                min-height: 340px;
                max-width: calc(100vw - 48px);
                max-height: calc(100vh - 48px);
                resize: both;
                overflow: auto;
            }
            .vp-chat-editor-form {
                display: flex; flex-direction: column; gap: 10px;
            }
            .vp-chat-editor-form > label {
                display: flex; flex-direction: column; gap: 3px;
                font-size: 12px; color: var(--text-secondary, #a6adc8);
            }
            .vp-chat-editor-form > label > span { font-weight: 600; }
            .vp-chat-editor-form > label > input {
                background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px; padding: 7px 9px; color: var(--text-primary, #cdd6f4);
                font-size: 13px; outline: none;
            }
            .vp-chat-editor-form > label > input:focus { border-color: var(--accent, #6c5fa6); }
            .vp-chat-editor-section {
                border: 1px solid rgba(255,255,255,0.08); border-radius: 10px;
                background: rgba(255,255,255,0.035); padding: 10px;
                display: flex; flex-direction: column; gap: 6px;
            }
            .vp-chat-editor-section-head {
                display: flex; align-items: center; justify-content: space-between;
                font-size: 13px; font-weight: 700; color: var(--text-primary, #cdd6f4);
            }
            .vp-chat-editor-section-hint {
                font-size: 11px; color: var(--text-secondary, #a6adc8); line-height: 1.4;
            }
            .vp-chat-editor-section input,
            .vp-chat-editor-section textarea {
                background: rgba(255,255,255,0.06); border: 1px solid rgba(255,255,255,0.12);
                border-radius: 6px; padding: 7px 9px; color: var(--text-primary, #cdd6f4);
                font-size: 13px; outline: none; resize: vertical; font-family: inherit;
            }
            .vp-chat-editor-section input:focus,
            .vp-chat-editor-section textarea:focus { border-color: var(--accent, #6c5fa6); }
            .vp-chat-avatar-editor {
                display:flex; gap:12px; align-items:center; padding:10px; border:1px solid rgba(255,255,255,0.08);
                border-radius:10px; background:rgba(255,255,255,0.035);
            }
            .vp-chat-avatar-preview {
                width:72px; height:72px; flex:0 0 72px; border-radius:18px; overflow:hidden;
                display:flex; align-items:center; justify-content:center; color:#fff; font-size:28px; font-weight:800;
                border:1px solid rgba(255,255,255,0.16); box-shadow:0 8px 22px rgba(0,0,0,0.28);
            }
            .vp-chat-avatar-preview img { width:100%; height:100%; object-fit:cover; display:block; }
            .vp-chat-avatar-tools { min-width:0; display:flex; flex-direction:column; gap:6px; }
            .vp-chat-avatar-title { font-weight:800; color:var(--text-primary,#cdd6f4); }
            .vp-chat-avatar-note { color:var(--text-secondary,#a6adc8); font-size:11px; line-height:1.35; }
            .vp-chat-profile-form { display:flex; flex-direction:column; gap:10px; font-size:12px; }
            .vp-chat-profile-form label { display:flex; align-items:center; justify-content:space-between; gap:10px; }
            .vp-chat-profile-form input,
            .vp-chat-profile-form select,
            .vp-chat-profile-form textarea {
                width:64%; min-width:160px; border-radius:6px; border:1px solid rgba(255,255,255,0.12);
                background:var(--bg-tertiary,#252540); color:var(--text-primary,#cdd6f4); padding:6px 8px; font-size:12px;
                font-family:inherit;
            }
            .vp-chat-profile-form textarea { min-height:150px; resize:vertical; }
            .vp-chat-profile-color-row {
                width:64%; min-width:160px; display:grid; grid-template-columns:42px minmax(95px, 1fr); gap:7px; align-items:center;
            }
            .vp-chat-profile-form .vp-chat-profile-color-row input[type="color"] {
                width:42px; min-width:42px; height:30px; padding:2px; cursor:pointer;
            }
            .vp-chat-profile-form .vp-chat-profile-color-row input[type="text"] {
                width:100%; min-width:0; font-family:ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; text-transform:lowercase;
            }
            .vp-chat-profile-color-presets { grid-column:1 / -1; display:flex; flex-wrap:wrap; gap:5px; }
            .vp-chat-color-swatch {
                width:18px; height:18px; border-radius:999px; border:1px solid rgba(255,255,255,0.24); cursor:pointer; padding:0;
                box-shadow:0 1px 4px rgba(0,0,0,0.28);
            }
            .vp-chat-color-swatch:hover { transform:translateY(-1px); border-color:rgba(255,255,255,0.55); }
            .vp-chat-profile-form .vp-chat-profile-block { display:flex; flex-direction:column; align-items:stretch; }
            .vp-chat-profile-form .vp-chat-profile-block > span { margin-bottom:6px; font-weight:700; }
            .vp-chat-profile-form .vp-chat-profile-block textarea { width:100%; }
            .vp-chat-profile-form .vp-chat-profile-check { justify-content:flex-start; }
            .vp-chat-profile-form .vp-chat-profile-check input { width:auto; min-width:0; }
            .vp-chat-profile-actions { display:flex; justify-content:flex-end; gap:8px; padding-top:4px; }
        `;
        document.head.appendChild(style);
    }

    function renderChatsPanel(container) {
        injectChatPanelStyles();
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'vp-chats-panel';
        wrap.innerHTML = `
            <div class="vp-chats-toolbar">
                <button class="vp-btn" data-act="new">＋ New</button>
                <button class="vp-btn vp-btn-ghost" data-act="dup">Duplicate</button>
                <span class="spacer"></span>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="edit">Edit</button>
                <button class="vp-btn vp-btn-ghost vp-btn-sm" data-act="delete">Delete</button>
            </div>
            <div class="vp-chats-list"></div>`;

        const list = wrap.querySelector('.vp-chats-list');
        const chats = [...(S.chats.items || [])].sort((a, b) => (b.meta?.updatedAt || 0) - (a.meta?.updatedAt || 0));
        if (!chats.length) {
            list.innerHTML = `<div class="vp-chats-empty"><div style="font-size:28px;margin-bottom:8px;">💬</div><b>Chats</b><br>Здесь будет список разговоров. Пока можно создать новый чат на базе текущего assistant profile.</div>`;
        } else {
            chats.forEach(chat => {
                const item = document.createElement('div');
                item.className = 'vp-chats-item' + (chat.id === S.chats.activeChatId ? ' active' : '');
                item.innerHTML = `
                    <div class="vp-chats-avatar-stack" data-role="avatar-stack"></div>
                    <div class="vp-chats-main">
                        <div class="vp-chats-title">${getChatDisplayTitle(chat)}</div>
                        <div class="vp-chats-sub">${getChatSubtitle(chat)}</div>
                    </div>
                    <div class="vp-chats-actions">
                        <button class="vp-chats-mini" data-act="dup" title="Duplicate">dup</button>
                        <button class="vp-chats-mini" data-act="edit" title="Edit chat">edit</button>
                        <button class="vp-chats-mini" data-act="del" title="Delete">×</button>
                    </div>`;
                renderChatAvatarStack(item.querySelector('[data-role="avatar-stack"]'), chat);
                item.addEventListener('click', () => activateChat(chat.id));
                item.querySelector('[data-act="dup"]').addEventListener('click', (e) => { e.stopPropagation(); duplicateActiveChatInteractive(chat.id); });
                item.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); openChatEditorInteractive(chat.id); });
                item.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); deleteChatInteractive(chat.id); });
                list.appendChild(item);
            });
        }

        wrap.querySelector('[data-act="new"]').addEventListener('click', () => createChatInteractive());
        wrap.querySelector('[data-act="dup"]').addEventListener('click', () => duplicateActiveChatInteractive());
        wrap.querySelector('[data-act="edit"]').addEventListener('click', () => openChatEditorInteractive());
        wrap.querySelector('[data-act="delete"]').addEventListener('click', () => deleteChatInteractive());
        container.appendChild(wrap);
    }

    function getProfilesPanelPrefs(ctx = {}) {
        const defaults = {
            viewMode: 'grid',
            cardSize: 170,
            sortBy: 'name',
            avatarShape: 'rounded',
            showDescriptions: true,
            showMeta: true,
            showActions: true,
        };
        const local = ctx.getPanelState ? ctx.getPanelState(defaults) : defaults;
        return {
            ...defaults,
            ...local,
            cardSize: Math.max(120, Math.min(260, Number(local.cardSize) || defaults.cardSize)),
            viewMode: local.viewMode === 'list' ? 'list' : 'grid',
            sortBy: ['name', 'kind', 'updated'].includes(local.sortBy) ? local.sortBy : 'name',
            avatarShape: ['rounded', 'circle', 'square'].includes(local.avatarShape) ? local.avatarShape : 'rounded',
            showDescriptions: local.showDescriptions !== false,
            showMeta: local.showMeta !== false,
            showActions: local.showActions !== false,
        };
    }

    function sortProfilesForPanel(items, prefs) {
        const list = [...(items || [])];
        return list.sort((a, b) => {
            if (!!a.meta?.builtin !== !!b.meta?.builtin) return a.meta?.builtin ? -1 : 1;
            if (prefs.sortBy === 'kind') {
                const ka = String(a.meta?.kind || 'character');
                const kb = String(b.meta?.kind || 'character');
                if (ka !== kb) return ka.localeCompare(kb);
            }
            if (prefs.sortBy === 'updated') {
                const da = Number(a.meta?.updatedAt || a.meta?.createdAt || 0);
                const db = Number(b.meta?.updatedAt || b.meta?.createdAt || 0);
                if (da !== db) return db - da;
            }
            return String(a.name || '').localeCompare(String(b.name || ''));
        });
    }

    function renderProfilesPanel(container, ctx = {}) {
        injectChatPanelStyles();
        const prefs = getProfilesPanelPrefs(ctx);
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'vp-chats-panel';
        wrap.innerHTML = `
            <div class="vp-chats-toolbar">
                <button class="vp-btn" data-act="new-profile">＋ Profile</button>
                <span class="spacer"></span>
                <span style="color:var(--text-secondary,#a6adc8);font-size:11px;">${S.profiles.items.length} profile${S.profiles.items.length === 1 ? '' : 's'} · ${prefs.viewMode}</span>
            </div>
            <div class="vp-profiles-grid ${prefs.viewMode === 'list' ? 'list-mode' : 'grid-mode'}"></div>`;

        const grid = wrap.querySelector('.vp-profiles-grid');
        grid.style.setProperty('--vp-profile-card-size', `${prefs.cardSize}px`);
        grid.classList.toggle('avatar-circle', prefs.avatarShape === 'circle');
        grid.classList.toggle('avatar-square', prefs.avatarShape === 'square');
        grid.classList.toggle('hide-desc', !prefs.showDescriptions);
        grid.classList.toggle('hide-meta', !prefs.showMeta);
        grid.classList.toggle('hide-actions', !prefs.showActions);

        const profiles = sortProfilesForPanel(S.profiles.items || [], prefs);

        const makeAvatar = (profile) => {
            const avatar = document.createElement('div');
            avatar.className = 'vp-profile-card-avatar';
            avatar.style.background = profile.color || '#6c5fa6';
            if (profile.avatar) {
                const img = document.createElement('img');
                img.src = profile.avatar;
                img.alt = profile.name || 'Profile';
                avatar.appendChild(img);
            } else {
                avatar.textContent = (profile.name || 'P').slice(0, 1).toUpperCase();
            }
            return avatar;
        };

        if (!profiles.length) {
            grid.innerHTML = `<div class="vp-chats-empty"><div style="font-size:28px;margin-bottom:8px;">👤</div><b>Profiles</b><br>Создайте профиль персонажа/роли для текущего мира.</div>`;
        } else {
            profiles.forEach(profile => {
                const relatedChats = getChatsForProfile(profile.id);
                const latestChat = getLatestChatForProfile(profile.id);
                const card = document.createElement('div');
                card.className = 'vp-profile-card';
                card.title = latestChat ? `Latest chat: ${latestChat.title}` : 'No chats yet';

                const avatar = makeAvatar(profile);
                // Hero block: avatar with the profile name overlaid on its
                // bottom edge (grid mode). In list mode CSS flattens this
                // wrapper and shows the regular body title instead.
                const hero = document.createElement('div');
                hero.className = 'vp-profile-card-hero';
                hero.appendChild(avatar);
                const heroName = document.createElement('div');
                heroName.className = 'vp-profile-card-hero-name';
                heroName.textContent = profile.name || 'Profile';
                hero.appendChild(heroName);

                const body = document.createElement('div');
                body.className = 'vp-profile-card-body';
                const title = document.createElement('div');
                title.className = 'vp-profile-card-title';
                title.textContent = profile.name || 'Profile';
                const sub = document.createElement('div');
                sub.className = 'vp-profile-card-sub';
                sub.textContent = profile.description || (profile.meta?.builtin ? 'Built-in assistant profile' : 'Custom profile');
                const meta = document.createElement('div');
                meta.className = 'vp-profile-card-meta';
                const kind = profile.meta?.kind || 'character';
                meta.textContent = `${kind} · ${relatedChats.length} chat${relatedChats.length === 1 ? '' : 's'}${profile.meta?.builtin ? ' · builtin' : ''}`;
                body.appendChild(title);
                body.appendChild(sub);
                body.appendChild(meta);

                const actions = document.createElement('div');
                actions.className = 'vp-profile-card-actions';
                actions.innerHTML = `
                    <div class="vp-profile-card-actions-left">
                        <button class="vp-chats-mini" data-act="open" title="Open latest or create chat">💬</button>
                        <button class="vp-chats-mini" data-act="newchat" title="Create new chat from profile">＋</button>
                    </div>
                    <div class="vp-profile-card-actions-right">
                        <button class="vp-chats-mini" data-act="edit" title="Edit profile">✏️</button>
                        <button class="vp-chats-mini vp-chats-mini-danger" data-act="del" title="Delete profile">✕</button>
                    </div>`;

                card.appendChild(hero);
                card.appendChild(body);
                card.appendChild(actions);

                card.addEventListener('click', () => openLatestOrCreateChatForProfile(profile.id));
                actions.querySelector('[data-act="open"]').addEventListener('click', (e) => { e.stopPropagation(); openLatestOrCreateChatForProfile(profile.id); });
                actions.querySelector('[data-act="newchat"]').addEventListener('click', (e) => { e.stopPropagation(); createChatInteractive(profile.id); });
                actions.querySelector('[data-act="edit"]').addEventListener('click', (e) => { e.stopPropagation(); editProfileInteractive(profile.id); });
                actions.querySelector('[data-act="del"]').addEventListener('click', (e) => { e.stopPropagation(); deleteProfileInteractive(profile.id); });
                grid.appendChild(card);
            });
        }

        wrap.querySelector('[data-act="new-profile"]').addEventListener('click', () => createProfileInteractive());
        container.appendChild(wrap);
    }

    function renderProfilesSettings(container, ctx = {}) {
        injectChatPanelStyles();
        const prefs = getProfilesPanelPrefs(ctx);
        container.innerHTML = '';
        const wrap = document.createElement('div');
        wrap.className = 'vp-shell-settings-form';
        wrap.innerHTML = `
            <label><span>View mode</span>
                <select data-k="viewMode"><option value="grid">Grid cards</option><option value="list">Compact list</option></select>
            </label>
            <label><span>Card size</span><input type="range" data-k="cardSize" min="120" max="260" step="10"></label>
            <label><span>Sort by</span>
                <select data-k="sortBy"><option value="name">Name</option><option value="kind">Kind</option><option value="updated">Recently updated</option></select>
            </label>
            <label><span>Avatar shape</span>
                <select data-k="avatarShape"><option value="rounded">Rounded square</option><option value="circle">Circle</option><option value="square">Square</option></select>
            </label>
            <label><span>Show descriptions</span><input type="checkbox" data-k="showDescriptions"></label>
            <label><span>Show badges</span><input type="checkbox" data-k="showMeta"></label>
            <label><span>Show action buttons</span><input type="checkbox" data-k="showActions"></label>
            <div class="vp-shell-settings-note">These settings are saved in the current workspace layout area. They only affect this Profiles panel view, not the profiles themselves.</div>`;

        wrap.querySelector('[data-k="viewMode"]').value = prefs.viewMode;
        wrap.querySelector('[data-k="cardSize"]').value = String(prefs.cardSize);
        wrap.querySelector('[data-k="sortBy"]').value = prefs.sortBy;
        wrap.querySelector('[data-k="avatarShape"]').value = prefs.avatarShape;
        wrap.querySelector('[data-k="showDescriptions"]').checked = prefs.showDescriptions;
        wrap.querySelector('[data-k="showMeta"]').checked = prefs.showMeta;
        wrap.querySelector('[data-k="showActions"]').checked = prefs.showActions;

        const apply = () => {
            const next = {
                viewMode: wrap.querySelector('[data-k="viewMode"]').value || 'grid',
                cardSize: Math.max(120, Math.min(260, parseInt(wrap.querySelector('[data-k="cardSize"]').value, 10) || 170)),
                sortBy: wrap.querySelector('[data-k="sortBy"]').value || 'name',
                avatarShape: wrap.querySelector('[data-k="avatarShape"]').value || 'rounded',
                showDescriptions: wrap.querySelector('[data-k="showDescriptions"]').checked,
                showMeta: wrap.querySelector('[data-k="showMeta"]').checked,
                showActions: wrap.querySelector('[data-k="showActions"]').checked,
            };
            if (ctx.setPanelState) ctx.setPanelState(next);
            // Refresh visible Profiles panels without rebuilding the whole shell,
            // so the settings modal stays open while sliders/options change.
            document.querySelectorAll('.vp-shell-area').forEach(area => {
                const panelId = area.querySelector('.vp-shell-panel-select')?.value;
                if (panelId !== 'profiles') return;
                const host = area.querySelector('.vp-shell-panel-host');
                if (!host) return;
                const liveCtx = VP.shell?.getPanelContext?.(area.dataset.areaId, 'profiles') || ctx;
                renderProfilesPanel(host, liveCtx);
            });
        };
        wrap.querySelectorAll('select,input').forEach(el => {
            el.addEventListener('change', apply);
            if (el.type === 'range') el.addEventListener('input', apply);
        });
        container.appendChild(wrap);
    }

    function registerPanels() {
        if (!VP.getPanel?.('chats')) {
            VP.registerPanel({
                id: 'chats',
                title: 'Chats',
                icon: '💬',
                order: 25,
                create: renderChatsPanel,
            });
        }
        if (!VP.getPanel?.('profiles')) {
                VP.registerPanel({
                id: 'profiles',
                title: 'Profiles',
                icon: '👤',
                order: 26,
                create: renderProfilesPanel,
                settings: {
                    title: 'Profiles Settings', icon: '👤', mode: 'auto', minWidth: 420, minHeight: 320, width: 420,
                    create: renderProfilesSettings,
                },
            });
        }
    }

    async function boot() {
        if (_bootDone) return ready;
        if (_bootStarted) return ready;
        _bootStarted = true;
        try {
            if (VP.ready) await VP.ready;
            ensureStores();

            const savedProfiles = DB?.getProfiles ? await DB.getProfiles() : null;
            const savedChats = DB?.getChatStore ? await DB.getChatStore() : null;

            if (savedProfiles?.items) S.profiles = { items: savedProfiles.items.map(normalizeProfile) };
            else S.profiles = { items: [] };
            const builtin = ensureBuiltinProfile();

            if (savedChats?.items?.length) {
                S.chats = {
                    activeChatId: savedChats.activeChatId || null,
                    items: savedChats.items.map(normalizeChat),
                };
            } else {
                const legacySession = await loadLegacySessionState();
                const legacyProjector = await loadLegacyProjectorState();
                const mainChat = buildLegacyDefaultChat(builtin.id, legacySession, legacyProjector);
                S.chats = {
                    activeChatId: mainChat.id,
                    items: [mainChat],
                };
                schedulePersistProfiles();
                schedulePersistChatStore();
            }

            normalizeStores();
            registerPanels();
            installScenarioPromptProvider();
            _bootDone = true;
            _resolveReady?.(API);
            VP.shell?.render?.();
            console.log(`[VP Chats] ready — ${S.chats.items.length} chat(s), ${S.profiles.items.length} profile(s).`);
        } catch (err) {
            console.error('[VP Chats] boot failed:', err);
            _rejectReady?.(err);
            throw err;
        }
        return ready;
    }

    // ════════════════════════════════════════════════════════════════
    //  CHAT SCENARIO PROMPT PROVIDER
    // ════════════════════════════════════════════════════════════════
    function installScenarioPromptProvider() {
        if (!VP.registerPromptProvider) return;
        VP.registerPromptProvider({
            id: 'chat-scenario',
            order: 55,
            build(state) {
                const chat = getActiveChat();
                if (!chat?.scenario?.enabled || !chat.scenario.text.trim()) return '';
                const title = chat.scenario.title.trim();
                const lines = ['[CHAT SCENARIO]'];
                if (title) lines.push(`Title: ${title}`);
                lines.push(chat.scenario.text.trim());
                lines.push('[/CHAT SCENARIO]');
                return lines.join('\n');
            },
        });
    }

    // ════════════════════════════════════════════════════════════════
    //  CHAT EDITOR MODAL  (scenario + note)
    // ════════════════════════════════════════════════════════════════
    let _chatEditorBackdrop = null;

    function closeChatEditorModal() {
        if (_chatEditorBackdrop) { _chatEditorBackdrop.remove(); _chatEditorBackdrop = null; }
    }

    function onChatEditorEsc(e) {
        if (e.key === 'Escape') closeChatEditorModal();
    }

    function openChatEditorModal(chatId = null) {
        injectChatPanelStyles();
        closeChatEditorModal();

        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return;

        const backdrop = document.createElement('div');
        backdrop.className = 'vp-shell-modal-backdrop global vp-chat-editor-modal';
        backdrop.style.setProperty('--vp-modal-width', '520px');

        const card = document.createElement('div');
        card.className = 'vp-shell-modal-card vp-chat-editor-card';
        card.innerHTML = `
            <div class="vp-shell-modal-head">
                <div class="vp-shell-modal-title">📝 Edit Chat</div>
                <button class="vp-shell-modal-close" title="Close">×</button>
            </div>
            <div class="vp-shell-modal-body">
                <div class="vp-chat-editor-form">
                    <label><span>Title</span><input data-k="title" type="text" placeholder="Chat title"></label>
                    <div class="vp-chat-editor-section">
                        <div class="vp-chat-editor-section-head">
                            <span>🎬 Scenario</span>
                            <label class="vp-chat-profile-check"><span>Enabled</span><input data-k="scenarioEnabled" type="checkbox"></label>
                        </div>
                        <div class="vp-chat-editor-section-hint">Scene premise and situation. Visible to the model as context when enabled.</div>
                        <input data-k="scenarioTitle" type="text" placeholder="Scenario title (optional)">
                        <textarea data-k="scenarioText" rows="5" placeholder="What is happening right now? Current situation, important details, possible developments..."></textarea>
                    </div>
                    <div class="vp-chat-editor-section">
                        <div class="vp-chat-editor-section-head"><span>📋 Note</span></div>
                        <textarea data-k="note" rows="3" placeholder="Internal note (not sent to model)"></textarea>
                    </div>
                    <div class="vp-chat-profile-actions">
                        <button class="vp-btn vp-btn-ghost" data-act="cancel">Cancel</button>
                        <button class="vp-btn" data-act="save">Save</button>
                    </div>
                </div>
            </div>`;

        backdrop.appendChild(card);
        document.body.appendChild(backdrop);
        _chatEditorBackdrop = backdrop;

        // Populate fields
        const f = (k) => card.querySelector(`[data-k="${k}"]`);
        f('title').value = chat.title || '';
        f('scenarioEnabled').checked = chat.scenario?.enabled !== false;
        f('scenarioTitle').value = chat.scenario?.title || '';
        f('scenarioText').value = chat.scenario?.text || '';
        f('note').value = chat.note || '';

        const close = () => closeChatEditorModal();
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });
        card.querySelector('.vp-shell-modal-close').addEventListener('click', close);
        card.querySelector('[data-act="cancel"]').addEventListener('click', close);
        setTimeout(() => document.addEventListener('keydown', onChatEditorEsc, true), 0);

        // Make modal draggable
        const head = card.querySelector('.vp-shell-modal-head');
        let isDragging = false, startX, startY, startLeft, startTop;
        head.addEventListener('mousedown', (e) => {
            if (e.target.closest('.vp-shell-modal-close') || e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX; startY = e.clientY;
            const rect = card.getBoundingClientRect();
            const backdropRect = backdrop.getBoundingClientRect();
            startLeft = rect.left - backdropRect.left;
            startTop = rect.top - backdropRect.top;
            card.style.margin = '0';
            card.style.position = 'absolute';
            card.style.left = `${startLeft}px`;
            card.style.top = `${startTop}px`;
            e.preventDefault();
            const onMouseMove = (ev) => {
                if (!isDragging) return;
                card.style.left = `${startLeft + (ev.clientX - startX)}px`;
                card.style.top = `${startTop + (ev.clientY - startY)}px`;
            };
            const onMouseUp = () => { isDragging = false; document.removeEventListener('mousemove', onMouseMove); document.removeEventListener('mouseup', onMouseUp); };
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
        });

        // Save
        card.querySelector('[data-act="save"]').addEventListener('click', () => {
            const newTitle = f('title').value.trim();
            if (newTitle && newTitle !== chat.title) {
                chat.title = newTitle;
            }
            chat.scenario = {
                enabled: f('scenarioEnabled').checked,
                title: f('scenarioTitle').value.trim(),
                text: f('scenarioText').value.trim(),
            };
            chat.note = f('note').value.trim();
            touchChatMeta(chat);
            schedulePersistChatStore();
            notifyChatUiChanged();
            VP.showToast?.('Chat updated', 'success');
            close();
        });
    }

    async function openChatEditorInteractive(chatId = null) {
        const chat = getChatById(chatId || S.chats.activeChatId);
        if (!chat) return;
        openChatEditorModal(chat.id);
    }

    const API = {
        ready,
        boot,
        getProfilesStore: () => S.profiles,
        getChatStore: () => S.chats,
        getProfileById,
        getChatsForProfile,
        getLatestChatForProfile,
        getChatById,
        getActiveChat,
        getActiveParticipants,
        getActiveSpeaker,
        getParticipantById,
        getParticipantProfile,
        getParticipantDisplayName,
        getActiveChatMessages,
        getActiveChatDraft,
        setActiveChatDraft,
        setActiveChatMessages,
        addActiveChatMessage,
        updateActiveChatMessage,
        deleteActiveChatMessage,
        createProfile,
        updateProfile,
        deleteProfile,
        createProfileInteractive,
        editProfileInteractive,
        deleteProfileInteractive,
        openLatestOrCreateChatForProfile,
        createChatFromProfile,
        duplicateChat,
        renameChat,
        setActiveChat,
        setActiveSpeaker,
        addParticipantToChat,
        removeParticipantFromChat,
        activateChat,
        setActiveSpeakerInteractive,
        addParticipantToCurrentChatInteractive,
        removeParticipantFromCurrentChatInteractive,
        deleteChat,
        createChatInteractive,
        duplicateActiveChatInteractive,
        renameChatInteractive,
        openChatEditorModal,
        openChatEditorInteractive,
        deleteChatInteractive,
        syncProjectorFromRuntime,
        applyActiveChatProjectorToRuntime,
        persistProfiles: schedulePersistProfiles,
        persistChatStore: schedulePersistChatStore,
        persistProfilesNow,
        persistChatStoreNow,
    };

    window.VisualProjector.chats = API;

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => { boot().catch(() => {}); });
    } else {
        setTimeout(() => { boot().catch(() => {}); }, 0);
    }
})();
