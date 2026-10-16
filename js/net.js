/*
 * 角斗士棋联机传输层（仅浏览器）。两种实现，接口相同：
 *   ServerNet   —— 连接 server.js（SSE 接收房间状态，POST 发送操作），服务器执行电脑回合
 *   ArtifactNet —— 在 Claude 发布的页面里，用页面自带的共享存储（db）保存房间、
 *                  用 room 能力感知在线玩家；电脑回合由房主的浏览器执行
 *
 * connect(code, token, handlers) 的回调：
 *   onIdentity(id) onRoom(room) onPeers(ids|null) onConnection(bool) onGone() onError(msg)
 *   onPreview(id, preview|null) —— 其他玩家正在尝试的位置（不保存，只实时转发）
 */
(function (root) {
  'use strict';

  var Online = root.BlokusOnline;

  function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }

  function netError(message, code) {
    var e = new Error(message);
    e.code = code || 'error';
    return e;
  }

  function randomToken() {
    var chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';
    var bytes = new Uint8Array(20);
    if (root.crypto && root.crypto.getRandomValues) root.crypto.getRandomValues(bytes);
    else for (var i = 0; i < bytes.length; i++) bytes[i] = Math.floor(Math.random() * 256);
    var s = '';
    for (var j = 0; j < bytes.length; j++) s += chars.charAt(bytes[j] & 63);
    return s;
  }

  function clampWait(ms) { return Math.max(0, Math.min(1200, ms)); }

  function uniq(list) {
    var out = [];
    list.forEach(function (x) { if (out.indexOf(x) < 0) out.push(x); });
    return out;
  }

  /* ================= 自建服务器 ================= */

  function ServerNet(base) {
    this.kind = 'server';
    this.serverRunsAI = true;
    this.llmProxy = false;
    this.base = base || '';
    this.es = null;
    this.code = null;
    this.token = null;
  }

  ServerNet.prototype.request = function (method, url, body) {
    return fetch(this.base + url, {
      method: method,
      headers: body ? { 'Content-Type': 'application/json' } : undefined,
      body: body ? JSON.stringify(body) : undefined,
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; }).then(function (data) {
        if (!res.ok) throw netError(data.error || '网络错误（' + res.status + '）', data.code || 'http_' + res.status);
        return data;
      });
    }, function () {
      throw netError('连不上服务器，请检查网络', 'offline');
    });
  };

  ServerNet.prototype.create = function (token, name, mode) {
    return this.request('POST', 'api/rooms', { token: token, name: name, mode: mode }).then(function (d) { return d.code; });
  };

  ServerNet.prototype.exists = function (code) {
    return this.request('GET', 'api/rooms/' + code).then(function () { return true; }, function (e) {
      if (e.code === 'no_room') return false;
      throw e;
    });
  };

  ServerNet.prototype.connect = function (code, token, h) {
    var self = this;
    this.disconnect();
    this.code = code;
    this.token = token;
    var es = new EventSource(this.base + 'api/rooms/' + code + '/stream?token=' + encodeURIComponent(token));
    this.es = es;
    es.addEventListener('hello', function (e) { h.onIdentity(JSON.parse(e.data).pid); });
    es.addEventListener('room', function (e) {
      var room = Online.normalizeRoom(JSON.parse(e.data));
      if (room) h.onRoom(room);
    });
    es.addEventListener('peers', function (e) { h.onPeers(JSON.parse(e.data)); });
    es.addEventListener('preview', function (e) {
      var d = JSON.parse(e.data);
      if (d && typeof d.pid === 'string') h.onPreview(d.pid, d.preview || null);
    });
    es.onopen = function () { h.onConnection(true); };
    es.onerror = function () {
      if (self.es !== es) return;
      h.onConnection(false);
      // 4xx 时浏览器不会自动重连：确认房间是否还在
      if (es.readyState === 2) {
        self.exists(code).then(function (ok) {
          if (self.es !== es) return;
          if (!ok) h.onGone();
          else setTimeout(function () { if (self.es === es) self.connect(code, token, h); }, 3000);
        }, function () {
          setTimeout(function () { if (self.es === es) self.connect(code, token, h); }, 3000);
        });
      }
    };
  };

  ServerNet.prototype.op = function (op) { return this.opAt(this.code, this.token, op); };

  ServerNet.prototype.opAt = function (code, token, op) {
    return this.request('POST', 'api/rooms/' + code + '/op', { token: token, op: op });
  };

  ServerNet.prototype.preview = function (preview) {
    if (!this.code) return Promise.resolve();
    return this.request('POST', 'api/rooms/' + this.code + '/preview', { token: this.token, preview: preview }).catch(function () {});
  };

  ServerNet.prototype.disconnect = function () {
    if (this.es) this.es.close();
    this.es = null;
  };

  /* ================= Claude 页面共享存储 ================= */

  function ArtifactNet(db, room, canWrite) {
    this.kind = 'artifact';
    this.serverRunsAI = false;
    this.db = db;
    this.roomCap = room;
    this.canWrite = canWrite;
    this.code = null;
    this.token = null;
    this.unsub = null;
    this.named = null;
    this.online = null;
  }

  function dbError(e) {
    if (e && e.code === 'invalid_argument') return netError('你没有修改权限：请让页面主人把你设为可编辑（Contributor 或以上）', 'denied');
    if (e && (e.code === 'quota_exceeded' || e.code === 'resource_exhausted')) return netError('房间存储已满或操作太频繁，请稍后再试', e.code);
    if (e && e.code && e.message && !/^[a-z_]+$/.test(e.message)) return netError(e.message, e.code);
    return netError('同步失败，请重试', (e && e.code) || 'unavailable');
  }

  // 用租约串行化同一房间的写入：拿到租约 → 读 → 改 → 写
  // 租约无法主动释放，取最短的 1 秒；别人持有时等到它过期再试
  ArtifactNet.prototype.withLock = function (ref, holder, fn) {
    var tries = 0;
    function attempt() {
      return ref.acquire({ holder: holder, ttlMs: 1000 }).then(function (res) {
        if (res && res.acquired) return fn();
        if (++tries >= 12) throw netError('房间正忙，请再试一次', 'busy');
        var wait = res && res.expiresAt ? Date.parse(res.expiresAt) - Date.now() : NaN;
        wait = isFinite(wait) ? clampWait(wait) : 150;
        return sleep(wait + 30 + Math.random() * 120).then(attempt);
      });
    }
    return attempt().catch(function (e) { throw e && e.code && /[\u4e00-\u9fff]/.test(e.message) ? e : dbError(e); });
  };

  ArtifactNet.prototype.create = function (token, name, mode) {
    var self = this;
    var tries = 0;
    function attempt() {
      var code = Online.makeCode();
      var ref = self.db.doc('rooms/' + code);
      return self.withLock(ref, token, function () {
        return ref.get().then(function (snap) {
          if (snap.exists) return null;
          return ref.set(Online.createRoom({ code: code, host: token, name: name, mode: mode, now: Date.now() })).then(function () { return code; });
        });
      }).then(function (c) {
        if (c) return c;
        if (++tries > 5) throw netError('没能生成房间号，请重试', 'busy');
        return attempt();
      });
    }
    return attempt();
  };

  ArtifactNet.prototype.exists = function (code) {
    return this.db.doc('rooms/' + code).get().then(function (snap) {
      return snap.exists && !!Online.normalizeRoom(snap.data());
    }, function (e) { throw dbError(e); });
  };

  ArtifactNet.prototype.connect = function (code, token, h) {
    var self = this;
    this.disconnect();
    this.code = code;
    this.token = token;
    this.online = null;
    var ref = this.db.doc('rooms/' + code);
    h.onIdentity(token);
    h.onConnection(true);
    this.unsub = ref.onSnapshot(function (snap) {
      if (!snap.exists) { h.onGone(); return; }
      var room = Online.normalizeRoom(snap.data());
      if (room) h.onRoom(room);
      else h.onError('房间数据无法识别');
    }, function (e) {
      h.onConnection(false);
      h.onError(dbError(e).message);
    });
    h.onPeers(null);
    if (!this.roomCap) return;
    var cap = this.roomCap;
    cap.join('blokus-' + code.toLowerCase()).then(function (named) {
      if (self.code !== code) { named.leave(); return; }
      self.named = named;
      named.presence({ pid: token });
      named.onPeers(function (change) {
        var ids = uniq(change.peers.map(function (p) { return p.presence && p.presence.pid; })
          .filter(function (x) { return typeof x === 'string' && x.length < 80; }));
        self.online = ids;
        h.onPeers(ids);
        // 正在尝试的位置放在在线状态里，随鼠标移动实时更新
        change.peers.forEach(function (p) {
          var pr = p.presence || {};
          if (p.sameTab || typeof pr.pid !== 'string') return;
          h.onPreview(pr.pid, pr.pv && typeof pr.pv === 'object' ? pr.pv : null);
        });
      });
      named.onConnection(function (c) { h.onConnection(c); });
    }, function () { /* 没有在线状态时照常可玩 */ });
  };

  ArtifactNet.prototype.op = function (op) { return this.opAt(this.code, this.token, op); };

  ArtifactNet.prototype.opAt = function (code, token, op) {
    var self = this;
    var ref = this.db.doc('rooms/' + code);
    var online = this.code === code ? this.online : null;
    return this.withLock(ref, token, function () {
      return ref.get().then(function (snap) {
        if (!snap.exists) throw netError('房间已解散', 'no_room');
        var room = Online.normalizeRoom(snap.data());
        if (!room) throw netError('房间数据无法识别', 'corrupt');
        var res = Online.applyOp(room, op, token, { now: Date.now(), online: online, allowClientAI: true });
        if (res.error) throw netError(res.error, res.code);
        return ref.set(res.room).then(function () { return { ok: true, rev: res.room.rev }; });
      });
    });
  };

  ArtifactNet.prototype.preview = function (preview) {
    if (!this.named) return Promise.resolve();
    return this.named.presence({ pid: this.token, pv: preview }).catch(function () {});
  };

  ArtifactNet.prototype.disconnect = function () {
    if (this.unsub) this.unsub();
    this.unsub = null;
    if (this.named) this.named.leave().catch(function () {});
    this.named = null;
    this.code = null;
  };

  /* ================= 探测可用的联机方式 ================= */

  // 返回 { net, reason }：reason 为 null（可用）/ 'artifact'（页面不支持共享存储）/ 'static' / 'file'
  function detect() {
    var claude = root.claude;
    if (claude && typeof claude.use === 'function') {
      return Promise.resolve(claude.use('db')).then(function (db) {
        if (!db) return { net: null, reason: 'artifact' };
        var roomP = Promise.resolve(claude.use('room')).catch(function () { return null; });
        var userP = Promise.resolve(claude.use('user')).catch(function () { return null; });
        return Promise.all([roomP, userP]).then(function (r) {
          var user = r[1];
          var canP = user && user.can ? Promise.resolve(user.can('data.write')).catch(function () { return null; }) : Promise.resolve(null);
          return canP.then(function (can) {
            return { net: new ArtifactNet(db, r[0], can), reason: null };
          });
        });
      }, function () { return { net: null, reason: 'artifact' }; });
    }
    if (/^https?:$/.test(root.location.protocol)) {
      return fetch('api/info', { cache: 'no-store' }).then(function (res) {
        return res.ok ? res.json() : null;
      }).then(function (info) {
        if (!info || !info.blokus) return { net: null, reason: 'static' };
        var net = new ServerNet('');
        net.llmProxy = !!info.llmProxy;
        return { net: net, reason: null };
      }, function () { return { net: null, reason: 'static' }; });
    }
    return Promise.resolve({ net: null, reason: 'file' });
  }

  root.BlokusNet = {
    detect: detect,
    randomToken: randomToken,
    ServerNet: ServerNet,
    ArtifactNet: ArtifactNet
  };
})(typeof self !== 'undefined' ? self : this);
