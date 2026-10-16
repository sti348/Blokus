'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const AI = require('../js/ai.js');
const LLM = require('../js/llm.js');

const SETTINGS = { provider: 'openai', baseUrl: 'https://llm.example.com/v1/', apiKey: 'sk-test', model: 'demo-model', timeout: 30 };

function midGame(mode, plies) {
  const st = Engine.createGame(Engine.buildConfig(mode, Engine.MODES[mode].seats.map((s, i) => ({ seat: i }))));
  let seed = 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < plies && !st.over; i++) {
    const m = AI.chooseMove(st, 'normal', { rng });
    Engine.applyAction(st, m ? Object.assign({ type: 'place' }, m) : { type: 'resign' });
  }
  return st;
}

// 假的 OpenAI 兼容接口：记录请求，按 reply 回答
function fakeFetch(reply, status = 200) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (typeof reply === 'function') return reply(url, init);
    const text = typeof reply === 'string' ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }) : JSON.stringify(reply);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  f.calls = calls;
  return f;
}

test('大模型：设置校验与接口地址', () => {
  const s = LLM.normalizeSettings({ provider: 'nope', baseUrl: '  https://a.b/v1  ', model: ' m ', timeout: 5, tier: 'x' });
  assert.equal(s.provider, 'openai');
  assert.equal(s.baseUrl, 'https://a.b/v1');
  assert.equal(s.model, 'm');
  assert.equal(s.timeout, 10);
  assert.equal(s.tier, 'quick');
  assert.equal(LLM.isReady(s), true);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ baseUrl: 'ftp://x', model: 'm' })), false);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ baseUrl: 'https://x/v1' })), false);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ provider: 'claude' })), true);
  assert.equal(LLM.endpointOf('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(LLM.endpointOf('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');
});

test('大模型：解析回答', () => {
  assert.deepEqual(LLM.parseReply('{"choice": 3, "reason": "堵住红方"}', 12), { index: 2, reason: '堵住红方' });
  assert.deepEqual(LLM.parseReply('<think>先想想 #9</think>\n```json\n{"choice":"#2","reason":"抢中心"}\n```', 12), { index: 1, reason: '抢中心' });
  assert.equal(LLM.parseReply('我选择 #5，因为它离中心近', 12).index, 4);
  assert.equal(LLM.parseReply('choice: 13', 12), null);
  assert.equal(LLM.parseReply('{"choice": 0}', 12), null);
  assert.equal(LLM.parseReply('不知道', 12), null);
  assert.equal(LLM.parseReply(null, 12), null);
  const long = LLM.parseReply('{"choice": 1, "reason": "' + '很长'.repeat(50) + '\\u2028"}', 12);
  assert.ok(long.reason.length <= 40);
});

test('大模型：各种棋盘都能生成提示词，候选都是合法走法', () => {
  for (const mode of ['classic', 'duo', 'trigon', 'cube', 'prism']) {
    const st = midGame(mode, 8);
    const cands = AI.rankMoves(st, 12);
    assert.ok(cands.length > 1, mode);
    assert.ok(cands.length <= 12, mode);
    for (let i = 1; i < cands.length; i++) assert.ok(cands[i - 1].score >= cands[i].score, mode + ' 按估值排序');
    for (const c of cands) {
      const m = c.move;
      assert.equal(Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y, m.z), null, mode);
      assert.equal(c.size, st.set.pieces[m.piece].size);
    }
    const msgs = LLM.buildMessages(st, cands);
    assert.equal(msgs.length, 2);
    assert.equal(msgs[0].role, 'system');
    const text = msgs[1].content;
    assert.ok(text.includes('#' + cands.length + ' '), mode);
    assert.ok(text.includes('【棋盘】'), mode);
    assert.ok(text.includes('【你】'), mode);
    assert.ok(text.length < 8000, mode + ' 提示词不要太长：' + text.length);
    // 棋盘图里每个已放的格子都画出来了（立体棋盘是俯视图，只数列）
    const board = LLM.boardText(st);
    if (st.topo.dims === 2) {
      const filled = Array.from(st.board).filter((v) => v >= 0).length;
      assert.equal((board.match(/[BYRGVO]/g) || []).length, filled, mode);
    }
  }
});

test('大模型：调用 OpenAI 兼容接口选出候选里的一步', async () => {
  const st = midGame('classic', 12);
  const cands = AI.rankMoves(st, 12);
  const f = fakeFetch('好的。{"choice": 3, "reason": "占住中心并压住红方"}');
  const r = await LLM.decide(st, SETTINGS, { fetch: f });
  assert.deepEqual(r.move, cands[2].move);
  assert.equal(r.reason, '占住中心并压住红方');
  assert.equal(r.asked, true);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(call.init.method, 'POST');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'demo-model');
  assert.equal(call.body.messages.length, 2);
  // 局面没有被改动
  assert.deepEqual(AI.rankMoves(st, 12).map((c) => c.move), cands.map((c) => c.move));

  // 没填密钥（本地模型）时不带 Authorization
  const f2 = fakeFetch('{"choice": 1}');
  await LLM.decide(st, Object.assign({}, SETTINGS, { apiKey: '' }), { fetch: f2 });
  assert.equal(f2.calls[0].init.headers.Authorization, undefined);
});

test('大模型：出错时给出可读的原因', async () => {
  const st = midGame('trigon', 6);
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch('我觉得都不错') }), (e) => e.code === 'bad_reply');
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch({ error: { message: 'Incorrect API key' } }, 401) }),
    (e) => e.code === 'http' && /401/.test(e.message) && /密钥/.test(e.message) && /Incorrect API key/.test(e.message));
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch({ choices: [] }) }), (e) => e.code === 'empty');
  await assert.rejects(LLM.decide(st, { provider: 'openai', baseUrl: '', model: '' }, { fetch: fakeFetch('1') }), (e) => e.code === 'setup');
  // 浏览器直连失败（跨域）且没有转发
  const cors = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: cors }), (e) => e.code === 'network' && /跨域/.test(e.message));
  // 取消
  const ctl = new AbortController();
  const hang = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const p = LLM.decide(st, SETTINGS, { fetch: hang, signal: ctl.signal });
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('大模型：直连失败时改走服务器转发', async () => {
  const st = midGame('cube', 6);
  const f = fakeFetch((url, init) => {
    if (url !== '/api/llm') throw new TypeError('Failed to fetch');
    const body = JSON.parse(init.body);
    assert.equal(body.url, 'https://llm.example.com/v1/chat/completions');
    assert.equal(body.key, 'sk-test');
    assert.equal(body.body.model, 'demo-model');
    return { ok: true, status: 200, text: async () => JSON.stringify({ choices: [{ message: { content: '{"choice":2,"reason":"往上爬"}' } }] }) };
  });
  const r = await LLM.decide(st, SETTINGS, { fetch: f, proxy: '/api/llm' });
  assert.equal(r.index, 1);
  assert.equal(r.reason, '往上爬');
  assert.equal(f.calls.length, 2);
});

test('大模型：Claude 页面自带的 Claude', async () => {
  const st = midGame('prism', 6);
  const seen = [];
  const sample = async (prompt, opts) => {
    seen.push({ prompt, opts });
    return { text: '{"choice": 4, "reason": "留角点"}', truncated: false };
  };
  const r = await LLM.decide(st, { provider: 'claude', tier: 'default' }, { sample });
  assert.equal(r.index, 3);
  assert.equal(seen[0].opts.modelTier, 'default');
  assert.equal(seen[0].opts.cache, false);
  assert.ok(seen[0].prompt.includes('【候选走法】'));
  await assert.rejects(LLM.decide(st, { provider: 'claude' }, {}), (e) => e.code === 'unavailable');
  const denied = async () => { throw { code: 'not_granted', message: 'no' }; };
  await assert.rejects(LLM.decide(st, { provider: 'claude' }, { sample: denied }), (e) => e.code === 'not_granted' && /允许/.test(e.message));
});

test('大模型：只有一步可走时不调用模型', async () => {
  // 找一个当前玩家恰好只有一步可走的局面（终盘很常见）
  let st = null;
  for (let g = 0; g < 20 && !st; g++) {
    const s = Engine.createGame(Engine.buildConfig('duo', [{ seat: 0 }, { seat: 1 }]));
    let seed = 11 + g;
    const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
    while (!s.over) {
      if (Engine.legalMoves(s, s.current).length === 1) { st = s; break; }
      const m = AI.chooseMove(s, 'easy', { rng });
      Engine.applyAction(s, m ? Object.assign({ type: 'place' }, m) : { type: 'resign' });
    }
  }
  assert.ok(st, '没找到只有一步的局面');
  const f = fakeFetch('{"choice": 1}');
  const r = await LLM.decide(st, SETTINGS, { fetch: f });
  assert.equal(r.asked, false);
  assert.deepEqual(r.move, Engine.legalMoves(st, st.current)[0]);
  assert.equal(f.calls.length, 0);
});

test('电脑：重构估值后困难电脑的选择不变', () => {
  // 固定随机数时，同一局面下 rankMoves 的第一名就是困难电脑会走的那步
  for (const mode of ['classic', 'trigon', 'prism']) {
    const st = midGame(mode, 10);
    const hard = AI.chooseMove(st, 'hard', { rng: () => 0 });
    const top = AI.rankMoves(st, 1)[0].move;
    assert.deepEqual(top, hard, mode);
  }
});
