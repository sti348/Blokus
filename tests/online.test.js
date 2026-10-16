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
  const client = { room: null, pid: null, peers: [], previews: [], close: () => ctrl.abort() };
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
            if (ev[1] === 'preview') client.previews.push(value);
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
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
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

  // 正在尝试的位置：只有当前玩家能发，其他人实时收到，不进房间记录
  const pv = { at: 0, piece: 3, orient: 1, x: 0, y: 0 };
  assert.equal((await post(base, `/api/rooms/${code}/preview`, { token: tokB, preview: pv })).status, 409);
  assert.equal((await post(base, `/api/rooms/${code}/preview`, { token: tokA, preview: { at: 'x' } })).status, 400);
  assert.equal((await post(base, `/api/rooms/${code}/preview`, { token: tokA, preview: pv })).status, 204);
  await b.waitFor((c) => c.previews.length === 1);
  assert.deepEqual(b.previews[0], { pid: a.pid, preview: pv });
  assert.equal(a.previews.length, 0);
  assert.equal((await post(base, `/api/rooms/${code}/preview`, { token: tokA, preview: null })).status, 204);
  await b.waitFor((c) => c.previews.length === 2 && c.previews[1].preview === null);
  assert.equal(b.room.game.actions.length, 0);

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

/* ---------------- 大模型电脑 ---------------- */

function llmRoom() {
  let room = newRoom();
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: '乙' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'seat', seat: 0, kind: 'ai', level: 'llm' }, HOST));
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'off' }, HOST));
  room = ok(Online.applyOp(room, { type: 'seat', seat: 3, kind: 'off' }, HOST));
  return ok(Online.applyOp(room, { type: 'start' }, HOST));
}

test('房间：大模型电脑由房主代为落子，附带的话会清理', () => {
  let room = llmRoom();
  assert.equal(room.game.config.players[0].level, 'llm');
  assert.equal(room.game.config.players[0].type, 'ai');
  const a = firstMove(room);
  // 只有替电脑落子的人（房主在线时是房主）可以替大模型电脑落子
  assert.equal(Online.applyOp(room, { type: 'act', at: 0, action: a }, GUEST, { online: [HOST, GUEST] }).code, 'not_your_turn');
  const note = '占住角落 并且' + '很长的理由'.repeat(20);
  room = ok(Online.applyOp(room, { type: 'act', at: 0, action: a, note }, HOST, { online: [HOST, GUEST] }));
  const rec = room.game.actions[0];
  assert.ok(rec.note.startsWith('占住角落 并且'));
  assert.ok(rec.note.length <= 60);
  assert.equal(room.game.actions.length, 1);
  // 房主不在线时由在线的玩家接手
  let room2 = llmRoom();
  assert.equal(Online.applyOp(room2, { type: 'act', at: 0, action: firstMove(room2) }, HOST, { online: [GUEST] }).code, 'not_your_turn');
  room2 = ok(Online.applyOp(room2, { type: 'act', at: 0, action: firstMove(room2) }, GUEST, { online: [GUEST] }));
  // 真人落子不能附带理由
  const b = firstMove(room);
  room = ok(Online.applyOp(room, { type: 'act', at: 1, action: b, note: '我也想说话' }, GUEST, { online: [HOST, GUEST] }));
  assert.equal(room.game.actions[1].note, undefined);
  // 普通电脑仍然只能由服务器或共享存储里的房主落子
  let room3 = newRoom();
  room3 = ok(Online.applyOp(room3, { type: 'claim', seat: 1, name: '乙' }, GUEST));
  room3 = ok(Online.applyOp(room3, { type: 'seat', seat: 0, kind: 'ai', level: 'hard' }, HOST));
  room3 = ok(Online.applyOp(room3, { type: 'start' }, HOST));
  assert.equal(Online.applyOp(room3, { type: 'act', at: 0, action: firstMove(room3) }, HOST, { online: [HOST, GUEST] }).code, 'not_your_turn');
  // 存储里的理由会被重新清理
  const raw = JSON.parse(JSON.stringify(room));
  raw.game.actions[0].note = '\u0007坏' + 'x'.repeat(100);
  const norm = Online.normalizeRoom(raw);
  assert.ok(norm.game.actions[0].note.startsWith('坏'));
  assert.ok(norm.game.actions[0].note.length <= 60);
  assert.equal(Online.normalizeRoom(Object.assign({}, raw, { seats: raw.seats.map((s) => Object.assign({}, s, { level: 'genius' })) })), null);
});

test('服务器：大模型电脑等房主落子，等太久由服务器代下；大模型转发', async (t) => {
  // 假的 OpenAI 兼容接口
  const http = require('http');
  const upstream = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      const data = JSON.parse(body);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ choices: [{ message: { content: 'auth=' + (req.headers.authorization || '') + ' model=' + data.model + ' path=' + req.url } }] }));
    });
  });
  await new Promise((r) => upstream.listen(0, '127.0.0.1', r));
  const server = await start(0, '127.0.0.1', { aiDelay: 1, llmWait: 400, llmProxy: false });
  const clients = [];
  t.after(() => new Promise((r) => {
    clients.forEach((c) => c.close());
    server.closeAllConnections();
    upstream.close();
    server.close(r);
  }));
  const base = `http://127.0.0.1:${server.address().port}`;
  const up = `http://127.0.0.1:${upstream.address().port}/v1/chat/completions`;

  // 转发默认关闭
  assert.equal((await fetch(base + '/api/info').then((r) => r.json())).llmProxy, false);
  let r = await post(base, '/api/llm', { url: up, key: 'k', body: { model: 'm', messages: [] } });
  assert.equal(r.status, 404);
  assert.match(r.body.error.message, /LLM_PROXY/);

  const tokA = 'tokenLLMAAAAAAAAAAAAA', tokB = 'tokenLLMBBBBBBBBBBBBB';
  const code = (await post(base, '/api/rooms', { token: tokA, name: '甲', mode: 'duo' })).body.code;
  const a = sseClient(base, code, tokA);
  clients.push(a);
  await a.ready;
  await a.waitFor((c) => c.room && c.pid);
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'seat', seat: 0, kind: 'ai', level: 'llm' } });
  assert.equal(r.status, 200);
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'seat', seat: 1, kind: 'ai', level: 'easy' } });
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'start' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await a.waitFor((c) => c.room.status === 'playing');

  // 房主替大模型电脑落子，附带理由；别人不行
  const room = a.room;
  const st = Online.gameState(room);
  const m = Engine.legalMoves(st, st.current)[0];
  r = await post(base, `/api/rooms/${code}/op`, { token: tokB, op: { type: 'act', at: 0, action: { type: 'place', ...m } } });
  assert.equal(r.status, 409);
  r = await post(base, `/api/rooms/${code}/op`, { token: tokA, op: { type: 'act', at: 0, action: { type: 'place', ...m }, note: '先占中心' } });
  assert.equal(r.status, 200, JSON.stringify(r.body));
  await a.waitFor((c) => c.room.game.actions.length >= 1);
  assert.equal(a.room.game.actions[0].note, '先占中心');

  // 普通电脑回合由服务器马上走；下一个大模型回合房主不动，服务器等一会儿后代下
  await a.waitFor((c) => c.room.game.actions.length >= 2);
  const t0 = Date.now();
  await a.waitFor((c) => c.room.game.actions.length >= 3, 4000);
  assert.ok(Date.now() - t0 >= 300, '应该先等房主');
  assert.equal(a.room.game.actions[2].note, undefined);

  // 房主掉线后没人能替大模型电脑落子：服务器很快代下
  a.close();
  const watcher = sseClient(base, code, 'tokenLLMWATCHERWWWWWW');
  clients.push(watcher);
  await watcher.ready;
  await watcher.waitFor((c) => c.room && c.room.game && c.room.game.actions.length >= 6, 4000);

  // 开启转发后：只转发到 …/chat/completions，带上密钥
  const server2 = await start(0, '127.0.0.1', { llmProxy: true });
  t.after(() => new Promise((res) => { server2.closeAllConnections(); server2.close(res); }));
  const base2 = `http://127.0.0.1:${server2.address().port}`;
  assert.equal((await fetch(base2 + '/api/info').then((x) => x.json())).llmProxy, true);
  r = await post(base2, '/api/llm', { url: up, key: 'sk-proxy', body: { model: 'mm', messages: [{ role: 'user', content: 'hi' }] } });
  assert.equal(r.status, 200);
  assert.equal(r.body.choices[0].message.content, 'auth=Bearer sk-proxy model=mm path=/v1/chat/completions');
  r = await post(base2, '/api/llm', { url: up.replace('/chat/completions', '/systemone'), key: 'ts', body: { model: 'jev-latest', questions: {} } });
  assert.equal(r.status, 200);
  assert.match(r.body.choices[0].message.content, /path=\/v1\/systemone/);
  r = await post(base2, '/api/llm', { url: up.replace('/v1/chat/completions', '/api/alpha/decisions'), key: 'or', body: { model: 'x' } });
  assert.equal(r.status, 200);
  r = await post(base2, '/api/llm', { url: up.replace('/chat/completions', '/models'), body: {} });
  assert.equal(r.status, 400);
  r = await post(base2, '/api/llm', { url: 'file:///etc/passwd', body: {} });
  assert.equal(r.status, 400);
  r = await post(base2, '/api/llm', { url: 'http://127.0.0.1:1/v1/chat/completions', body: { model: 'x' } });
  assert.equal(r.status, 502);
});

test('房间：大师难度与大模型座位的模型配置名', () => {
  let room = newRoom();
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: '乙' }, GUEST));
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'ai', level: 'expert' }, HOST));
  room = ok(Online.applyOp(room, { type: 'seat', seat: 3, kind: 'ai', level: 'llm', model: ' DeepSeek\u0007 V4 很长很长很长很长的名字 ' }, HOST));
  assert.equal(room.seats[3].model, 'DeepSeek V4 很长很长');
  assert.equal(Online.applyOp(room, { type: 'seat', seat: 3, model: 'x' }, GUEST).code, 'not_host');
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, model: 'Jev' }, HOST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  const ps = room.game.config.players;
  assert.equal(ps[2].level, 'expert');
  assert.equal(ps[2].model, '', '不是大模型座位时不带模型名');
  assert.equal(ps[3].model, 'DeepSeek V4 很长很长');
  const norm = Online.normalizeRoom(JSON.parse(JSON.stringify(room)));
  assert.equal(norm.seats[3].model, 'DeepSeek V4 很长很长');
  assert.equal(norm.game.config.players[3].model, 'DeepSeek V4 很长很长');
  assert.equal(norm.game.config.players[2].level, 'expert');
  // 清空模型名
  let lobby = newRoom();
  lobby = ok(Online.applyOp(lobby, { type: 'seat', seat: 3, kind: 'ai', level: 'llm', model: 'A' }, HOST));
  lobby = ok(Online.applyOp(lobby, { type: 'seat', seat: 3, model: '' }, HOST));
  assert.equal(lobby.seats[3].model, undefined);
});

test('房间：宝石阵只能 3、4 或 6 方开局', () => {
  let room = Online.createRoom({ code: 'ABCDE', host: HOST, name: '房主', mode: 'gemblo', now: 1 });
  assert.equal(room.seats.length, 6);
  room = ok(Online.applyOp(room, { type: 'claim', seat: 1, name: '乙' }, GUEST));
  for (const i of [2, 3, 4, 5]) room = ok(Online.applyOp(room, { type: 'seat', seat: i, kind: 'off' }, HOST));
  assert.equal(Online.applyOp(room, { type: 'start' }, HOST).code, 'bad_count');
  room = ok(Online.applyOp(room, { type: 'seat', seat: 2, kind: 'ai', level: 'hard' }, HOST));
  room = ok(Online.applyOp(room, { type: 'start' }, HOST));
  assert.equal(room.game.config.players.length, 3);
  assert.equal(Online.gameState(room).topo.cells.length, 241);
});
