#!/usr/bin/env node
/*
 * 角斗士棋联机服务器（无第三方依赖）。
 *   node server.js            默认监听 0.0.0.0:8080
 *   PORT=3000 node server.js  换端口
 *
 * 提供静态页面和联机接口：
 *   GET  /api/info                     探测服务器
 *   POST /api/rooms                    建房  { token, name, mode } -> { code }
 *   GET  /api/rooms/:code/stream       SSE 推送房间状态（?token=）
 *   POST /api/rooms/:code/op           房间操作 { token, op }
 * 服务器用规则引擎校验每一步，并负责电脑玩家的回合。
 */
'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const AI = require('./js/ai.js');
const Online = require('./js/online.js');

const PORT = Number(process.env.PORT) || 8080;
const HOST = process.env.HOST || '0.0.0.0';
const ROOT = __dirname;
const MAX_ROOMS = 500;
const MAX_CLIENTS_PER_ROOM = 32;
const MAX_BODY = 16 * 1024;
const IDLE_ROOM_MS = 30 * 60 * 1000;
let AI_DELAY = { fast: 250, normal: 650, slow: 1200 };

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

/** code -> { room, clients: Set<{ res, pid }>, aiTimer, lastActive } */
const rooms = new Map();

function pidOf(token) {
  return crypto.createHash('sha256').update('blokus:' + token).digest('base64url').slice(0, 16);
}

function validToken(t) {
  return typeof t === 'string' && /^[A-Za-z0-9_-]{16,64}$/.test(t);
}

function sendJson(res, status, body) {
  const data = JSON.stringify(body);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(data)
  });
  res.end(data);
}

function readJson(req) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(Object.assign(new Error('too large'), { status: 413 }));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8') || '{}'));
      } catch (e) {
        reject(Object.assign(new Error('bad json'), { status: 400 }));
      }
    });
    req.on('error', reject);
  });
}

function onlinePids(entry) {
  const out = [];
  for (const c of entry.clients) if (out.indexOf(c.pid) < 0) out.push(c.pid);
  return out;
}

function sse(res, event, data) {
  res.write('event: ' + event + '\ndata: ' + JSON.stringify(data) + '\n\n');
}

function broadcastRoom(entry) {
  for (const c of entry.clients) sse(c.res, 'room', entry.room);
}

function broadcastPeers(entry) {
  const peers = onlinePids(entry);
  for (const c of entry.clients) sse(c.res, 'peers', peers);
}

function commit(entry, result) {
  entry.room = result.room;
  entry.lastActive = Date.now();
  broadcastRoom(entry);
  scheduleAI(entry);
}

// 电脑回合由服务器执行
function scheduleAI(entry) {
  clearTimeout(entry.aiTimer);
  const room = entry.room;
  if (room.status !== 'playing') return;
  const state = Online.gameState(room);
  if (state.over) return;
  const pl = room.game.config.players[state.current];
  if (pl.type !== 'ai') return;
  const rev = room.rev;
  entry.aiTimer = setTimeout(() => {
    if (!rooms.has(room.code) || entry.room.rev !== rev) return;
    const st = Online.gameState(entry.room);
    const move = AI.chooseMove(st, pl.level || 'normal');
    const action = move ? Object.assign({ type: 'place' }, move) : { type: 'resign' };
    const result = Online.applyOp(entry.room, { type: 'act', at: st.actions.length, action }, Online.SYSTEM, {
      now: Date.now(),
      online: onlinePids(entry),
      system: true
    });
    if (result.room) commit(entry, result);
    else console.warn('[ai] %s: %s', room.code, result.error);
  }, AI_DELAY[room.speed] || AI_DELAY.normal);
}

async function createRoom(req, res) {
  const body = await readJson(req);
  if (!validToken(body.token)) return sendJson(res, 400, { error: '缺少身份信息，请刷新页面' });
  if (rooms.size >= MAX_ROOMS) return sendJson(res, 503, { error: '房间太多了，请稍后再试' });
  let code;
  do code = Online.makeCode(); while (rooms.has(code));
  const room = Online.createRoom({ code, host: pidOf(body.token), name: body.name, mode: body.mode, now: Date.now() });
  rooms.set(code, { room, clients: new Set(), aiTimer: null, lastActive: Date.now() });
  console.log('[room] %s created (%s)', code, room.mode);
  sendJson(res, 200, { code });
}

function stream(req, res, entry, token) {
  if (entry.clients.size >= MAX_CLIENTS_PER_ROOM) return sendJson(res, 503, { error: '房间人数已满' });
  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-store',
    Connection: 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.write('retry: 2000\n\n');
  const client = { res, pid: pidOf(token) };
  entry.clients.add(client);
  entry.lastActive = Date.now();
  sse(res, 'hello', { pid: client.pid });
  sse(res, 'room', entry.room);
  broadcastPeers(entry);
  const keepAlive = setInterval(() => res.write(': ping\n\n'), 20000);
  req.on('close', () => {
    clearInterval(keepAlive);
    entry.clients.delete(client);
    entry.lastActive = Date.now();
    broadcastPeers(entry);
  });
}

async function roomOp(req, res, entry) {
  const body = await readJson(req);
  if (!validToken(body.token)) return sendJson(res, 400, { error: '缺少身份信息，请刷新页面' });
  const result = Online.applyOp(entry.room, body.op, pidOf(body.token), {
    now: Date.now(),
    online: onlinePids(entry),
    allowClientAI: false
  });
  if (result.error) return sendJson(res, 409, result);
  commit(entry, result);
  sendJson(res, 200, { ok: true, rev: entry.room.rev });
}

// 只开放页面需要的文件：index.html、css/、js/
function serveStatic(req, res, pathname) {
  let rel;
  try {
    rel = pathname === '/' ? 'index.html' : decodeURIComponent(pathname.slice(1));
  } catch (e) {
    return sendJson(res, 400, { error: 'bad path' });
  }
  const file = path.resolve(ROOT, rel);
  const parts = path.relative(ROOT, file).split(path.sep);
  const allowed = (parts.length === 1 && parts[0] === 'index.html') ||
    (parts.length > 1 && (parts[0] === 'css' || parts[0] === 'js'));
  if (!allowed || rel.indexOf('\0') >= 0) return sendJson(res, 404, { error: 'not found' });
  const type = MIME[path.extname(file)];
  if (!type) return sendJson(res, 404, { error: 'not found' });
  fs.readFile(file, (err, data) => {
    if (err) return sendJson(res, 404, { error: 'not found' });
    res.writeHead(200, { 'Content-Type': type, 'Cache-Control': 'no-cache', 'Content-Length': data.length });
    res.end(req.method === 'HEAD' ? undefined : data);
  });
}

async function handle(req, res) {
  const url = new URL(req.url, 'http://localhost');
  const p = url.pathname;
  if (p === '/api/info' && req.method === 'GET') return sendJson(res, 200, { blokus: 1, rooms: rooms.size });
  if (p === '/api/rooms' && req.method === 'POST') return createRoom(req, res);
  const one = /^\/api\/rooms\/([A-Za-z0-9]{5})$/.exec(p);
  if (one && req.method === 'GET') {
    return rooms.has(one[1].toUpperCase())
      ? sendJson(res, 200, { code: one[1].toUpperCase() })
      : sendJson(res, 404, { error: '房间不存在或已解散', code: 'no_room' });
  }
  const m = /^\/api\/rooms\/([A-Za-z0-9]{5})\/(stream|op)$/.exec(p);
  if (m) {
    const entry = rooms.get(m[1].toUpperCase());
    if (!entry) return sendJson(res, 404, { error: '房间不存在或已解散', code: 'no_room' });
    if (m[2] === 'stream' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!validToken(token)) return sendJson(res, 400, { error: '缺少身份信息，请刷新页面' });
      return stream(req, res, entry, token);
    }
    if (m[2] === 'op' && req.method === 'POST') return roomOp(req, res, entry);
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, p);
}

function start(port, host, opts) {
  if (opts && opts.aiDelay != null) AI_DELAY = { fast: opts.aiDelay, normal: opts.aiDelay, slow: opts.aiDelay };
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err) => {
      if (!res.headersSent) sendJson(res, err.status || 500, { error: err.status ? err.message : '服务器出错了' });
      if (!err.status) console.error(err);
    });
  });
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [code, entry] of rooms) {
      if (entry.clients.size === 0 && now - entry.lastActive > IDLE_ROOM_MS) {
        clearTimeout(entry.aiTimer);
        rooms.delete(code);
      }
    }
  }, 60 * 1000);
  sweep.unref();
  server.on('close', () => {
    clearInterval(sweep);
    for (const entry of rooms.values()) clearTimeout(entry.aiTimer);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (require.main === module) {
  start(PORT, HOST).then((server) => {
    const addr = server.address();
    console.log('角斗士棋已启动：http://localhost:%d', addr.port);
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal)
      .forEach((n) => console.log('局域网内其他设备访问：http://%s:%d', n.address, addr.port));
  });
}

module.exports = { start, rooms };
