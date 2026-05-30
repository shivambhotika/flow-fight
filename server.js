'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

// Resolve public directory
const PUBLIC_DIR = [
  path.join(__dirname, 'public'),
  path.join(process.cwd(), 'public'),
  path.join(__dirname, '..', 'public'),
].find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
  || path.join(__dirname, 'public');

app.use(express.static(PUBLIC_DIR));
app.use(express.json());

// ─── Data files ────────────────────────────────────────────────────────────────
const DATA = [
  path.join(__dirname, 'data'),
  path.join(process.cwd(), 'data'),
  path.join(__dirname, '..', 'data'),
].find(p => { try { return fs.statSync(p).isDirectory(); } catch { return false; } })
  || path.join(__dirname, 'data');

function loadJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(path.join(DATA, file), 'utf8')); } catch { return fallback; }
}
function saveJson(file, data) {
  try {
    fs.mkdirSync(DATA, { recursive: true });
    fs.writeFileSync(path.join(DATA, file), JSON.stringify(data, null, 2));
  } catch (_) {
    // Silently skip on read-only filesystems (e.g. Render free tier ephemeral)
  }
}

let config      = loadJson('event-config.json', defaultConfig());
let leaderboard = loadJson('leaderboard.json', []);
let runs        = loadJson('runs.json', []);
let names       = loadJson('names.json', []);
let promptsDb   = loadJson('prompts.json', []);

function defaultConfig() {
  return {
    eventId: 'event_001', eventName: 'Flow Fight', partnerName: '',
    defaultMode: 'wpm-fight',
    enabledModes: ['wpm-fight', 'voice-vs-keyboard', 'solo-challenge'],
    roundSeconds: 60, countdownSeconds: 3, resultsSeconds: 15, ctaSeconds: 10,
    enableVoiceMode: true, enableQrCta: true,
    qrUrl: 'https://wispr.ai', qrLabel: 'Try Wispr Flow', leaderboardLimit: 20,
  };
}

// ─── Mode definitions ──────────────────────────────────────────────────────────
const MODES = {
  'wpm-fight':          { label: 'WPM Fight',          tagline: 'Pure typing speed — who\'s faster?',  icon: '⌨️', playerCount: 2, rounds: 1 },
  'voice-vs-keyboard':  { label: 'Voice vs Keyboard',  tagline: 'One talks. One types. Who wins?',     icon: '🎙️', playerCount: 2, rounds: 1 },
  'solo-challenge':     { label: 'Solo Challenge',     tagline: 'Type then speak — beat your score.',  icon: '🏃', playerCount: 1, rounds: 2 },
};

function getRoundAssignments(mode, roundIndex) {
  if (mode === 'voice-vs-keyboard') return { 1: 'keyboard', 2: 'voice' };
  if (mode === 'solo-challenge')    return roundIndex === 0 ? { 1: 'keyboard' } : { 1: 'voice' };
  return { 1: 'keyboard', 2: 'keyboard' }; // wpm-fight + default
}

// ─── Station & session state ───────────────────────────────────────────────────
const stations = new Map([
  [1, { ws: null, player: null, ready: false }],
  [2, { ws: null, player: null, ready: false }],
]);

let session = null;
let timers  = [];

function uid()   { return crypto.randomUUID().slice(0, 8); }
function later(fn, ms) { const t = setTimeout(fn, ms); timers.push(t); return t; }
function clearAllTimers() { timers.forEach(t => clearTimeout(t)); timers = []; }

// ─── Broadcast helpers ─────────────────────────────────────────────────────────
function broadcast(data) {
  const msg = JSON.stringify(data);
  wss.clients.forEach(c => { if (c.readyState === 1) c.send(msg); });
}
function sendTo(ws, data) { if (ws?.readyState === 1) ws.send(JSON.stringify(data)); }
function sendToStation(id, data) { sendTo(stations.get(id)?.ws, data); }

function broadcastState() {
  broadcast({ type: 'state:update', session: serializeSession(), config: publicConfig() });
}

function publicConfig() {
  return {
    eventName: config.eventName, partnerName: config.partnerName,
    enabledModes: config.enabledModes, roundSeconds: config.roundSeconds,
    enableQrCta: config.enableQrCta, qrUrl: config.qrUrl, qrLabel: config.qrLabel,
    modes: MODES,
  };
}

function serializeSession() {
  if (!session) return null;
  return {
    id: session.id, mode: session.mode, state: session.state,
    players: session.players,
    currentRoundIndex: session.currentRoundIndex,
    currentRound: session.rounds[session.currentRoundIndex] || null,
    rounds: session.rounds,
    winner: session.winner,
    playerScores: session.playerScores || null,
    pendingAssignments: session.pendingAssignments || null,
  };
}

// ─── Prompts ───────────────────────────────────────────────────────────────────
function pickPrompt(mode) {
  const cat = mode === 'hinglish-hustle' ? 'hinglish' : mode === 'prompt-royale' ? 'royale' : null;
  let pool = cat ? promptsDb.filter(p => p.category === cat)
                 : promptsDb.filter(p => p.category !== 'hinglish' && p.category !== 'royale' && p.category !== 'one_liner');
  if (!pool.length) pool = promptsDb;
  return pool[Math.floor(Math.random() * pool.length)];
}

// Pick a queue of one-liner prompts for the multi-line race
function pickLineQueue(_mode, count = 25) {
  let pool = promptsDb.filter(p => p.category === 'one_liner');
  // Fill up if not enough one-liners
  if (pool.length < count) {
    const extra = promptsDb.filter(p =>
      p.category !== 'one_liner' && p.text.length < 90 &&
      !pool.some(q => q.id === p.id)
    );
    pool = [...pool, ...extra];
  }
  if (!pool.length) pool = promptsDb;
  return [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));
}

// ─── Scoring helpers ───────────────────────────────────────────────────────────
function countWords(text) {
  return (text || '').trim().split(/\s+/).filter(Boolean).length;
}

// Count how many words the typed input matches (partial credit at end of round)
function countPartialWords(targetText, typedText, inputMode) {
  if (!typedText || typedText.length < 2) return 0;
  if (inputMode !== 'voice') {
    // Keyboard: count correctly typed characters / 5
    const target = targetText || '';
    let correct = 0;
    for (let i = 0; i < Math.min(typedText.length, target.length); i++) {
      if (typedText[i] === target[i]) correct++;
    }
    return Math.floor(correct / 5);
  }
  // Voice: count normalized word matches from start
  const targetWords = (targetText || '').toLowerCase().replace(/[.,!?;:'"—–]/g, '').split(/\s+/).filter(Boolean);
  const typedWords  = (typedText  || '').toLowerCase().replace(/[.,!?;:'"—–]/g, '').split(/\s+/).filter(Boolean);
  let count = 0;
  for (let i = 0; i < Math.min(typedWords.length, targetWords.length); i++) {
    if (typedWords[i] === targetWords[i]) count++;
  }
  return count;
}

// ─── Legacy scoring (single-prompt modes) ─────────────────────────────────────
function normalizeText(text, inputMode) {
  let t = text.replace(/\s+/g, ' ').trim();
  if (inputMode === 'voice' || inputMode === 'hinglish') {
    t = t.toLowerCase().replace(/[.,!?;:'"—–]/g, '').replace(/\s+/g, ' ').trim();
  }
  return t;
}

function evaluateInput(targetText, currentText, elapsedMs, inputMode) {
  const target  = normalizeText(targetText, inputMode);
  const current = normalizeText(currentText, inputMode);
  const mins    = Math.max(elapsedMs / 60000, 0.001);

  let correctChars = 0;
  const minLen = Math.min(target.length, current.length);
  for (let i = 0; i < minLen; i++) {
    if (target[i] === current[i]) correctChars++;
  }

  const rawWpm     = Math.round((current.length / 5) / mins);
  const correctWpm = Math.round((correctChars / 5) / mins);
  const accuracy   = current.length > 0 ? correctChars / Math.max(target.length, current.length) : 0;
  const usableWpm  = Math.round(correctWpm * accuracy);
  const progress   = target.length > 0 ? Math.min(1, current.length / target.length) : 0;
  const isComplete = inputMode === 'voice'
    ? (current.length >= target.length * 0.85 && accuracy > 0.75)
    : (current === target);

  return { correctChars, rawWpm, correctWpm, accuracy, usableWpm, progress, isComplete };
}

function calcFlowScore(usableWpm, accuracy, completed, corrections) {
  const completionBonus   = completed ? 10 : 0;
  const correctionPenalty = corrections * 0.25;
  return Math.max(0, Math.round((usableWpm * 1.2) + completionBonus - correctionPenalty));
}

function assignBadges(keyboardWords, voiceWords, accuracy, corrections, inputMode) {
  const badges = [];
  const voiceAdv = keyboardWords > 0 && voiceWords > 0 ? voiceWords / keyboardWords : null;
  if (voiceAdv !== null && voiceAdv >= 2) badges.push('keyboard_slayer');
  if (accuracy >= 0.95)                   badges.push('flow_state');
  if (inputMode === 'voice' || voiceWords > 0) badges.push('no_hands');
  if (Math.max(keyboardWords, voiceWords) >= 100) badges.push('speed_demon');
  if (corrections <= 1 && inputMode === 'keyboard') badges.push('clean_talker');
  if (voiceAdv !== null && voiceAdv < 1 && keyboardWords > 0) badges.push('keyboard_survivor');
  return badges;
}

// ─── Leaderboard ───────────────────────────────────────────────────────────────
function topEntries(bucket, limit = 20) {
  const entries = bucket ? leaderboard.filter(e => e.bucket === bucket) : leaderboard;
  return entries.sort((a, b) => b.flowScore - a.flowScore).slice(0, limit);
}

// ─── Session state machine ─────────────────────────────────────────────────────
function createSession(mode) {
  clearAllTimers();
  const modeConf = MODES[mode] || MODES['wpm-fight'];
  session = {
    id: uid(), mode, state: 'name-entry',
    players: {}, rounds: [], currentRoundIndex: 0,
    winner: null, playerScores: null, pendingAssignments: null,
    stationState: {},
  };
  stations.forEach((s, id) => stations.set(id, { ...s, player: null, ready: false }));
  broadcastState();
}

function checkBothReady() {
  if (!session) return;
  const needed = MODES[session.mode]?.playerCount === 1 ? [1] : [1, 2];
  if (needed.every(id => stations.get(id)?.ready)) startCountdown();
}

function isMultiLineMode(_mode) {
  return true; // all 3 modes are multi-line 60s races
}

function startCountdown() {
  const idx         = session.currentRoundIndex;
  const assignments = getRoundAssignments(session.mode, idx);
  const multiLine   = isMultiLineMode(session.mode);

  let roundData;
  if (multiLine) {
    const lineQueue = pickLineQueue(session.mode);
    roundData = {
      id: uid(), index: idx,
      promptId: lineQueue[0]?.id || '',
      targetText: lineQueue[0]?.text || '',
      promptCategory: 'one_liner',
      lineQueue,
      isMultiLine: true,
      inputAssignments: assignments,
      durationSeconds: config.roundSeconds,
      startedAt: null, endedAt: null, stationResults: {},
    };
  } else {
    const prompt = pickPrompt(session.mode);
    roundData = {
      id: uid(), index: idx,
      promptId: prompt.id, targetText: prompt.text, promptCategory: prompt.category,
      isMultiLine: false,
      inputAssignments: assignments,
      durationSeconds: config.roundSeconds,
      startedAt: null, endedAt: null, stationResults: {},
    };
  }

  session.rounds[idx] = roundData;
  session.state = 'countdown';
  broadcastState();

  let count = config.countdownSeconds;
  broadcast({ type: 'countdown:tick', count });
  const iv = setInterval(() => {
    count--;
    if (count > 0) {
      broadcast({ type: 'countdown:tick', count });
    } else {
      clearInterval(iv);
      broadcast({ type: 'countdown:tick', count: 'GO' });
      later(() => startRound(), 700);
    }
  }, 1000);
  timers.push(iv);
}

function startRound() {
  const round = session.rounds[session.currentRoundIndex];
  round.startedAt = Date.now();
  session.state = 'racing';

  // Init per-station state for multi-line mode
  if (round.isMultiLine) {
    session.stationState = {};
    Object.keys(round.inputAssignments).forEach(id => {
      session.stationState[id] = { lineIdx: 0, completedWords: 0, lastValue: '', errors: 0 };
    });
  }

  broadcastState();
  later(() => forceEndRound(), round.durationSeconds * 1000 + 500);
}

function handleRoundInputSingle(stationId, value, elapsedMs, corrections) {
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  if (!round) return;
  const inputMode = round.inputAssignments[stationId] || 'keyboard';
  const stats = evaluateInput(round.targetText, value, elapsedMs, inputMode);

  const otherId = stationId === 1 ? 2 : 1;
  sendToStation(otherId, { type: 'opponent:update', stationId, progress: stats.progress, usableWpm: stats.usableWpm });
  broadcast({ type: 'live:update', stationId, name: session.players[stationId]?.name, progress: stats.progress, usableWpm: stats.usableWpm });
}

function submitRoundResult(stationId, value, elapsedMs, corrections, backspaces) {
  // Only used for single-prompt (prompt-royale) mode
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  if (!round || round.isMultiLine || round.stationResults[stationId]) return;

  const player    = session.players[stationId];
  const inputMode = round.inputAssignments[stationId] || 'keyboard';
  const stats     = evaluateInput(round.targetText, value, elapsedMs, inputMode);
  const flowScore = calcFlowScore(stats.usableWpm, stats.accuracy, stats.isComplete, corrections);

  round.stationResults[stationId] = {
    stationId: String(stationId), playerId: player?.id, playerName: player?.name,
    inputMode, rawText: value,
    completedWords: 0,
    rawWpm: stats.rawWpm, usableWpm: stats.usableWpm, accuracy: stats.accuracy,
    corrections, backspaces, completed: stats.isComplete,
    completionTimeMs: elapsedMs, flowScore, badgeIds: [],
  };

  const required = Object.keys(round.inputAssignments).map(Number);
  if (required.every(id => round.stationResults[id])) {
    clearAllTimers();
    endRound();
  } else {
    const otherId = stationId === 1 ? 2 : 1;
    sendToStation(otherId, { type: 'toast', message: `${player?.name || 'Opponent'} finished — ${stats.usableWpm} WPM!` });
  }
}

function forceEndRound() {
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  if (!round) return;

  const durationMs = round.durationSeconds * 1000;
  const mins       = round.durationSeconds / 60;

  Object.keys(round.inputAssignments).map(Number).forEach(id => {
    if (round.stationResults[id]) return;

    if (round.isMultiLine) {
      const ss = session.stationState?.[id] || { lineIdx: 0, completedWords: 0, lastValue: '' };
      const inputMode    = round.inputAssignments[id];
      const currentLine  = round.lineQueue?.[ss.lineIdx]?.text || '';
      const partialWords = countPartialWords(currentLine, ss.lastValue, inputMode);
      const totalWords   = ss.completedWords + partialWords;
      const usableWpm    = Math.round(totalWords / Math.max(mins, 0.01));
      const flowScore    = totalWords * 10;

      round.stationResults[id] = {
        stationId: String(id), playerId: session.players[id]?.id, playerName: session.players[id]?.name,
        inputMode, rawText: ss.lastValue,
        completedWords: totalWords,
        rawWpm: usableWpm, usableWpm, accuracy: 1.0,
        corrections: ss.errors || 0, backspaces: 0,
        completed: false, completionTimeMs: durationMs,
        flowScore, badgeIds: [],
      };
    } else {
      round.stationResults[id] = {
        stationId: String(id), playerId: session.players[id]?.id, playerName: session.players[id]?.name,
        inputMode: round.inputAssignments[id], rawText: '',
        completedWords: 0,
        rawWpm: 0, usableWpm: 0, accuracy: 0, corrections: 0, backspaces: 0,
        completed: false, completionTimeMs: durationMs, flowScore: 0, badgeIds: [],
      };
    }
  });
  endRound();
}

function endRound() {
  clearAllTimers();
  const round = session.rounds[session.currentRoundIndex];
  round.endedAt = Date.now();
  broadcast({ type: 'round:results', round, roundIndex: session.currentRoundIndex });

  const totalRounds = MODES[session.mode].rounds;
  const nextIdx     = session.currentRoundIndex + 1;

  if (nextIdx < totalRounds) {
    session.currentRoundIndex  = nextIdx;
    session.pendingAssignments = getRoundAssignments(session.mode, nextIdx);
    session.state = 'round-transition';
    broadcastState();
    later(() => { session.pendingAssignments = null; startCountdown(); }, 5000);
  } else {
    endSession();
  }
}

function endSession() {
  session.state = 'results';
  const playerScores = {};

  for (const [sid, player] of Object.entries(session.players)) {
    let totalFlow = 0, keyboardWords = 0, voiceWords = 0, keyboardErrors = 0, voiceErrors = 0;
    session.rounds.forEach(round => {
      const r = round.stationResults[parseInt(sid)];
      if (!r) return;
      totalFlow += r.flowScore;
      if (r.inputMode === 'keyboard') {
        keyboardWords  = r.completedWords || r.usableWpm || 0;
        keyboardErrors = r.corrections    || 0;
      }
      if (r.inputMode === 'voice') {
        voiceWords  = r.completedWords || r.usableWpm || 0;
        voiceErrors = r.corrections    || 0;
      }
    });

    const voiceMultiplier = keyboardWords > 0 && voiceWords > 0
      ? Math.round((voiceWords / keyboardWords) * 10) / 10 : null;
    const extraWords = voiceWords > keyboardWords ? voiceWords - keyboardWords : 0;
    const badges = assignBadges(keyboardWords, voiceWords, 1.0, 0, voiceWords > 0 ? 'voice' : 'keyboard');

    playerScores[sid] = {
      totalFlow,
      keyboardWpm: keyboardWords,   // kept for compat
      voiceWpm: voiceWords,         // kept for compat
      keyboardWords, voiceWords, extraWords, voiceMultiplier,
      keyboardErrors, voiceErrors,
      badges,
    };

    leaderboard.push({
      id: uid(), eventId: config.eventId, playerName: player.name, company: player.company || '',
      mode: session.mode, flowScore: totalFlow,
      usableWpm: Math.max(keyboardWords, voiceWords),
      voiceAdvantage: voiceMultiplier, badgeIds: badges,
      bucket: session.mode, createdAt: Date.now(),
    });
    saveJson('leaderboard.json', leaderboard);

    session.rounds.forEach(round => {
      const r = round.stationResults[parseInt(sid)];
      if (!r) return;
      runs.push({
        runId: uid(), sessionId: session.id, eventId: config.eventId, timestamp: Date.now(),
        mode: session.mode, playerName: player.name, company: player.company || '',
        inputMode: r.inputMode, promptId: round.promptId,
        rawWpm: r.rawWpm, usableWpm: r.usableWpm, accuracy: r.accuracy,
        flowScore: r.flowScore, voiceAdvantage: voiceMultiplier,
        badgeIds: r.badgeIds, completed: r.completed,
        completedWords: r.completedWords || 0, corrections: r.corrections || 0,
      });
    });
    saveJson('runs.json', runs);
  }

  // Determine winner
  const scores = Object.entries(playerScores).map(([sid, s]) => ({ sid: parseInt(sid), score: s.totalFlow }));
  if (scores.length === 1) {
    session.winner = { type: 'solo', stationId: scores[0].sid, name: session.players[scores[0].sid]?.name };
  } else {
    const [a, b] = scores;
    if (a.score > b.score)      session.winner = { type: 'win', stationId: a.sid, name: session.players[a.sid]?.name };
    else if (b.score > a.score) session.winner = { type: 'win', stationId: b.sid, name: session.players[b.sid]?.name };
    else                        session.winner = { type: 'tie' };
  }

  session.playerScores = playerScores;
  broadcastState();
  broadcast({ type: 'session:results', winner: session.winner, playerScores, leaderboard: topEntries(null) });

  if (config.enableQrCta) {
    later(() => { session.state = 'cta'; broadcastState(); later(doReset, config.ctaSeconds * 1000); }, config.resultsSeconds * 1000);
  } else {
    later(doReset, config.resultsSeconds * 1000);
  }
}

function doReset() {
  clearAllTimers();
  session = null;
  stations.forEach((s, id) => stations.set(id, { ws: s.ws, player: null, ready: false }));
  broadcast({ type: 'state:update', session: null, config: publicConfig() });
}

// ─── WebSocket ─────────────────────────────────────────────────────────────────
wss.on('connection', (ws) => {
  let myStation = null;

  ws.on('message', (raw) => {
    let msg; try { msg = JSON.parse(raw); } catch { return; }

    switch (msg.type) {

      case 'station:join': {
        const id = parseInt(msg.stationId);
        if (id === 1 || id === 2) {
          myStation = id;
          stations.set(id, { ...stations.get(id), ws });
        }
        sendTo(ws, { type: 'state:update', session: serializeSession(), config: publicConfig() });
        sendTo(ws, { type: 'names', names });
        break;
      }

      case 'mode:select': {
        if (!session) createSession(msg.mode || config.defaultMode);
        break;
      }

      case 'player:select': {
        if (!session) break;
        const sid = parseInt(msg.stationId) || myStation;
        if (!sid) break;
        session.players[sid] = { id: uid(), stationId: String(sid), name: msg.name || 'Player', company: msg.company || '', isReady: false };
        broadcastState();
        break;
      }

      case 'player:ready': {
        if (!session) break;
        const sid = parseInt(msg.stationId) || myStation;
        if (!sid) break;
        stations.set(sid, { ...stations.get(sid), ready: true });
        if (session.players[sid]) session.players[sid].isReady = true;
        broadcastState();
        checkBothReady();
        break;
      }

      case 'input:update': {
        if (!session || session.state !== 'racing') break;
        const sid   = parseInt(msg.stationId) || myStation;
        const round = session.rounds[session.currentRoundIndex];
        if (!round || !sid) break;

        if (round.isMultiLine) {
          // Store lastValue for partial scoring at round-end
          const ss = session.stationState?.[sid];
          if (ss) { ss.lastValue = msg.value || ''; if (msg.corrections !== undefined) ss.errors = msg.corrections; }

          // Compute live word count (completed + partial) for leaderboard display
          const elapsed      = Date.now() - (round.startedAt || Date.now());
          const inputMode    = round.inputAssignments[sid];
          const currentLine  = round.lineQueue?.[ss?.lineIdx || 0]?.text || '';
          const partial      = countPartialWords(currentLine, msg.value || '', inputMode);
          const totalWords   = (ss?.completedWords || 0) + partial;
          const mins         = Math.max(elapsed / 60000, 0.001);
          broadcast({ type: 'live:update', stationId: sid, name: session.players[sid]?.name, usableWpm: Math.round(totalWords / mins) });
          const otherId = sid === 1 ? 2 : 1;
          sendToStation(otherId, { type: 'opponent:update', stationId: sid, wordCount: totalWords });
        } else {
          handleRoundInputSingle(sid, msg.value || '', round.startedAt ? Date.now() - round.startedAt : 0, msg.corrections || 0);
        }
        break;
      }

      case 'line:complete': {
        // Client reports a line was fully completed in multi-line mode
        if (!session || session.state !== 'racing') break;
        const sid   = parseInt(msg.stationId) || myStation;
        const round = session.rounds[session.currentRoundIndex];
        if (!round?.isMultiLine || !sid) break;
        const ss = session.stationState?.[sid];
        if (!ss) break;
        // Desync guard: only accept if lineIdx matches
        if (msg.lineIdx !== ss.lineIdx) break;

        const lineText   = round.lineQueue[ss.lineIdx]?.text || '';
        const wordCount  = countWords(lineText);
        ss.completedWords += wordCount;
        ss.lineIdx++;
        ss.lastValue = '';
        if (msg.errors !== undefined) ss.errors = msg.errors;

        const elapsed    = Date.now() - (round.startedAt || Date.now());
        const mins       = Math.max(elapsed / 60000, 0.001);
        broadcast({ type: 'live:update', stationId: sid, name: session.players[sid]?.name, usableWpm: Math.round(ss.completedWords / mins) });
        const otherId = sid === 1 ? 2 : 1;
        sendToStation(otherId, { type: 'opponent:update', stationId: sid, wordCount: ss.completedWords });
        break;
      }

      case 'round:finish': {
        // Only used for single-prompt (prompt-royale) mode
        if (!session || session.state !== 'racing') break;
        const sid   = parseInt(msg.stationId) || myStation;
        const round = session.rounds[session.currentRoundIndex];
        if (!round || round.isMultiLine || !sid) break;
        submitRoundResult(sid, msg.value || '', round.startedAt ? Date.now() - round.startedAt : 0, msg.corrections || 0, msg.backspaces || 0);
        break;
      }

      case 'admin:reset': {
        doReset();
        break;
      }

      case 'admin:mode': {
        const m = msg.mode || config.defaultMode;
        doReset();
        later(() => createSession(m), 100);
        break;
      }
    }
  });

  ws.on('close', () => {
    if (myStation === 1 || myStation === 2) {
      const s = stations.get(myStation);
      if (s) stations.set(myStation, { ...s, ws: null });
    }
  });
});

// ─── REST ──────────────────────────────────────────────────────────────────────
app.get('/station/:id(\\d+)', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/leaderboard',  (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'leaderboard.html')));
app.get('/admin',        (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.get('/api/status', (_req, res) => res.json({
  serverStatus: 'healthy',
  connectedStations: { station1: !!stations.get(1)?.ws, station2: !!stations.get(2)?.ws },
  currentMode: session?.mode || null, currentState: session?.state || 'idle',
  leaderboardCount: leaderboard.length,
}));
app.get('/api/config',  (_req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  config = { ...config, ...req.body };
  saveJson('event-config.json', config);
  broadcast({ type: 'config:update', config: publicConfig() });
  res.json({ ok: true });
});
app.post('/api/reset', (_req, res) => { doReset(); res.json({ ok: true }); });
app.get('/api/leaderboard', (req, res) => res.json(topEntries(req.query.bucket || null)));
app.post('/api/leaderboard/clear', (_req, res) => {
  leaderboard = []; saveJson('leaderboard.json', leaderboard); res.json({ ok: true });
});
app.get('/api/names', (_req, res) => res.json(names));
app.post('/api/names/import', (req, res) => {
  if (!Array.isArray(req.body)) return res.status(400).json({ error: 'Expected array' });
  names = req.body; saveJson('names.json', names);
  broadcast({ type: 'names', names });
  res.json({ ok: true, count: names.length });
});
app.get('/api/prompts/reload', (_req, res) => {
  promptsDb = loadJson('prompts.json', promptsDb);
  res.json({ ok: true, count: promptsDb.length });
});

app.get('/api/export/runs.csv', (_req, res) => {
  const cols = ['timestamp','event_id','event_name','mode','player_name','company','input_mode','prompt_id','raw_wpm','usable_wpm','accuracy','flow_score','completed_words','voice_advantage','badges','completed'];
  const rows = runs.map(r => [
    new Date(r.timestamp).toISOString(), r.eventId, config.eventName,
    r.mode, r.playerName, r.company, r.inputMode, r.promptId,
    r.rawWpm, r.usableWpm, Math.round((r.accuracy || 0) * 100) + '%',
    r.flowScore, r.completedWords || 0, r.voiceAdvantage ?? '', (r.badgeIds || []).join('|'), r.completed ? 'yes' : 'no',
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="flow-fight-runs-${Date.now()}.csv"`);
  res.send([cols.join(','), ...rows].join('\n'));
});

app.get('/api/export/leaderboard.csv', (_req, res) => {
  const cols = ['rank','player_name','company','mode','flow_score','words','voice_advantage','badges'];
  const sorted = [...leaderboard].sort((a, b) => b.flowScore - a.flowScore);
  const rows = sorted.map((e, i) => [
    i + 1, e.playerName, e.company || '', e.mode, e.flowScore,
    e.usableWpm, e.voiceAdvantage ?? '', (e.badgeIds || []).join('|'),
  ].map(v => `"${String(v ?? '').replace(/"/g, '""')}"`).join(','));
  res.setHeader('Content-Type', 'text/csv');
  res.setHeader('Content-Disposition', `attachment; filename="flow-fight-leaderboard-${Date.now()}.csv"`);
  res.send([cols.join(','), ...rows].join('\n'));
});

// ─── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, '0.0.0.0', () => {
  const ips = Object.values(os.networkInterfaces()).flat()
    .filter(n => n.family === 'IPv4' && !n.internal).map(n => n.address);
  console.log('\n  ⚡ FLOW FIGHT SERVER');
  console.log('  ──────────────────────────────────────');
  console.log(`  Local:       http://localhost:${PORT}`);
  ips.forEach(ip => console.log(`  Network:     http://${ip}:${PORT}`));
  console.log('\n  Kiosk URLs (use your network IP):');
  console.log(`  Station 1:   http://[IP]:${PORT}/station/1`);
  console.log(`  Station 2:   http://[IP]:${PORT}/station/2`);
  console.log(`  Leaderboard: http://[IP]:${PORT}/leaderboard`);
  console.log(`  Admin:       http://[IP]:${PORT}/admin\n`);
});
