'use strict';

const assert = require('node:assert/strict');
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');
const test = require('node:test');
const { WebSocket } = require('ws');

const projectRoot = path.join(__dirname, '..');
let child;
let baseUrl;

function reservePort() {
  return new Promise((resolve, reject) => {
    const listener = net.createServer();
    listener.once('error', reject);
    listener.listen(0, '127.0.0.1', () => {
      const { port } = listener.address();
      listener.close(error => error ? reject(error) : resolve(port));
    });
  });
}

async function waitForServer(url) {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const response = await fetch(`${url}/api/status`);
      if (response.ok) return;
    } catch {}
    await new Promise(resolve => setTimeout(resolve, 100));
  }
  throw new Error('Test server did not become ready.');
}

function connectPlayer(clientId) {
  return new Promise((resolve, reject) => {
    const socket = new WebSocket(baseUrl.replace('http', 'ws'));
    const stateWaiters = [];
    const states = [];

    function settleWaiters(session) {
      for (let index = stateWaiters.length - 1; index >= 0; index -= 1) {
        const waiter = stateWaiters[index];
        if (!waiter.predicate(session)) continue;
        stateWaiters.splice(index, 1);
        clearTimeout(waiter.timer);
        waiter.resolve(session);
      }
    }

    socket.once('error', reject);
    socket.on('message', raw => {
      const message = JSON.parse(raw);
      if (message.type !== 'state:update') return;
      states.push(message.session);
      settleWaiters(message.session);
    });
    socket.once('open', () => {
      socket.send(JSON.stringify({ type: 'station:join', stationId: 1, clientId }));
      resolve({
        socket,
        send: message => socket.send(JSON.stringify(message)),
        waitForState(predicate) {
          const existing = [...states].reverse().find(predicate);
          if (existing !== undefined) return Promise.resolve(existing);
          return new Promise((waitResolve, waitReject) => {
            const timer = setTimeout(() => waitReject(new Error('Timed out waiting for state update.')), 2000);
            stateWaiters.push({ predicate, resolve: waitResolve, timer });
          });
        },
      });
    });
  });
}

test.before(async () => {
  const port = await reservePort();
  baseUrl = `http://127.0.0.1:${port}`;
  child = spawn(process.execPath, ['server.js'], {
    cwd: projectRoot,
    env: { ...process.env, PORT: String(port), OPENAI_API_KEY: '' },
    stdio: ['ignore', 'ignore', 'pipe'],
  });
  await waitForServer(baseUrl);
});

test.after(() => {
  child?.kill('SIGTERM');
});

test('production config exposes solo mode and a 10-second transition', async () => {
  const config = await fetch(`${baseUrl}/api/config`).then(response => response.json());
  assert.deepEqual(config.enabledModes, ['solo-challenge']);
  assert.equal(config.defaultMode, 'solo-challenge');
  assert.equal(config.transitionSeconds, 10);
});

test('challenge repository contains 20 clean rap-style prompts only', () => {
  const prompts = require('../data/prompts.json');
  assert.equal(prompts.length, 20);
  assert.equal(new Set(prompts.map(prompt => prompt.id)).size, 20);
  assert.ok(prompts.every(prompt => prompt.category === 'one_liner'));
  assert.ok(prompts.every(prompt => prompt.difficulty === 'hard'));
  assert.ok(prompts.every(prompt => !/[^\p{L}\p{N}\s]/u.test(prompt.text)));
});

test('landing page uses the packaged Wispr logo', () => {
  const html = fs.readFileSync(path.join(projectRoot, 'public', 'index.html'), 'utf8');
  const logoPath = path.join(projectRoot, 'public', 'wisprlogo.png');
  assert.match(html, /<img[^>]+src="\/wisprlogo\.png"/);
  assert.ok(fs.statSync(logoPath).size > 0);
});

test('two devices receive independent solo sessions', async () => {
  const [first, second] = await Promise.all([
    connectPlayer('device-alpha-1234'),
    connectPlayer('device-bravo-5678'),
  ]);

  first.send({ type: 'mode:select', mode: 'solo-challenge' });
  second.send({ type: 'mode:select', mode: 'solo-challenge' });
  const [firstSession, secondSession] = await Promise.all([
    first.waitForState(session => session?.state === 'name-entry'),
    second.waitForState(session => session?.state === 'name-entry'),
  ]);
  assert.notEqual(firstSession.id, secondSession.id);

  first.send({ type: 'player:select', stationId: 1, name: 'Alpha Player' });
  second.send({ type: 'player:select', stationId: 1, name: 'Bravo Player' });
  const [firstNamed, secondNamed] = await Promise.all([
    first.waitForState(session => session?.players?.[1]?.name === 'Alpha Player'),
    second.waitForState(session => session?.players?.[1]?.name === 'Bravo Player'),
  ]);
  assert.equal(firstNamed.players[1].name, 'Alpha Player');
  assert.equal(secondNamed.players[1].name, 'Bravo Player');
  assert.equal(firstNamed.players[1].name === secondNamed.players[1].name, false);

  first.socket.close();
  second.socket.close();
});
