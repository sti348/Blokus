#!/usr/bin/env node
/*
 * 角斗士棋联机服务器（无第三方依赖）。
 *   node server.js            默认监听 0.0.0.0:8080
 *   PORT=3000 node server.js  换端口
 *   LLM_PROXY=1 node server.js  开启大模型转发（给不允许网页直连的接口用）
 *
 * 提供静态页面和联机接口：
 *   GET  /api/info                     探测服务器
 *   POST /api/rooms                    建房  { token, name, mode } -> { code }
 *   GET  /api/rooms/:code/stream       SSE 推送房间状态（?token=）
 *   POST /api/rooms/:code/op           房间操作 { token, op }
 *   POST /api/rooms/:code/preview      当前玩家正在尝试的位置 { token, preview }（只转发，不保存）
 *   POST /api/llm                      大模型转发 { url, key, body }（默认关闭；只转发到 …/chat/completions 或 Jev 的 …/systemone、…/decisions）
 * 服务器用规则引擎校验每一步，并负责电脑玩家的回合；「大模型」电脑由房主的浏览器调用模型后落子。
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
// 「大模型」电脑等房主的浏览器落子，超时由服务器用大师电脑代下
let LLM_WAIT_MS = 150 * 1000;
let llmProxyOn = process.env.LLM_PROXY === '1';
const LLM_MAX_BODY = 256 * 1024;
const LLM_MAX_RESPONSE = 2 * 1024 * 1024;
const LLM_MAX_ACTIVE = 8;
const LLM_TIMEOUT_MS = 300 * 1000;
let llmActive = 0;

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon'
};

// 全站游玩次数：每开一局 +1（同一地址 3 秒内只算一次），保存在 statsFile 里
const stats = { plays: 0, file: null, timer: null, last: new Map() };

function loadStats(file) {
  stats.file = file || null;
  stats.plays = 0;
  if (!file) return;
  try {
    const n = JSON.parse(fs.readFileSync(file, 'utf8')).plays;
    if (Number.isInteger(n) && n >= 0) stats.plays = n;
  } catch (e) { /* 第一次运行还没有文件 */ }
}

function saveStats() {
  if (!stats.file) return;
  clearTimeout(stats.timer);
  stats.timer = setTimeout(() => fs.writeFile(stats.file, JSON.stringify({ plays: stats.plays }), () => {}), 1000);
}

function countPlay(req, res) {
  const ip = req.socket.remoteAddress || '';
  const now = Date.now();
  if (now - (stats.last.get(ip) || 0) >= 3000) {
    if (stats.last.size > 5000) stats.last.clear();
    stats.last.set(ip, now);
    stats.plays++;
    saveStats();
  }
  sendJson(res, 200, { plays: stats.plays });
}

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

function readJson(req, limit) {
  return new Promise((resolve, reject) => {
    let size = 0;
    const chunks = [];
    req.on('data', (c) => {
      size += c.length;
      if (size > (limit || MAX_BODY)) {
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
  const llm = pl.level === 'llm';
  const runner = llm ? Online.aiRunner(room, onlinePids(entry)) : null;
  entry.aiTimer = setTimeout(() => {
    if (!rooms.has(room.code) || entry.room.rev !== rev) return;
    const st = Online.gameState(entry.room);
    const move = AI.chooseMove(st, llm ? 'expert' : pl.level || 'normal');
    const action = move ? Object.assign({ type: 'place' }, move) : { type: 'resign' };
    const result = Online.applyOp(entry.room, { type: 'act', at: st.actions.length, action }, Online.SYSTEM, {
      now: Date.now(),
      online: onlinePids(entry),
      system: true
    });
    if (result.room) commit(entry, result);
    else console.warn('[ai] %s: %s', room.code, result.error);
  }, runner ? LLM_WAIT_MS : AI_DELAY[room.speed] || AI_DELAY.normal);
}

function currentIsLLM(entry) {
  const room = entry.room;
  if (room.status !== 'playing' || !room.game) return false;
  const st = Online.gameState(room);
  const pl = room.game.config.players[st.current];
  return !st.over && pl.type === 'ai' && pl.level === 'llm';
}

// 大模型转发（默认关闭）：有些接口不允许网页直接访问（跨域），由服务器代发
async function llmProxy(req, res) {
  if (!llmProxyOn) return sendJson(res, 404, { error: { message: '服务器没有开启大模型转发（用 LLM_PROXY=1 启动）' } });
  const body = await readJson(req, LLM_MAX_BODY);
  let target;
  try {
    target = new URL(String(body.url || ''));
  } catch (e) {
    return sendJson(res, 400, { error: { message: '接口地址无效' } });
  }
  if (!/^https?:$/.test(target.protocol) || !/\/(chat\/completions|systemone|decisions)$/.test(target.pathname)) {
    return sendJson(res, 400, { error: { message: '只能转发到 …/chat/completions、…/systemone 或 …/decisions' } });
  }
  if (!body.body || typeof body.body !== 'object') return sendJson(res, 400, { error: { message: '缺少请求内容' } });
  if (llmActive >= LLM_MAX_ACTIVE) return sendJson(res, 429, { error: { message: '转发中的请求太多，请稍后再试' } });
  llmActive++;
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), LLM_TIMEOUT_MS);
  res.on('close', () => { if (!res.writableEnded) ctl.abort(); });
  try {
    const headers = { 'Content-Type': 'application/json' };
    if (typeof body.key === 'string' && body.key) headers.Authorization = 'Bearer ' + body.key;
    const up = await fetch(target, { method: 'POST', headers, body: JSON.stringify(body.body), signal: ctl.signal, redirect: 'error' });
    const text = await up.text();
    if (text.length > LLM_MAX_RESPONSE) return sendJson(res, 502, { error: { message: '接口返回的内容太大' } });
    res.writeHead(up.status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
    res.end(text);
  } catch (e) {
    if (!res.headersSent) sendJson(res, 502, { error: { message: ctl.signal.aborted ? '转发超时' : '服务器连不上接口：' + e.message } });
  } finally {
    clearTimeout(timer);
    llmActive--;
  }
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
    // 正在替大模型电脑落子的人掉线了：重新安排（没人能接手时由服务器代下）
    if (currentIsLLM(entry)) scheduleAI(entry);
  });
}

// 当前玩家正在尝试的位置：只转发给房间里的其他人，不保存
const previewTimes = new Map();
function cleanPreview(p) {
  if (p === null) return null;
  if (!p || typeof p !== 'object') return undefined;
  const out = {};
  for (const k of ['at', 'piece', 'orient', 'x', 'y', 'z']) {
    if (p[k] === undefined && k === 'z') continue;
    if (!Number.isInteger(p[k]) || Math.abs(p[k]) > 1000) return undefined;
    out[k] = p[k];
  }
  return out;
}

async function roomPreview(req, res, entry) {
  const body = await readJson(req);
  if (!validToken(body.token)) return sendJson(res, 400, { error: '缺少身份信息，请刷新页面' });
  const pid = pidOf(body.token);
  const room = entry.room;
  if (room.status !== 'playing') return sendJson(res, 409, { error: '对局不在进行中', code: 'not_playing' });
  const preview = cleanPreview(body.preview);
  if (preview === undefined) return sendJson(res, 400, { error: 'bad preview' });
  const st = Online.gameState(room);
  const pl = room.game.config.players[st.current];
  if (!pl || pl.type !== 'human' || pl.owner !== pid) {
    // 回合结束后发来的“清空”无需转发：其他人按回合号自动忽略旧位置
    if (preview === null) { res.writeHead(204); res.end(); return; }
    return sendJson(res, 409, { error: '还没轮到你', code: 'not_your_turn' });
  }
  // 每人每秒最多 20 次
  const now = Date.now();
  const last = previewTimes.get(pid) || [];
  const recent = last.filter((t) => now - t < 1000);
  if (recent.length >= 20) return sendJson(res, 429, { error: 'too many' });
  recent.push(now);
  previewTimes.set(pid, recent);
  for (const c of entry.clients) if (c.pid !== pid) sse(c.res, 'preview', { pid, preview });
  res.writeHead(204, { 'Cache-Control': 'no-store' });
  res.end();
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
  if (p === '/api/info' && req.method === 'GET') return sendJson(res, 200, { blokus: 1, rooms: rooms.size, llmProxy: llmProxyOn });
  if (p === '/api/stats' && req.method === 'GET') return sendJson(res, 200, { plays: stats.plays });
  if (p === '/api/stats/play' && req.method === 'POST') return countPlay(req, res);
  if (p === '/api/llm' && req.method === 'POST') return llmProxy(req, res);
  if (p === '/api/rooms' && req.method === 'POST') return createRoom(req, res);
  const one = /^\/api\/rooms\/([A-Za-z0-9]{5})$/.exec(p);
  if (one && req.method === 'GET') {
    return rooms.has(one[1].toUpperCase())
      ? sendJson(res, 200, { code: one[1].toUpperCase() })
      : sendJson(res, 404, { error: '房间不存在或已解散', code: 'no_room' });
  }
  const m = /^\/api\/rooms\/([A-Za-z0-9]{5})\/(stream|op|preview)$/.exec(p);
  if (m) {
    const entry = rooms.get(m[1].toUpperCase());
    if (!entry) return sendJson(res, 404, { error: '房间不存在或已解散', code: 'no_room' });
    if (m[2] === 'stream' && req.method === 'GET') {
      const token = url.searchParams.get('token');
      if (!validToken(token)) return sendJson(res, 400, { error: '缺少身份信息，请刷新页面' });
      return stream(req, res, entry, token);
    }
    if (m[2] === 'op' && req.method === 'POST') return roomOp(req, res, entry);
    if (m[2] === 'preview' && req.method === 'POST') return roomPreview(req, res, entry);
    return sendJson(res, 405, { error: 'method not allowed' });
  }
  if (p.startsWith('/api/')) return sendJson(res, 404, { error: 'not found' });
  if (req.method !== 'GET' && req.method !== 'HEAD') return sendJson(res, 405, { error: 'method not allowed' });
  return serveStatic(req, res, p);
}

function start(port, host, opts) {
  if (opts && opts.aiDelay != null) AI_DELAY = { fast: opts.aiDelay, normal: opts.aiDelay, slow: opts.aiDelay };
  if (opts && opts.llmWait != null) LLM_WAIT_MS = opts.llmWait;
  if (opts && opts.llmProxy != null) llmProxyOn = !!opts.llmProxy;
  loadStats(opts && opts.statsFile);
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
    clearTimeout(stats.timer);
    for (const entry of rooms.values()) clearTimeout(entry.aiTimer);
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(server)));
}

if (require.main === module) {
  start(PORT, HOST, { statsFile: process.env.STATS_FILE || path.join(ROOT, 'stats.json') }).then((server) => {
    const addr = server.address();
    console.log('角斗士棋已启动：http://localhost:%d', addr.port);
    const nets = require('os').networkInterfaces();
    Object.values(nets).flat().filter((n) => n && n.family === 'IPv4' && !n.internal)
      .forEach((n) => console.log('局域网内其他设备访问：http://%s:%d', n.address, addr.port));
  });
}

module.exports = { start, rooms };
