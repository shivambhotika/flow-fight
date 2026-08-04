'use strict';

const express = require('express');
const { WebSocketServer } = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
const server = http.createServer(app);
const wss = new WebSocketServer({ server });

const PUBLIC_DIR = path.join(__dirname, 'public');
const DATA_DIR = path.join(__dirname, 'data');

app.use(express.static(PUBLIC_DIR));
app.use(express.json({ limit: '6mb' }));

function loadJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(path.join(DATA_DIR, file), 'utf8'));
  } catch {
    return fallback;
  }
}

function saveJson(file, data) {
  try {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    const target = path.join(DATA_DIR, file);
    const temp = `${target}.${process.pid}.tmp`;
    fs.writeFileSync(temp, JSON.stringify(data, null, 2));
    fs.renameSync(temp, target);
  } catch (error) {
    console.error(`Could not persist ${file}:`, error.message);
  }
}

function uid() {
  return crypto.randomUUID().slice(0, 12);
}

const SOLO_MODE = 'solo-challenge';
const MODES = {
  [SOLO_MODE]: {
    label: 'Solo Challenge',
    tagline: 'Type, then speak. See how much faster your ideas flow.',
    icon: '⚡',
    playerCount: 1,
    rounds: 2,
  },
};

const storedConfig = loadJson('event-config.json', {});
let config = {
  eventId: storedConfig.eventId || 'event_001',
  eventName: storedConfig.eventName || 'Flow Fight',
  partnerName: storedConfig.partnerName || '',
  defaultMode: SOLO_MODE,
  enabledModes: [SOLO_MODE],
  roundSeconds: Number(storedConfig.roundSeconds) || 60,
  countdownSeconds: Number(storedConfig.countdownSeconds) || 3,
  resultsSeconds: Number(storedConfig.resultsSeconds) || 15,
  ctaSeconds: Number(storedConfig.ctaSeconds) || 10,
  enableVoiceMode: true,
  enableQrCta: storedConfig.enableQrCta !== false,
  qrUrl: storedConfig.qrUrl || 'https://wispr.ai',
  qrLabel: storedConfig.qrLabel || 'Try Wispr Flow',
  leaderboardLimit: Number(storedConfig.leaderboardLimit) || 20,
};

let leaderboard = loadJson('leaderboard.json', []);
let runs = loadJson('runs.json', []);
let promptsDb = loadJson('prompts.json', []);

function publicConfig() {
  return {
    eventName: config.eventName,
    partnerName: config.partnerName,
    enabledModes: [SOLO_MODE],
    defaultMode: SOLO_MODE,
    roundSeconds: config.roundSeconds,
    countdownSeconds: config.countdownSeconds,
    resultsSeconds: config.resultsSeconds,
    ctaSeconds: config.ctaSeconds,
    enableQrCta: config.enableQrCta,
    qrUrl: config.qrUrl,
    qrLabel: config.qrLabel,
    speechEntryEnabled: Boolean(process.env.OPENAI_API_KEY),
    modes: MODES,
  };
}

function countWords(text) {
  return String(text || '').trim().split(/\s+/).filter(Boolean).length;
}

function countPartialWords(targetText, enteredText, inputMode) {
  if (!enteredText || enteredText.length < 2) return 0;
  if (inputMode !== 'voice') {
    const target = targetText || '';
    let correct = 0;
    for (let i = 0; i < Math.min(enteredText.length, target.length); i += 1) {
      if (enteredText[i] === target[i]) correct += 1;
    }
    return Math.floor(correct / 5);
  }

  const normalize = value => String(value || '')
    .toLowerCase()
    .replace(/[.,!?;:'"—–]/g, '')
    .split(/\s+/)
    .filter(Boolean);
  const targetWords = normalize(targetText);
  const enteredWords = normalize(enteredText);
  let matched = 0;
  for (let i = 0; i < Math.min(targetWords.length, enteredWords.length); i += 1) {
    if (targetWords[i] === enteredWords[i]) matched += 1;
  }
  return matched;
}

function assignBadges(keyboardWords, voiceWords, keyboardErrors) {
  const badges = [];
  const voiceAdvantage = keyboardWords > 0 && voiceWords > 0 ? voiceWords / keyboardWords : null;
  if (voiceAdvantage !== null && voiceAdvantage >= 2) badges.push('keyboard_slayer');
  if (voiceWords > 0) badges.push('no_hands');
  if (Math.max(keyboardWords, voiceWords) >= 100) badges.push('speed_demon');
  if (keyboardErrors <= 1) badges.push('clean_talker');
  if (voiceAdvantage !== null && voiceAdvantage < 1) badges.push('keyboard_survivor');
  return badges;
}

function topEntries(bucket, limit = config.leaderboardLimit) {
  const entries = bucket ? leaderboard.filter(entry => entry.bucket === bucket) : leaderboard;
  return [...entries].sort((a, b) => b.flowScore - a.flowScore).slice(0, limit);
}

function pickLineQueue(count = 25) {
  let pool = promptsDb.filter(prompt => prompt.category === 'one_liner');
  if (pool.length < count) {
    const extras = promptsDb.filter(prompt =>
      prompt.category !== 'one_liner' && prompt.text?.length < 90 &&
      !pool.some(existing => existing.id === prompt.id));
    pool = [...pool, ...extras];
  }
  if (!pool.length) pool = promptsDb;
  return [...pool].sort(() => Math.random() - 0.5).slice(0, Math.min(count, pool.length));
}

function getRoundAssignments(roundIndex) {
  return roundIndex === 0 ? { 1: 'keyboard' } : { 1: 'voice' };
}

// Each browser tab owns an isolated runtime. Only leaderboard data is shared.
// This keeps simultaneous solo players completely independent.
const runtimes = new Map();
const displaySockets = new Set();

function createRuntime(clientId) {
  return {
    clientId,
    ws: null,
    session: null,
    timers: new Set(),
    cleanupTimer: null,
    lastSeenAt: Date.now(),
  };
}

function send(ws, data) {
  if (ws?.readyState === 1) ws.send(JSON.stringify(data));
}

function sendRuntime(runtime, data) {
  send(runtime.ws, data);
}

function serializeSession(session) {
  if (!session) return null;
  return {
    ...session,
    currentRound: session.rounds[session.currentRoundIndex] || null,
  };
}

function sendState(runtime) {
  sendRuntime(runtime, {
    type: 'state:update',
    session: serializeSession(runtime.session),
    config: publicConfig(),
  });
}

function broadcastDisplays(data) {
  displaySockets.forEach(ws => send(ws, data));
}

function clearRuntimeTimers(runtime) {
  runtime.timers.forEach(timer => {
    clearTimeout(timer);
    clearInterval(timer);
  });
  runtime.timers.clear();
}

function later(runtime, callback, delayMs) {
  const timer = setTimeout(() => {
    runtime.timers.delete(timer);
    callback();
  }, delayMs);
  runtime.timers.add(timer);
  return timer;
}

function createSession(runtime) {
  clearRuntimeTimers(runtime);
  runtime.session = {
    id: uid(),
    mode: SOLO_MODE,
    state: 'name-entry',
    players: {},
    rounds: [],
    currentRoundIndex: 0,
    winner: null,
    playerScores: null,
    pendingAssignments: null,
    stationState: {},
  };
  sendState(runtime);
}

function startCountdown(runtime) {
  const session = runtime.session;
  if (!session) return;

  const roundIndex = session.currentRoundIndex;
  const lineQueue = pickLineQueue();
  session.rounds[roundIndex] = {
    id: uid(),
    index: roundIndex,
    promptId: lineQueue[0]?.id || '',
    targetText: lineQueue[0]?.text || '',
    promptCategory: 'one_liner',
    lineQueue,
    isMultiLine: true,
    inputAssignments: getRoundAssignments(roundIndex),
    durationSeconds: config.roundSeconds,
    startedAt: null,
    endedAt: null,
    stationResults: {},
  };
  session.state = 'countdown';
  sendState(runtime);

  let count = config.countdownSeconds;
  sendRuntime(runtime, { type: 'countdown:tick', count });
  const interval = setInterval(() => {
    count -= 1;
    if (count > 0) {
      sendRuntime(runtime, { type: 'countdown:tick', count });
      return;
    }
    clearInterval(interval);
    runtime.timers.delete(interval);
    sendRuntime(runtime, { type: 'countdown:tick', count: 'GO' });
    later(runtime, () => startRound(runtime), 700);
  }, 1000);
  runtime.timers.add(interval);
}

function startRound(runtime) {
  const session = runtime.session;
  const round = session?.rounds[session.currentRoundIndex];
  if (!session || !round) return;

  round.startedAt = Date.now();
  session.state = 'racing';
  session.stationState = {
    1: { lineIdx: 0, completedWords: 0, lastValue: '', errors: 0 },
  };
  sendState(runtime);
  later(runtime, () => forceEndRound(runtime), round.durationSeconds * 1000 + 500);
}

function handleInputUpdate(runtime, message) {
  const session = runtime.session;
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  const state = session.stationState[1];
  if (!round || !state) return;

  state.lastValue = String(message.value || '');
  if (message.corrections !== undefined) state.errors = Number(message.corrections) || 0;

}

function handleLineComplete(runtime, message) {
  const session = runtime.session;
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  const state = session.stationState[1];
  if (!round || !state || Number(message.lineIdx) !== state.lineIdx) return;

  state.completedWords += countWords(round.lineQueue[state.lineIdx]?.text || '');
  state.lineIdx += 1;
  state.lastValue = '';
  if (message.errors !== undefined) state.errors = Number(message.errors) || 0;
}

function forceEndRound(runtime) {
  const session = runtime.session;
  if (session?.state !== 'racing') return;
  const round = session.rounds[session.currentRoundIndex];
  if (!round) return;

  const state = session.stationState[1] || { lineIdx: 0, completedWords: 0, lastValue: '', errors: 0 };
  const currentLine = round.lineQueue[state.lineIdx]?.text || '';
  const partialWords = countPartialWords(currentLine, state.lastValue, round.inputAssignments[1]);
  const totalWords = state.completedWords + partialWords;
  const minutes = Math.max(round.durationSeconds / 60, 0.01);
  const usableWpm = Math.round(totalWords / minutes);

  round.stationResults[1] = {
    stationId: '1',
    playerId: session.players[1]?.id,
    playerName: session.players[1]?.name,
    inputMode: round.inputAssignments[1],
    rawText: state.lastValue,
    completedWords: totalWords,
    rawWpm: usableWpm,
    usableWpm,
    accuracy: 1,
    corrections: state.errors,
    backspaces: 0,
    completed: false,
    completionTimeMs: round.durationSeconds * 1000,
    flowScore: totalWords * 10,
    badgeIds: [],
  };
  endRound(runtime);
}

function endRound(runtime) {
  clearRuntimeTimers(runtime);
  const session = runtime.session;
  const round = session?.rounds[session.currentRoundIndex];
  if (!session || !round) return;

  round.endedAt = Date.now();
  sendRuntime(runtime, { type: 'round:results', round, roundIndex: session.currentRoundIndex });

  if (session.currentRoundIndex === 0) {
    session.currentRoundIndex = 1;
    session.pendingAssignments = getRoundAssignments(1);
    session.state = 'round-transition';
    sendState(runtime);
    later(runtime, () => {
      if (!runtime.session) return;
      runtime.session.pendingAssignments = null;
      startCountdown(runtime);
    }, 5000);
    return;
  }

  endSession(runtime);
}

function endSession(runtime) {
  const session = runtime.session;
  const player = session?.players[1];
  if (!session || !player) return;

  let totalFlow = 0;
  let keyboardWords = 0;
  let voiceWords = 0;
  let keyboardErrors = 0;
  let voiceErrors = 0;

  session.rounds.forEach(round => {
    const result = round.stationResults[1];
    if (!result) return;
    totalFlow += result.flowScore;
    if (result.inputMode === 'keyboard') {
      keyboardWords = result.completedWords || result.usableWpm || 0;
      keyboardErrors = result.corrections || 0;
    } else {
      voiceWords = result.completedWords || result.usableWpm || 0;
      voiceErrors = result.corrections || 0;
    }
  });

  const voiceMultiplier = keyboardWords > 0 && voiceWords > 0
    ? Math.round((voiceWords / keyboardWords) * 10) / 10
    : null;
  const extraWords = Math.max(0, voiceWords - keyboardWords);
  const badges = assignBadges(keyboardWords, voiceWords, keyboardErrors);

  session.playerScores = {
    1: {
      totalFlow,
      keyboardWpm: keyboardWords,
      voiceWpm: voiceWords,
      keyboardWords,
      voiceWords,
      extraWords,
      voiceMultiplier,
      keyboardErrors,
      voiceErrors,
      badges,
    },
  };
  session.winner = { type: 'solo', stationId: 1, name: player.name };
  session.state = 'results';

  leaderboard.push({
    id: uid(),
    eventId: config.eventId,
    playerName: player.name,
    mode: SOLO_MODE,
    flowScore: totalFlow,
    usableWpm: Math.max(keyboardWords, voiceWords),
    voiceAdvantage: voiceMultiplier,
    badgeIds: badges,
    bucket: SOLO_MODE,
    createdAt: Date.now(),
  });
  saveJson('leaderboard.json', leaderboard);

  session.rounds.forEach(round => {
    const result = round.stationResults[1];
    if (!result) return;
    runs.push({
      runId: uid(),
      sessionId: session.id,
      clientId: runtime.clientId,
      eventId: config.eventId,
      timestamp: Date.now(),
      mode: SOLO_MODE,
      playerName: player.name,
      inputMode: result.inputMode,
      promptId: round.promptId,
      rawWpm: result.rawWpm,
      usableWpm: result.usableWpm,
      accuracy: result.accuracy,
      flowScore: result.flowScore,
      voiceAdvantage: voiceMultiplier,
      badgeIds: result.badgeIds,
      completed: result.completed,
      completedWords: result.completedWords || 0,
      corrections: result.corrections || 0,
    });
  });
  saveJson('runs.json', runs);

  sendState(runtime);
  sendRuntime(runtime, {
    type: 'session:results',
    winner: session.winner,
    playerScores: session.playerScores,
    leaderboard: topEntries(null),
  });
  broadcastDisplays({ type: 'session:results' });

  if (config.enableQrCta) {
    later(runtime, () => {
      if (!runtime.session) return;
      runtime.session.state = 'cta';
      sendState(runtime);
      later(runtime, () => resetRuntime(runtime), config.ctaSeconds * 1000);
    }, config.resultsSeconds * 1000);
  } else {
    later(runtime, () => resetRuntime(runtime), config.resultsSeconds * 1000);
  }
}

function resetRuntime(runtime) {
  clearRuntimeTimers(runtime);
  runtime.session = null;
  sendState(runtime);
}

function safeClientId(value) {
  const clientId = String(value || '');
  return /^[a-zA-Z0-9_-]{8,80}$/.test(clientId) ? clientId : `temporary-${uid()}`;
}

wss.on('connection', ws => {
  let runtime = null;
  let isDisplay = false;

  ws.on('message', raw => {
    let message;
    try {
      message = JSON.parse(raw);
    } catch {
      return;
    }

    if (message.type === 'station:join') {
      if (message.stationId === 'display') {
        isDisplay = true;
        displaySockets.add(ws);
        send(ws, { type: 'state:update', session: null, config: publicConfig() });
        return;
      }

      const clientId = safeClientId(message.clientId);
      runtime = runtimes.get(clientId) || createRuntime(clientId);
      runtimes.set(clientId, runtime);
      runtime.ws = ws;
      runtime.lastSeenAt = Date.now();
      if (runtime.cleanupTimer) {
        clearTimeout(runtime.cleanupTimer);
        runtime.cleanupTimer = null;
      }
      sendState(runtime);
      return;
    }

    if (!runtime) return;
    runtime.lastSeenAt = Date.now();

    switch (message.type) {
      case 'mode:select':
        if (!runtime.session) createSession(runtime);
        break;
      case 'player:select': {
        if (!runtime.session) break;
        const name = String(message.name || 'Player').trim().slice(0, 80) || 'Player';
        runtime.session.players[1] = {
          id: uid(),
          stationId: '1',
          name,
          isReady: false,
        };
        sendState(runtime);
        break;
      }
      case 'player:ready':
        if (!runtime.session?.players[1]) break;
        runtime.session.players[1].isReady = true;
        sendState(runtime);
        startCountdown(runtime);
        break;
      case 'input:update':
        handleInputUpdate(runtime, message);
        break;
      case 'line:complete':
        handleLineComplete(runtime, message);
        break;
      case 'admin:reset':
        resetRuntime(runtime);
        break;
      default:
        break;
    }
  });

  ws.on('close', () => {
    if (isDisplay) displaySockets.delete(ws);
    if (!runtime || runtime.ws !== ws) return;
    runtime.ws = null;
    runtime.cleanupTimer = setTimeout(() => {
      clearRuntimeTimers(runtime);
      runtimes.delete(runtime.clientId);
    }, 30 * 60 * 1000);
  });
});

// Push-to-talk name transcription. The API key never leaves the server.
const transcriptionAttempts = new Map();
app.post('/api/transcribe-name', async (req, res) => {
  if (!process.env.OPENAI_API_KEY) {
    return res.status(503).json({ error: 'Voice entry is not configured yet. Type your name instead.' });
  }

  const ip = req.ip || req.socket.remoteAddress || 'unknown';
  const now = Date.now();
  const recent = (transcriptionAttempts.get(ip) || []).filter(time => now - time < 60_000);
  if (recent.length >= 12) return res.status(429).json({ error: 'Too many voice attempts. Type your name instead.' });
  recent.push(now);
  transcriptionAttempts.set(ip, recent);

  const encoded = String(req.body?.audio || '').replace(/^data:[^;]+;base64,/, '');
  const mimeType = String(req.body?.mimeType || 'audio/webm').slice(0, 80);
  if (!encoded) return res.status(400).json({ error: 'No audio received.' });

  let audio;
  try {
    audio = Buffer.from(encoded, 'base64');
  } catch {
    return res.status(400).json({ error: 'Invalid audio data.' });
  }
  if (audio.length < 100 || audio.length > 4 * 1024 * 1024) {
    return res.status(400).json({ error: 'Please record a short name (under 15 seconds).' });
  }

  try {
    const form = new FormData();
    const extension = mimeType.includes('mp4') ? 'm4a' : mimeType.includes('ogg') ? 'ogg' : 'webm';
    form.append('file', new Blob([audio], { type: mimeType }), `name.${extension}`);
    form.append('model', process.env.OPENAI_TRANSCRIBE_MODEL || 'gpt-4o-mini-transcribe');
    form.append('language', 'en');
    form.append('prompt', 'The speaker is saying their name. Transcribe only the name, preserving the spoken spelling as closely as possible.');

    const response = await fetch('https://api.openai.com/v1/audio/transcriptions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.OPENAI_API_KEY}` },
      body: form,
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok) {
      console.error('OpenAI transcription error:', response.status, payload?.error?.message || 'Unknown error');
      return res.status(502).json({ error: 'Could not transcribe that. Please type your name.' });
    }

    const text = String(payload.text || '')
      .trim()
      .replace(/^["']|["'.,!?]+$/g, '')
      .slice(0, 80);
    if (!text) return res.status(422).json({ error: 'I did not catch that. Try again or type your name.' });
    return res.json({ text });
  } catch (error) {
    console.error('Transcription request failed:', error.message);
    return res.status(502).json({ error: 'Voice entry is temporarily unavailable. Type your name instead.' });
  }
});

app.get('/station/:id(\\d+)', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'index.html')));
app.get('/leaderboard', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'leaderboard.html')));
app.get('/admin', (_req, res) => res.sendFile(path.join(PUBLIC_DIR, 'admin.html')));

app.get('/api/status', (_req, res) => res.json({
  serverStatus: 'healthy',
  connectedPlayers: [...runtimes.values()].filter(runtime => runtime.ws).length,
  activeSessions: [...runtimes.values()].filter(runtime => runtime.session).length,
  currentMode: SOLO_MODE,
  currentState: 'independent-solo-sessions',
  leaderboardCount: leaderboard.length,
  speechEntryEnabled: Boolean(process.env.OPENAI_API_KEY),
}));

app.get('/api/config', (_req, res) => res.json(config));
app.post('/api/config', (req, res) => {
  const allowed = ['eventName', 'partnerName', 'roundSeconds', 'countdownSeconds', 'resultsSeconds', 'ctaSeconds', 'enableQrCta', 'qrUrl', 'qrLabel', 'leaderboardLimit'];
  allowed.forEach(key => {
    if (req.body?.[key] !== undefined) config[key] = req.body[key];
  });
  config.defaultMode = SOLO_MODE;
  config.enabledModes = [SOLO_MODE];
  saveJson('event-config.json', config);
  runtimes.forEach(runtime => sendState(runtime));
  res.json({ ok: true, config });
});

app.post('/api/reset', (_req, res) => {
  runtimes.forEach(runtime => resetRuntime(runtime));
  res.json({ ok: true });
});

app.get('/api/leaderboard', (req, res) => res.json(topEntries(req.query.bucket || null)));
app.post('/api/leaderboard/clear', (_req, res) => {
  leaderboard = [];
  saveJson('leaderboard.json', leaderboard);
  res.json({ ok: true });
});

// Kept as empty compatibility endpoints for older admin screens.
app.get('/api/names', (_req, res) => res.json([]));
app.post('/api/names/import', (_req, res) => res.status(410).json({ error: 'Name lists are no longer used.' }));
app.get('/api/prompts/reload', (_req, res) => {
  promptsDb = loadJson('prompts.json', promptsDb);
  res.json({ ok: true, count: promptsDb.length });
});

function csvCell(value) {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text;
}

app.get('/api/export/runs.csv', (_req, res) => {
  const columns = ['timestamp', 'event_id', 'event_name', 'mode', 'player_name', 'input_mode', 'prompt_id', 'raw_wpm', 'usable_wpm', 'accuracy', 'flow_score', 'completed_words', 'voice_advantage', 'badges', 'completed'];
  const rows = runs.map(run => [
    run.timestamp, run.eventId, config.eventName, run.mode, run.playerName, run.inputMode,
    run.promptId, run.rawWpm, run.usableWpm, run.accuracy, run.flowScore,
    run.completedWords, run.voiceAdvantage, (run.badgeIds || []).join('|'), run.completed,
  ]);
  res.type('text/csv').send([columns, ...rows].map(row => row.map(csvCell).join(',')).join('\n'));
});

app.get('/api/export/leaderboard.csv', (_req, res) => {
  const columns = ['rank', 'player_name', 'mode', 'flow_score', 'words', 'voice_advantage', 'badges'];
  const rows = topEntries(null, leaderboard.length).map((entry, index) => [
    index + 1, entry.playerName, entry.mode, entry.flowScore, entry.usableWpm,
    entry.voiceAdvantage, (entry.badgeIds || []).join('|'),
  ]);
  res.type('text/csv').send([columns, ...rows].map(row => row.map(csvCell).join(',')).join('\n'));
});

const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  console.log(`Flow Fight solo server running on http://localhost:${PORT}`);
  console.log(`Push-to-talk name entry: ${process.env.OPENAI_API_KEY ? 'enabled' : 'disabled (OPENAI_API_KEY not set)'}`);
});
