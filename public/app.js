'use strict';

// ─── Station detection ─────────────────────────────────────────────────────────
const _pathMatch = location.pathname.match(/\/station\/(\d+)/);
const STATION_ID = _pathMatch
  ? parseInt(_pathMatch[1])
  : parseInt(new URLSearchParams(location.search).get('station')) || 1;

// ─── Mode config (mirrors server) ─────────────────────────────────────────────
const MODES_META = {
  'keyboard-race':     { label: 'Keyboard Race',     tagline: 'Classic WPM race.', icon: '⌨️',  playerCount: 2, rounds: 1 },
  'voice-vs-keyboard': { label: 'Voice vs Keyboard', tagline: 'One talks. One types.', icon: '🎙️', playerCount: 2, rounds: 1 },
  'swap-duel':         { label: 'Swap Duel',          tagline: 'Both do both. Fairest battle.', icon: '🔄', playerCount: 2, rounds: 2 },
  'beat-the-keyboard': { label: 'Beat the Keyboard',  tagline: 'Solo challenge.', icon: '🥊',    playerCount: 1, rounds: 2 },
  'hinglish-hustle':   { label: 'Hinglish Hustle',    tagline: 'Mix it up.', icon: '🇮🇳',         playerCount: 2, rounds: 1 },
  'prompt-royale':     { label: 'Prompt Royale',      tagline: 'Real-world writing.', icon: '✍️', playerCount: 2, rounds: 1 },
};

const BADGE_META = {
  keyboard_slayer:  { label: 'Keyboard Slayer',    emoji: '⚔️' },
  flow_state:       { label: 'Flow State',          emoji: '🌊' },
  no_hands:         { label: 'No Hands Needed',     emoji: '🎙️' },
  speed_demon:      { label: 'Speed Demon',         emoji: '⚡' },
  clean_talker:     { label: 'Clean Talker',        emoji: '✨' },
  keyboard_survivor:{ label: 'Keyboard Survivor',   emoji: '🛡️' },
};

// ─── State ─────────────────────────────────────────────────────────────────────
let ws            = null;
let serverSession = null;
let serverConfig  = null;
let names         = [];
let clientState   = null;   // 'mode-select' — client-only pre-session state
let playerName    = null;
let playerCompany = '';
let recognition   = null;

// Race state
let currentPrompt  = '';
let currentMode    = '';    // 'keyboard' | 'voice'
let typedText      = '';
let raceStartTime  = null;
let corrections    = 0;
let backspaces     = 0;
let wpmTimer       = null;
let clockTimer     = null;
let rtTimer        = null;
let nextRaceTimer  = null;
let roundEndSent   = false;
let lastRoundResult = null;

// ─── Boot ──────────────────────────────────────────────────────────────────────
(function init() {
  el('station-badge').textContent = `STATION ${STATION_ID}`;
  document.title = `Flow Fight — Station ${STATION_ID}`;
  document.addEventListener('keydown', globalKeyHandler);
  connectWS();
})();

// ─── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}`);
  ws.onopen = () => send({ type: 'station:join', stationId: STATION_ID });

  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };

  ws.onclose = () => {
    renderScreen('connecting');
    setTimeout(connectWS, 2000);
  };
}

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── Message handler ───────────────────────────────────────────────────────────
function handleMsg(msg) {
  switch (msg.type) {

    case 'state:update':
      serverSession = msg.session;
      if (msg.config) { serverConfig = msg.config; buildModeGrid(); }
      onStateChange();
      break;

    case 'config:update':
      serverConfig = msg.config;
      buildModeGrid();
      break;

    case 'names':
      names = msg.names || [];
      if (deriveScreen() === 'name-entry') renderNameList(names);
      break;

    case 'countdown:tick':
      onCountdownTick(msg.count);
      break;

    case 'opponent:update':
      onOpponentUpdate(msg.progress, msg.usableWpm);
      break;

    case 'round:results':
      lastRoundResult = msg.round;
      break;

    case 'session:results':
      // Fetch fresh leaderboard and push into the results screen if it's showing
      fetch('/api/leaderboard')
        .then(r => r.json())
        .then(entries => renderLeaderboard(entries, 'result-leaderboard'))
        .catch(() => {});
      break;

    case 'toast':
      notify(msg.message, 'info');
      break;
  }
}

// ─── Screen routing ────────────────────────────────────────────────────────────
function onStateChange() {
  // If server just created a session, exit local mode-select
  if (serverSession && clientState === 'mode-select') clientState = null;
  const screen = deriveScreen();
  renderScreen(screen);
  populateScreen(screen);
}

function deriveScreen() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return 'connecting';
  if (clientState === 'mode-select') return 'mode-select';
  if (!serverSession) return 'idle';

  const { state, players, mode } = serverSession;
  const meta = MODES_META[mode];
  const me   = players?.[STATION_ID];

  // Station 2 spectating a solo mode
  if (meta?.playerCount === 1 && STATION_ID === 2 && state === 'racing') return 'spectator';

  switch (state) {
    case 'name-entry':     return me?.isReady ? 'waiting' : 'name-entry';
    case 'countdown':      return 'countdown';
    case 'racing':         return me ? 'racing' : 'spectator';
    case 'round-transition': return me ? 'round-transition' : 'spectator';
    case 'results':        return 'results';
    case 'cta':            return 'cta';
    default:               return 'idle';
  }
}

function renderScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = el(`screen-${name}`);
  if (s) s.classList.add('active');
}

// ─── Screen population ─────────────────────────────────────────────────────────
function populateScreen(screen) {
  switch (screen) {
    case 'idle':        populateIdle(); break;
    case 'name-entry':  populateNameEntry(); break;
    case 'waiting':     populateWaiting(); break;
    case 'countdown':   populateCountdown(); break;
    case 'racing':      populateRacing(); break;
    case 'round-transition': populateRoundTransition(); break;
    case 'results':     populateResults(); break;
    case 'cta':         populateCta(); break;
  }
}

// ─── IDLE ──────────────────────────────────────────────────────────────────────
function populateIdle() {
  // Fetch top leaderboard entries via REST
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(entries => renderLeaderboard(entries, 'idle-leaderboard'))
    .catch(() => renderLeaderboard([], 'idle-leaderboard'));
}

function listenForAnyKey() {
  function onKey(e) {
    if (e.ctrlKey || e.metaKey || e.key === 'Escape') return;
    if (deriveScreen() !== 'idle') { document.removeEventListener('keydown', onKey); return; }
    document.removeEventListener('keydown', onKey);
    clientState = 'mode-select';
    renderScreen('mode-select');
  }
  document.addEventListener('keydown', onKey);
}

// ─── MODE SELECT ───────────────────────────────────────────────────────────────
function buildModeGrid() {
  const enabled = serverConfig?.enabledModes || Object.keys(MODES_META);
  const grid = el('mode-grid');
  if (!grid) return;
  grid.innerHTML = enabled.map(modeId => {
    const m = MODES_META[modeId] || serverConfig?.modes?.[modeId];
    if (!m) return '';
    return `<div class="mode-card" data-mode="${esc(modeId)}" onclick="selectMode('${esc(modeId)}')">
      <div class="mode-icon">${m.icon || '🎮'}</div>
      <div class="mode-label">${esc(m.label)}</div>
      <div class="mode-tagline">${esc(m.tagline || '')}</div>
    </div>`;
  }).join('');
}

function selectMode(modeId) {
  clientState = null;
  send({ type: 'mode:select', mode: modeId });
}

// ─── NAME ENTRY ────────────────────────────────────────────────────────────────
function populateNameEntry() {
  playerName = null;
  playerCompany = '';
  el('name-search').value = '';
  el('company-input').value = '';
  el('confirm-section').style.display = 'none';
  el('speech-section').style.display = '';
  el('adhoc-section').style.display = 'none';
  el('selected-name').textContent = '';
  renderNameList(names);
  setupSpeech();
  setTimeout(() => el('name-search').focus(), 100);
}

function onNameSearch(query) {
  const q = query.toLowerCase().trim();
  const filtered = q ? names.filter(n => n.toLowerCase().includes(q)) : names;
  renderNameList(filtered);
  // Show ad hoc button if query has 2+ chars and no exact match
  const adhoc = el('adhoc-section');
  const preview = el('adhoc-name-preview');
  if (q.length >= 2 && !names.some(n => n.toLowerCase() === q)) {
    const display = query.trim().replace(/\b\w/g, c => c.toUpperCase());
    preview.textContent = display;
    adhoc.style.display = '';
  } else {
    adhoc.style.display = 'none';
  }
}

function useAdhocName() {
  const raw = el('name-search').value.trim();
  if (!raw) return;
  const display = raw.replace(/\b\w/g, c => c.toUpperCase());
  selectName(display);
}

function renderNameList(list) {
  const container = el('name-list');
  if (!list.length) { container.innerHTML = '<p class="no-results">No names found</p>'; return; }
  container.innerHTML = list.slice(0, 20).map(name => {
    const cls = name === playerName ? 'name-btn selected' : 'name-btn';
    return `<button class="${cls}" data-name="${esc(name)}">${esc(name)}</button>`;
  }).join('');
  container.querySelectorAll('.name-btn').forEach(btn => {
    btn.addEventListener('click', () => selectName(btn.dataset.name));
  });
}

function selectName(name) {
  playerName = name;
  el('selected-name').textContent = name;
  el('speech-section').style.display = 'none';
  el('confirm-section').style.display = '';
  const q = el('name-search').value.toLowerCase();
  renderNameList(q ? names.filter(n => n.toLowerCase().includes(q)) : names);
}

function clearName() {
  playerName = null;
  el('confirm-section').style.display = 'none';
  el('speech-section').style.display = '';
  el('adhoc-section').style.display = 'none';
  renderNameList(names);
}

function confirmName() {
  if (!playerName) return;
  playerCompany = el('company-input').value.trim();
  send({ type: 'player:select', stationId: STATION_ID, name: playerName, company: playerCompany });
  send({ type: 'player:ready', stationId: STATION_ID });
}

// ─── SPEECH ────────────────────────────────────────────────────────────────────
function setupSpeech() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) { el('speech-section').style.display = 'none'; return; }
  if (recognition) { try { recognition.abort(); } catch (_) {} }
  recognition = new SpeechRec();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';
  recognition.maxAlternatives = 5;

  recognition.onstart  = () => { el('speech-btn').classList.add('listening'); el('speech-status').textContent = 'Listening…'; };
  recognition.onend    = () => { el('speech-btn').classList.remove('listening'); el('speech-status').textContent = 'Tap to speak your name'; };
  recognition.onerror  = (e) => { el('speech-btn').classList.remove('listening'); el('speech-status').textContent = e.error === 'not-allowed' ? 'Mic blocked — search below' : 'Try again'; };

  recognition.onresult = (e) => {
    const candidates = [];
    for (let i = 0; i < e.results.length; i++)
      for (let j = 0; j < e.results[i].length; j++)
        candidates.push(e.results[i][j].transcript.toLowerCase().trim());
    for (const t of candidates) { const m = fuzzyMatch(t); if (m) { selectName(m); break; } }
  };
}

function startListening() {
  if (!recognition) return;
  try { recognition.start(); } catch (_) { recognition.stop(); setTimeout(() => { try { recognition.start(); } catch (_2) {} }, 300); }
}

function fuzzyMatch(transcript) {
  const words = transcript.split(/\s+/).filter(w => w.length >= 2);
  for (const w of words) {
    const exact = names.find(n => n.toLowerCase() === w); if (exact) return exact;
    const starts = names.find(n => n.toLowerCase().startsWith(w)); if (starts) return starts;
  }
  let best = null, bestDist = 3;
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const w of words) {
      if (Math.abs(w.length - lower.length) > 3) continue;
      const d = levenshtein(w, lower);
      if (d < bestDist) { bestDist = d; best = name; }
    }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0));
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1] ? dp[i-1][j-1] : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// ─── WAITING ───────────────────────────────────────────────────────────────────
function populateWaiting() {
  const players = serverSession?.players || {};
  const mode    = serverSession?.mode;
  const meta    = MODES_META[mode];
  el('waiting-your-name').textContent = playerName || players[STATION_ID]?.name || 'YOU';
  el('waiting-mode-label').textContent = meta ? `${meta.icon} ${meta.label}` : '';

  const otherId  = STATION_ID === 1 ? 2 : 1;
  const otherP   = players[otherId];
  if (otherP) {
    el('waiting-opp-name').textContent = otherP.name;
    el('waiting-opp-name').style.display = '';
    el('waiting-opp-status').innerHTML = '<span style="color:var(--success)">● READY</span>';
  } else {
    el('waiting-opp-name').style.display = 'none';
    el('waiting-opp-status').innerHTML = '<span class="dot-pulse">●</span> Waiting for opponent…';
  }
}

// ─── COUNTDOWN ─────────────────────────────────────────────────────────────────
function populateCountdown() {
  const s = serverSession;
  if (!s) return;

  const round  = s.currentRound;
  const mode   = s.mode;
  const meta   = MODES_META[mode];
  const myMode = round?.inputAssignments?.[STATION_ID] || 'keyboard';

  el('countdown-mode-label').textContent = meta ? `${meta.icon} ${meta.label} — Round ${(s.currentRoundIndex || 0) + 1}` : '';

  // Player names
  const p1name = s.players?.[1]?.name || 'Station 1';
  const p2name = mode === 'beat-the-keyboard' ? '—' : (s.players?.[2]?.name || 'Station 2');
  el('countdown-p1-name').textContent = p1name;
  el('countdown-p2-name').textContent = p2name;

  // Input hint
  el('countdown-input-hint').textContent = myMode === 'voice'
    ? '🎙️ Get ready to speak'
    : '⌨️ Get ready to type';

  // Prompt preview
  if (round?.targetText) {
    if (mode === 'prompt-royale') {
      el('countdown-prompt').textContent = '📝 ' + round.targetText;
    } else {
      el('countdown-prompt').textContent = round.targetText;
    }
  }
}

function onCountdownTick(count) {
  const numEl = el('countdown-number');
  if (count === 'GO') {
    numEl.textContent = 'GO!';
    numEl.className = 'countdown-number go pop';
  } else {
    numEl.textContent = count;
    numEl.className = 'countdown-number pop';
  }
}

// ─── RACING ────────────────────────────────────────────────────────────────────
function populateRacing() {
  const s = serverSession;
  if (!s) return;

  const round = s.currentRound;
  if (!round) return;

  currentPrompt = round.targetText || '';
  currentMode   = round.inputAssignments?.[STATION_ID] || 'keyboard';
  typedText     = '';
  corrections   = 0;
  backspaces    = 0;
  roundEndSent  = false;
  raceStartTime = round.startedAt || Date.now();

  // Names
  const otherId = STATION_ID === 1 ? 2 : 1;
  el('your-name-display').textContent = s.players?.[STATION_ID]?.name || `Station ${STATION_ID}`;
  el('opp-name-display').textContent  = s.players?.[otherId]?.name || (s.mode === 'beat-the-keyboard' ? '—' : `Station ${otherId}`);
  el('race-mode-badge').textContent   = MODES_META[s.mode]?.label || s.mode;
  el('race-station-label').textContent = `STATION ${STATION_ID} · ${currentMode.toUpperCase()}`;

  // Reset progress
  el('your-wpm').textContent = '0';
  el('opp-wpm').textContent  = '0';
  el('your-progress-bar').style.width = '0%';
  el('opp-progress-bar').style.width  = '0%';
  el('your-progress-pct').textContent = '0%';
  el('opp-progress-pct').textContent  = '0%';
  el('finish-message').style.display  = 'none';

  if (currentMode === 'voice') {
    el('keyboard-area').style.display = 'none';
    el('voice-area').style.display    = '';
    el('voice-target-text').textContent = currentPrompt;
    const ta = el('voice-textarea');
    ta.value = '';
    setupVoiceInput(ta);
  } else {
    el('voice-area').style.display    = 'none';
    el('keyboard-area').style.display = '';
    renderTypingDisplay();
    document.addEventListener('keydown', onRaceKey);
    el('voice-textarea').removeEventListener('input', onVoiceInput);
  }

  clearInterval(wpmTimer);
  clearInterval(clockTimer);
  wpmTimer  = setInterval(updateRaceStats, 300);
  clockTimer = setInterval(updateClock, 100);
}

// ── Keyboard mode ──────────────────────────────────────────────────────────────
function onRaceKey(e) {
  if (deriveScreen() !== 'racing' || currentMode !== 'keyboard') return;
  if (el('finish-message').style.display !== 'none') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();

  if (e.key === 'Backspace') {
    if (typedText.length > 0) { typedText = typedText.slice(0, -1); backspaces++; }
  } else if (e.key.length === 1 && typedText.length < currentPrompt.length) {
    if (e.key !== currentPrompt[typedText.length]) corrections++;
    typedText += e.key;
  } else { return; }

  renderTypingDisplay();
  sendInputUpdate();
  checkComplete();
}

function renderTypingDisplay() {
  const html = currentPrompt.split('').map((char, i) => {
    let cls;
    if (i < typedText.length)    cls = typedText[i] === char ? 'correct' : 'wrong';
    else if (i === typedText.length) cls = 'cursor';
    else                         cls = 'upcoming';
    return `<span class="char ${cls}">${char === ' ' ? '&nbsp;' : esc(char)}</span>`;
  }).join('');
  el('typing-display').innerHTML = html;
  el('typing-display').querySelector('.cursor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Voice mode ─────────────────────────────────────────────────────────────────
function setupVoiceInput(ta) {
  ta.removeEventListener('input', onVoiceInput);
  ta.addEventListener('input', onVoiceInput);
  setTimeout(() => ta.focus(), 200);
}

function onVoiceInput(e) {
  if (roundEndSent) return;
  const value = e.target.value;
  sendInputUpdate(value);
  updateRaceStatsVoice(value);
  // Auto-submit on apparent completion (server also force-ends via timer)
  const target = normalizeForMatch(currentPrompt);
  const current = normalizeForMatch(value);
  if (current.length >= target.length * 0.9 && target.length > 0) {
    submitRoundFinish(value);
  }
}

function normalizeForMatch(t) {
  return t.toLowerCase().replace(/[.,!?;:'"]/g, '').replace(/\s+/g, ' ').trim();
}

// ── Shared stats ───────────────────────────────────────────────────────────────
function calcWpm(text) {
  if (!raceStartTime) return 0;
  const mins = (Date.now() - raceStartTime) / 60000;
  if (mins < 0.001) return 0;
  const correct = [...text].filter((c, i) => c === currentPrompt[i]).length;
  return Math.round((correct / 5) / mins);
}

function updateRaceStats() {
  if (currentMode !== 'keyboard') return;
  const wpm = calcWpm(typedText);
  const pct = currentPrompt.length > 0 ? typedText.length / currentPrompt.length : 0;
  el('your-wpm').textContent = wpm;
  el('your-progress-bar').style.width = `${Math.round(pct * 100)}%`;
  el('your-progress-pct').textContent = `${Math.round(pct * 100)}%`;
}

function updateRaceStatsVoice(value) {
  const wpm = calcWpm(value);
  const pct = currentPrompt.length > 0 ? value.length / currentPrompt.length : 0;
  el('your-wpm').textContent = wpm;
  el('your-progress-bar').style.width = `${Math.min(100, Math.round(pct * 100))}%`;
  el('your-progress-pct').textContent = `${Math.min(100, Math.round(pct * 100))}%`;
}

function updateClock() {
  if (!raceStartTime) return;
  const secs = Math.floor((Date.now() - raceStartTime) / 1000);
  el('race-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function onOpponentUpdate(progress, usableWpm) {
  el('opp-progress-bar').style.width = `${Math.round(progress * 100)}%`;
  el('opp-progress-pct').textContent = `${Math.round(progress * 100)}%`;
  el('opp-wpm').textContent = usableWpm;
}

function sendInputUpdate(voiceValue) {
  const value = currentMode === 'voice' ? (voiceValue || el('voice-textarea').value) : typedText;
  send({ type: 'input:update', stationId: STATION_ID, value, corrections });
}

function checkComplete() {
  if (typedText.length === currentPrompt.length) {
    if ([...typedText].every((c, i) => c === currentPrompt[i])) submitRoundFinish(typedText);
  }
}

function submitRoundFinish(value) {
  if (roundEndSent) return;
  roundEndSent = true;
  clearInterval(wpmTimer);
  clearInterval(clockTimer);
  document.removeEventListener('keydown', onRaceKey);

  const finalWpm = calcWpm(value || typedText);
  el('your-wpm').textContent = finalWpm;
  el('finish-wpm').textContent = finalWpm;
  el('finish-message').style.display = '';

  send({ type: 'round:finish', stationId: STATION_ID, value: value || typedText, corrections, backspaces });
}

// ─── ROUND TRANSITION ──────────────────────────────────────────────────────────
function populateRoundTransition() {
  const s = serverSession;
  if (!s) return;

  // Mini results from previous round
  const prevRound = s.rounds?.[s.currentRoundIndex - 1] || lastRoundResult;
  const miniEl = el('rt-mini-results');
  if (prevRound?.stationResults && miniEl) {
    const items = Object.values(prevRound.stationResults);
    miniEl.innerHTML = items.map(r => `
      <div class="rt-score-block">
        <div class="rt-score-name">${esc(r.playerName || r.stationId)}</div>
        <div class="rt-score-num">${r.usableWpm}<small> WPM</small></div>
        <div style="font-size:11px;color:var(--text-dim)">${r.inputMode.toUpperCase()}</div>
      </div>`).join('<div style="width:1px;background:var(--border);margin:0 8px"></div>');
  }

  // Next round assignments
  const pending = s.pendingAssignments || {};
  const assignEl = el('rt-next-assignment');
  if (assignEl) {
    const rows = Object.entries(pending).map(([sid, mode]) => {
      const name = s.players?.[parseInt(sid)]?.name || `Station ${sid}`;
      const isMe = parseInt(sid) === STATION_ID;
      return `<div class="rt-assign-row">
        <span>${isMe ? '<strong>' + esc(name) + ' (you)</strong>' : esc(name)}</span>
        <span class="assign-mode ${mode}">${mode === 'voice' ? '🎙️ Voice' : '⌨️ Keyboard'}</span>
      </div>`;
    }).join('');
    assignEl.innerHTML = `<div class="rt-next-label">Next round</div>${rows}`;
  }

  // Countdown timer
  let secs = 5;
  el('rt-timer').textContent = secs;
  clearInterval(rtTimer);
  rtTimer = setInterval(() => {
    secs--;
    el('rt-timer').textContent = secs;
    if (secs <= 0) clearInterval(rtTimer);
  }, 1000);
}

// ─── RESULTS ───────────────────────────────────────────────────────────────────
function populateResults() {
  const s = serverSession;
  if (!s) return;

  const winner  = s.winner;
  const scores  = s.playerScores || {};
  const isSolo  = winner?.type === 'solo';
  const isWin   = winner?.type === 'win';
  const isTie   = winner?.type === 'tie';
  const iAm     = winner?.stationId === STATION_ID;

  // Banner
  const banner = el('result-banner');
  if (isSolo) {
    banner.textContent = `${esc(winner.name)} — SOLO COMPLETE`;
    banner.className = 'result-banner solo';
  } else if (isTie) {
    banner.textContent = "IT'S A TIE!";
    banner.className = 'result-banner tie';
  } else if (iAm) {
    banner.textContent = `${esc(winner.name)} WINS! 🏆`;
    banner.className = 'result-banner win';
  } else {
    banner.textContent = `${esc(winner?.name || '??')} WINS`;
    banner.className = 'result-banner lose';
  }

  // Score cards
  const scoresEl = el('result-scores');
  const players = s.players || {};
  const sids    = Object.keys(players).map(Number);

  scoresEl.innerHTML = sids.map((sid, idx) => {
    const p   = players[sid];
    const sc  = scores[sid] || {};
    const isW = winner?.stationId === sid;
    const hasVoice = sc.voiceWpm > 0;
    const hasKb    = sc.keyboardWpm > 0;
    return `<div class="result-player ${isW ? 'winner' : ''}">
      <div class="result-pname">${esc(p?.name || `Station ${sid}`)}</div>
      <div class="result-flow-score">${sc.totalFlow || 0}</div>
      <div class="result-flow-label">Flow Score</div>
      <div class="result-detail-row">
        ${hasKb ? `<div class="result-stat"><div class="result-stat-val kb-val">${sc.keyboardWpm}</div><div class="result-stat-label">KB WPM</div></div>` : ''}
        ${hasVoice ? `<div class="result-stat"><div class="result-stat-val voice-val">${sc.voiceWpm}</div><div class="result-stat-label">Voice WPM</div></div>` : ''}
      </div>
    </div>`;
  }).join('<div class="result-vs">VS</div>');

  // Voice advantage
  const allScores = Object.values(scores);
  const maxVA = Math.max(...allScores.map(s => s.voiceAdvantage || 0));
  const vaEl = el('voice-advantage-banner');
  if (maxVA > 0) {
    vaEl.style.display = '';
    el('va-number').textContent = `${maxVA}×`;
  } else {
    vaEl.style.display = 'none';
  }

  // Badges
  const allBadges = [...new Set(allScores.flatMap(s => s.badges || []))];
  const badgesEl = el('badges-row');
  if (allBadges.length) {
    badgesEl.innerHTML = allBadges.map(b => {
      const meta = BADGE_META[b];
      if (!meta) return '';
      return `<div class="badge-chip">${meta.emoji} ${meta.label}</div>`;
    }).join('');
    el('badges-section').style.display = '';
  } else {
    el('badges-section').style.display = 'none';
  }

  // Leaderboard — fetch fresh from server
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(entries => renderLeaderboard(entries, 'result-leaderboard'))
    .catch(() => renderLeaderboard([], 'result-leaderboard'));

  // Countdown
  let secs = serverConfig?.resultsSeconds || 15;
  el('next-race-timer').textContent = secs;
  clearInterval(nextRaceTimer);
  nextRaceTimer = setInterval(() => {
    secs--;
    el('next-race-timer').textContent = secs;
    if (secs <= 0) clearInterval(nextRaceTimer);
  }, 1000);
}

// ─── CTA ───────────────────────────────────────────────────────────────────────
function populateCta() {
  const scores = serverSession?.playerScores || {};
  const maxVA  = Math.max(...Object.values(scores).map(s => s.voiceAdvantage || 0));
  const qrUrl  = serverConfig?.qrUrl || 'https://wispr.ai';

  el('cta-headline').innerHTML = `Try <span>Wispr Flow</span>`;
  el('cta-subline').textContent = maxVA > 0
    ? `You were ${maxVA}× faster with your voice.`
    : 'Talk faster than you type.';
  el('cta-qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`;
  el('cta-url').textContent = qrUrl;
}

// ─── Leaderboard rendering ─────────────────────────────────────────────────────
function renderLeaderboard(entries, containerId) {
  const c = el(containerId);
  if (!c) return;
  if (!entries?.length) { c.innerHTML = '<p class="lb-empty">No scores yet — be the first!</p>'; return; }
  const medals = ['🥇', '🥈', '🥉'];
  const modeShort = { 'swap-duel': 'Swap', 'voice-vs-keyboard': 'V×K', 'beat-the-keyboard': 'Solo', 'keyboard-race': 'KB', 'hinglish-hustle': 'HH', 'prompt-royale': 'PR' };
  c.innerHTML = entries.slice(0, 10).map((e, i) =>
    `<div class="lb-row ${i < 3 ? 'top-' + (i + 1) : ''}">
      <span class="lb-rank">${medals[i] || (i + 1)}</span>
      <span class="lb-name">${esc(e.playerName)}</span>
      <span class="lb-score">${e.flowScore} <small>FS</small></span>
      <span class="lb-mode">${modeShort[e.mode] || e.mode}</span>
    </div>`).join('');
}

// ─── Global key handling ───────────────────────────────────────────────────────
function globalKeyHandler(e) {
  // Ctrl+Shift+R — force reset
  if (e.ctrlKey && e.shiftKey && e.key === 'R') { e.preventDefault(); send({ type: 'admin:reset' }); }

  const screen = deriveScreen();

  if (screen === 'idle') {
    if (!e.ctrlKey && !e.metaKey && e.key !== 'Escape') {
      clientState = 'mode-select';
      renderScreen('mode-select');
    }
  }
}

// ─── Notifications ─────────────────────────────────────────────────────────────
function notify(text, type = 'info') {
  const d = document.createElement('div');
  d.className = `notification ${type}`;
  d.textContent = text;
  el('notification-layer').appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

// ─── Utilities ─────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s ?? '')
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
