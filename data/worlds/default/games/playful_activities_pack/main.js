(function () {
  'use strict';

  const GAME_ID = 'playful_activities_pack';

  const clamp = (n, a, b) => Math.max(a, Math.min(b, Number(n) || 0));
  const rnd = (a = 0, b = 1) => a + Math.random() * (b - a);
  const pick = (arr) => arr[Math.floor(Math.random() * arr.length)] || arr[0];
  const uid = (p = 'id') => `${p}_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 6)}`;
  const fmt = (n) => Number(n || 0).toFixed(2);

  const DEFAULT_STATE = {
    version: 1,
    createdAt: Date.now(),
    difficulty: 0.52,
    stats: {
      sessions: 0,
      wins: 0,
      losses: 0,
      draws: 0,
      pillowFight: 0,
      staringContest: 0,
      hideAndSeek: 0,
      chase: 0,
      dontLaugh: 0
    },
    sceneMood: {
      playfulness: 0.25,
      warmth: 0.1,
      tension: 0.08,
      ease: 0.2,
      energy: 0.8
    },
    settings: {
      autoPostResult: true,
      autoAskReaction: true,
      debugSceneEvents: true
    },
    lastResult: null,
    log: []
  };

  function normalizeState(s) {
    s = { ...DEFAULT_STATE, ...(s || {}) };
    s.stats = { ...DEFAULT_STATE.stats, ...(s.stats || {}) };
    const legacySocial = s.social && typeof s.social === 'object' ? s.social : {};
    s.sceneMood = { ...DEFAULT_STATE.sceneMood, ...(s.sceneMood || {}) };
    if (typeof legacySocial.playfulness === 'number') s.sceneMood.playfulness = legacySocial.playfulness;
    if (typeof legacySocial.affection === 'number') s.sceneMood.warmth = legacySocial.affection;
    if (typeof legacySocial.warmth === 'number') s.sceneMood.warmth = legacySocial.warmth;
    if (typeof legacySocial.tension === 'number') s.sceneMood.tension = legacySocial.tension;
    if (typeof legacySocial.comfort === 'number') s.sceneMood.ease = legacySocial.comfort;
    if (typeof legacySocial.ease === 'number') s.sceneMood.ease = legacySocial.ease;
    if (typeof legacySocial.energy === 'number') s.sceneMood.energy = legacySocial.energy;
    delete s.social;
    s.settings = { ...DEFAULT_STATE.settings, ...(s.settings || {}) };
    if (!Array.isArray(s.log)) s.log = [];
    s.difficulty = clamp(s.difficulty, 0.15, 0.9);
    return s;
  }

  function applyEffects(state, effects = {}) {
    const map = { warmth: 'warmth', ease: 'ease' };
    for (const [rawKey, v] of Object.entries(effects || {})) {
      const k = map[rawKey] || rawKey;
      if (typeof state.sceneMood[k] === 'number') state.sceneMood[k] = clamp(state.sceneMood[k] + Number(v || 0), 0, 1);
    }
  }

  function pushLog(state, type, text, meta = {}) {
    const row = { id: uid('log'), type, text: String(text || ''), meta, createdAt: Date.now() };
    state.log.push(row);
    if (state.log.length > 60) state.log = state.log.slice(-60);
    return row;
  }

  async function saveState(api, state) {
    await api.storage.setState(state);
  }

  async function completeActivity(api, state, result) {
    const normalized = await api.activities.complete(result);
    state.lastResult = normalized;
    state.stats.sessions += 1;
    if (normalized.activityId === 'pillow_fight') state.stats.pillowFight += 1;
    if (normalized.activityId === 'staring_contest') state.stats.staringContest += 1;
    if (normalized.activityId === 'hide_and_seek') state.stats.hideAndSeek += 1;
    if (normalized.activityId === 'chase') state.stats.chase += 1;
    if (normalized.activityId === 'dont_laugh') state.stats.dontLaugh += 1;
    if (normalized.status === 'completed') {
      if (normalized.outcome.includes('draw')) state.stats.draws += 1;
      else if (normalized.success) state.stats.wins += 1;
      else state.stats.losses += 1;
    }
    applyEffects(state, normalized.effects);
    pushLog(state, 'activity', normalized.summary || `${normalized.activityId}: ${normalized.outcome}`, { result: normalized });
    await saveState(api, state);
    return normalized;
  }

  function humanActivityName(id = '') {
    return String(id || 'activity').split(/[\/_-]+/).filter(Boolean).map(x => x.charAt(0).toUpperCase() + x.slice(1)).join(' ') || 'Activity';
  }

  function buildSceneEventNote(result, state = null) {
    if (!result) return '';
    const effects = Object.entries(result.effects || {}).map(([k, v]) => {
      const label = k === 'affection' ? 'warmth' : k === 'comfort' ? 'ease' : k;
      return `${label} ${Number(v) >= 0 ? '+' : ''}${Number(v).toFixed(3)}`;
    }).join(', ') || 'none';
    const compact = `🎮 ${humanActivityName(result.activityId)}: ${result.summary || result.outcome}${result.score !== null && result.score !== undefined ? ` Score: ${result.score}.` : ''}`;
    const debug = state?.settings?.debugSceneEvents !== false;
    if (!debug) return [
      '[SCENE EVENT: PLAYFUL ACTIVITY RESULT]',
      compact,
      'Use this as the latest shared physical/social event. The assistant should now react in character if prompted.',
      '[/SCENE EVENT]'
    ].join('\n');
    return [
      '[SCENE EVENT: PLAYFUL ACTIVITY RESULT]',
      compact,
      `Activity: ${result.activityId}`,
      `Outcome: ${result.outcome}`,
      `Success: ${result.success ? 'yes' : 'no'}`,
      `Score: ${result.score ?? 'n/a'}`,
      `Quality: ${result.quality || 'n/a'}`,
      `Scene mood effects: ${effects}`,
      `Tags: ${(result.tags || []).join(', ') || 'none'}`,
      'Use this as the latest shared physical/social event. The assistant should now react in character if prompted.',
      '[/SCENE EVENT]'
    ].join('\n');
  }

  async function postResultToChat(api, state, result = state.lastResult, opts = {}) {
    if (!result) return null;
    const note = buildSceneEventNote(result, state);
    api.chat.addSystemNote(note);
    pushLog(state, 'chat-note', `${result.activityId}: scene event posted to chat.`);
    await saveState(api, state);
    if (opts.requestAssistant && api.chat.requestAssistant) {
      setTimeout(() => {
        api.chat.requestAssistant('React to the latest playful activity result in character. Keep it natural and continue the roleplay scene.', { skipUserAppend: true })
          .catch(err => api.ui.toast(`Assistant reaction failed: ${err.message || err}`, 'error'));
      }, 120);
    }
    return note;
  }

  async function completeAndMaybePost(api, state, result, opts = {}) {
    const normalized = await completeActivity(api, state, result);
    const shouldPost = opts.autoPost !== false && state.settings?.autoPostResult !== false;
    const shouldReact = !!opts.requestAssistant && state.settings?.autoAskReaction !== false;
    if (shouldPost) await postResultToChat(api, state, normalized, { requestAssistant: shouldReact });
    return normalized;
  }

  function buildAftermathSystem(api, state) {
    return api.context.compose([
      'You are a playful roleplay activity narrator inside Visual Projector.',
      'React to the mini-game result with warmth, brevity and in-character friendliness.',
      'Do not claim hard physical facts beyond the provided activity result.',
      'You may suggest a tiny difficulty adjustment, but the game decides whether to apply it.',
      api.context.user(),
      api.context.activeProfile(),
      api.context.gameState({
        pack: 'Playful Activities Pack',
        difficulty: state.difficulty,
        sceneMood: state.sceneMood,
        lastResult: state.lastResult
      })
    ]);
  }

  async function askAftermath(api, state, source = 'manual') {
    if (!state.lastResult) {
      api.ui.toast('No activity result yet.', 'info');
      return null;
    }
    const fallback = {
      reaction: state.lastResult.summary || 'The playful moment settles into shared laughter.',
      recommendation: { difficultyDelta: 0, reason: 'fallback' }
    };
    const res = await api.llm.json({
      system: buildAftermathSystem(api, state),
      prompt: 'Return JSON with a short reaction and optional difficulty recommendation. Shape: {"reaction":"string","recommendation":{"difficultyDelta":number,"reason":"string"}}',
      shape: { reaction: 'string', recommendation: 'object' },
      fallback,
      maxTokens: 180,
      temperature: 0.7
    });
    const data = res.data || fallback;
    const delta = clamp(data.recommendation?.difficultyDelta || 0, -0.08, 0.08);
    if (Math.abs(delta) > 0.001) {
      state.difficulty = clamp(state.difficulty + delta, 0.15, 0.9);
      pushLog(state, 'difficulty', `LLM suggested difficulty ${delta > 0 ? '+' : ''}${delta.toFixed(2)}: ${data.recommendation?.reason || ''}`);
    }
    pushLog(state, 'aftermath', data.reaction, { source, ok: !!res.ok, recommendation: data.recommendation || null });
    await saveState(api, state);
    await api.projector.say(data.reaction, { role: 'assistant', type: 'playful-aftermath' });
    return data;
  }

  function renderDashboard(container, api, state) {
    container.innerHTML = `
      <div class="pap-root">
        <div class="pap-hero">
          <div>
            <div class="pap-kicker">Universal roleplay mini-games</div>
            <h2>🎈 Playful Activities Pack</h2>
            <p>Lightweight activities that fit ordinary character interaction: teasing, playing, hiding, chasing, laughing and friendly rivalry.</p>
          </div>
          <div class="pap-diff">
            <span>Difficulty</span>
            <b data-role="difficulty"></b>
          </div>
        </div>

        <div class="pap-grid">
          <button class="pap-card" data-act="pillow">
            <b>🛏️ Pillow Fight</b>
            <span>Turn-based playful duel with stamina, momentum and several rounds.</span>
          </button>
          <button class="pap-card" data-act="stare">
            <b>👀 Staring Contest</b>
            <span>Quick focus contest: hold composure while tension rises.</span>
          </button>
          <button class="pap-card" data-act="hide">
            <b>🙈 Hide and Seek</b>
            <span>Small multi-step guessing game with warm/cold hints.</span>
          </button>
          <button class="pap-card" data-act="chase">
            <b>🏃 Playful Chase</b>
            <span>A quick catch-up game about distance, choices and comic timing.</span>
          </button>
          <button class="pap-card" data-act="laugh">
            <b>😂 Don’t Laugh</b>
            <span>Try to keep composure while the character escalates the silliness.</span>
          </button>
        </div>

        <div class="pap-actions">
          <button class="vp-btn" data-act="aftermath">Ask LLM aftermath</button>
          <button class="vp-btn vp-btn-ghost" data-act="auto-pillow">Auto pillow fight</button>
          <button class="vp-btn vp-btn-ghost" data-act="easier">Difficulty -</button>
          <button class="vp-btn vp-btn-ghost" data-act="harder">Difficulty +</button>
          <button class="vp-btn vp-btn-ghost" data-act="copy">Copy active context</button>
          <button class="vp-btn vp-btn-ghost" data-act="post">Post result note to chat</button>
          <button class="vp-btn vp-btn-ghost" data-act="post-react">Post + ask reaction</button>
          <button class="vp-btn vp-btn-ghost" data-act="reset">Reset pack state</button>
        </div>

        <div class="pap-settings">
          <label><input type="checkbox" data-setting="autoPostResult"> Auto post result to chat</label>
          <label><input type="checkbox" data-setting="autoAskReaction"> Auto ask assistant reaction</label>
          <label><input type="checkbox" data-setting="debugSceneEvents"> Debug scene event details</label>
        </div>

        <div class="pap-panels">
          <div class="pap-panel">
            <h3>Scene mood <small>temporary</small></h3>
            <div class="pap-bars" data-role="bars"></div>
          </div>
          <div class="pap-panel">
            <h3>Recent activity</h3>
            <div class="pap-log" data-role="log"></div>
          </div>
          <div class="pap-panel pap-wide">
            <h3>Last result</h3>
            <pre data-role="last"></pre>
          </div>
        </div>
      </div>`;

    const q = (sel) => container.querySelector(sel);
    const render = () => {
      q('[data-role="difficulty"]').textContent = fmt(state.difficulty);
      q('[data-role="bars"]').innerHTML = '';
      for (const [k, v] of Object.entries(state.sceneMood)) {
        const row = document.createElement('div');
        row.className = 'pap-bar-row';
        row.innerHTML = `<span></span><div><i></i></div><b></b>`;
        row.querySelector('span').textContent = k;
        row.querySelector('i').style.width = `${Math.round(clamp(v, 0, 1) * 100)}%`;
        row.querySelector('b').textContent = fmt(v);
        q('[data-role="bars"]').appendChild(row);
      }
      const log = state.log.slice(-8).reverse();
      q('[data-role="log"]').innerHTML = '';
      if (!log.length) q('[data-role="log"]').innerHTML = '<div class="pap-muted">No activity yet.</div>';
      for (const row of log) {
        const div = document.createElement('div');
        div.className = 'pap-log-row';
        div.innerHTML = `<b></b><span></span><p></p>`;
        div.querySelector('b').textContent = row.type;
        div.querySelector('span').textContent = new Date(row.createdAt || Date.now()).toLocaleTimeString();
        div.querySelector('p').textContent = row.text || '';
        q('[data-role="log"]').appendChild(div);
      }
      q('[data-role="last"]').textContent = state.lastResult ? JSON.stringify(state.lastResult, null, 2) : 'No result yet.';
      container.querySelectorAll('[data-setting]').forEach(input => {
        input.checked = state.settings?.[input.dataset.setting] !== false;
      });
    };

    q('[data-act="pillow"]').addEventListener('click', () => openPillowFight(api, state, render));
    q('[data-act="stare"]').addEventListener('click', () => openStaringContest(api, state, render));
    q('[data-act="hide"]').addEventListener('click', () => openHideAndSeek(api, state, render));
    q('[data-act="chase"]').addEventListener('click', () => openChase(api, state, render));
    q('[data-act="laugh"]').addEventListener('click', () => openDontLaugh(api, state, render));
    q('[data-act="auto-pillow"]').addEventListener('click', async () => { await autoPillow(api, state); render(); });
    q('[data-act="aftermath"]').addEventListener('click', async () => { try { await askAftermath(api, state); render(); } catch (err) { api.ui.toast(`LLM aftermath failed: ${err.message || err}`, 'error'); } });
    q('[data-act="easier"]').addEventListener('click', async () => { state.difficulty = clamp(state.difficulty - 0.05, 0.15, 0.9); await saveState(api, state); render(); });
    q('[data-act="harder"]').addEventListener('click', async () => { state.difficulty = clamp(state.difficulty + 0.05, 0.15, 0.9); await saveState(api, state); render(); });
    q('[data-act="copy"]').addEventListener('click', async () => {
      const text = buildActiveContext(api, state);
      try { await navigator.clipboard.writeText(text); api.ui.toast('Activity Pack context copied', 'success'); }
      catch { api.ui.toast('Clipboard unavailable', 'error'); }
    });
    q('[data-act="post"]').addEventListener('click', async () => {
      if (!state.lastResult) { api.ui.toast('No result to post yet.', 'info'); return; }
      try { await postResultToChat(api, state, state.lastResult, { requestAssistant: false }); render(); api.ui.toast('Scene event posted to chat', 'success'); }
      catch (err) { api.ui.toast(`Post to chat failed: ${err.message || err}`, 'error'); }
    });
    q('[data-act="post-react"]').addEventListener('click', async () => {
      if (!state.lastResult) { api.ui.toast('No result to post yet.', 'info'); return; }
      try { await postResultToChat(api, state, state.lastResult, { requestAssistant: true }); render(); api.ui.toast('Scene event posted; requesting reaction...', 'success'); }
      catch (err) { api.ui.toast(`Post/react failed: ${err.message || err}`, 'error'); }
    });
    q('[data-act="reset"]').addEventListener('click', async () => {
      if (!confirm('Reset Playful Activities Pack state?')) return;
      const fresh = normalizeState({ createdAt: Date.now() });
      Object.keys(state).forEach(k => delete state[k]);
      Object.assign(state, fresh);
      await saveState(api, state);
      render();
    });
    container.querySelectorAll('[data-setting]').forEach(input => input.addEventListener('change', async () => {
      state.settings[input.dataset.setting] = !!input.checked;
      await saveState(api, state);
      render();
    }));
    render();
  }

  async function autoPillow(api, state) {
    const player = 50 + rnd(0, 40) - state.difficulty * 12;
    const npc = 45 + rnd(0, 45) + state.difficulty * 10;
    const success = player >= npc;
    const diff = Math.abs(player - npc);
    const outcome = diff < 7 ? 'playful_draw' : success ? 'user_won_pillow_fight' : 'npc_won_pillow_fight';
    const score = Math.round(clamp(50 + player - npc, 0, 100));
    return completeActivity(api, state, {
      activityId: 'pillow_fight',
      status: 'completed',
      outcome,
      success: outcome === 'playful_draw' ? true : success,
      score,
      quality: score > 75 ? 'excellent' : score > 55 ? 'good' : 'messy',
      effects: { playfulness: 0.05, warmth: 0.02, tension: -0.02, energy: -0.06 },
      tags: ['playful', 'turn-based', 'auto-resolve'],
      summary: outcome === 'playful_draw'
        ? 'The pillow fight ended in a breathless, laughing draw.'
        : success ? 'The user won the pillow fight with a perfect playful counterattack.' : 'The character won the pillow fight and looked far too pleased about it.',
      payload: { player, npc, difficulty: state.difficulty, mode: 'auto' }
    });
  }

  async function autoGeneric(api, state, activityId, opts = {}) {
    if (activityId === 'pillow_fight') return autoPillow(api, state);
    const diff = state.difficulty;
    const roll = rnd(0, 100) + (0.5 - diff) * 18;
    const success = roll >= 48;
    const common = { status: 'completed', success, score: Math.round(clamp(roll, 0, 100)), quality: roll > 78 ? 'excellent' : roll > 56 ? 'good' : 'messy' };
    const table = {
      chase: {
        activityId: 'chase', outcome: success ? 'caught_character' : 'character_escaped_laughing',
        tags: ['playful', 'chase', 'auto-resolve'], effects: { playfulness: 0.05, warmth: success ? 0.02 : 0.01, tension: -0.015, energy: -0.055 },
        summary: success ? 'The user caught up during the playful chase, turning it into shared laughter.' : 'The character escaped the playful chase while laughing over their shoulder.'
      },
      dont_laugh: {
        activityId: 'dont_laugh', outcome: success ? 'npc_laughed_first' : 'user_laughed_first',
        tags: ['playful', 'dont-laugh', 'auto-resolve'], effects: { playfulness: 0.06, warmth: 0.015, tension: -0.025, energy: -0.02 },
        summary: success ? 'The character laughed first during the Don’t Laugh challenge.' : 'The user laughed first during the Don’t Laugh challenge.'
      },
      staring_contest: {
        activityId: 'staring_contest', outcome: success ? 'npc_looked_away_first' : 'user_looked_away_first',
        tags: ['playful', 'staring-contest', 'auto-resolve'], effects: { playfulness: 0.035, warmth: 0.02, tension: 0.02, energy: -0.015 },
        summary: success ? 'The character looked away first, visibly flustered.' : 'The user looked away first, making the character smile triumphantly.'
      },
      hide_and_seek: {
        activityId: 'hide_and_seek', outcome: success ? 'found_npc' : 'npc_stayed_hidden',
        tags: ['playful', 'hide-and-seek', 'auto-resolve'], effects: { playfulness: 0.045, warmth: 0.012, tension: -0.012, energy: -0.025 },
        summary: success ? 'The user found the character after a playful little search.' : 'The character stayed hidden and tried not to laugh.'
      }
    };
    const base = table[activityId];
    if (!base) throw new Error(`Unknown activity: ${activityId}`);
    return completeActivity(api, state, { ...common, ...base, payload: { mode: 'auto', difficulty: diff, request: opts.request || null } });
  }

  function openPillowFight(api, state, onUpdate) {
    const session = {
      id: uid('pillow'),
      round: 1,
      maxRounds: 5,
      playerHp: 100,
      npcHp: 100,
      playerScore: 0,
      npcScore: 0,
      momentum: 0,
      difficulty: state.difficulty,
      events: []
    };
    const moves = {
      quick: { label: 'Quick swat', power: 12, risk: 0.12, stamina: 5, beats: 'feint' },
      guard: { label: 'Fluffy guard', power: 5, risk: 0.03, stamina: -3, beats: 'quick' },
      feint: { label: 'Silly feint', power: 9, risk: 0.08, stamina: 4, beats: 'guard' },
      risky: { label: 'All-out pillow storm', power: 18, risk: 0.24, stamina: 10, beats: 'quick' }
    };
    const npcMoves = ['quick', 'guard', 'feint', 'risky'];

    function resolveMove(playerMove) {
      const npcMove = pick(npcMoves);
      const pm = moves[playerMove];
      const nm = moves[npcMove];
      let playerHit = pm.power + rnd(-4, 7) + session.momentum * 1.5 - session.difficulty * 5;
      let npcHit = nm.power + rnd(-4, 7) + session.difficulty * 7 - session.momentum;
      if (pm.beats === npcMove) playerHit += 8;
      if (nm.beats === playerMove) npcHit += 8;
      if (Math.random() < pm.risk) playerHit *= 0.35;
      if (Math.random() < nm.risk) npcHit *= 0.35;
      if (playerMove === 'guard') npcHit *= 0.55;
      if (npcMove === 'guard') playerHit *= 0.55;
      playerHit = Math.max(0, Math.round(playerHit));
      npcHit = Math.max(0, Math.round(npcHit));
      session.npcHp = clamp(session.npcHp - playerHit, 0, 100);
      session.playerHp = clamp(session.playerHp - npcHit, 0, 100);
      session.playerScore += playerHit;
      session.npcScore += npcHit;
      session.momentum = clamp(session.momentum + (playerHit - npcHit) / 12, -4, 4);
      const line = `${pm.label} vs ${nm.label}: you land ${playerHit}, they land ${npcHit}.`;
      session.events.push({ round: session.round, playerMove, npcMove, playerHit, npcHit, line });
      session.round += 1;
    }

    function finish(overlay, reason = 'completed') {
      const draw = Math.abs(session.playerScore - session.npcScore) < 8;
      const success = session.playerScore >= session.npcScore;
      const outcome = draw ? 'laughing_draw' : success ? 'user_won_pillow_fight' : 'npc_won_pillow_fight';
      const score = Math.round(clamp(50 + session.playerScore - session.npcScore, 0, 100));
      overlay.close({ completed: true, result: {
        activityId: 'pillow_fight', status: reason, outcome, success: draw ? true : success, score,
        quality: score > 78 ? 'excellent' : score > 56 ? 'good' : 'messy',
        durationMs: Date.now() - Number(session.id.split('_')[1] || Date.now()),
        effects: { playfulness: 0.07, warmth: success ? 0.025 : 0.015, tension: -0.025, energy: -0.08, ease: 0.015 },
        tags: ['playful', 'pillow-fight', 'turn-based'],
        summary: draw ? 'The pillow fight dissolved into a laughing draw.' : success ? 'The user won the pillow fight after a chaotic flurry of soft attacks.' : 'The character won the pillow fight and celebrated with dramatic smugness.',
        payload: { session }
      }});
    }

    api.activities.openOverlay({
      title: '🛏️ Pillow Fight',
      mount(body, overlay) {
        body.innerHTML = `
          <div class="pap-overlay pap-pillow">
            <div class="pap-overlay-card">
              <h1>🛏️ Pillow Fight</h1>
              <p>A soft, silly turn-based duel. Pick a move each round; the character answers with their own move.</p>
              <div class="pap-combat">
                <div><b>You</b><meter min="0" max="100" value="100" data-role="php"></meter><span data-role="pstat"></span></div>
                <div><b>Character</b><meter min="0" max="100" value="100" data-role="nhp"></meter><span data-role="nstat"></span></div>
              </div>
              <div class="pap-round" data-role="round"></div>
              <div class="pap-moves">
                <button class="vp-btn" data-move="quick">Quick swat</button>
                <button class="vp-btn vp-btn-ghost" data-move="guard">Fluffy guard</button>
                <button class="vp-btn vp-btn-ghost" data-move="feint">Silly feint</button>
                <button class="vp-btn vp-btn-ghost" data-move="risky">Pillow storm</button>
              </div>
              <div class="pap-actions"><button class="vp-btn vp-btn-ghost" data-act="auto">Auto-finish</button></div>
              <div class="pap-event-log" data-role="events"></div>
            </div>
          </div>`;
        const q = (sel) => body.querySelector(sel);
        const render = () => {
          q('[data-role="php"]').value = session.playerHp;
          q('[data-role="nhp"]').value = session.npcHp;
          q('[data-role="pstat"]').textContent = `${Math.round(session.playerHp)} stamina · score ${session.playerScore}`;
          q('[data-role="nstat"]').textContent = `${Math.round(session.npcHp)} stamina · score ${session.npcScore}`;
          q('[data-role="round"]').textContent = `Round ${Math.min(session.round, session.maxRounds)} / ${session.maxRounds} · momentum ${session.momentum.toFixed(1)}`;
          q('[data-role="events"]').innerHTML = session.events.slice(-7).reverse().map(e => `<div>${e.line}</div>`).join('') || '<div>Choose your opening move.</div>';
        };
        body.querySelectorAll('[data-move]').forEach(btn => btn.addEventListener('click', () => {
          resolveMove(btn.dataset.move);
          render();
          if (session.round > session.maxRounds || session.playerHp <= 0 || session.npcHp <= 0) finish(overlay);
        }));
        q('[data-act="auto"]').addEventListener('click', () => {
          while (session.round <= session.maxRounds && session.playerHp > 0 && session.npcHp > 0) resolveMove(pick(Object.keys(moves)));
          render(); finish(overlay);
        });
        render();
      },
      async onClose(payload) {
        if (payload?.completed && payload.result) {
          await completeAndMaybePost(api, state, payload.result, { requestAssistant: true });
          onUpdate?.();
          api.ui.toast('Pillow fight result saved; requesting reaction...', 'success');
        }
      }
    });
  }

  function openStaringContest(api, state, onUpdate) {
    const session = { focus: 50, npcFocus: 50, ticks: 0, maxTicks: 8, events: [] };
    api.activities.openOverlay({
      title: '👀 Staring Contest',
      mount(body, overlay) {
        body.innerHTML = `
          <div class="pap-overlay"><div class="pap-overlay-card pap-stare">
            <h1>👀 Staring Contest</h1>
            <p>Keep composure. Each choice changes focus and playful tension.</p>
            <div class="pap-combat"><div><b>You</b><meter min="0" max="100" value="50" data-role="f"></meter></div><div><b>Character</b><meter min="0" max="100" value="50" data-role="nf"></meter></div></div>
            <div class="pap-moves"><button class="vp-btn" data-act="steady">Stay steady</button><button class="vp-btn vp-btn-ghost" data-act="tease">Tease them</button><button class="vp-btn vp-btn-ghost" data-act="soft">Smile softly</button></div>
            <div class="pap-event-log" data-role="log"></div>
          </div></div>`;
        const q = s => body.querySelector(s);
        const step = (act) => {
          session.ticks++;
          if (act === 'steady') session.focus += rnd(6, 13);
          if (act === 'tease') { session.focus += rnd(-5, 9); session.npcFocus -= rnd(3, 12); }
          if (act === 'soft') { session.focus += rnd(0, 8); session.npcFocus += rnd(-8, 5); }
          session.npcFocus += rnd(-5, 10) + state.difficulty * 4;
          session.focus = clamp(session.focus, 0, 100); session.npcFocus = clamp(session.npcFocus, 0, 100);
          session.events.push(pick(['The silence turns warm and ridiculous.', 'Someone almost laughs.', 'The eye contact becomes dangerously intense.', 'A tiny smile threatens the whole contest.']));
          render();
          if (session.ticks >= session.maxTicks || session.focus >= 100 || session.npcFocus >= 100 || session.focus <= 0 || session.npcFocus <= 0) finish();
        };
        const render = () => { q('[data-role="f"]').value = session.focus; q('[data-role="nf"]').value = session.npcFocus; q('[data-role="log"]').innerHTML = session.events.slice(-6).reverse().map(x => `<div>${x}</div>`).join('') || '<div>First to lose composure loses.</div>'; };
        const finish = () => {
          const success = session.focus >= session.npcFocus;
          const draw = Math.abs(session.focus - session.npcFocus) < 5;
          overlay.close({ completed: true, result: {
            activityId: 'staring_contest', status: 'completed', outcome: draw ? 'mutual_blush_draw' : success ? 'npc_looked_away_first' : 'user_looked_away_first', success: draw ? true : success,
            score: Math.round(clamp(50 + session.focus - session.npcFocus, 0, 100)), quality: draw ? 'tender' : success ? 'good' : 'flustered',
            effects: { playfulness: 0.04, warmth: 0.025, tension: 0.025, ease: 0.01, energy: -0.02 }, tags: ['playful', 'staring-contest', 'social'],
            summary: draw ? 'The staring contest ended with both sides breaking into embarrassed laughter.' : success ? 'The character looked away first, visibly flustered.' : 'The user looked away first, making the character smile triumphantly.', payload: { session }
          }});
        };
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => step(b.dataset.act)));
        render();
      },
      async onClose(payload) { if (payload?.completed) { await completeAndMaybePost(api, state, payload.result, { requestAssistant: true }); onUpdate?.(); } }
    });
  }

  function openHideAndSeek(api, state, onUpdate) {
    const spots = ['behind the curtains', 'under a blanket', 'near the door', 'behind the sofa', 'in the shadowy corner', 'somewhere comically obvious'];
    const target = pick(spots);
    let tries = 0;
    api.activities.openOverlay({
      title: '🙈 Hide and Seek',
      mount(body, overlay) {
        body.innerHTML = `<div class="pap-overlay"><div class="pap-overlay-card"><h1>🙈 Hide and Seek</h1><p>The character hides somewhere nearby. Pick a place to search.</p><div class="pap-choices"></div><div class="pap-event-log" data-role="hint"><div>Listen for tiny suspicious noises...</div></div></div></div>`;
        const choices = body.querySelector('.pap-choices');
        spots.forEach(spot => {
          const btn = document.createElement('button'); btn.className = 'vp-btn vp-btn-ghost'; btn.textContent = spot;
          btn.addEventListener('click', () => {
            tries++;
            if (spot === target) return finish(true, spot);
            const hint = tries >= 3 ? `Very warm. It is not ${spot}.` : pick(['Cold.', 'Warmer.', 'You hear a suspicious giggle.', 'Something rustles nearby.']);
            body.querySelector('[data-role="hint"]').innerHTML = `<div>${hint}</div>`;
            if (tries >= 4) finish(false, spot);
          });
          choices.appendChild(btn);
        });
        function finish(found, lastSpot) {
          overlay.close({ completed: true, result: {
            activityId: 'hide_and_seek', status: 'completed', outcome: found ? 'found_npc' : 'npc_stayed_hidden', success: found,
            score: found ? Math.round(clamp(100 - tries * 15, 35, 100)) : 28, quality: found && tries <= 2 ? 'excellent' : found ? 'good' : 'sneaky',
            effects: { playfulness: 0.055, warmth: 0.015, tension: -0.015, energy: -0.035 }, tags: ['playful', 'hide-and-seek', 'guessing'],
            summary: found ? `The user found the character ${target} after ${tries} tries.` : `The character stayed hidden and tried not to laugh while the user searched ${lastSpot}.`, payload: { target, tries, lastSpot }
          }});
        }
      },
      async onClose(payload) { if (payload?.completed) { await completeAndMaybePost(api, state, payload.result, { requestAssistant: true }); onUpdate?.(); } }
    });
  }


  function openChase(api, state, onUpdate) {
    const session = { distance: 55, round: 1, maxRounds: 6, score: 0, events: [] };
    const actions = {
      sprint: { label: 'Sprint forward', delta: -18, risk: 0.24 },
      cut: { label: 'Cut the corner', delta: -13, risk: 0.14 },
      fake: { label: 'Fake them out', delta: -9, risk: 0.08 },
      pause: { label: 'Let them get cocky', delta: -5, risk: 0.03 }
    };
    api.activities.openOverlay({
      title: '🏃 Playful Chase',
      mount(body, overlay) {
        body.innerHTML = `
          <div class="pap-overlay"><div class="pap-overlay-card">
            <h1>🏃 Playful Chase</h1>
            <p>Close the distance before the character escapes. It can be physical, imaginary, or just a playful chat scene.</p>
            <div class="pap-distance"><b>Distance</b><meter min="0" max="100" value="55" data-role="dist"></meter><span data-role="dtext"></span></div>
            <div class="pap-moves">
              <button class="vp-btn" data-act="sprint">Sprint</button>
              <button class="vp-btn vp-btn-ghost" data-act="cut">Cut corner</button>
              <button class="vp-btn vp-btn-ghost" data-act="fake">Fake out</button>
              <button class="vp-btn vp-btn-ghost" data-act="pause">Play it cool</button>
            </div>
            <div class="pap-event-log" data-role="log"></div>
          </div></div>`;
        const q = sel => body.querySelector(sel);
        const render = () => {
          q('[data-role="dist"]').value = session.distance;
          q('[data-role="dtext"]').textContent = `${Math.round(session.distance)} steps · round ${session.round}/${session.maxRounds}`;
          q('[data-role="log"]').innerHTML = session.events.slice(-7).reverse().map(x => `<div>${x}</div>`).join('') || '<div>They grin and dart away. Catch up!</div>';
        };
        const step = (act) => {
          const a = actions[act];
          let delta = a.delta + rnd(-5, 6) + state.difficulty * 8;
          if (Math.random() < a.risk) delta *= -0.35;
          const npcSlip = Math.random() < (0.12 + (1 - state.difficulty) * 0.08);
          if (npcSlip) delta -= rnd(8, 16);
          session.distance = clamp(session.distance + delta, 0, 100);
          session.score += Math.max(0, -delta);
          session.events.push(npcSlip ? `${a.label}: they almost slip from laughing, and you gain ground!` : `${a.label}: distance is now ${Math.round(session.distance)}.`);
          session.round++;
          render();
          if (session.distance <= 0 || session.distance >= 100 || session.round > session.maxRounds) finish();
        };
        const finish = () => {
          const success = session.distance <= 25;
          const outcome = session.distance <= 0 ? 'caught_character' : success ? 'close_enough_to_tag' : 'character_escaped_laughing';
          overlay.close({ completed: true, result: {
            activityId: 'chase', status: 'completed', outcome, success,
            score: Math.round(clamp(100 - session.distance + session.score * 0.25, 0, 100)), quality: success ? 'good' : 'slippery',
            effects: { playfulness: 0.06, warmth: success ? 0.02 : 0.01, tension: -0.018, energy: -0.07, ease: 0.01 },
            tags: ['playful', 'chase', 'movement'],
            summary: success ? 'The user caught up during the playful chase, turning it into shared laughter.' : 'The character escaped the playful chase while laughing over their shoulder.',
            payload: { session }
          }});
        };
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => step(b.dataset.act)));
        render();
      },
      async onClose(payload) { if (payload?.completed) { await completeAndMaybePost(api, state, payload.result, { requestAssistant: true }); onUpdate?.(); } }
    });
  }

  function openDontLaugh(api, state, onUpdate) {
    const session = { composure: 70, npcComposure: 70, round: 1, maxRounds: 6, events: [] };
    const prompts = [
      'They make an absurdly serious face.',
      'They whisper the worst joke with total confidence.',
      'They try to stay dignified and fail immediately.',
      'They wiggle their eyebrows like this is a dramatic duel.',
      'A tiny snort almost escapes from one of you.'
    ];
    api.activities.openOverlay({
      title: '😂 Don’t Laugh',
      mount(body, overlay) {
        body.innerHTML = `
          <div class="pap-overlay"><div class="pap-overlay-card">
            <h1>😂 Don’t Laugh</h1>
            <p>Hold composure while the silliness escalates. You can stay calm, counter-tease, or make it worse on purpose.</p>
            <div class="pap-combat"><div><b>You</b><meter min="0" max="100" value="70" data-role="c"></meter></div><div><b>Character</b><meter min="0" max="100" value="70" data-role="nc"></meter></div></div>
            <div class="pap-moves"><button class="vp-btn" data-act="calm">Keep a straight face</button><button class="vp-btn vp-btn-ghost" data-act="counter">Counter-tease</button><button class="vp-btn vp-btn-ghost" data-act="escalate">Make it worse</button></div>
            <div class="pap-event-log" data-role="log"></div>
          </div></div>`;
        const q = sel => body.querySelector(sel);
        const render = () => {
          q('[data-role="c"]').value = session.composure;
          q('[data-role="nc"]').value = session.npcComposure;
          q('[data-role="log"]').innerHTML = session.events.slice(-7).reverse().map(x => `<div>${x}</div>`).join('') || '<div>The challenge begins. No laughing.</div>';
        };
        const step = (act) => {
          session.round++;
          if (act === 'calm') { session.composure += rnd(3, 9); session.npcComposure -= rnd(3, 8); }
          if (act === 'counter') { session.composure -= rnd(0, 8); session.npcComposure -= rnd(8, 18); }
          if (act === 'escalate') { session.composure -= rnd(8, 20); session.npcComposure -= rnd(8, 20); }
          session.composure -= rnd(3, 8) + state.difficulty * 4;
          session.npcComposure -= rnd(2, 7);
          session.composure = clamp(session.composure, 0, 100);
          session.npcComposure = clamp(session.npcComposure, 0, 100);
          session.events.push(pick(prompts));
          render();
          if (session.composure <= 0 || session.npcComposure <= 0 || session.round > session.maxRounds) finish();
        };
        const finish = () => {
          const both = session.composure <= 0 && session.npcComposure <= 0;
          const success = both || session.composure >= session.npcComposure;
          const outcome = both ? 'both_laughed' : session.npcComposure <= 0 ? 'npc_laughed_first' : session.composure <= 0 ? 'user_laughed_first' : success ? 'user_kept_composure' : 'npc_kept_composure';
          overlay.close({ completed: true, result: {
            activityId: 'dont_laugh', status: 'completed', outcome, success,
            score: Math.round(clamp(50 + session.composure - session.npcComposure, 0, 100)), quality: both ? 'chaotic' : success ? 'good' : 'silly',
            effects: { playfulness: 0.075, warmth: 0.018, tension: -0.03, energy: -0.025, ease: 0.015 },
            tags: ['playful', 'dont-laugh', 'social'],
            summary: both ? 'Both sides broke into laughter at nearly the same time.' : success ? 'The user survived the Don’t Laugh challenge better than the character.' : 'The character won the Don’t Laugh challenge with unbearable smugness.',
            payload: { session }
          }});
        };
        body.querySelectorAll('[data-act]').forEach(b => b.addEventListener('click', () => step(b.dataset.act)));
        render();
      },
      async onClose(payload) { if (payload?.completed) { await completeAndMaybePost(api, state, payload.result, { requestAssistant: true }); onUpdate?.(); } }
    });
  }

  function buildActiveContext(api, state) {
    return api.context.compose([
      '[ACTIVE GAME CONTEXT: Playful Activities Pack]',
      'This pack provides light, optional, playful roleplay activities. It is not a strict simulator.',
      'Use activity results as shared roleplay flavor, not as hard constraints unless the user wants that.',
      '[PLAYFUL ACTIVITY PACK RULES]\nScene mood is temporary atmosphere from recent playful activities, not permanent relationship truth. Use it lightly to adjust tone. Do not roleplay a whole mini-game inside chat after emitting an activity command; the host will open UI or ask consent. After a PLAYFUL ACTIVITY RESULT scene event, react naturally in character and continue the scene.\n[/PLAYFUL ACTIVITY PACK RULES]',
      api.context.gameState({
        difficulty: state.difficulty,
        sceneMood: state.sceneMood,
        settings: state.settings,
        lastResult: state.lastResult,
        stats: state.stats,
        recentActivityLog: (state.log || []).slice(-6).map(x => ({ type: x.type, text: x.text }))
      }),
      api.context.commands([
        { name: '[ACTIVITY_REQUEST:playful_activities_pack/pillow_fight]', description: 'Suggest a soft turn-based pillow duel. Use only when it naturally fits and do not force-start.' },
        { name: '[ACTIVITY_REQUEST:playful_activities_pack/chase]', description: 'Suggest playful chase/dogonyalki.' },
        { name: '[ACTIVITY_REQUEST:playful_activities_pack/hide_and_seek]', description: 'Suggest a small hide-and-seek guessing game.' },
        { name: '[ACTIVITY_REQUEST:playful_activities_pack/dont_laugh]', description: 'Suggest a Don’t Laugh composure challenge.' },
        { name: '[ACTIVITY_REQUEST:playful_activities_pack/staring_contest]', description: 'Suggest a staring contest.' },
        { name: '[ACTIVITY_ACCEPT]', description: 'Use if the character accepts a pending activity proposed by the user.' },
        { name: '[ACTIVITY_DECLINE]', description: 'Use if the character declines a pending activity. Refusal is a valid social event.' },
        { name: 'REACT_TO_ACTIVITY_RESULT', description: 'React to the latest activity result in character.' },
        { name: 'ADJUST_DIFFICULTY_SOFTLY', description: 'Only recommend easier/harder difficulty; the game validates changes.' }
      ]),
      'Available built-in activities: pillow_fight, staring_contest, hide_and_seek, chase, dont_laugh. Activity commands are hidden from the user after execution, like image/effect commands.'
    ]);
  }

  VP_GAMES.register({
    id: GAME_ID,
    title: 'Playful Activities Pack',
    _api: null,
    _state: null,

    async activate(api) {
      this._api = api;
      this._state = normalizeState(await api.storage.getState(DEFAULT_STATE));
      await api.storage.setState(this._state);
    },

    async deactivate(api) {
      if (this._state && (api || this._api)) await (api || this._api).storage.setState(this._state);
    },

    buildPromptContext(api) {
      const liveApi = this._api || api;
      const state = this._state;
      if (!liveApi || !state) return '';
      return buildActiveContext(liveApi, state);
    },

    async startActivity(activityId, api, opts = {}) {
      this._api = api;
      this._state = normalizeState(await api.storage.getState(DEFAULT_STATE));
      await api.storage.setState(this._state);
      const render = () => {};
      const id = String(activityId || '').trim();
      if (opts.auto) return this.autoResolveActivity(id, api, opts);
      if (id === 'pillow_fight') return openPillowFight(api, this._state, render);
      if (id === 'staring_contest') return openStaringContest(api, this._state, render);
      if (id === 'hide_and_seek') return openHideAndSeek(api, this._state, render);
      if (id === 'chase') return openChase(api, this._state, render);
      if (id === 'dont_laugh') return openDontLaugh(api, this._state, render);
      throw new Error(`Unknown Playful Activity: ${id}`);
    },

    async autoResolveActivity(activityId, api, opts = {}) {
      this._api = api;
      this._state = normalizeState(await api.storage.getState(DEFAULT_STATE));
      const result = await autoGeneric(api, this._state, String(activityId || '').trim(), opts);
      if (opts.autoPost !== false && this._state.settings?.autoPostResult !== false) {
        await postResultToChat(api, this._state, result, { requestAssistant: opts.requestAssistant !== false && this._state.settings?.autoAskReaction !== false });
      }
      await api.storage.setState(this._state);
      return result;
    },

    async mount(container, api) {
      this._api = api;
      this._state = normalizeState(await api.storage.getState(DEFAULT_STATE));
      await api.storage.setState(this._state);
      renderDashboard(container, api, this._state);
    },

    async unmount() {
      if (this._api && this._state) await this._api.storage.setState(this._state);
    }
  });
})();
