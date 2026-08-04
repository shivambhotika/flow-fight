'use strict';

let currentConfig = {};

// ── Load on boot ───────────────────────────────────────────────────────────────
fetchStatus();
fetchConfig();

function fetchStatus() {
  fetch('/api/status').then(r => r.json()).then(s => {
    setText('status-players', String(s.connectedPlayers ?? 0));
    setText('status-sessions', String(s.activeSessions ?? 0));
    setText('status-mode', s.currentMode || '—');
    setText('status-speech', s.speechEntryEnabled ? 'Configured' : 'API key missing');
    setText('status-lb', String(s.leaderboardCount ?? '—'));
  }).catch(() => {});
}

function fetchConfig() {
  fetch('/api/config').then(r => r.json()).then(cfg => {
    currentConfig = cfg;
    // Populate fields
    setVal('cfg-eventName',     cfg.eventName || '');
    setVal('cfg-partnerName',   cfg.partnerName || '');
    setVal('cfg-roundSeconds',  cfg.roundSeconds ?? 25);
    setVal('cfg-transitionSeconds', cfg.transitionSeconds ?? 10);
    setVal('cfg-qrUrl',         cfg.qrUrl || '');
    setVal('cfg-resultsSeconds',cfg.resultsSeconds ?? 15);
  }).catch(() => {});
}

function saveConfig() {
  const patch = {
    eventName:     getVal('cfg-eventName'),
    partnerName:   getVal('cfg-partnerName'),
    roundSeconds:  parseInt(getVal('cfg-roundSeconds')) || 60,
    transitionSeconds: parseInt(getVal('cfg-transitionSeconds')) || 10,
    qrUrl:         getVal('cfg-qrUrl'),
    resultsSeconds:parseInt(getVal('cfg-resultsSeconds')) || 15,
  };
  apiPost('/api/config', patch, () => flashToast('config-saved'));
}

function clearLb() {
  if (!confirm('Clear all leaderboard entries? This cannot be undone.')) return;
  apiPost('/api/leaderboard/clear', {}, () => { fetchStatus(); alert('Leaderboard cleared.'); });
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

function setText(id, val) { const el = document.getElementById(id); if (el) el.textContent = val; }
function setVal(id, val) { const el = document.getElementById(id); if (el) el.value = val; }
function getVal(id) { const el = document.getElementById(id); return el ? el.value : ''; }

// Auto-refresh status every 5s
setInterval(fetchStatus, 5000);
