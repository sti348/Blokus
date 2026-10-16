'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const Online = require('../js/online.js');
const { start } = require('../server.js');

const HOST = 'host-aaaaaaaa';
const GUEST = 'guest-bbbbbbbb';

function ok(result) {
  assert.ok(result.room, result.error);
  return result.room;
}

function newRoom(mode) {
  return Online.createRoom({ code: 'ABCDE', host: HOST, name: '房主', mode: mode || 'classic', now: 1 });
}

function firstMove(room) {
  const st = Online.gameState(room);
  const m = Engine.legalMoves(st, st.current)[0];
  const a = { type: 'place', piece: m.piece, orient: m.orient, x: m.x, y: m.y };
  if (m.z !== undefined) a.z = m.z;
  return a;
}

test('房间：入座、权限与开局检查', () => {
  let room = newRoom();
  assert.equal(room.seats[0].owner, HOST);
  assert.equal(Online.applyOp(room, { type: 'claim', seat: 0, name: 'x' }, GUEST).code, 'seat_taken');
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: '小明\u200b' }, GUEST));
  assert.equal(room.seats[1].name, '小明');
  assert.equal(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'off' }, GUEST).code, 'not_host');
  assert.equal(Online.applyOp(room, { type: 'start' }, GUEST).code, 'not_host');
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'open' }, HOST));
  assert.equal(Online.applyOp(room, { type: 'start' }, HOST).code, 'seat_empty');
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'ai', level: 'hard' }, HOST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  assert.equal(room.status, 'playing');
  assert.deepEqual(room.game.config.players.map((p) => p.type), ['human', 'human', 'ai', 'ai']);
  assert.equal(room.game.config.players[2].level, 'hard');
  assert.ok(Online.normalizeRoom(room));
  assert.equal(Online.normalizeRoom({ ...room, seats: [] }), null);
});

test('房间：只能在自己的回合落子，棋步由引擎校验', () => {
  let room = newRoom();
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: 'B' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  const move = firstMove(room);
  assert.equal(Online.applyOp(room, { type: 'act', at: 0, action: move }, GUEST).code, 'not_your_turn');
  assert.equal(Online.applyOp(room, { type: 'act', at: 1, action: move }, HOST).code, 'stale');
  assert.equal(Online.applyOp(room, { type: 'act', at: 0, action: { ...move, x: 7, y: 7 } }, HOST).code, 'illegal');
  room = ok(Online.applyOp(room, { type: 'act', at: 0, action: move }, HOST));
  assert.equal(room.game.actions.length, 1);
  // 轮到电脑：客户端只有在允许时才能代落
  const aiMove = firstMove(ok(Online.applyOp(room, { type: 'act', at: 1, action: firstMove(room) }, GUEST)));
  room = ok(Online.applyOp(room, { type: 'act', at: 1, action: firstMove(room) }, GUEST));
  assert.equal(Online.applyOp(room, { type: 'act', at: 2, action: aiMove }, HOST).code, 'not_your_turn');
  room = ok(Online.applyOp(room, { type: 'act', at: 2, action: aiMove }, HOST, { allowClientAI: true }));
  assert.equal(room.game.actions.length, 3);
});

test('房间：托管、接任房主、换棋盘与再来一局', () => {
  let room = newRoom();
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: 'B' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'mode', mode: 'trigon' }, HOST));
  assert.equal(room.mode, 'trigon');
  assert.deepEqual(room.seats.map((s) => s.owner), [HOST, GUEST, null, null]);
  room = ok(Online.applyOp(room, { type: 'seat', seat: 3, kind: 'off' }, HOST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  assert.equal(room.game.config.size, 8);
  assert.equal(room.game.config.players[0].starts.length, 6);
  assert.equal(Online.applyOp(room, { type: 'takeover', player: 1 }, HOST, { online: [HOST, GUEST] }).code, 'player_online');
  room = ok(Online.applyOp(room, { type: 'takeover', player: 1 }, HOST, { online: [HOST] }));
  assert.equal(room.game.config.players[1].type, 'ai');
  assert.equal(Online.applyOp(room, { type: 'host' }, GUEST, { online: [HOST, GUEST] }).code, 'host_online');
  room = ok(Online.applyOp(room, { type: 'host' }, GUEST, { online: [GUEST] }));
  assert.equal(room.host, GUEST);
  room = ok(Online.applyOp(room, { type: 'rematch' }, GUEST, { online: [GUEST] }));
  assert.equal(room.status, 'lobby');
  assert.deepEqual(room.seats.map((s) => s.owner), [null, GUEST, null, null]);
});

test('房间：拒绝不可信的房间数据', () => {
  let room = newRoom();
  assert.equal(Online.normalizeRoom({ ...room, mode: '__proto__' }), null);
  assert.equal(Online.normalizeRoom({ ...room, mode: 'constructor' }), null);
  assert.equal(Online.createRoom({ code: 'ABCDE', host: HOST, mode: 'toString' }).mode, 'classic');
  assert.equal(Online.applyOp(room, { type: 'mode', mode: '__proto__' }, HOST).code, 'bad_mode');
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: 'B' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  // 篡改的棋盘尺寸 / 起点会按座位重建
  const tampered = JSON.parse(JSON.stringify(room));
  tampered.game.config.size = 1e7;
  tampered.game.config.players[0].starts = [[5, 5]];
  const fixed = Online.normalizeRoom(tampered);
  assert.equal(fixed.game.config.size, 20);
  assert.deepEqual(fixed.game.config.players[0].starts, [[0, 0]]);
  // 伪造的动作不会让重放崩溃
  tampered.game.actions = [{ type: 'place', player: 0, piece: 'constructor', orient: 0, x: 0, y: 0 }];
  const st = Online.gameState(Online.normalizeRoom(tampered));
  assert.equal(st.actions.length, 0);
});

test('房间：立体棋盘的棋步带 z 坐标', () => {
  let room = newRoom('cube');
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: 'B' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  assert.equal(room.game.config.size, 7);
  assert.deepEqual(room.game.config.players[1].starts, [[6, 0, 0]]);
  const move = firstMove(room);
  assert.equal(typeof move.z, 'number');
  assert.equal(Online.applyOp(room, { type: 'act', at: 0, action: { ...move, z: undefined } }, HOST).code, 'illegal');
  room = ok(Online.applyOp(room, { type: 'act', at: 0, action: move }, HOST));
  assert.equal(room.game.actions[0].z, move.z);
  const again = Online.normalizeRoom(JSON.parse(JSON.stringify(room)));
  assert.equal(Online.gameState(again).actions.length, 1);
});

test('房间号格式', () => {
  for (let i = 0; i < 50; i++) assert.ok(Online.normalizeCode(Online.makeCode()));
  assert.equal(Online.normalizeCode(' ab cd e '), 'ABCDE');
  assert.equal(Online.normalizeCode('ABC0E'), null);
});

/* ---------------- 服务器端到端 ---------------- */

function sseClient(base, code, token) {
  const ctrl = new AbortController();
  const listeners = [];
  const client = { room: null, pid: null, peers: [], close: () => ctrl.abort() };
  client.waitFor = (pred, ms = 8000) => new Promise((resolve, reject) => {
    if (pred(client)) return resolve(client);
    const timer = setTimeout(() => reject(new Error('timeout waiting for room state')), ms);
    listeners.push(() => { if (pred(client)) { clearTimeout(timer); resolve(client); return true; } return false; });
  });
  client.ready = fetch(`${base}/api/rooms/${code}/stream?token=${token}`, { signal: ctrl.signal }).then(async (res) => {
    assert.equal(res.status, 200);
    const decoder = new TextDecoder();
    let buf = '';
    (async () => {
      try {
        for await (const chunk of res.body) {
          buf += decoder.decode(chunk, { stream: true });
          let i;
          while ((i = buf.indexOf('\n\n')) >= 0) {
            const block = buf.slice(0, i);
            buf = buf.slice(i + 2);
            const ev = /^event: (.+)$/m.exec(block);
            const data = /^data: (.+)$/m.exec(block);
            if (!ev || !data) continue;
            const value = JSON.parse(data[1]);
            if (ev[1] === 'room') client.room = value;
            if (ev[1] === 'hello') client.pid = value.pid;
            if (ev[1] === 'peers') client.peers = value;
            for (let k = listeners.length - 1; k >= 0; k--) if (listeners[k]()) listeners.splice(k, 1);
          }
        }
      } catch (e) { /* aborted */ }
    })();
  });
  return client;
}

async function post(base, url, body) {
  const res = await fetch(base + url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return { status: res.status, body: await res.json() };
}

test('服务器：两名玩家 + 两个电脑完整打完一局', async (t) => {
  const server = await start(0, '127.0.0.1', { aiDelay: 1 });
  const clients = [];
  t.after(() => new Promise((r) => {
    clients.forEach((c) => c.close());
    server.closeAllConnections();
    server.close(r);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const info = await fetch(base + '/api/info').then((r) => r.json());
  assert.equal(info.blokus, 1);
  // 静态文件白名单
  assert.equal((await fetch(base + '/')).status, 200);
  assert.equal((await fetch(base + '/js/engine.js')).status, 200);
  assert.equal((await fetch(base + '/server.js')).status, 404);
  assert.equal((await fetch(base + '/js/../server.js')).status, 404);
  assert.equal((await fetch(base + '/js/..%2fserver.js')).status, 404);
  assert.equal((await fetch(base + '/js/%2e%2e%2fpackage.json')).status, 404);
  assert.equal((await fetch(base + '/css/style.css')).status, 200);
  assert.equal((await post(base, '/api/rooms', { token: 'tokenCCCCCCCCCCCCCCCC', mode: '__proto__' })).status, 200);

  const tokA = 'tokenAAAAAAAAAAAAAAAA', tokB = 'tokenBBBBBBBBBBBBBBBB';
  const created = await post(base, '/api/rooms', { token: tokA, name: '甲', mode: 'classic' });
  assert.equal(created.status, 200);
  const code = created.body.code;
  const a = sseClient(base, code, tokA);
  const b = sseClient(base, code, tokB);
  clients.push(a, b);
  await Promise.all([a.ready, b.ready]);
  await a.waitFor((c) => c.peers.length === 2);
  await b.waitFor((c) => c.room && c.pid);

  let r = await post(base, `/api/rooms/${code}/op`, { token: tokB, op: { type: 'claim', seat: 2, name: '乙' } });
  assert.equal(r.status, 409);
  assert.equal(r.body.code, 'seat_closed');
  r = await post(base, `/api/rooms/${code}/op`, { token: tokB, op: { type: 'claim', seat: 1, name: '乙' } });
  assert.equal(r.status, 200);
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'speed', speed: 'fast' } });
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'start' } });
  assert.equal(r.status, 200);
  await a.waitFor((c) => c.room.status !== 'lobby');

  const tokens = { [a.pid]: tokA, [b.pid]: tokB };
  for (let guard = 0; guard < 400; guard++) {
    await a.waitFor((c) => {
      if (!c.room || c.room.status === 'over') return true;
      const st = Online.gameState(c.room);
      return c.room.game.config.players[st.current].type === 'human';
    });
    const room = a.room;
    if (room.status === 'over') break;
    const st = Online.gameState(room);
    const pl = room.game.config.players[st.current];
    const m = Engine.legalMoves(st, st.current)[0];
    r = await post(base, `/api/rooms/${code}/op`, {
      token: tokens[pl.owner],
      op: { type: 'act', at: room.game.actions.length, action: { type: 'place', ...m } }
    });
    assert.equal(r.status, 200, JSON.stringify(r.body));
    await a.waitFor((c) => c.room.game.actions.length > room.game.actions.length);
  }
  await b.waitFor((c) => c.room.status === 'over');
  const final = Online.gameState(b.room);
  assert.ok(final.over);
  assert.ok(final.actions.length > 40);

  r = await post(base, `/api/rooms/${code}/op`, { token: tokB, op: { type: 'rematch' } });
  assert.equal(r.body.code, 'not_host');
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'rematch' } });
  assert.equal(r.status, 200);
  await b.waitFor((c) => c.room.status === 'lobby');
  assert.equal((await post(base, '/api/rooms/ZZZZZ/op', { token: tokA, op: { type: 'start' } })).status, 404);
});
