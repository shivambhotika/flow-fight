'use strict';

// ─── Config ───────────────────────────────────────────────────────────────────
const STATION_ID = parseInt(new URLSearchParams(location.search).get('station')) || 1;
const WS_URL = `ws://${location.host}`;

// ─── State ────────────────────────────────────────────────────────────────────
let ws            = null;
let names         = [];
let currentState  = 'connecting';
let playerName    = null;
let opponentName  = null;
let currentPrompt = '';
let typedText     = '';
let raceStartTime = null;
let wpmTimer      = null;
let clockTimer    = null;
let nextRaceTimer = null;
let recognition   = null;

// ─── Boot ─────────────────────────────────────────────────────────────────────
(function init() {
  el('station-badge').textContent = `STATION ${STATION_ID}`;
  document.title = `Typing Race — Station ${STATION_ID}`;
  document.addEventListener('keydown', globalKeyHandler);
  fetchNames();
  connectWS();
})();

// ─── WebSocket ────────────────────────────────────────────────────────────────
function connectWS() {
  ws = new WebSocket(WS_URL);

  ws.onopen = () => send({ type: 'register', stationId: STATION_ID });

  ws.onmessage = (e) => {
    try { handleMessage(JSON.parse(e.data)); } catch (err) { console.error(err); }
  };

  ws.onclose = () => {
    setState('connecting');
    setTimeout(connectWS, 2000);
  };
}

function send(data) {
  if (ws?.readyState === WebSocket.OPEN) ws.send(JSON.stringify(data));
}

// ─── Message handler ──────────────────────────────────────────────────────────
function handleMessage(msg) {
  switch (msg.type) {

    case 'registered':
      if (msg.leaderboard) renderLeaderboard(msg.leaderboard, 'idle-leaderboard');
      setState('idle');
      break;

    case 'waiting_for_opponent':
      el('waiting-your-name').textContent = playerName;
      el('waiting-opponent-status').innerHTML = '<span class="dot-pulse"></span> Waiting for opponent…';
      el('waiting-opponent-name').style.display = 'none';
      setState('waiting');
      break;

    case 'opponent_joined':
      opponentName = msg.opponentName;
      el('waiting-opponent-name').textContent = opponentName;
      el('waiting-opponent-name').style.display = '';
      el('waiting-opponent-status').innerHTML = '<span style="color:var(--opp)">● READY</span>';
      break;

    case 'countdown':
      currentPrompt = msg.prompt;
      el('countdown-p1-name').textContent = STATION_ID === 1 ? playerName  : opponentName;
      el('countdown-p2-name').textContent = STATION_ID === 2 ? playerName  : opponentName;
      el('countdown-prompt').textContent  = currentPrompt;
      el('countdown-number').textContent  = '';
      setState('countdown');
      break;

    case 'countdown_tick': {
      const num = el('countdown-number');
      num.textContent = msg.count;
      num.className = 'countdown-number';
      num.classList.add('pop');
      break;
    }

    case 'race_start':
      el('countdown-number').textContent = 'GO!';
      el('countdown-number').classList.add('go', 'pop');
      setTimeout(() => {
        setState('racing');
        startRace();
      }, 600);
      break;

    case 'opponent_update':
      updateOpponentProgress(msg.progress, msg.wpm);
      break;

    case 'opponent_finished':
      notify(`${opponentName} finished — ${msg.wpm} WPM!`, 'info');
      break;

    case 'race_result':
      clearRaceTimers();
      setState('results');
      showResults(msg);
      break;

    case 'reset':
      doReset();
      break;

    case 'leaderboard':
      renderLeaderboard(msg.entries, 'idle-leaderboard');
      break;
  }
}

// ─── State machine ────────────────────────────────────────────────────────────
function setState(newState) {
  currentState = newState;
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const screen = el(`screen-${newState}`);
  if (screen) screen.classList.add('active');

  if (newState === 'name-entry') initNameEntry();
  if (newState === 'idle') listenForAnyKey();
}

function listenForAnyKey() {
  function onKey(e) {
    if (currentState !== 'idle') return;
    if (e.ctrlKey || e.metaKey || e.key === 'Escape') return;
    document.removeEventListener('keydown', onKey);
    setState('name-entry');
  }
  document.addEventListener('keydown', onKey);
}

// ─── Names & search ───────────────────────────────────────────────────────────
async function fetchNames() {
  try {
    const res = await fetch('/api/names');
    names = await res.json();
  } catch { names = []; }
}

function onNameSearch(query) {
  const q = query.toLowerCase();
  renderNameList(q ? names.filter(n => n.toLowerCase().includes(q)) : names);
}

function renderNameList(list) {
  const container = el('name-list');
  if (!list.length) {
    container.innerHTML = '<p class="no-results">No names found</p>';
    return;
  }
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
  renderNameList(names);
}

function confirmName() {
  if (!playerName) return;
  send({ type: 'player_ready', name: playerName, stationId: STATION_ID });
}

// ─── Name entry init ──────────────────────────────────────────────────────────
function initNameEntry() {
  playerName = null;
  el('name-search').value = '';
  el('confirm-section').style.display = 'none';
  el('speech-section').style.display = '';
  el('selected-name').textContent = '';
  renderNameList(names);
  setupSpeech();
  setTimeout(() => el('name-search').focus(), 100);
}

// ─── Speech recognition ───────────────────────────────────────────────────────
function setupSpeech() {
  const SpeechRec = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRec) { el('speech-section').style.display = 'none'; return; }

  if (recognition) { try { recognition.abort(); } catch (_) {} }

  recognition = new SpeechRec();
  recognition.continuous      = false;
  recognition.interimResults  = true;
  recognition.lang            = 'en-US';
  recognition.maxAlternatives = 5;

  recognition.onstart = () => {
    el('speech-btn').classList.add('listening');
    el('speech-status').textContent = 'Listening…';
  };

  recognition.onresult = (e) => {
    const candidates = [];
    for (let i = 0; i < e.results.length; i++) {
      for (let j = 0; j < e.results[i].length; j++) {
        candidates.push(e.results[i][j].transcript.toLowerCase().trim());
      }
    }
    for (const t of candidates) {
      const match = fuzzyMatchName(t);
      if (match) { selectName(match); break; }
    }
  };

  recognition.onend = () => {
    el('speech-btn').classList.remove('listening');
    el('speech-status').textContent = 'Tap to speak your name';
  };

  recognition.onerror = (e) => {
    el('speech-btn').classList.remove('listening');
    el('speech-status').textContent = e.error === 'not-allowed' ? 'Mic blocked — search below' : 'Try again';
  };
}

function startListening() {
  if (!recognition) return;
  try {
    recognition.start();
  } catch (_) {
    recognition.stop();
    setTimeout(() => { try { recognition.start(); } catch (_2) {} }, 300);
  }
}

// ─── Fuzzy name match ─────────────────────────────────────────────────────────
function fuzzyMatchName(transcript) {
  const words = transcript.split(/\s+/).filter(w => w.length >= 2);

  for (const word of words) {
    // Exact
    const exact = names.find(n => n.toLowerCase() === word);
    if (exact) return exact;
    // Starts with
    const starts = names.find(n => n.toLowerCase().startsWith(word));
    if (starts) return starts;
  }

  // Levenshtein fallback
  let best = null, bestDist = 3;
  for (const name of names) {
    const lower = name.toLowerCase();
    for (const word of words) {
      if (Math.abs(word.length - lower.length) > 3) continue;
      const d = levenshtein(word, lower);
      if (d < bestDist) { bestDist = d; best = name; }
    }
  }
  return best;
}

function levenshtein(a, b) {
  const m = a.length, n = b.length;
  const dp = Array.from({ length: m + 1 }, (_, i) =>
    Array.from({ length: n + 1 }, (_, j) => i === 0 ? j : j === 0 ? i : 0)
  );
  for (let i = 1; i <= m; i++)
    for (let j = 1; j <= n; j++)
      dp[i][j] = a[i-1] === b[j-1]
        ? dp[i-1][j-1]
        : 1 + Math.min(dp[i-1][j], dp[i][j-1], dp[i-1][j-1]);
  return dp[m][n];
}

// ─── Race ─────────────────────────────────────────────────────────────────────
function startRace() {
  typedText     = '';
  raceStartTime = Date.now();

  el('your-name-display').textContent     = playerName;
  el('opponent-name-display').textContent = opponentName || 'Opponent';
  el('opp-label').textContent             = (opponentName || 'OPP').substring(0, 6).toUpperCase();
  el('finish-message').style.display      = 'none';

  renderTypingDisplay();
  if (document.activeElement) document.activeElement.blur();
  document.addEventListener('keydown', onRaceKey);

  wpmTimer   = setInterval(updateRaceStats, 300);
  clockTimer = setInterval(updateClock, 100);
}

function onRaceKey(e) {
  if (currentState !== 'racing') return;
  if (el('finish-message').style.display !== 'none') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();

  if (e.key === 'Backspace') {
    typedText = typedText.slice(0, -1);
  } else if (e.key.length === 1 && typedText.length < currentPrompt.length) {
    typedText += e.key;
  } else {
    return;
  }

  renderTypingDisplay();
  sendTypingUpdate();

  if (typedText.length === currentPrompt.length) {
    const allCorrect = [...typedText].every((c, i) => c === currentPrompt[i]);
    if (allCorrect) completeRace();
  }
}

function renderTypingDisplay() {
  const html = currentPrompt.split('').map((char, i) => {
    let cls;
    if (i < typedText.length) {
      cls = typedText[i] === char ? 'correct' : 'wrong';
    } else if (i === typedText.length) {
      cls = 'cursor';
    } else {
      cls = 'upcoming';
    }
    const display = char === ' ' ? '&nbsp;' : esc(char);
    return `<span class="char ${cls}">${display}</span>`;
  }).join('');

  el('typing-display').innerHTML = html;

  // Keep cursor in view
  const cursor = el('typing-display').querySelector('.cursor');
  if (cursor) cursor.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

function calcWpm() {
  if (!raceStartTime) return 0;
  const mins = (Date.now() - raceStartTime) / 60000;
  if (mins < 0.001) return 0;
  const correct = [...typedText].filter((c, i) => c === currentPrompt[i]).length;
  return Math.round((correct / 5) / mins);
}

function updateRaceStats() {
  const wpm      = calcWpm();
  const progress = typedText.length / currentPrompt.length;
  el('your-wpm').textContent          = wpm;
  el('your-progress-bar').style.width = `${Math.round(progress * 100)}%`;
  el('your-progress-pct').textContent = `${Math.round(progress * 100)}%`;
}

function updateClock() {
  if (!raceStartTime) return;
  const secs = Math.floor((Date.now() - raceStartTime) / 1000);
  el('race-timer').textContent = `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

function sendTypingUpdate() {
  send({
    type: 'typing_update',
    progress: typedText.length / currentPrompt.length,
    wpm: calcWpm(),
  });
}

function completeRace() {
  clearRaceTimers();
  document.removeEventListener('keydown', onRaceKey);
  const finalWpm = calcWpm();
  el('your-wpm').textContent      = finalWpm;
  el('finish-wpm').textContent    = finalWpm;
  el('finish-message').style.display = '';
  send({ type: 'race_complete', wpm: finalWpm });
}

function updateOpponentProgress(progress, wpm) {
  el('opp-progress-bar').style.width  = `${Math.round(progress * 100)}%`;
  el('opp-progress-pct').textContent  = `${Math.round(progress * 100)}%`;
  el('opponent-wpm').textContent      = wpm;
}

function clearRaceTimers() {
  clearInterval(wpmTimer);
  clearInterval(clockTimer);
  wpmTimer = clockTimer = null;
  document.removeEventListener('keydown', onRaceKey);
}

// ─── Results ──────────────────────────────────────────────────────────────────
function showResults(msg) {
  const { p1, p2, winner, leaderboard } = msg;

  const banner = el('result-banner');
  if (winner === STATION_ID) {
    banner.textContent = 'YOU WIN!';
    banner.className   = 'result-banner win';
  } else if (winner === 'tie') {
    banner.textContent = "IT'S A TIE!";
    banner.className   = 'result-banner tie';
  } else {
    banner.textContent = 'NICE EFFORT!';
    banner.className   = 'result-banner lose';
  }

  el('result-p1-name').textContent = p1.name;
  el('result-p1-wpm').textContent  = p1.wpm;
  el('result-p2-name').textContent = p2.name;
  el('result-p2-wpm').textContent  = p2.wpm;

  renderLeaderboard(leaderboard || [], 'result-lb-entries');

  let secs = 15;
  el('next-race-timer').textContent = secs;
  nextRaceTimer = setInterval(() => {
    secs--;
    el('next-race-timer').textContent = secs;
    if (secs <= 0) clearInterval(nextRaceTimer);
  }, 1000);
}

// ─── Leaderboard ──────────────────────────────────────────────────────────────
function renderLeaderboard(entries, containerId) {
  const container = el(containerId);
  if (!container) return;
  if (!entries?.length) {
    container.innerHTML = '<p class="lb-empty">No scores yet — be the first!</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  container.innerHTML = entries.slice(0, 10).map((entry, i) => `
    <div class="lb-row ${i < 3 ? 'top-' + (i + 1) : ''}">
      <span class="lb-rank">${medals[i] || (i + 1)}</span>
      <span class="lb-name">${esc(entry.name)}</span>
      <span class="lb-wpm">${entry.wpm} <small>WPM</small></span>
      <span class="lb-date">${entry.date || ''}</span>
    </div>`).join('');
}

// ─── Reset ────────────────────────────────────────────────────────────────────
function doReset() {
  clearRaceTimers();
  clearInterval(nextRaceTimer);
  playerName = opponentName = null;
  typedText  = currentPrompt = '';
  raceStartTime = null;
  setState('name-entry');
}

// ─── Global keys ──────────────────────────────────────────────────────────────
function globalKeyHandler(e) {
  // Ctrl+Shift+R — admin hard reset
  if (e.ctrlKey && e.shiftKey && e.key === 'R') {
    e.preventDefault();
    doReset();
  }
}

// ─── Notifications ────────────────────────────────────────────────────────────
function notify(text, type = 'info') {
  const d = document.createElement('div');
  d.className = `notification ${type}`;
  d.textContent = text;
  el('notification-layer').appendChild(d);
  setTimeout(() => d.remove(), 3200);
}

// ─── Utils ────────────────────────────────────────────────────────────────────
function el(id) { return document.getElementById(id); }
function esc(s) {
  return String(s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
