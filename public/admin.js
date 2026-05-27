'use strict';

const ALL_MODES = ['swap-duel', 'voice-vs-keyboard', 'beat-the-keyboard', 'solo-output', 'keyboard-race', 'hinglish-hustle', 'prompt-royale'];
const MODE_LABELS = {
  'swap-duel': 'Swap Duel', 'voice-vs-keyboard': 'Voice vs Keyboard',
  'beat-the-keyboard': 'Beat the Keyboard', 'solo-output': 'Solo Output Challenge',
  'keyboard-race': 'Keyboard Race', 'hinglish-hustle': 'Hinglish Hustle', 'prompt-royale': 'Prompt Royale',
};

let currentConfig = {};

// Build mode checkboxes
const checksEl = document.getElementById('mode-checks');
ALL_MODES.forEach(m => {
  const label = document.createElement('label');
  label.className = 'mode-check';
  label.innerHTML = `<input type="checkbox" value="${m}" checked> ${MODE_LABELS[m]}`;
  checksEl.appendChild(label);
});

// ── Load on boot ───────────────────────────────────────────────────────────────
fetchStatus();
fetchConfig();

function fetchStatus() {
  fetch('/api/status').then(r => r.json()).then(s => {
    setDot('dot-s1', s.connectedStations?.station1);
    setDot('dot-s2', s.connectedStations?.station2);
    setText('status-s1', s.connectedStations?.station1 ? 'Connected' : 'Offline');
    setText('status-s2', s.connectedStations?.station2 ? 'Connected' : 'Offline');
    setText('status-mode', s.currentMode || '—');
    setText('status-state', s.currentState || 'idle');
    setText('status-lb', String(s.leaderboardCount ?? '—'));
  }).catch(() => {});
}

function fetchConfig() {
  fetch('/api/config').then(r => r.json()).then(cfg => {
    currentConfig = cfg;
    // Populate fields
    setVal('cfg-eventName',     cfg.eventName || '');
    setVal('cfg-partnerName',   cfg.partnerName || '');
    setVal('cfg-defaultMode',   cfg.defaultMode || 'swap-duel');
    setVal('cfg-roundSeconds',  cfg.roundSeconds ?? 25);
    setVal('cfg-qrUrl',         cfg.qrUrl || '');
    setVal('cfg-resultsSeconds',cfg.resultsSeconds ?? 15);
    // Check enabled modes
    document.querySelectorAll('#mode-checks input[type=checkbox]').forEach(cb => {
      cb.checked = (cfg.enabledModes || ALL_MODES).includes(cb.value);
    });
    // Sync launch select + default select
    setVal('launch-mode-select', cfg.defaultMode || 'swap-duel');
  }).catch(() => {});
}

function saveConfig() {
  const enabled = [...document.querySelectorAll('#mode-checks input:checked')].map(cb => cb.value);
  const patch = {
    eventName:     getVal('cfg-eventName'),
    partnerName:   getVal('cfg-partnerName'),
    defaultMode:   getVal('cfg-defaultMode'),
    roundSeconds:  parseInt(getVal('cfg-roundSeconds')) || 60,
    qrUrl:         getVal('cfg-qrUrl'),
    resultsSeconds:parseInt(getVal('cfg-resultsSeconds')) || 15,
    enabledModes:  enabled,
  };
  apiPost('/api/config', patch, () => flashToast('config-saved'));
}

function launchMode() {
  const mode = getVal('launch-mode-select');
  apiPost('/api/reset', {}, () => {
    setTimeout(() => {
      // Tell the server via WebSocket or just reset + config default
      // Simplest: update default mode then reset so stations pick it up
      apiPost('/api/config', { defaultMode: mode });
    }, 200);
  });
}

function clearLb() {
  if (!confirm('Clear all leaderboard entries? This cannot be undone.')) return;
  apiPost('/api/leaderboard/clear', {}, () => { fetchStatus(); alert('Leaderboard cleared.'); });
}

function importNames() {
  const raw = document.getElementById('names-import').value.trim();
  if (!raw) return;
  const names = raw.split('\n').map(n => n.trim()).filter(Boolean);
  apiPost('/api/names/import', names, () => {
    flashToast('names-saved');
    document.getElementById('names-import').value = '';
  });
}

// ── Utilities ──────────────────────────────────────────────────────────────────
function apiPost(url, body, onSuccess) {
  fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  }).then(r => r.json()).then(d => { if (d.ok !== false && onSuccess) onSuccess(d); }).catch(() => {});
}

function flashToast(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.classList.add('show');
  setTimeout(() => el.classList.remove('show'), 2000);
}

function setDot(id, on) {
  const el = document.getElementById(id);
  if (el) { el.classList.toggle('on', !!on); el.classList.toggle('off', !on); }
}
function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

// Auto-refresh status every 5s
setInterval(fetchStatus, 5000);
