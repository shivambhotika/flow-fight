'use strict';

const { countMatchedWords, isExactWordMatch, normalizeText, normalizeWords } = window.FlowFightTextMatch;

// Every browser tab gets an isolated server-side solo session. sessionStorage
// survives reconnects/reloads in the same tab without coupling separate devices.
const CLIENT_ID = sessionStorage.getItem('flowFightClientId') ||
  (crypto.randomUUID?.() || `client-${Date.now()}-${Math.random().toString(36).slice(2)}`);
sessionStorage.setItem('flowFightClientId', CLIENT_ID);
const STATION_ID = 1; // Kept as the in-session player key for score compatibility.

// ─── Mode config (mirrors server) ─────────────────────────────────────────────
const MODES_META = {
  'solo-challenge': { label: 'Solo Challenge', tagline: 'Type, then speak. See how much faster your ideas flow.', icon: '⚡', playerCount: 1, rounds: 2 },
};

const BADGE_META = {
  keyboard_slayer:   { label: 'Keyboard Slayer',  emoji: '⚔️' },
  flow_state:        { label: 'Flow State',        emoji: '🌊' },
  no_hands:          { label: 'No Hands Needed',   emoji: '🎙️' },
  speed_demon:       { label: 'Speed Demon',        emoji: '⚡' },
  clean_talker:      { label: 'Clean Talker',       emoji: '✨' },
  keyboard_survivor: { label: 'Keyboard Survivor',  emoji: '🛡️' },
};

// ─── Global state ──────────────────────────────────────────────────────────────
let ws            = null;
let serverSession = null;
let serverConfig  = null;
let playerName    = null;
let nameRecorder  = null;
let nameStream    = null;
let nameChunks    = [];
let isRecordingName = false;

// Race state
let currentPrompt   = '';
let currentMode     = '';    // 'keyboard' | 'voice'
let typedText       = '';
let raceStartTime   = null;
let corrections     = 0;
let backspaces      = 0;
let roundEndSent    = false;
let lastRoundResult = null;

// Multi-line race state
let lineQueue           = [];    // [{id, text, category}]
let currentLineIndex    = 0;
let completedWords      = 0;
let completedLinesList  = [];    // [{text, wordCount}]
let roundEndTime        = null;  // absolute timestamp when round ends
let roundDurationSecs   = 60;
let oppWordCount        = 0;
let isMultiLineRound    = false;

// Voice focus tracking
let voiceFocused        = false;

// Camera callout tracking
let voiceLeadNotified   = false;
let voicex2Notified     = false;
let flashTimer          = null;

// Timers
let wpmTimer      = null;
let clockTimer    = null;
let rtTimer       = null;
let nextRaceTimer = null;

// ─── Boot ──────────────────────────────────────────────────────────────────────
(function init() {
  el('station-badge').textContent = 'SOLO CHALLENGE';
  document.title = 'Flow Fight — Solo Challenge';
  document.addEventListener('keydown', globalKeyHandler);
  connectWS();
})();

// ─── WebSocket ─────────────────────────────────────────────────────────────────
function connectWS() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}`);
  ws.onopen = () => send({ type: 'station:join', stationId: STATION_ID, clientId: CLIENT_ID });

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
      if (msg.config) serverConfig = msg.config;
      onStateChange();
      break;

    case 'config:update':
      serverConfig = msg.config;
      break;

    case 'countdown:tick':
      onCountdownTick(msg.count);
      break;

    case 'opponent:update':
      onOpponentUpdate(msg.progress, msg.usableWpm, msg.wordCount);
      break;

    case 'round:results':
      lastRoundResult = msg.round;
      break;

    case 'session:results':
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
  const screen = deriveScreen();
  renderScreen(screen);
  populateScreen(screen);
}

function deriveScreen() {
  if (!ws || ws.readyState !== WebSocket.OPEN) return 'connecting';
  if (!serverSession) return 'idle';

  const { state, players, mode } = serverSession;
  const meta = MODES_META[mode];
  const me   = players?.[STATION_ID];

  switch (state) {
    case 'name-entry':      return me?.isReady ? 'waiting' : 'name-entry';
    case 'countdown':       return 'countdown';
    case 'racing':          return me ? 'racing' : 'spectator';
    case 'round-transition': return me ? 'round-transition' : 'spectator';
    case 'results':         return 'results';
    case 'cta':             return 'cta';
    default:                return 'idle';
  }
}

function renderScreen(name) {
  document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
  const s = el(`screen-${name}`);
  if (s) s.classList.add('active');
  // Always remove race key listener when leaving racing screen
  if (name !== 'racing') {
    document.removeEventListener('keydown', onRaceKey);
    clearInterval(wpmTimer);
    clearInterval(clockTimer);
  }
}

// ─── Screen population ─────────────────────────────────────────────────────────
function populateScreen(screen) {
  switch (screen) {
    case 'idle':             populateIdle(); break;
    case 'name-entry':       populateNameEntry(); break;
    case 'waiting':          populateWaiting(); break;
    case 'countdown':        populateCountdown(); break;
    case 'racing':           populateRacing(); break;
    case 'round-transition': populateRoundTransition(); break;
    case 'results':          populateResults(); break;
    case 'cta':              populateCta(); break;
  }
}

// ─── IDLE ──────────────────────────────────────────────────────────────────────
function populateIdle() {
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(entries => renderLeaderboard(entries, 'idle-leaderboard'))
    .catch(() => renderLeaderboard([], 'idle-leaderboard'));
}

// ─── SOLO START ────────────────────────────────────────────────────────────────
function startSoloChallenge() {
  if (deriveScreen() !== 'idle') return;
  send({ type: 'mode:select', mode: 'solo-challenge' });
}

// ─── NAME ENTRY ────────────────────────────────────────────────────────────────
function populateNameEntry() {
  playerName = null;
  const input = el('name-input');
  input.value = '';
  onNameInput('');
  setupNameRecorder();
  setTimeout(() => input.focus(), 100);
}

function onNameInput(value) {
  playerName = String(value || '').trim();
  const button = el('name-continue');
  button.disabled = playerName.length < 2;
}

function confirmName() {
  playerName = el('name-input').value.trim();
  if (playerName.length < 2) return;
  send({ type: 'player:select', stationId: STATION_ID, name: playerName });
  send({ type: 'player:ready', stationId: STATION_ID });
}

// ─── PUSH-TO-TALK NAME ENTRY ──────────────────────────────────────────────────
function setupNameRecorder() {
  const button = el('speech-btn');
  if (!navigator.mediaDevices?.getUserMedia || !window.MediaRecorder) {
    button.disabled = true;
    el('speech-status').textContent = 'Voice entry is unavailable here — type your name below.';
    return;
  }
  button.disabled = serverConfig?.speechEntryEnabled === false;
  el('speech-status').textContent = button.disabled
    ? 'Voice entry needs an API key — type your name below.'
    : 'Tap once to start, then tap again when you’re done.';
}

async function toggleNameRecording() {
  if (isRecordingName) {
    nameRecorder?.stop();
    return;
  }

  try {
    nameStream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const preferred = ['audio/webm;codecs=opus', 'audio/webm', 'audio/mp4']
      .find(type => MediaRecorder.isTypeSupported(type));
    nameChunks = [];
    nameRecorder = new MediaRecorder(nameStream, preferred ? { mimeType: preferred } : undefined);
    nameRecorder.ondataavailable = event => {
      if (event.data?.size) nameChunks.push(event.data);
    };
    nameRecorder.onstop = transcribeRecordedName;
    nameRecorder.start();
    isRecordingName = true;
    el('speech-btn').classList.add('listening');
    el('speech-status').textContent = 'Listening… tap again when you’re done.';
  } catch (error) {
    isRecordingName = false;
    el('speech-status').textContent = error?.name === 'NotAllowedError'
      ? 'Microphone access was blocked — type your name below.'
      : 'Could not start the microphone — type your name below.';
  }
}

async function transcribeRecordedName() {
  isRecordingName = false;
  el('speech-btn').classList.remove('listening');
  el('speech-btn').disabled = true;
  el('speech-status').textContent = 'Transcribing your name…';
  nameStream?.getTracks().forEach(track => track.stop());

  try {
    const blob = new Blob(nameChunks, { type: nameRecorder?.mimeType || 'audio/webm' });
    const audio = await blobToDataUrl(blob);
    const response = await fetch('/api/transcribe-name', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ audio, mimeType: blob.type }),
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(payload.error || 'Could not transcribe that.');
    el('name-input').value = payload.text;
    onNameInput(payload.text);
    el('speech-status').textContent = 'Got it. Edit the name if needed, then continue.';
    el('name-input').focus();
  } catch (error) {
    el('speech-status').textContent = error.message || 'Could not transcribe that — type your name below.';
  } finally {
    el('speech-btn').disabled = serverConfig?.speechEntryEnabled === false;
    nameChunks = [];
    nameRecorder = null;
    nameStream = null;
  }
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = reject;
    reader.readAsDataURL(blob);
  });
}

// ─── WAITING ───────────────────────────────────────────────────────────────────
function populateWaiting() {
  const players = serverSession?.players || {};
  const mode    = serverSession?.mode;
  const meta    = MODES_META[mode];
  const isSolo  = meta?.playerCount === 1;

  el('waiting-your-name').textContent  = playerName || players[STATION_ID]?.name || 'YOU';
  el('waiting-mode-label').textContent = meta ? `${meta.icon} ${meta.label}` : '';

  const vsDiv    = document.querySelector('.vs-divider');
  const oppCard  = el('waiting-opp-card');

  if (isSolo) {
    // Solo challenge — hide VS + opponent card
    if (vsDiv)   vsDiv.style.display   = 'none';
    if (oppCard) oppCard.style.display = 'none';
  } else {
    if (vsDiv)   vsDiv.style.display   = '';
    if (oppCard) oppCard.style.display = '';
    const otherId = STATION_ID === 1 ? 2 : 1;
    const otherP  = players[otherId];
    if (otherP) {
      el('waiting-opp-name').textContent = otherP.name;
      el('waiting-opp-name').style.display = '';
      el('waiting-opp-status').innerHTML = '<span style="color:var(--success)">● READY</span>';
    } else {
      el('waiting-opp-name').style.display = 'none';
      el('waiting-opp-status').innerHTML = '<span class="dot-pulse">●</span> Waiting for opponent…';
    }
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

  const p1name = s.players?.[1]?.name || 'Station 1';
  el('countdown-p1-name').textContent = p1name;
  el('countdown-p2-name').style.display = 'none';
  document.querySelector('.countdown-vs').style.display = 'none';

  el('countdown-input-hint').textContent = myMode === 'voice'
    ? '🎙️ Get ready to speak'
    : '⌨️ Get ready to type';

  if (round?.isMultiLine) {
    el('countdown-prompt').textContent = `${round.lineQueue?.length || 20} one-line sentences · ${round.durationSeconds || 60}s`;
  } else if (round?.targetText) {
    el('countdown-prompt').textContent = round.targetText;
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

  currentMode   = round.inputAssignments?.[STATION_ID] || 'keyboard';
  typedText     = '';
  corrections   = 0;
  backspaces    = 0;
  roundEndSent  = false;
  raceStartTime = round.startedAt || Date.now();

  isMultiLineRound = !!(round.isMultiLine && round.lineQueue?.length);

  if (isMultiLineRound) {
    lineQueue           = round.lineQueue;
    currentLineIndex    = 0;
    completedWords      = 0;
    completedLinesList  = [];
    currentPrompt       = lineQueue[0]?.text || '';
    roundDurationSecs   = round.durationSeconds || 60;
    roundEndTime        = raceStartTime + roundDurationSecs * 1000;
    oppWordCount        = 0;
  } else {
    lineQueue    = [];
    currentPrompt = round.targetText || '';
    roundEndTime  = null;
  }

  // Names / labels
  const otherId = STATION_ID === 1 ? 2 : 1;
  el('your-name-display').textContent  = s.players?.[STATION_ID]?.name || `Station ${STATION_ID}`;
  el('opp-name-display').textContent   = s.players?.[otherId]?.name || '—';
  el('race-mode-badge').textContent    = MODES_META[s.mode]?.label || s.mode;
  el('race-station-label').textContent = `YOU · ${currentMode.toUpperCase()}`;
  document.querySelector('.race-score-bar').classList.add('solo-score');
  document.querySelector('.score-col.opp-col').style.display = 'none';

  // Score bar
  el('your-words').textContent = '0';
  el('opp-words').textContent  = '0';
  el('your-progress-bar').style.width = '0%';
  el('opp-progress-bar').style.width  = '0%';

  // Role label — always shown, styled by mode
  voiceFocused = false;
  voiceLeadNotified = false;
  voicex2Notified   = false;
  setRoleLabel(currentMode, false);

  // Completed lines feed
  el('completed-lines-feed').innerHTML = '';

  // Timer label
  const timerEl = el('race-timer');
  timerEl.classList.remove('timer-urgent');
  if (isMultiLineRound) {
    timerEl.textContent = formatCountdown(roundDurationSecs);
  } else {
    timerEl.textContent = '0:00';
  }

  // Line indicator
  updateLineIndicator();

  // Input mode setup
  if (currentMode === 'voice') {
    el('keyboard-area').style.display    = 'none';
    el('voice-target-area').style.display = '';
    el('voice-area').style.display       = '';
    el('current-line-display').textContent = currentPrompt;
    const ta = el('voice-textarea');
    ta.value = '';
    setupVoiceInput(ta);
  } else {
    el('voice-target-area').style.display = 'none';
    el('voice-area').style.display        = 'none';
    el('keyboard-area').style.display     = '';
    renderTypingDisplay();
    document.addEventListener('keydown', onRaceKey);
  }

  clearInterval(wpmTimer);
  clearInterval(clockTimer);
  wpmTimer  = setInterval(updateRaceStats, 300);
  clockTimer = setInterval(updateClock, 100);
}

// ── Keyboard mode ──────────────────────────────────────────────────────────────
function onRaceKey(e) {
  if (deriveScreen() !== 'racing' || currentMode !== 'keyboard') return;
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  e.preventDefault();

  // Enter and Tab never bypass word validation.
  if ((e.key === 'Enter' || e.key === 'Tab') && isMultiLineRound) {
    checkLineComplete();
    return;
  }

  if (e.key === 'Backspace') {
    if (typedText.length > 0) { typedText = typedText.slice(0, -1); backspaces++; }
  } else if (e.key.length === 1 && typedText.length < currentPrompt.length * 3 + 50) {
    const before = normalizeForMatch(typedText);
    typedText += e.key;
    const after = normalizeForMatch(typedText);
    const target = normalizeForMatch(currentPrompt);

    // Count only meaningful letter/number mismatches. Case, punctuation, and
    // repeated whitespace disappear during normalization and never add errors.
    for (let index = before.length; index < after.length; index += 1) {
      if (after[index] !== target[index]) corrections += 1;
    }
  } else { return; }

  renderTypingDisplay();
  sendInputUpdate();
  checkLineComplete();
}

function renderTypingDisplay() {
  const entered = normalizeForMatch(typedText);
  const target = normalizeForMatch(currentPrompt);
  const html = currentPrompt.split('').map((char, i) => {
    let cls;
    if (i < entered.length)      cls = entered[i] === target[i] ? 'correct' : 'wrong';
    else if (i === entered.length) cls = 'cursor';
    else                            cls = 'upcoming';
    return `<span class="char ${cls}">${char === ' ' ? '&nbsp;' : esc(char)}</span>`;
  }).join('');
  el('typing-display').innerHTML = html;
  el('typing-display').querySelector('.cursor')?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
}

// ── Voice mode ─────────────────────────────────────────────────────────────────
function setupVoiceInput(ta) {
  ta.removeEventListener('input', onVoiceInput);
  ta.removeEventListener('focus', onVoiceFocus);
  ta.removeEventListener('blur',  onVoiceBlur);
  ta.addEventListener('input', onVoiceInput);
  ta.addEventListener('focus', onVoiceFocus);
  ta.addEventListener('blur',  onVoiceBlur);
  setTimeout(() => { ta.focus(); }, 200);
}

function onVoiceFocus() {
  voiceFocused = true;
  setRoleLabel('voice', true);
}
function onVoiceBlur() {
  voiceFocused = false;
  if (deriveScreen() === 'racing' && currentMode === 'voice') setRoleLabel('voice', false);
}

function setRoleLabel(mode, focused) {
  const lbl  = el('role-label');
  const text = el('role-label-text');
  if (!lbl || !text) return;
  if (mode === 'voice') {
    lbl.className = focused ? 'role-label mode-voice voice-focused' : 'role-label mode-voice';
    text.textContent = focused
      ? '🎙️ FLOW IS READY — Speak your line now'
      : '⚠️ CLICK THE BOX BELOW — so Wispr Flow knows where to type';
  } else {
    lbl.className = 'role-label mode-keyboard';
    text.textContent = '⌨️ YOU ARE TYPING';
  }
}

function onVoiceInput(e) {
  if (deriveScreen() !== 'racing' || currentMode !== 'voice') return;
  const value = e.target.value;
  sendInputUpdate(value);

  if (isMultiLineRound) {
    if (currentLineIndex >= lineQueue.length) return;
    const target = lineQueue[currentLineIndex]?.text || '';
    if (isVoiceLineComplete(target, value)) {
      lineComplete('voice');
    }
  } else {
    // Single-prompt voice mode (prompt-royale)
    if (isExactWordMatch(currentPrompt, value)) {
      submitRoundFinish(value);
    }
  }
}

function isVoiceLineComplete(targetText, spokenText) {
  return isExactWordMatch(targetText, spokenText);
}

function normalizeForMatch(t) {
  return normalizeText(t);
}

// ── Line completion (multi-line mode) ─────────────────────────────────────────
function checkLineComplete() {
  if (!isMultiLineRound) {
    if (isExactWordMatch(currentPrompt, typedText)) submitRoundFinish(typedText);
    return;
  }
  const target = lineQueue[currentLineIndex]?.text || '';
  if (isExactWordMatch(target, typedText)) lineComplete('keyboard');
}

function lineComplete(inputMode) {
  const lineText  = lineQueue[currentLineIndex]?.text || '';
  const wordCount = normalizeWords(lineText).length;

  completedLinesList.push({ text: lineText, wordCount });
  completedWords += wordCount;

  // Tell server
  send({ type: 'line:complete', stationId: STATION_ID, lineIdx: currentLineIndex, wordCount, errors: corrections });

  // Brief visual flash
  showLineCompleteFlash();

  // Advance locally — loop queue when exhausted
  currentLineIndex++;
  if (currentLineIndex >= lineQueue.length) {
    // Shuffle and loop the queue for variety
    lineQueue = [...lineQueue].sort(() => Math.random() - 0.5);
    currentLineIndex = 0;
  }

  currentPrompt = lineQueue[currentLineIndex].text;
  typedText = '';

  if (inputMode === 'keyboard') {
    renderTypingDisplay();
  } else {
    const ta = el('voice-textarea');
    if (ta) {
      ta.value = '';
      ta.focus(); // Keep focused for Wispr Flow
    }
    el('current-line-display').textContent = currentPrompt;
  }

  updateCompletedFeed();
  updateLineIndicator();
  el('your-words').textContent = completedWords;
  el('race-footer-words').textContent = `${completedWords} word${completedWords !== 1 ? 's' : ''} completed`;
  updateProgressBar(completedWords, oppWordCount);
  checkCameraCallouts();
}

function showLineCompleteFlash() {
  const flash = el('line-complete-flash');
  if (!flash) return;
  clearTimeout(flashTimer);
  flash.style.display = '';
  flashTimer = setTimeout(() => { flash.style.display = 'none'; }, 800);
}

// ── Progress display helpers ───────────────────────────────────────────────────
const MAX_WORDS_FILL = 80; // bar fills at 80 words

function updateProgressBar(yourWords, oppWords) {
  const yourPct = Math.min(100, ((yourWords || 0) / MAX_WORDS_FILL) * 100);
  const oppPct  = Math.min(100, ((oppWords  || 0) / MAX_WORDS_FILL) * 100);
  el('your-progress-bar').style.width = `${yourPct}%`;
  el('opp-progress-bar').style.width  = `${oppPct}%`;
}

function updateCompletedFeed() {
  const feed = el('completed-lines-feed');
  if (!feed) return;
  const recent = completedLinesList.slice(-4);
  feed.innerHTML = recent.map(line =>
    `<div class="completed-line">✓ ${esc(line.text)}</div>`
  ).join('');
}

function updateLineIndicator() {
  const ind = el('race-line-indicator');
  if (!ind) return;
  if (isMultiLineRound && lineQueue.length) {
    const shown = Math.min(currentLineIndex + 1, lineQueue.length);
    ind.textContent = `Line ${shown} / ${lineQueue.length}`;
  } else {
    ind.textContent = '';
  }
}

// ── Clock ──────────────────────────────────────────────────────────────────────
function updateClock() {
  const timerEl = el('race-timer');
  if (!timerEl) return;

  if (isMultiLineRound && roundEndTime) {
    const remaining = Math.max(0, roundEndTime - Date.now());
    const secs = Math.ceil(remaining / 1000);
    timerEl.textContent = formatCountdown(secs);
    if (secs <= 10) timerEl.classList.add('timer-urgent');
    else timerEl.classList.remove('timer-urgent');
  } else if (raceStartTime) {
    const elapsed = Math.floor((Date.now() - raceStartTime) / 1000);
    timerEl.textContent = `${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}`;
  }
}

function formatCountdown(secs) {
  return `${Math.floor(secs / 60)}:${String(secs % 60).padStart(2, '0')}`;
}

// ── Live WPM stats interval ────────────────────────────────────────────────────
function updateRaceStats() {
  sendInputUpdate(); // keep server up to date

  if (isMultiLineRound) {
    el('your-words').textContent = completedWords;
    // Live WPM = completedWords / elapsed minutes
    if (raceStartTime) {
      const mins = Math.max((Date.now() - raceStartTime) / 60000, 0.01);
      el('your-wpm').textContent = Math.round(completedWords / mins);
    }
    updateProgressBar(completedWords, oppWordCount);
  } else if (currentMode === 'keyboard') {
    // Single-prompt WPM display
    const wpm = calcWpm(typedText);
    const targetWords = normalizeWords(currentPrompt).length;
    const pct = targetWords > 0 ? countMatchedWords(currentPrompt, typedText) / targetWords : 0;
    el('your-words').textContent = wpm;
    el('your-wpm').textContent   = wpm;
    el('your-progress-bar').style.width = `${Math.round(pct * 100)}%`;
  }
}

function calcWpm(text) {
  if (!raceStartTime) return 0;
  const mins = (Date.now() - raceStartTime) / 60000;
  if (mins < 0.001) return 0;
  return Math.round(countMatchedWords(currentPrompt, text) / mins);
}

function checkCameraCallouts() {
  if (!isMultiLineRound) return;
  // Determine which is voice and which is keyboard
  const voiceWords = currentMode === 'voice' ? completedWords : oppWordCount;
  const kbWords    = currentMode === 'voice' ? oppWordCount  : completedWords;
  if (voiceWords === 0 || kbWords === 0) return;

  if (!voiceLeadNotified && voiceWords > kbWords) {
    voiceLeadNotified = true;
    notify('🎙️ Voice takes the lead!', 'callout');
  }
  if (!voicex2Notified && voiceWords >= kbWords * 2) {
    voicex2Notified = true;
    notify('🔥 2× output with Flow!', 'callout');
  }
}

function onOpponentUpdate(progress, usableWpm, wordCount) {
  if (wordCount !== undefined) {
    // Multi-line mode: show word count
    oppWordCount = wordCount;
    el('opp-words').textContent = wordCount;
    // Rough WPM for opponent
    if (isMultiLineRound && raceStartTime) {
      const mins = Math.max((Date.now() - raceStartTime) / 60000, 0.01);
      el('opp-wpm').textContent = Math.round(wordCount / mins);
    }
    updateProgressBar(completedWords, oppWordCount);
    checkCameraCallouts();
  } else {
    // Single-prompt mode fallback
    el('opp-progress-bar').style.width = `${Math.round((progress || 0) * 100)}%`;
    el('opp-words').textContent = usableWpm || 0;
  }
}

function sendInputUpdate(voiceValue) {
  const value = currentMode === 'voice'
    ? (voiceValue !== undefined ? voiceValue : (el('voice-textarea')?.value || ''))
    : typedText;
  send({ type: 'input:update', stationId: STATION_ID, value, corrections });
}

// ── Single-prompt round finish (prompt-royale only) ────────────────────────────
function submitRoundFinish(value) {
  if (roundEndSent || isMultiLineRound) return;
  roundEndSent = true;
  clearInterval(wpmTimer);
  clearInterval(clockTimer);
  document.removeEventListener('keydown', onRaceKey);

  const finalWpm = calcWpm(value || typedText);
  el('your-words').textContent = finalWpm;

  send({ type: 'round:finish', stationId: STATION_ID, value: value || typedText, corrections, backspaces });
}

// ─── ROUND TRANSITION ──────────────────────────────────────────────────────────
function populateRoundTransition() {
  const s = serverSession;
  if (!s) return;

  const prevRound = s.rounds?.[s.currentRoundIndex - 1] || lastRoundResult;
  const miniEl = el('rt-mini-results');
  if (prevRound?.stationResults && miniEl) {
    const items = Object.values(prevRound.stationResults);
    miniEl.innerHTML = items.map(r => {
      const val = prevRound.isMultiLine ? `${r.completedWords || 0} words` : `${r.usableWpm} WPM`;
      return `<div class="rt-score-block">
        <div class="rt-score-name">${esc(r.playerName || r.stationId)}</div>
        <div class="rt-score-num">${val}</div>
        <div style="font-size:11px;color:var(--text-dim)">${r.inputMode.toUpperCase()}</div>
      </div>`;
    }).join('<div style="width:1px;background:var(--border);margin:0 8px"></div>');
  }

  const pending  = s.pendingAssignments || {};
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

  let secs = serverConfig?.transitionSeconds || 10;
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
  const allSc   = Object.values(scores);
  const players = s.players || {};
  const mode    = s.mode;
  const dur     = s.rounds?.[0]?.durationSeconds || 60;

  const isSoloMode = mode === 'solo-challenge';
  const isVvK      = mode === 'voice-vs-keyboard';

  // ── Aggregate totals across all players ──
  const totalKbWords  = allSc.reduce((sum, sc) => sum + (sc.keyboardWords || 0), 0);
  const totalVoWords  = allSc.reduce((sum, sc) => sum + (sc.voiceWords    || 0), 0);
  const totalKbErrors = allSc.reduce((sum, sc) => sum + (sc.keyboardErrors || 0), 0);
  const hasVoice = totalVoWords > 0;

  // ── Banner ──
  const banner = el('result-banner');
  if (hasVoice && totalKbWords > 0) {
    const mult = Math.round((totalVoWords / totalKbWords) * 10) / 10;
    banner.textContent = mult > 1
      ? `${mult}× more output with Flow`
      : `${totalVoWords} words with your voice`;
    banner.className = 'result-banner voice-lift';
  } else if (hasVoice) {
    banner.textContent = `${totalVoWords} words with Wispr Flow`;
    banner.className = 'result-banner voice-lift';
  } else if (isSoloMode) {
    banner.textContent = 'Challenge complete';
    banner.className = 'result-banner solo';
  } else if (winner?.type === 'tie') {
    banner.textContent = "IT'S A TIE!";
    banner.className = 'result-banner tie';
  } else if (winner?.stationId) {
    const iAm = winner.stationId === STATION_ID;
    banner.textContent = iAm ? `🏆 You win!` : `${esc(winner.name)} wins`;
    banner.className = `result-banner ${iAm ? 'win' : 'lose'}`;
  } else {
    banner.textContent = 'Round Complete';
    banner.className = 'result-banner solo';
  }

  // ── Voice Comparison Cards (solo-challenge + voice-vs-keyboard) ──
  const voSection = el('voice-output-section');
  const showVoice = hasVoice && (isSoloMode || isVvK);

  if (showVoice) {
    voSection.style.display = '';
    el('voice-advantage-banner').style.display = ''; // reset before conditional hide below

    // Determine card labels and per-card numbers
    let kbLabel = 'Keyboard', voLabel = 'Wispr Flow';
    let kbWords = 0, voWords = 0, kbErrors = 0;

    if (isSoloMode) {
      const solo = scores[1] || allSc[0] || {};
      kbWords  = solo.keyboardWords  || 0;
      voWords  = solo.voiceWords     || 0;
      kbErrors = solo.keyboardErrors || 0;
      kbLabel  = 'Round 1 · Keyboard';
      voLabel  = 'Round 2 · Flow';
    } else {
      // voice-vs-keyboard: find which player was which
      Object.entries(scores).forEach(([sid, sc]) => {
        const name = players[parseInt(sid)]?.name || `Station ${sid}`;
        if ((sc.keyboardWords || 0) > 0) {
          kbLabel = name; kbWords = sc.keyboardWords; kbErrors = sc.keyboardErrors || 0;
        }
        if ((sc.voiceWords || 0) > 0) {
          voLabel = name; voWords = sc.voiceWords;
        }
      });
    }

    const mult = kbWords > 0 && voWords > 0
      ? Math.round((voWords / kbWords) * 10) / 10 : null;

    el('vo-cards').innerHTML = `
      <div class="vo-card kb-card">
        <div class="vo-card-icon">⌨️</div>
        <div class="vo-card-label">${esc(kbLabel)}</div>
        <div class="vo-card-words">${kbWords}</div>
        <div class="vo-card-sublabel">words · ${dur}s</div>
        ${kbErrors > 0 ? `<div class="vo-card-errors">${kbErrors} error${kbErrors !== 1 ? 's' : ''}</div>` : ''}
      </div>
      <div class="vo-card flow-card">
        <div class="vo-card-icon">🎙️</div>
        <div class="vo-card-label">${esc(voLabel)}</div>
        <div class="vo-card-words">${voWords}</div>
        <div class="vo-card-sublabel">words · ${dur}s</div>
      </div>`;

    const vaNum = el('va-number');
    const vaLbl = el('va-label');
    if (mult !== null && mult > 1) {
      vaNum.textContent = `${mult}×`;
      vaLbl.textContent = 'more output with Flow';
    } else if (voWords > kbWords) {
      vaNum.textContent = `+${voWords - kbWords}`;
      vaLbl.textContent = 'extra words with Flow';
    } else if (voWords > 0 && kbWords === 0) {
      vaNum.textContent = `${voWords}`;
      vaLbl.textContent = 'words spoken';
    } else {
      // Flow didn't beat keyboard — still show "KB wins" in the banner above
      el('voice-advantage-banner').style.display = 'none';
    }
  } else {
    voSection.style.display = 'none';
  }

  // ── Per-player score cards ──
  const scoresEl = el('result-scores');
  const sids = Object.keys(players).map(Number).sort();

  scoresEl.innerHTML = sids.map(sid => {
    const p    = players[sid];
    const sc   = scores[sid] || {};
    const isW  = winner?.stationId === sid;
    const kbW  = sc.keyboardWords  || 0;
    const voW  = sc.voiceWords     || 0;
    const kbE  = sc.keyboardErrors || 0;
    const voE  = sc.voiceErrors    || 0;
    const best = Math.max(kbW, voW);
    const errs = kbE + voE;

    let detail = '';
    if (kbW > 0 && voW > 0) {
      detail = `<span class="res-mode-pill kb-pill">⌨️ ${kbW}</span><span class="res-mode-pill vo-pill">🎙️ ${voW}</span>`;
    } else if (kbW > 0) {
      detail = `<span class="res-mode-pill kb-pill">⌨️ typed</span>`;
    } else if (voW > 0) {
      detail = `<span class="res-mode-pill vo-pill">🎙️ spoken</span>`;
    }

    return `<div class="result-player ${isW ? 'winner' : ''}">
      <div class="result-pname">${esc(p?.name || `Station ${sid}`)}</div>
      <div class="result-big-num">${best}</div>
      <div class="result-big-unit">words</div>
      <div class="result-errors-line ${errs === 0 ? 'clean' : ''}">${errs === 0 ? '✓ No errors' : `${errs} error${errs !== 1 ? 's' : ''}`}</div>
      <div class="result-mode-pills">${detail}</div>
    </div>`;
  }).join(sids.length > 1 ? '<div class="result-vs">VS</div>' : '');

  // ── Badges ──
  const allBadges = [...new Set(allSc.flatMap(sc => sc.badges || []))];
  const badgesEl = el('badges-row');
  if (allBadges.length) {
    badgesEl.innerHTML = allBadges.map(b => {
      const meta = BADGE_META[b];
      return meta ? `<div class="badge-chip">${meta.emoji} ${meta.label}</div>` : '';
    }).join('');
    el('badges-section').style.display = '';
  } else {
    el('badges-section').style.display = 'none';
  }

  // ── Leaderboard ──
  fetch('/api/leaderboard')
    .then(r => r.json())
    .then(entries => renderLeaderboard(entries, 'result-leaderboard'))
    .catch(() => renderLeaderboard([], 'result-leaderboard'));

  // ── Countdown ──
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
  const allSc  = Object.values(scores);
  const maxVM  = Math.max(...allSc.map(s => s.voiceMultiplier || s.voiceAdvantage || 0));
  const maxExtra = Math.max(...allSc.map(s => s.extraWords || 0));
  const qrUrl  = serverConfig?.qrUrl || 'https://wispr.ai';

  el('cta-headline').innerHTML = `Try <span>Wispr Flow</span>`;
  if (maxVM > 0) {
    el('cta-subline').textContent = `You were ${maxVM}× faster with your voice.`;
  } else if (maxExtra > 0) {
    el('cta-subline').textContent = `Voice gave you ${maxExtra} extra words in 60 seconds.`;
  } else {
    el('cta-subline').textContent = 'Talk faster than you type.';
  }
  el('cta-qr-img').src = `https://api.qrserver.com/v1/create-qr-code/?size=200x200&data=${encodeURIComponent(qrUrl)}`;
  el('cta-url').textContent = qrUrl;
}

// ─── Leaderboard rendering ─────────────────────────────────────────────────────
function renderLeaderboard(entries, containerId) {
  const c = el(containerId);
  if (!c) return;
  if (!entries?.length) { c.innerHTML = '<p class="lb-empty">No scores yet — be the first!</p>'; return; }
  const medals = ['🥇', '🥈', '🥉'];
  const modeShort = {
    'solo-challenge': 'Solo',
  };
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
  if (e.ctrlKey && e.shiftKey && e.key === 'R') { e.preventDefault(); send({ type: 'admin:reset' }); }

  const screen = deriveScreen();
  if (screen === 'idle') {
    if (!e.ctrlKey && !e.metaKey && e.key !== 'Escape') {
      startSoloChallenge();
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
