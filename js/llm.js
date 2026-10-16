/*
 * 大模型电脑。棋力来自程序的搜索：大师电脑（AI.ExpertSearch）先把候选走法各推演几轮，
 * 只把推演结果差不多一样好的几步交给模型，由它做战略取舍；只有一步明显最好时直接走，不问模型。
 *   openai —— 任何 OpenAI 兼容的 Chat Completions 接口，回答一个编号和一句理由
 *   jev    —— TypeSafe 的 Jev（System One 决策模型），用一道选择题直接返回选项和把握
 *   claude —— Claude 发布的页面自带的 Claude
 * 候选都在大师认可的范围内，所以模型怎么选都接近大师的水平。
 * 每个座位可以用不同的模型配置（profiles），配置只保存在本机。
 * 出错、超时或回答无法解析时 decide() 会失败，由调用方改用内置电脑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./ai.js'));
  else root.BlokusLLM = factory(root.BlokusEngine, root.BlokusAI);
})(typeof self !== 'undefined' ? self : this, function (Engine, AI) {
  'use strict';

  var PROVIDERS = ['openai', 'jev', 'claude'];
  var TIERS = ['quick', 'default', 'complex'];
  var JEV_URL = 'https://api.typesafe.ai/v1';
  var JEV_MODEL = 'jev-latest';
  // 也可以经 OpenRouter 调用 Jev（它的 Decisions 接口，请求和回答格式相同）
  var JEV_OPENROUTER_URL = 'https://openrouter.ai/api/v1';
  var JEV_OPENROUTER_MODEL = '~typesafe/jev-latest';
  // 候选：与最佳一步的推演结果差不超过 MARGIN，最多 MAX_CANDIDATES 个（自对弈里总选最差的一步也接近大师）
  var MARGIN = 0.6;
  var MAX_CANDIDATES = 4;
  var LETTER = { blue: 'B', yellow: 'Y', red: 'R', green: 'G', violet: 'V', orange: 'O' };

  function defaults() {
    return {
      provider: 'openai',
      openai: { baseUrl: '', apiKey: '', model: '' },
      jev: { baseUrl: JEV_URL, apiKey: '', model: JEV_MODEL },
      tier: 'quick',
      timeout: 30,
      noThink: true
    };
  }

  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

  function endpointOf(raw, d) {
    raw = raw && typeof raw === 'object' ? raw : {};
    return { baseUrl: str(raw.baseUrl, 300) || d.baseUrl, apiKey: str(raw.apiKey, 500), model: str(raw.model, 120) || d.model };
  }

  function normalizeSettings(raw) {
    var s = defaults();
    if (!raw || typeof raw !== 'object') return s;
    if (PROVIDERS.indexOf(raw.provider) >= 0) s.provider = raw.provider;
    // 旧版设置把 OpenAI 兼容接口的地址、密钥、模型放在最外层
    s.openai = endpointOf(raw.openai || { baseUrl: raw.baseUrl, apiKey: raw.apiKey, model: raw.model }, s.openai);
    s.jev = endpointOf(raw.jev, s.jev);
    if (TIERS.indexOf(raw.tier) >= 0) s.tier = raw.tier;
    var t = Math.round(Number(raw.timeout));
    if (isFinite(t) && raw.timeout !== null && raw.timeout !== '') s.timeout = Math.max(5, Math.min(300, t));
    if (typeof raw.noThink === 'boolean') s.noThink = raw.noThink;
    return s;
  }

  function profileName(s) {
    return String(s == null ? '' : s).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 16);
  }

  /**
   * 全部模型配置：{ profiles: [settings + name] }，名字不重复；至少有一个。
   * 也接受旧版的单个设置。
   */
  function normalizeConfig(raw) {
    var list = raw && Array.isArray(raw.profiles) ? raw.profiles.slice(0, 12) : raw && typeof raw === 'object' ? [raw] : [];
    var out = [], used = {};
    list.forEach(function (p, i) {
      var s = normalizeSettings(p);
      var name = profileName(p && p.name) || (i === 0 ? '默认' : '模型 ' + (i + 1));
      var base = name, k = 2;
      while (used[name]) name = (base.slice(0, 13) + ' ' + k++);
      used[name] = 1;
      s.name = name;
      out.push(s);
    });
    if (!out.length) {
      var d = normalizeSettings(null);
      d.name = '默认';
      out.push(d);
    }
    return { profiles: out };
  }

  // 按名字找配置，找不到用第一个
  function findProfile(cfg, name) {
    for (var i = 0; i < cfg.profiles.length; i++) if (cfg.profiles[i].name === name) return cfg.profiles[i];
    return cfg.profiles[0];
  }

  function validUrl(u) { return /^https?:\/\/[^\s]+$/i.test(u || ''); }

  // 接口地址和模型都填了才算设置好；密钥可以为空（本地模型）
  function isReady(s) {
    if (!s) return false;
    if (s.provider === 'claude') return true;
    var ep = s[s.provider];
    return !!ep && validUrl(ep.baseUrl) && !!ep.model;
  }

  function trimUrl(u) { return String(u || '').trim().replace(/\/+$/, ''); }

  // 地址填到 /v1 即可，也接受完整的 …/chat/completions、…/systemone
  function chatUrl(baseUrl) {
    var u = trimUrl(baseUrl);
    return /\/chat\/completions$/i.test(u) ? u : u + '/chat/completions';
  }

  // TypeSafe 官方：…/v1/systemone；OpenRouter：/api/alpha/decisions；完整地址原样使用
  function jevUrl(baseUrl) {
    var u = trimUrl(baseUrl);
    if (/\/(systemone|decisions)$/i.test(u)) return u;
    var m = /^(https?:\/\/(?:[^\/]+\.)?openrouter\.ai)(\/|$)/i.exec(u);
    if (m) return m[1] + '/api/alpha/decisions';
    return u + '/systemone';
  }

  function hostOf(u) {
    var m = /^https?:\/\/([^\/:?#]+)/i.exec(String(u || '').trim());
    return m ? m[1].toLowerCase() : '';
  }

  // 已知会默认“深度思考”的接口：关掉思考能从几十秒降到几秒
  function noThinkParams(baseUrl) {
    var h = hostOf(baseUrl);
    if (/(^|\.)deepseek\.com$/.test(h) || /(^|\.)bigmodel\.cn$/.test(h) || /(^|\.)z\.ai$/.test(h)) {
      return { thinking: { type: 'disabled' }, max_tokens: 200 };
    }
    if (/(^|\.)dashscope(-intl)?\.aliyuncs\.com$/.test(h)) return { enable_thinking: false, max_tokens: 200 };
    return null;
  }

  function llmError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
  }

  /* ================= 候选走法 ================= */

  function countMoves(state, p) {
    var n = 0;
    Engine.forEachMove(state, p, function () { n++; });
    return n;
  }

  /**
   * 从大师的推演结果（按 value 从高到低）里取几步差不多一样好的，附带给模型看的特征：
   * mine / opp：落子后自己 / 对手合计可走步数相对现在的变化（百分比）；
   * blocks：[{ player, n }] 压住各家对手的可落子角点数。
   */
  function candidatesFrom(state, results) {
    if (!results || !results.length) return [];
    var best = results[0].value;
    var list = results.filter(function (c) { return c.value >= best - MARGIN; }).slice(0, MAX_CANDIDATES);
    if (list.length < 2) return list;
    var me = state.current, topo = state.topo;
    var myBefore = countMoves(state, me), oppBefore = 0;
    var opps = [];
    state.players.forEach(function (pl, o) {
      if (o === me || pl.done) return;
      oppBefore += countMoves(state, o);
      var forb = Engine.forbiddenMask(state.board, topo, o);
      opps.push({ player: o, mark: Engine.anchorMask(state.board, topo, o, pl, forb).mark });
    });
    function pct(after, before) { return Math.round((after - before) / Math.max(1, before) * 100); }
    return list.map(function (r) {
      var c = {};
      for (var k in r) c[k] = r[k];
      var m = c.move;
      var idx = Engine.placementIndices(state, m.piece, m.orient, m.x, m.y, m.z);
      c.mine = pct(c.myMoves, myBefore);
      c.opp = pct(c.oppMoves, oppBefore);
      c.blocks = [];
      opps.forEach(function (o) {
        var n = 0;
        for (var j = 0; j < idx.length; j++) if (o.mark[idx[j]]) n++;
        if (n) c.blocks.push({ player: o.player, n: n });
      });
      return c;
    });
  }

  // 没有现成的推演结果时当场算（会占用几十到几百毫秒）
  function candidates(state, results) {
    return candidatesFrom(state, results || new AI.ExpertSearch(state).run());
  }

  /* ================= 提示词 ================= */

  function letterOf(state, p) {
    return LETTER[state.players[p].color] || String.fromCharCode(65 + p);
  }

  function pad(s, n) {
    s = String(s);
    while (s.length < n) s = ' ' + s;
    return s;
  }

  function header(cols, w, lead) {
    var tens = '', ones = '';
    for (var x = 0; x < cols; x++) {
      var cellT = x >= 10 ? String(Math.floor(x / 10) % 10) : ' ';
      var cellO = String(x % 10);
      while (cellT.length < w) cellT += ' ';
      while (cellO.length < w) cellO += ' ';
      tens += cellT;
      ones += cellO;
    }
    var out = [];
    if (cols > 10) out.push(lead + tens.replace(/\s+$/, ''));
    out.push(lead + ones.replace(/\s+$/, ''));
    return out;
  }

  // 平面棋盘逐行画出；立体棋盘画俯视图：每一列最上面那格的颜色和它在第几层
  function boardText(state) {
    var topo = state.topo, board = state.board;
    var lines = [];
    var x, y, z, i;
    if (topo.dims === 2) {
      lines = lines.concat(header(topo.cols, 2, '      '));
      for (y = 0; y < topo.rows; y++) {
        var row = '';
        for (x = 0; x < topo.cols; x++) {
          i = y * topo.cols + x;
          row += (!topo.valid[i] ? ' ' : board[i] >= 0 ? letterOf(state, board[i]) : '.') + ' ';
        }
        lines.push('y=' + pad(y, 2) + '  ' + row.replace(/\s+$/, ''));
      }
      return lines.join('\n');
    }
    var W = topo.cols, D = topo.depth, H = topo.height;
    lines = lines.concat(header(W, 3, '      '));
    for (z = 0; z < D; z++) {
      var r = '';
      for (x = 0; x < W; x++) {
        if (!topo.colValid[z * W + x]) { r += '   '; continue; }
        var tok = '.  ';
        for (y = H - 1; y >= 0; y--) {
          i = x + W * (z + D * y);
          if (board[i] >= 0) { tok = letterOf(state, board[i]) + (y + 1) + ' '; break; }
        }
        r += tok;
      }
      lines.push('z=' + pad(z, 2) + '  ' + r.replace(/\s+$/, ''));
    }
    return lines.join('\n');
  }

  function rulesText(state) {
    var topo = state.topo;
    if (topo.dims === 3) {
      return '三维棋盘（' + (topo.kind === 'prism' ? '地面由三角形组成，每格是一根三棱柱' : '每格是一个立方体') + '，最高 ' + topo.height + ' 层）。' +
        '棋子从上方落下，停在地面或任何人的棋子上。自己的棋子不能面贴面，新棋子必须和自己的棋子共享棱或顶点；可以叠在别人的棋子上。';
    }
    return (topo.kind === 'tri' ? '六边形三角格棋盘' : '方格棋盘') + '。每块新棋子必须和自己的棋子角对角相接，不能和自己的棋子边贴边；和别人的棋子贴边没关系。';
  }

  function cellText(state, c) {
    return state.topo.dims === 3 ? '(' + c[0] + ',' + c[2] + ',' + (c[1] + 1) + '层)' : '(' + c[0] + ',' + c[1] + ')';
  }

  function signed(n) { return (n > 0 ? '+' : n < 0 ? '−' : '±') + Math.abs(n); }

  function situationText(state) {
    var me = state.current, topo = state.topo;
    var scores = state.players.map(function (pl) { return Engine.scoreOf(pl); });
    var lead = -1;
    scores.forEach(function (s, p) { if (p !== me && (lead < 0 || s > scores[lead])) lead = p; });
    var placed = state.actions.filter(function (a) { return a.type === 'place'; }).length;
    var lines = ['第 ' + (placed + 1) + ' 手，轮到' + state.players[me].label + '方（字母 ' + letterOf(state, me) + '）。'];
    state.players.forEach(function (pl, p) {
      var left = pl.remaining.filter(Boolean).length;
      var line = pl.label + '方（' + letterOf(state, p) + '）' + (p === me ? '【你】' : p === lead ? '【对手中领先】' : '') +
        '：得分 ' + scores[p] + '，剩 ' + left + ' 块 ' + pl.remainingSquares + ' 格';
      if (pl.done) line += '，已无处可放';
      else {
        var forb = Engine.forbiddenMask(state.board, topo, p);
        line += '，可落子角点 ' + Engine.anchorMask(state.board, topo, p, pl, forb).list.length + ' 个';
      }
      lines.push(line);
    });
    return lines.join('\n');
  }

  function candidateText(state, c) {
    var m = c.move;
    var piece = state.set.pieces[m.piece];
    var cells = Engine.placementCells(state, m.piece, m.orient, m.x, m.y, m.z);
    var blocks = c.blocks.length
      ? '压住' + c.blocks.map(function (b) { return state.players[b.player].label + '方 ' + b.n + ' 个'; }).join('、') + '角点'
      : '不压对手角点';
    return '「' + piece.name + '」' + c.size + ' 格 ' + cells.map(function (cc) { return cellText(state, cc); }).join(' ') +
      '｜你的走法 ' + signed(c.mine) + '%，对手走法 ' + signed(c.opp) + '%｜' + blocks;
  }

  // 固定的说明放在最前面，便于接口缓存前缀
  var SYSTEM = '你是角斗士棋（Blokus）高手，替一方挑选下一步。终局时每个没放上棋盘的格子扣 1 分。' +
    '程序已经把每个候选往后推演过，下面几步都合法而且推演结果差不多一样好，#1 略优。请结合局势取舍：压制领先的对手、' +
    '抢对手正要进入的空地、给自己留下可落子的角点、别把自己困死。没有明显理由就选 #1。' +
    '只回复一行 JSON：{"choice": 编号, "reason": "不超过 20 字的中文理由"}';

  function buildMessages(state, cands) {
    var legend = state.topo.dims === 3
      ? '俯视图，每列显示最上面那格的颜色和层数（如 B2），. 为空列'
      : '字母为各方棋子，. 为空格';
    var user = [
      '【规则】' + rulesText(state),
      '【局面】' + situationText(state),
      '【棋盘】' + legend,
      boardText(state),
      '【候选】',
      cands.map(function (c, k) { return '#' + (k + 1) + ' ' + candidateText(state, c); }).join('\n')
    ].join('\n');
    return [{ role: 'system', content: SYSTEM }, { role: 'user', content: user }];
  }

  // Jev 的选择题：局面放在 state，候选放在 criteria（键为 m1、m2…）
  function buildJevRequest(state, cands, model) {
    var me = state.players[state.current];
    var criteria = {};
    cands.forEach(function (c, k) {
      criteria['m' + (k + 1)] = (k === 0 ? '程序推演略优。' : '') + candidateText(state, c);
    });
    return {
      model: model,
      state: '角斗士棋（Blokus）。' + rulesText(state) + '终局时每个没放上棋盘的格子扣 1 分。\n' +
        situationText(state) + '\n棋盘：\n' + boardText(state),
      questions: {
        move: {
          type: 'choice',
          instructions: '你执' + me.label + '方。以下几步都合法且差不多好，选出最有利于你最终得分的一步：' +
            '压制领先的对手、抢占空地、给自己留下可落子的角点、别把自己困死。',
          criteria: criteria
        }
      }
    };
  }

  /* ================= 解析回答 ================= */

  function cleanReason(s) {
    return String(s == null ? '' : s)
      .replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 40);
  }

  // 返回 { index（从 0 开始）, reason }；读不出有效编号时返回 null
  function parseReply(text, n) {
    if (typeof text !== 'string') return null;
    var t = text.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
    var idx = null, reason = '';
    var m = t.match(/\{[\s\S]*\}/);
    if (m) {
      try {
        var o = JSON.parse(m[0]);
        var v = o.choice != null ? o.choice : o.move != null ? o.move : o.index;
        if (typeof v === 'string') v = v.replace(/^#/, '');
        if (v != null && /^\d+$/.test(String(v).trim())) idx = Number(v);
        if (typeof o.reason === 'string') reason = o.reason;
      } catch (e) { /* 不是严格的 JSON，下面再宽松地找 */ }
    }
    if (idx == null) {
      var m2 = t.match(/choice["'\s]*[:：=]\s*["'#]*(\d+)/i) || t.match(/#\s*(\d+)/) || t.match(/(?:^|[^\d.])(\d{1,2})(?![\d.])/);
      if (m2) idx = Number(m2[1]);
      var m3 = t.match(/reason["'\s]*[:：]\s*["“]([^"”]*)/i);
      if (m3) reason = m3[1];
    }
    if (!(idx >= 1 && idx <= n)) return null;
    return { index: idx - 1, reason: cleanReason(reason) };
  }

  // Jev 的回答：answers.move = { choice: 'm2', probabilities: {...}, confidence }
  function parseJev(data, n, name) {
    var answers = data && data.answers;
    if (!answers || typeof answers !== 'object') return null;
    var a = answers[name || 'move'];
    if (a == null) a = answers[Object.keys(answers)[0]];
    if (a == null) return null;
    var probs = a && typeof a === 'object' && a.probabilities && typeof a.probabilities === 'object' ? a.probabilities : null;
    var key = typeof a === 'string' ? a : a.choice != null ? a.choice : a.answer != null ? a.answer : a.value;
    if (key == null && probs) {
      Object.keys(probs).forEach(function (k) { if (key == null || probs[k] > probs[key]) key = k; });
    }
    var conf = typeof a.confidence === 'number' ? a.confidence : probs && typeof probs[key] === 'number' ? probs[key] : null;
    var m = /^m?(\d+)$/i.exec(String(key == null ? '' : key).trim());
    if (!m) return { key: key == null ? '' : String(key), index: -1, confidence: conf };
    var idx = Number(m[1]);
    if (!(idx >= 1 && idx <= n)) return null;
    return { key: String(key), index: idx - 1, confidence: conf };
  }

  /* ================= 调用模型 ================= */

  // 把外部的取消信号和超时合成一个
  function linkedSignal(signal, ms) {
    var ctl = new AbortController();
    var timedOut = false;
    var timer = setTimeout(function () { timedOut = true; ctl.abort(); }, ms);
    function onAbort() { ctl.abort(); }
    if (signal) {
      if (signal.aborted) ctl.abort();
      else signal.addEventListener('abort', onAbort);
    }
    return {
      signal: ctl.signal,
      timedOut: function () { return timedOut; },
      done: function () {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    };
  }

  function httpError(status, data, text) {
    var msg = data && data.error && (data.error.message || (typeof data.error === 'string' && data.error));
    if (!msg && data && typeof data.message === 'string') msg = data.message;
    if (!msg) msg = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    var hint = status === 401 || status === 403 ? '密钥不对或没有权限' : status === 404 ? '地址或模型名不对' : status === 429 ? '请求太频繁或额度用完' : '';
    var e = llmError('http', '接口返回 ' + status + (hint ? '（' + hint + '）' : '') + (msg ? '：' + msg : ''));
    e.status = status;
    return e;
  }

  function postJson(f, url, headers, body, signal) {
    return f(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!res.ok) throw httpError(res.status, data, text);
        if (!data) throw llmError('bad_reply', '接口返回的不是 JSON');
        return data;
      });
    });
  }

  function fetchOf(env) {
    return env.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
  }

  // 直连失败（多半是接口不允许网页跨域访问）时，联机服务器开了转发就改走服务器
  function post(env, url, key, body, signal) {
    var f = fetchOf(env);
    if (!f) return Promise.reject(llmError('network', '当前环境不能发网络请求'));
    var headers = { 'Content-Type': 'application/json' };
    if (key) headers.Authorization = 'Bearer ' + key;
    return postJson(f, url, headers, body, signal).catch(function (err) {
      if (err && err.code) throw err;
      if (signal.aborted) throw err;
      if (env.proxy) return postJson(f, env.proxy, { 'Content-Type': 'application/json' }, { url: url, key: key, body: body }, signal);
      throw llmError('network', '连不上接口：地址不对，或者这个接口不允许网页直接访问（跨域）。' +
        '可以改用支持跨域的接口，或用 LLM_PROXY=1 node server.js 启动服务器转发');
    });
  }

  function messageOf(data) {
    var ch = data && data.choices && data.choices[0];
    return ch && (ch.message || { content: ch.text }) || {};
  }

  function contentOf(msg) {
    var c = msg.content;
    if (Array.isArray(c)) {
      c = c.map(function (part) { return typeof part === 'string' ? part : part && (part.text || ''); }).join('');
    }
    return typeof c === 'string' ? c : '';
  }

  // 带上“关闭思考”参数被接口拒绝过的地址和模型，以后不再带
  var rejectedExtras = {};

  function askOpenAI(settings, messages, env, signal) {
    var ep = settings.openai;
    var url = chatUrl(ep.baseUrl);
    var cacheKey = url + '|' + ep.model;
    var extras = settings.noThink && !rejectedExtras[cacheKey] ? noThinkParams(ep.baseUrl) : null;
    function send(withExtras) {
      var body = { model: ep.model, messages: messages, stream: false };
      if (withExtras) for (var k in withExtras) body[k] = withExtras[k];
      return post(env, url, ep.apiKey, body, signal);
    }
    return send(extras).catch(function (err) {
      if (!extras || !err || err.status !== 400) throw err;
      rejectedExtras[cacheKey] = true;
      return send(null);
    }).then(function (data) {
      var msg = messageOf(data);
      var text = contentOf(msg);
      if (!text) throw llmError('empty', '接口没有返回内容');
      var thought = msg.reasoning_content || msg.reasoning || '';
      return { text: text, thinking: typeof thought === 'string' && thought.length > 0 };
    });
  }

  function askJev(settings, request, env, signal) {
    var ep = settings.jev;
    return post(env, jevUrl(ep.baseUrl), ep.apiKey, request, signal);
  }

  var SAMPLE_ERRORS = {
    not_granted: '你没有允许这个页面使用 Claude',
    sampling_disabled: '这个账号不能在页面里使用 Claude',
    rate_limited: '调用太频繁或额度已用完，请稍后再试',
    session_expired: '登录已过期，请重新登录',
    refused: 'Claude 拒绝了这次请求'
  };

  function askClaude(settings, messages, env, signal) {
    if (!env.sample) return Promise.reject(llmError('unavailable', '只有在 Claude 发布的页面里才能用页面自带的 Claude'));
    var prompt = messages.map(function (m) { return m.content; }).join('\n\n');
    return Promise.resolve(env.sample(prompt, { modelTier: settings.tier, signal: signal, cache: false })).then(function (r) {
      return { text: r && r.text ? r.text : '', thinking: false };
    }, function (e) {
      var code = e && e.code;
      if (code === 'cancelled') throw llmError('cancelled', '已取消');
      throw llmError(code || 'claude', SAMPLE_ERRORS[code] || ('调用 Claude 失败' + (code ? '（' + code + '）' : '')));
    });
  }

  // 统一处理超时与取消
  function guarded(settings, env, run) {
    env = env || {};
    if (!isReady(settings)) return Promise.reject(llmError('setup', '还没有填写大模型的接口地址和模型'));
    var link = linkedSignal(env.signal, settings.timeout * 1000);
    return run(link.signal).then(function (r) {
      link.done();
      return r;
    }, function (err) {
      link.done();
      if (link.timedOut()) throw llmError('timeout', '大模型超过 ' + settings.timeout + ' 秒没有回答');
      if (env.signal && env.signal.aborted) throw llmError('cancelled', '已取消');
      throw err && err.code ? err : llmError('network', (err && err.message) || '请求失败');
    });
  }

  /**
   * 发一轮对话（openai / claude），返回 { text, thinking }。
   * env：{ signal, fetch, proxy: 服务器转发地址, sample: Claude 页面的 sample 函数 }
   */
  function ask(settings, messages, env) {
    settings = normalizeSettings(settings);
    env = env || {};
    return guarded(settings, env, function (signal) {
      return settings.provider === 'claude'
        ? askClaude(settings, messages, env, signal)
        : askOpenAI(settings, messages, env, signal);
    });
  }

  function confidenceNote(conf) {
    return typeof conf === 'number' && isFinite(conf) ? '把握 ' + Math.round(Math.max(0, Math.min(1, conf)) * 100) + '%' : '';
  }

  /**
   * 为当前玩家选一步。成功时返回 { move, reason, index, asked, options }；没有合法落子时 move 为 null。
   * 只有一步明显最好时不问模型（asked 为 false）。results 是大师的推演结果，不传就当场算。
   */
  function decide(state, settings, env, results) {
    settings = normalizeSettings(settings);
    env = env || {};
    var cands = candidates(state, results);
    if (!cands.length) return Promise.resolve({ move: null, reason: '', index: -1, asked: false, options: 0 });
    if (cands.length === 1) return Promise.resolve({ move: cands[0].move, reason: '', index: 0, asked: false, options: 1 });
    if (settings.provider === 'jev') {
      var request = buildJevRequest(state, cands, settings.jev.model);
      return guarded(settings, env, function (signal) { return askJev(settings, request, env, signal); }).then(function (data) {
        var r = parseJev(data, cands.length);
        if (!r || r.index < 0) throw llmError('bad_reply', 'Jev 的回答里没有有效的候选' + (r && r.key ? '（' + cleanReason(r.key) + '）' : ''));
        var conf = confidenceNote(r.confidence);
        return {
          move: cands[r.index].move,
          reason: '在 ' + cands.length + ' 步好棋里选了第 ' + (r.index + 1) + ' 步' + (conf ? '，' + conf : ''),
          index: r.index,
          asked: true,
          options: cands.length
        };
      });
    }
    return ask(settings, buildMessages(state, cands), env).then(function (r) {
      var p = parseReply(r.text, cands.length);
      if (!p) throw llmError('bad_reply', '大模型的回答里没有有效的候选编号');
      return { move: cands[p.index].move, reason: p.reason, index: p.index, asked: true, options: cands.length };
    });
  }

  // 测试连接：返回 { text, ms, thinking }
  function ping(settings, env) {
    settings = normalizeSettings(settings);
    env = env || {};
    var t0 = Date.now();
    if (settings.provider === 'jev') {
      var request = {
        model: settings.jev.model,
        state: '这是一次连接测试。',
        questions: { ping: { type: 'choice', instructions: '连接是否正常？', criteria: { ok: '连接正常', other: '其他情况' } } }
      };
      return guarded(settings, env, function (signal) { return askJev(settings, request, env, signal); }).then(function (data) {
        var r = parseJev(data, 2, 'ping');
        var text = r && r.key ? r.key + (r.confidence != null ? '（' + confidenceNote(r.confidence) + '）' : '') : JSON.stringify(data).slice(0, 60);
        return { text: cleanReason(text), ms: Date.now() - t0, thinking: false };
      });
    }
    return ask(settings, [{ role: 'user', content: '这是连接测试，请只回复：OK' }], env).then(function (r) {
      return { text: cleanReason(r.text.replace(/<think>[\s\S]*?<\/think>/gi, '')), ms: Date.now() - t0, thinking: r.thinking };
    });
  }

  return {
    PROVIDERS: PROVIDERS,
    TIERS: TIERS,
    JEV_URL: JEV_URL,
    JEV_MODEL: JEV_MODEL,
    JEV_OPENROUTER_URL: JEV_OPENROUTER_URL,
    JEV_OPENROUTER_MODEL: JEV_OPENROUTER_MODEL,
    MARGIN: MARGIN,
    MAX_CANDIDATES: MAX_CANDIDATES,
    defaults: defaults,
    normalizeSettings: normalizeSettings,
    normalizeConfig: normalizeConfig,
    findProfile: findProfile,
    profileName: profileName,
    isReady: isReady,
    chatUrl: chatUrl,
    jevUrl: jevUrl,
    noThinkParams: noThinkParams,
    candidates: candidates,
    candidatesFrom: candidatesFrom,
    boardText: boardText,
    buildMessages: buildMessages,
    buildJevRequest: buildJevRequest,
    parseReply: parseReply,
    parseJev: parseJev,
    ask: ask,
    decide: decide,
    ping: ping
  };
});
