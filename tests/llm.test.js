'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const AI = require('../js/ai.js');
const LLM = require('../js/llm.js');

const SETTINGS = { provider: 'openai', openai: { baseUrl: 'https://llm.example.com/v1/', apiKey: 'sk-test', model: 'demo-model' }, timeout: 30 };
const JEV = { provider: 'jev', jev: { apiKey: 'ts-test' }, timeout: 30 };

function newGame(mode) {
  return Engine.createGame(Engine.buildConfig(mode, Engine.MODES[mode].seats.map((s, i) => ({ seat: i }))));
}

function seeded(n) {
  let seed = n || 5;
  return () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
}

// 大师的推演结果（固定随机数，便于比较）
function expert(st, n) {
  return new AI.ExpertSearch(st, { rng: seeded(n) }).run();
}

function cands(st) {
  return LLM.candidatesFrom(st, expert(st));
}

function step(st, rng) {
  const m = AI.chooseMove(st, 'normal', { rng });
  Engine.applyAction(st, m ? Object.assign({ type: 'place' }, m) : { type: 'resign' });
}

// 走到当前玩家至少有 need 个（或恰好 exact 个）候选的局面
function position(mode, opts = {}) {
  const st = newGame(mode);
  let seed = opts.seed || 7;
  const rng = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let i = 0; i < (opts.plies || 6); i++) step(st, rng);
  for (let guard = 0; guard < 200 && !st.over; guard++) {
    const n = cands(st).length;
    if (opts.exact ? n === opts.exact : n >= (opts.need || 2)) return st;
    step(st, rng);
  }
  throw new Error('没找到合适的局面：' + mode);
}

// 假接口：记录请求，按 reply 回答
function fakeFetch(reply, status = 200) {
  const calls = [];
  const f = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (typeof reply === 'function') return reply(url, init, calls.length);
    const text = typeof reply === 'string' ? JSON.stringify({ choices: [{ message: { role: 'assistant', content: reply } }] }) : JSON.stringify(reply);
    return { ok: status >= 200 && status < 300, status, text: async () => text };
  };
  f.calls = calls;
  return f;
}

function json(status, data) {
  return { ok: status >= 200 && status < 300, status, text: async () => JSON.stringify(data) };
}

test('大模型：设置校验、旧版设置迁移与接口地址', () => {
  const s = LLM.normalizeSettings({ provider: 'nope', baseUrl: '  https://a.b/v1  ', model: ' m ', timeout: 2, tier: 'x' });
  assert.equal(s.provider, 'openai');
  assert.deepEqual(s.openai, { baseUrl: 'https://a.b/v1', apiKey: '', model: 'm' });
  assert.equal(s.timeout, 5);
  assert.equal(s.tier, 'quick');
  assert.equal(s.noThink, true);
  assert.equal(LLM.normalizeSettings(null).timeout, 30);
  assert.equal(s.jev.baseUrl, LLM.JEV_URL);
  assert.equal(s.jev.model, LLM.JEV_MODEL);
  assert.equal(LLM.isReady(s), true);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ baseUrl: 'ftp://x', model: 'm' })), false);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ openai: { baseUrl: 'https://x/v1' } })), false);
  assert.equal(LLM.isReady(LLM.normalizeSettings({ provider: 'claude' })), true);
  // Jev 有默认地址和模型
  assert.equal(LLM.isReady(LLM.normalizeSettings({ provider: 'jev' })), true);
  assert.equal(LLM.chatUrl('https://api.example.com/v1/'), 'https://api.example.com/v1/chat/completions');
  assert.equal(LLM.chatUrl('http://localhost:11434/v1/chat/completions'), 'http://localhost:11434/v1/chat/completions');
  assert.equal(LLM.jevUrl('https://api.typesafe.ai/v1/'), 'https://api.typesafe.ai/v1/systemone');
  assert.equal(LLM.jevUrl('http://localhost:11434/v1/systemone'), 'http://localhost:11434/v1/systemone');
  assert.equal(LLM.jevUrl('https://openrouter.ai/api/v1'), 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(LLM.jevUrl('https://openrouter.ai/api/v1/'), 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(LLM.jevUrl('https://openrouter.ai/api/alpha/decisions'), 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(LLM.jevUrl('https://openrouter.ai/api/v1/systemone'), 'https://openrouter.ai/api/v1/systemone');
  assert.equal(LLM.jevUrl('https://notopenrouter.ai/v1'), 'https://notopenrouter.ai/v1/systemone');
  assert.deepEqual(LLM.noThinkParams('https://api.deepseek.com/v1'), { thinking: { type: 'disabled' }, max_tokens: 200 });
  assert.deepEqual(LLM.noThinkParams('https://open.bigmodel.cn/api/paas/v4'), { thinking: { type: 'disabled' }, max_tokens: 200 });
  assert.deepEqual(LLM.noThinkParams('https://dashscope.aliyuncs.com/compatible-mode/v1'), { enable_thinking: false, max_tokens: 200 });
  assert.equal(LLM.noThinkParams('https://api.openai.com/v1'), null);
  assert.equal(LLM.noThinkParams('https://evil.com/api.deepseek.com'), null);
});

test('大模型：解析回答', () => {
  assert.deepEqual(LLM.parseReply('{"choice": 3, "reason": "堵住红方"}', 5), { index: 2, reason: '堵住红方' });
  assert.deepEqual(LLM.parseReply('<think>先想想 #4</think>\n```json\n{"choice":"#2","reason":"抢中心"}\n```', 5), { index: 1, reason: '抢中心' });
  assert.equal(LLM.parseReply('我选择 #5，因为它离中心近', 5).index, 4);
  assert.equal(LLM.parseReply('choice: 6', 5), null);
  assert.equal(LLM.parseReply('{"choice": 0}', 5), null);
  assert.equal(LLM.parseReply('不知道', 5), null);
  assert.equal(LLM.parseReply(null, 5), null);
  const long = LLM.parseReply('{"choice": 1, "reason": "' + '很长'.repeat(50) + '\\u2028"}', 5);
  assert.ok(long.reason.length <= 40);
  // Jev 的回答
  assert.deepEqual(LLM.parseJev({ answers: { move: { type: 'choice', choice: 'm2', probabilities: { m1: 0.2, m2: 0.7, m3: 0.1 }, confidence: 0.7 } } }, 3),
    { key: 'm2', index: 1, confidence: 0.7 });
  assert.equal(LLM.parseJev({ answers: { move: { probabilities: { m1: 0.1, m2: 0.3, m3: 0.6 } } } }, 3).index, 2);
  assert.equal(LLM.parseJev({ answers: { move: { choice: 'm9' } } }, 3), null);
  assert.deepEqual(LLM.parseJev({ answers: { move: { choice: 'other', confidence: 0.5 } } }, 3), { key: 'other', index: -1, confidence: 0.5 });
  assert.equal(LLM.parseJev({}, 3), null);
});

test('大模型：候选来自大师的推演，只取结果相近的几步，且都合法', () => {
  for (const mode of ['classic', 'duo', 'trigon', 'cube', 'prism']) {
    const st = position(mode);
    const res = expert(st);
    const cands = LLM.candidatesFrom(st, res);
    assert.ok(cands.length >= 2 && cands.length <= LLM.MAX_CANDIDATES, mode);
    assert.deepEqual(cands[0].move, res[0].move, mode + ' 第一个就是大师的选择');
    for (const c of cands) {
      assert.ok(c.value >= res[0].value - LLM.MARGIN - 1e-9, mode + ' 推演结果相近');
      const m = c.move;
      assert.equal(Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y, m.z), null, mode);
      assert.ok(Number.isFinite(c.mine) && Number.isFinite(c.opp), mode);
      for (const b of c.blocks) assert.ok(b.player !== st.current && b.n > 0, mode);
    }
    const msgs = LLM.buildMessages(st, cands);
    assert.equal(msgs[0].role, 'system');
    // 固定说明不含局面信息，便于缓存
    assert.equal(msgs[0].content, LLM.buildMessages(position(mode, { seed: 99 }), cands)[0].content);
    const text = msgs[1].content;
    assert.ok(text.includes('#' + cands.length + ' '), mode);
    assert.ok(text.includes('【你】'), mode);
    assert.ok(text.length < 5000, mode + ' 提示词不要太长：' + text.length);
    const req = LLM.buildJevRequest(st, cands, 'jev-latest');
    assert.equal(req.model, 'jev-latest');
    assert.equal(req.questions.move.type, 'choice');
    assert.deepEqual(Object.keys(req.questions.move.criteria), cands.map((c, k) => 'm' + (k + 1)));
    assert.ok(typeof req.state === 'string' && req.state.includes('【你】'));
    if (st.topo.dims === 2) {
      const filled = Array.from(st.board).filter((v) => v >= 0).length;
      assert.equal((LLM.boardText(st).match(/[BYRGVO]/g) || []).length, filled, mode);
    }
  }
});

test('大模型：调用 OpenAI 兼容接口选出候选里的一步', async () => {
  const st = position('classic', { need: 3 });
  const res = expert(st);
  const list = LLM.candidatesFrom(st, res);
  const f = fakeFetch('好的。{"choice": 3, "reason": "压住领先的黄方"}');
  const r = await LLM.decide(st, SETTINGS, { fetch: f }, res);
  assert.deepEqual(r.move, list[2].move);
  assert.equal(r.reason, '压住领先的黄方');
  assert.equal(r.asked, true);
  assert.equal(r.options, list.length);
  assert.equal(f.calls.length, 1);
  const call = f.calls[0];
  assert.equal(call.url, 'https://llm.example.com/v1/chat/completions');
  assert.equal(call.init.headers.Authorization, 'Bearer sk-test');
  assert.equal(call.body.model, 'demo-model');
  assert.equal(call.body.thinking, undefined, '不认识的接口不加额外参数');
  // 局面没有被改动
  assert.deepEqual(cands(st).map((c) => c.move), list.map((c) => c.move));
  // 不传推演结果时当场算
  const f1 = fakeFetch('{"choice": 1}');
  const r1 = await LLM.decide(st, SETTINGS, { fetch: f1 });
  assert.equal(Engine.checkPlacement(st, st.current, r1.move.piece, r1.move.orient, r1.move.x, r1.move.y, r1.move.z), null);
  // 没填密钥（本地模型）时不带 Authorization
  const f2 = fakeFetch('{"choice": 1}');
  await LLM.decide(st, { provider: 'openai', openai: { baseUrl: 'http://localhost:11434/v1', model: 'qwen3' } }, { fetch: f2 }, res);
  assert.equal(f2.calls[0].init.headers.Authorization, undefined);
});

test('大模型：DeepSeek 自动关闭深度思考，被拒绝时去掉参数重试', async () => {
  const st = position('trigon');
  const res = expert(st);
  const ds = { provider: 'openai', openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'deepseek-v4-flash' } };
  const f = fakeFetch('{"choice": 1, "reason": "ok"}');
  await LLM.decide(st, ds, { fetch: f }, res);
  assert.deepEqual(f.calls[0].body.thinking, { type: 'disabled' });
  assert.equal(f.calls[0].body.max_tokens, 200);
  // 关掉选项后不带
  const f2 = fakeFetch('{"choice": 1}');
  await LLM.decide(st, Object.assign({}, ds, { noThink: false }), { fetch: f2 }, res);
  assert.equal(f2.calls[0].body.thinking, undefined);
  // 接口不认这个参数（400）：去掉后重试，之后不再带
  const ds2 = { provider: 'openai', openai: { baseUrl: 'https://api.deepseek.com/v1', apiKey: 'k', model: 'old-model' } };
  const f3 = fakeFetch((url, init) => {
    const body = JSON.parse(init.body);
    return body.thinking ? json(400, { error: { message: 'unknown field thinking' } }) : json(200, { choices: [{ message: { content: '{"choice": 2}' } }] });
  });
  const r = await LLM.decide(st, ds2, { fetch: f3 }, res);
  assert.equal(r.index, 1);
  assert.equal(f3.calls.length, 2);
  await LLM.decide(st, ds2, { fetch: f3 }, res);
  assert.equal(f3.calls.length, 3);
  assert.equal(f3.calls[2].body.thinking, undefined);
  // 测试连接能看出模型开着深度思考
  const f4 = fakeFetch(() => json(200, { choices: [{ message: { content: 'OK', reasoning_content: '让我想想……' } }] }));
  const p = await LLM.ping(Object.assign({}, ds, { noThink: false }), { fetch: f4 });
  assert.equal(p.thinking, true);
  assert.equal(p.text, 'OK');
});

test('大模型：Jev 用选择题挑一步', async () => {
  const st = position('cube', { need: 3 });
  const res = expert(st);
  const list = LLM.candidatesFrom(st, res);
  const f = fakeFetch(() => json(200, {
    model: 'jev-1.14.0',
    answers: { move: { type: 'choice', choice: 'm3', probabilities: { m1: 0.1, m2: 0.15, m3: 0.75 }, confidence: 0.75 } }
  }));
  const r = await LLM.decide(st, JEV, { fetch: f }, res);
  assert.deepEqual(r.move, list[2].move);
  assert.match(r.reason, /第 3 步/);
  assert.match(r.reason, /把握 75%/);
  const call = f.calls[0];
  assert.equal(call.url, 'https://api.typesafe.ai/v1/systemone');
  assert.equal(call.init.headers.Authorization, 'Bearer ts-test');
  assert.equal(call.body.model, 'jev-latest');
  assert.equal(call.body.questions.move.type, 'choice');
  assert.equal(Object.keys(call.body.questions.move.criteria).length, list.length);
  // 回答不在候选里
  await assert.rejects(LLM.decide(st, JEV, { fetch: fakeFetch(() => json(200, { answers: { move: { choice: 'm9' } } })) }, res), (e) => e.code === 'bad_reply');
  await assert.rejects(LLM.decide(st, JEV, { fetch: fakeFetch(() => json(401, { error: { message: 'invalid key' } })) }, res), (e) => /401/.test(e.message));
  // 测试连接
  const pf = fakeFetch(() => json(200, { answers: { ping: { choice: 'ok', confidence: 0.98 } } }));
  const p = await LLM.ping(JEV, { fetch: pf });
  assert.match(p.text, /ok/);
  assert.equal(pf.calls[0].body.questions.ping.type, 'choice');
  // 直连失败时走服务器转发
  const viaProxy = fakeFetch((url, init) => {
    if (url !== '/api/llm') throw new TypeError('Failed to fetch');
    const body = JSON.parse(init.body);
    assert.equal(body.url, 'https://api.typesafe.ai/v1/systemone');
    assert.equal(body.key, 'ts-test');
    return json(200, { answers: { move: { choice: 'm1' } } });
  });
  assert.equal((await LLM.decide(st, JEV, { fetch: viaProxy, proxy: '/api/llm' }, res)).index, 0);
  // 经 OpenRouter 调用
  const orf = fakeFetch(() => json(200, { answers: { move: { type: 'choice', choice: 'm2', confidence: 0.6 } }, usage: { cost: 0.00001 } }));
  const ors = { provider: 'jev', jev: { baseUrl: LLM.JEV_OPENROUTER_URL, apiKey: 'sk-or-test', model: LLM.JEV_OPENROUTER_MODEL } };
  const orr = await LLM.decide(st, ors, { fetch: orf }, res);
  assert.equal(orr.index, 1);
  assert.equal(orf.calls[0].url, 'https://openrouter.ai/api/alpha/decisions');
  assert.equal(orf.calls[0].body.model, '~typesafe/jev-latest');
  assert.equal(orf.calls[0].init.headers.Authorization, 'Bearer sk-or-test');
});

test('大模型：出错时给出可读的原因', async () => {
  const st = position('trigon');
  const res = expert(st);
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch('我觉得都不错') }, res), (e) => e.code === 'bad_reply');
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch({ error: { message: 'Incorrect API key' } }, 401) }, res),
    (e) => e.code === 'http' && /401/.test(e.message) && /密钥/.test(e.message) && /Incorrect API key/.test(e.message));
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: fakeFetch({ choices: [] }) }, res), (e) => e.code === 'empty');
  await assert.rejects(LLM.decide(st, { provider: 'openai' }, { fetch: fakeFetch('1') }, res), (e) => e.code === 'setup');
  const cors = fakeFetch(() => { throw new TypeError('Failed to fetch'); });
  await assert.rejects(LLM.decide(st, SETTINGS, { fetch: cors }, res), (e) => e.code === 'network' && /跨域/.test(e.message));
  // 取消
  const ctl = new AbortController();
  const hang = fakeFetch((url, init) => new Promise((resolve, reject) => {
    init.signal.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
  }));
  const p = LLM.decide(st, SETTINGS, { fetch: hang, signal: ctl.signal }, res);
  setTimeout(() => ctl.abort(), 10);
  await assert.rejects(p, (e) => e.code === 'cancelled');
});

test('大模型：Claude 页面自带的 Claude', async () => {
  const st = position('prism', { need: 3 });
  const res = expert(st);
  const seen = [];
  const sample = async (prompt, opts) => {
    seen.push({ prompt, opts });
    return { text: '{"choice": 2, "reason": "留角点"}', truncated: false };
  };
  const r = await LLM.decide(st, { provider: 'claude', tier: 'default' }, { sample }, res);
  assert.equal(r.index, 1);
  assert.equal(seen[0].opts.modelTier, 'default');
  assert.equal(seen[0].opts.cache, false);
  assert.ok(seen[0].prompt.includes('【候选】'));
  await assert.rejects(LLM.decide(st, { provider: 'claude' }, {}, res), (e) => e.code === 'unavailable');
  const denied = async () => { throw { code: 'not_granted', message: 'no' }; };
  await assert.rejects(LLM.decide(st, { provider: 'claude' }, { sample: denied }, res), (e) => e.code === 'not_granted' && /允许/.test(e.message));
});

test('大模型：只有一步明显最好时不调用模型', async () => {
  const st = position('classic', { exact: 1 });
  const res = expert(st);
  const f = fakeFetch('{"choice": 1}');
  const r = await LLM.decide(st, SETTINGS, { fetch: f }, res);
  assert.equal(r.asked, false);
  assert.deepEqual(r.move, res[0].move);
  assert.equal(f.calls.length, 0);
});

test('电脑：重构估值后困难电脑的选择不变', () => {
  // 固定随机数时，同一局面下 rankMoves 的第一名就是困难电脑会走的那步
  for (const mode of ['classic', 'trigon', 'prism']) {
    const st = position(mode, { plies: 10 });
    const hard = AI.chooseMove(st, 'hard', { rng: () => 0 });
    const top = AI.rankMoves(st, 1)[0].move;
    assert.deepEqual(top, hard, mode);
  }
});

test('大模型：多个模型配置', () => {
  const legacy = LLM.normalizeConfig({ baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat', apiKey: 'k' });
  assert.equal(legacy.profiles.length, 1);
  assert.equal(legacy.profiles[0].name, '默认');
  assert.equal(legacy.profiles[0].openai.model, 'deepseek-chat');
  const cfg = LLM.normalizeConfig({ profiles: [
    { name: 'DeepSeek', provider: 'openai', openai: { baseUrl: 'https://api.deepseek.com/v1', model: 'deepseek-chat' } },
    { name: 'DeepSeek', provider: 'jev' },
    { name: '  \u0007Jev 很长很长很长很长很长很长的名字  ', provider: 'jev' },
    { provider: 'claude' }
  ] });
  assert.deepEqual(cfg.profiles.map((p) => p.name), ['DeepSeek', 'DeepSeek 2', 'Jev 很长很长很长很长很长很长', '模型 4']);
  assert.equal(cfg.profiles[1].provider, 'jev');
  assert.equal(LLM.findProfile(cfg, 'DeepSeek 2').provider, 'jev');
  assert.equal(LLM.findProfile(cfg, '不存在').name, 'DeepSeek');
  assert.equal(LLM.normalizeConfig(null).profiles.length, 1);
  assert.equal(LLM.normalizeConfig({ profiles: new Array(20).fill({}) }).profiles.length, 12);
});

test('电脑：大师搜索可以分步执行，结果与一次算完相同', () => {
  for (const mode of ['classic', 'prism']) {
    const st = position(mode, { plies: 8 });
    const before = Array.from(st.board);
    const a = new AI.ExpertSearch(st, { rng: seeded(3) });
    let steps = 0;
    while (!a.done()) { a.step(); steps++; }
    const b = new AI.ExpertSearch(st, { rng: seeded(3) }).run();
    assert.deepEqual(a.results().map((r) => r.move), b.map((r) => r.move), mode);
    assert.ok(steps >= 2, mode);
    for (let i = 1; i < b.length; i++) assert.ok(b[i - 1].value >= b[i].value, mode);
    assert.deepEqual(Array.from(st.board), before, mode + ' 推演后局面复原');
    const m = AI.chooseMove(st, 'expert', { rng: seeded(4) });
    assert.equal(Engine.checkPlacement(st, st.current, m.piece, m.orient, m.x, m.y, m.z), null, mode);
  }
});
