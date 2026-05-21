'use strict';

const TABS = [
  { bucket: '',                   label: '🏆 Top Flow Scores' },
  { bucket: 'swap-duel',          label: '🔄 Swap Duel' },
  { bucket: 'voice-vs-keyboard',  label: '🎙️ Voice × Keyboard' },
  { bucket: 'keyboard-race',      label: '⌨️ Keyboard Race' },
  { bucket: 'beat-the-keyboard',  label: '🥊 Solo' },
  { bucket: 'hinglish-hustle',    label: '🇮🇳 Hinglish' },
];

let activeBucket = '';
let ws;
const liveData = { 1: { name: null, wpm: 0 }, 2: { name: null, wpm: 0 } };

// Build tab bar
const tabsEl = document.getElementById('lb-tabs');
TABS.forEach(t => {
  const tab = document.createElement('div');
  tab.className = 'lb-tab' + (t.bucket === activeBucket ? ' active' : '');
  tab.textContent = t.label;
  tab.onclick = () => { activeBucket = t.bucket; setActiveTab(t.bucket); fetchLeaderboard(); };
  tabsEl.appendChild(tab);
});

function setActiveTab(bucket) {
  document.querySelectorAll('.lb-tab').forEach((el, i) => {
    el.classList.toggle('active', TABS[i].bucket === bucket);
  });
}

function connect() {
  const wsProto = location.protocol === 'https:' ? 'wss:' : 'ws:';
  ws = new WebSocket(`${wsProto}//${location.host}`);
  ws.onopen = () => ws.send(JSON.stringify({ type: 'station:join', stationId: 'display' }));
  ws.onmessage = (e) => {
    try { handleMsg(JSON.parse(e.data)); } catch (_) {}
  };
  ws.onclose = () => setTimeout(connect, 2000);
}

function handleMsg(msg) {
  switch (msg.type) {
    case 'state:update': {
      if (msg.config?.eventName) {
        document.getElementById('event-name-label').textContent = msg.config.eventName;
      }
      const state = msg.session?.state;
      if (state === 'racing' || state === 'round-transition') {
        showLiveBanner(msg.session);
      } else if (!state || state === 'idle' || state === 'results' || state === 'cta') {
        hideLiveBanner();
      }
      if (state === 'results' && msg.session?.playerScores) {
        fetchLeaderboard();
      }
      break;
    }
    case 'live:update': {
      const id = msg.stationId;
      if (!id) break;
      liveData[id] = { name: msg.name || liveData[id].name, wpm: msg.usableWpm || 0 };
      updateLiveBanner();
      break;
    }
    case 'session:results':
      fetchLeaderboard();
      hideLiveBanner();
      break;
  }
}

function showLiveBanner(session) {
  document.getElementById('live-banner').style.display = '';
  if (session?.mode) {
    document.getElementById('live-text').textContent = `${session.mode.replace(/-/g, ' ')} · in progress`;
  }
  const p = session?.players || {};
  if (p[1]) liveData[1].name = p[1].name;
  if (p[2]) liveData[2].name = p[2].name;
  updateLiveBanner();
}

function hideLiveBanner() {
  document.getElementById('live-banner').style.display = 'none';
}

function updateLiveBanner() {
  document.getElementById('live-s1-wpm').textContent = liveData[1].wpm || '—';
  document.getElementById('live-s1-label').textContent = liveData[1].name || 'Station 1';
  document.getElementById('live-s2-wpm').textContent = liveData[2].wpm || '—';
  document.getElementById('live-s2-label').textContent = liveData[2].name || 'Station 2';
}

function fetchLeaderboard() {
  const url = '/api/leaderboard' + (activeBucket ? `?bucket=${encodeURIComponent(activeBucket)}` : '');
  fetch(url).then(r => r.json()).then(renderLeaderboard).catch(() => {});
}

function renderLeaderboard(entries) {
  const list = document.getElementById('lb-full-list');
  if (!entries?.length) {
    list.innerHTML = '<p class="lb-empty">No scores in this category yet.</p>';
    return;
  }
  const medals = ['🥇', '🥈', '🥉'];
  const modeShort = {
    'swap-duel': 'Swap Duel', 'voice-vs-keyboard': 'V×K',
    'beat-the-keyboard': 'Solo', 'keyboard-race': 'Keyboard',
    'hinglish-hustle': 'Hinglish', 'prompt-royale': 'Royale',
  };
  list.innerHTML = entries.map((e, i) => `
    <div class="lb-full-row ${i < 3 ? 'top-' + (i + 1) : ''}">
      <span style="font-size:18px;text-align:center">${medals[i] || (i + 1)}</span>
      <span style="font-weight:600;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">${esc(e.playerName)}${e.company ? `<span style="color:#666;font-weight:400;font-size:12px;margin-left:6px">${esc(e.company)}</span>` : ''}</span>
      <span style="font-family:'IBM Plex Mono',monospace;font-weight:700;color:#034f46">${e.flowScore} <small style="color:#666;font-size:11px">FS</small></span>
      <span style="color:#666;font-size:12px">${modeShort[e.mode] || e.mode}</span>
      <span style="color:#aaa;font-size:11px">${e.createdAt ? new Date(e.createdAt).toLocaleDateString() : ''}</span>
    </div>`).join('');
}

function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

connect();
fetchLeaderboard();
setInterval(fetchLeaderboard, 30000);
