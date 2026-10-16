/*
 * 大模型电脑：程序先用困难电脑的估值挑出十几步合法的好棋，连同局面一起交给大模型，
 * 由它选一步并给出一句理由。模型可以是任何 OpenAI 兼容接口（地址、密钥、模型由玩家填写），
 * 在 Claude 发布的页面里也可以用页面自带的 Claude。
 * 出错、超时或回答无法解析时 decide() 会失败，由调用方改用内置电脑。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory(require('./engine.js'), require('./ai.js'));
  else root.BlokusLLM = factory(root.BlokusEngine, root.BlokusAI);
})(typeof self !== 'undefined' ? self : this, function (Engine, AI) {
  'use strict';

  var PROVIDERS = ['openai', 'claude'];
  var TIERS = ['quick', 'default', 'complex'];
  var DEFAULTS = { provider: 'openai', baseUrl: '', apiKey: '', model: '', tier: 'quick', timeout: 60 };
  var CANDIDATES = 12;
  var LETTER = { blue: 'B', yellow: 'Y', red: 'R', green: 'G', violet: 'V', orange: 'O' };

  function str(v, max) { return typeof v === 'string' ? v.trim().slice(0, max) : ''; }

  function normalizeSettings(raw) {
    var s = {};
    for (var k in DEFAULTS) s[k] = DEFAULTS[k];
    if (!raw || typeof raw !== 'object') return s;
    if (PROVIDERS.indexOf(raw.provider) >= 0) s.provider = raw.provider;
    s.baseUrl = str(raw.baseUrl, 300);
    s.apiKey = str(raw.apiKey, 500);
    s.model = str(raw.model, 120);
    if (TIERS.indexOf(raw.tier) >= 0) s.tier = raw.tier;
    var t = Math.round(Number(raw.timeout));
    if (isFinite(t)) s.timeout = Math.max(10, Math.min(300, t));
    return s;
  }

  // OpenAI 兼容接口需要地址和模型名；密钥可以为空（本地的 Ollama 等）
  function isReady(s) {
    if (!s) return false;
    if (s.provider === 'claude') return true;
    return /^https?:\/\/[^\s]+$/i.test(s.baseUrl) && !!s.model;
  }

  // 地址填到 /v1 即可，也接受完整的 …/chat/completions
  function endpointOf(baseUrl) {
    var u = String(baseUrl || '').trim().replace(/\/+$/, '');
    return /\/chat\/completions$/i.test(u) ? u : u + '/chat/completions';
  }

  function llmError(code, message) {
    var e = new Error(message);
    e.code = code;
    return e;
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
      var lead2 = '      ';
      lines = lines.concat(header(topo.cols, 2, lead2));
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
    var lead3 = '      ';
    lines = lines.concat(header(W, 3, lead3));
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
        '棋子从上方竖直落下，停在地面或任何人的棋子上。自己的棋子之间不能面贴面，新棋子必须和自己已有的棋子共享一条棱或一个顶点；' +
        '可以叠在别人的棋子上。第一块必须压住自己在地面上的起始角。';
    }
    return (topo.kind === 'tri' ? '六边形棋盘由三角形格子组成（相邻两格朝向相反）' : '方格棋盘') + '。' +
      '第一块必须盖住起点；之后每块都必须和自己已有的棋子角对角相接，且不能和自己的棋子边贴边；和别人的棋子边贴边没关系。';
  }

  function cellText(state, c) {
    return state.topo.dims === 3 ? '(' + c[0] + ',' + c[2] + ',' + (c[1] + 1) + '层)' : '(' + c[0] + ',' + c[1] + ')';
  }

  function playersText(state, me) {
    var topo = state.topo;
    return state.players.map(function (pl, p) {
      var left = pl.remaining.filter(Boolean).length;
      var line = pl.label + '方（' + letterOf(state, p) + '）' + (p === me ? '【你】' : '') + '：剩 ' + left + ' 块共 ' + pl.remainingSquares + ' 格';
      if (pl.done) return line + '，已无处可放';
      var forb = Engine.forbiddenMask(state.board, topo, p);
      var anchors = Engine.anchorMask(state.board, topo, p, pl, forb).list.length;
      return line + '，可落子角点 ' + anchors + ' 个';
    }).join('\n');
  }

  function candidatesText(state, cands) {
    return cands.map(function (c, k) {
      var m = c.move;
      var piece = state.set.pieces[m.piece];
      var cells = Engine.placementCells(state, m.piece, m.orient, m.x, m.y, m.z);
      return '#' + (k + 1) + ' 「' + piece.name + '」' + c.size + ' 格：' + cells.map(function (cc) { return cellText(state, cc); }).join(' ') +
        '｜己方角点 ' + (c.anchors >= 0 ? '+' : '') + c.anchors + '，压住对手角点 ' + c.blocked +
        '｜落子后你有 ' + c.myMoves + ' 种走法，对手合计 ' + c.oppMoves + ' 种';
    }).join('\n');
  }

  function buildMessages(state, cands) {
    var me = state.current;
    var pl = state.players[me];
    var placed = state.actions.filter(function (a) { return a.type === 'place'; }).length;
    var legend = state.topo.dims === 3
      ? '俯视图：每列显示最上面那格的颜色字母和它在第几层（如 B2），. 为空列；坐标写作 (x,z,第几层)'
      : '字母为各方棋子，. 为空格' + (state.topo.kind === 'tri' ? '，空白处不在棋盘内' : '') + '；坐标写作 (x,y)';
    var system = '你是角斗士棋（Blokus）高手，正在替' + pl.label + '方挑选下一步。下面的候选走法都已经确认合法，只能从中选一个。' +
      '只回复一行 JSON，不要输出别的内容。';
    var user = [
      '【规则】' + rulesText(state),
      '【计分】终局时每个没放上棋盘的格子扣 1 分，全部放完加 15 分。好棋通常：先放大块；朝空旷处和中心扩张；给自己留下更多可落子的角点；占掉或堵住对手的角点；别把自己困死。',
      '【局面】第 ' + (placed + 1) + ' 手，轮到' + pl.label + '方（字母 ' + letterOf(state, me) + '）。',
      playersText(state, me),
      '【棋盘】' + legend,
      boardText(state),
      '【候选走法】按内置估值从高到低排列，仅供参考：',
      candidatesText(state, cands),
      '请回复：{"choice": 编号, "reason": "不超过 30 字的中文理由"}'
    ].join('\n');
    return [{ role: 'system', content: system }, { role: 'user', content: user }];
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

  function contentOf(data) {
    var ch = data && data.choices && data.choices[0];
    var c = ch && (ch.message ? ch.message.content : ch.text);
    if (Array.isArray(c)) {
      c = c.map(function (part) { return typeof part === 'string' ? part : part && (part.text || ''); }).join('');
    }
    return typeof c === 'string' ? c : '';
  }

  function httpError(status, data, text) {
    var msg = data && data.error && (data.error.message || (typeof data.error === 'string' && data.error));
    if (!msg) msg = String(text || '').replace(/\s+/g, ' ').slice(0, 120);
    var hint = status === 401 || status === 403 ? '密钥不对或没有权限' : status === 404 ? '地址或模型名不对' : status === 429 ? '请求太频繁或额度用完' : '';
    return llmError('http', '接口返回 ' + status + (hint ? '（' + hint + '）' : '') + (msg ? '：' + msg : ''));
  }

  function postJson(f, url, headers, body, signal) {
    return f(url, { method: 'POST', headers: headers, body: JSON.stringify(body), signal: signal }).then(function (res) {
      return res.text().then(function (text) {
        var data = null;
        try { data = JSON.parse(text); } catch (e) { data = null; }
        if (!res.ok) throw httpError(res.status, data, text);
        var content = contentOf(data);
        if (!content) throw llmError('empty', '接口没有返回内容');
        return content;
      });
    });
  }

  function askOpenAI(settings, messages, env, signal) {
    var f = env.fetch || (typeof fetch === 'function' ? fetch.bind(null) : null);
    if (!f) return Promise.reject(llmError('network', '当前环境不能发网络请求'));
    var url = endpointOf(settings.baseUrl);
    var body = { model: settings.model, messages: messages, stream: false };
    var headers = { 'Content-Type': 'application/json' };
    if (settings.apiKey) headers.Authorization = 'Bearer ' + settings.apiKey;
    function viaProxy() {
      return postJson(f, env.proxy, { 'Content-Type': 'application/json' }, { url: url, key: settings.apiKey, body: body }, signal);
    }
    return postJson(f, url, headers, body, signal).catch(function (err) {
      if (err && err.code) throw err;
      if (signal.aborted) throw err;
      // 浏览器直连失败（多半是接口不允许跨域访问）：联机服务器开了转发就改走服务器
      if (env.proxy) return viaProxy();
      throw llmError('network', '连不上接口：地址不对，或者这个接口不允许网页直接访问（跨域）。' +
        '可以改用支持跨域的接口，或用 LLM_PROXY=1 node server.js 启动服务器转发');
    });
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
      return r && r.text ? r.text : '';
    }, function (e) {
      var code = e && e.code;
      if (code === 'cancelled') throw llmError('cancelled', '已取消');
      throw llmError(code || 'claude', SAMPLE_ERRORS[code] || ('调用 Claude 失败' + (code ? '（' + code + '）' : '')));
    });
  }

  /**
   * 发一轮对话，返回模型的回答文字。
   * env：{ signal, fetch, proxy: 服务器转发地址, sample: Claude 页面的 sample 函数 }
   */
  function ask(settings, messages, env) {
    env = env || {};
    settings = normalizeSettings(settings);
    if (!isReady(settings)) return Promise.reject(llmError('setup', '还没有填写大模型的接口地址和模型'));
    var link = linkedSignal(env.signal, settings.timeout * 1000);
    var p = settings.provider === 'claude'
      ? askClaude(settings, messages, env, link.signal)
      : askOpenAI(settings, messages, env, link.signal);
    return p.then(function (text) {
      link.done();
      return text;
    }, function (err) {
      link.done();
      if (link.timedOut()) throw llmError('timeout', '大模型超过 ' + settings.timeout + ' 秒没有回答');
      if (env.signal && env.signal.aborted) throw llmError('cancelled', '已取消');
      throw err && err.code ? err : llmError('network', (err && err.message) || '请求失败');
    });
  }

  /**
   * 为当前玩家选一步。成功时返回 { move, reason, index, asked }；没有合法落子时 move 为 null。
   * 只有一步可走时不问模型（asked 为 false）。
   */
  function decide(state, settings, env) {
    var cands = AI.rankMoves(state, CANDIDATES);
    if (!cands.length) return Promise.resolve({ move: null, reason: '', index: -1, asked: false });
    if (cands.length === 1) return Promise.resolve({ move: cands[0].move, reason: '只剩这一步可走', index: 0, asked: false });
    var messages = buildMessages(state, cands);
    return ask(settings, messages, env).then(function (text) {
      var r = parseReply(text, cands.length);
      if (!r) throw llmError('bad_reply', '大模型的回答里没有有效的候选编号');
      return { move: cands[r.index].move, reason: r.reason, index: r.index, asked: true };
    });
  }

  // 测试连接：返回 { text, ms }
  function ping(settings, env) {
    var t0 = Date.now();
    return ask(settings, [{ role: 'user', content: '这是连接测试，请只回复：OK' }], env).then(function (text) {
      return { text: cleanReason(text.replace(/<think>[\s\S]*?<\/think>/gi, '')), ms: Date.now() - t0 };
    });
  }

  return {
    PROVIDERS: PROVIDERS,
    TIERS: TIERS,
    DEFAULTS: DEFAULTS,
    normalizeSettings: normalizeSettings,
    isReady: isReady,
    endpointOf: endpointOf,
    boardText: boardText,
    buildMessages: buildMessages,
    parseReply: parseReply,
    ask: ask,
    decide: decide,
    ping: ping
  };
});
