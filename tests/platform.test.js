'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('path');

const PLATFORM = path.join(__dirname, '..', 'js', 'platform.js');

// 用假的 CrazyGames SDK 加载一份全新的 platform.js（它挂在 self 上）
function loadPlatform(fakeSdk) {
  const calls = [];
  const local = new Map();
  global.self = {
    localStorage: {
      getItem: (k) => (local.has(k) ? local.get(k) : null),
      setItem: (k, v) => local.set(k, String(v)),
      removeItem: (k) => local.delete(k)
    }
  };
  if (fakeSdk) global.self.CrazyGames = { SDK: fakeSdk(calls) };
  delete require.cache[PLATFORM];
  require(PLATFORM);
  const P = global.self.BlokusPlatform;
  delete global.self;
  return { P, calls };
}

function fakeSdk(opts = {}) {
  return (calls) => {
    const listeners = [];
    const sdk = {
      environment: 'uninitialized',
      init: async () => { sdk.environment = opts.env || 'crazygames'; },
      game: {
        settings: { muteAudio: !!opts.muteAudio, disableChat: false },
        loadingStart: () => calls.push('loadingStart'),
        loadingStop: () => calls.push('loadingStop'),
        gameplayStart: () => calls.push('gameplayStart'),
        gameplayStop: () => calls.push('gameplayStop'),
        happytime: () => calls.push('happytime'),
        addSettingsChangeListener: (fn) => listeners.push(fn),
        inviteParams: opts.inviteParams || null,
        isInstantMultiplayer: !!opts.instant,
        updateRoom: (r) => calls.push('updateRoom:' + JSON.stringify(r)),
        leftRoom: () => calls.push('leftRoom'),
        addJoinRoomListener: (fn) => { calls.join = fn; }
      },
      user: {
        systemInfo: { locale: opts.locale || 'pt-BR' },
        getUser: async () => { if (opts.userError) throw { code: 'other' }; return opts.user === undefined ? null : opts.user; }
      },
      ad: {
        requestAd: (type, cb) => {
          calls.push('requestAd:' + type);
          if (opts.ad) opts.ad(cb);
        }
      },
      data: opts.dataDisabled
        ? { getItem: () => { throw { code: 'dataModuleDisabled' }; } }
        : { store: new Map(), getItem(k) { return this.store.has(k) ? this.store.get(k) : null; }, setItem(k, v) { this.store.set(k, String(v)); }, removeItem(k) { this.store.delete(k); } },
      _settings: (s) => { sdk.game.settings = s; listeners.forEach((fn) => fn(s)); }
    };
    calls.sdk = sdk;
    return sdk;
  };
}

test('平台：没有 SDK 时一切都是空操作，存储用 localStorage', async () => {
  const { P } = loadPlatform(null);
  assert.equal(await P.init(), false);
  assert.equal(P.crazyGames, false);
  assert.equal(P.active, false);
  assert.equal(P.muted(), false);
  assert.equal(P.locale(), null);
  P.gameplay(true);
  P.happytime();
  P.loaded();
  assert.equal(await P.endOfGameAd(), 'none');
  P.store().setItem('k', 'v');
  assert.equal(P.store().getItem('k'), 'v');
});

test('平台：CrazyGames 上报加载、对局开始 / 停止（只在变化时上报），语言和存储来自 SDK', async () => {
  const { P, calls } = loadPlatform(fakeSdk());
  assert.equal(await P.init(), true);
  assert.equal(P.crazyGames, true);
  assert.equal(P.active, true);
  assert.equal(P.locale(), 'pt-BR');
  P.loaded();
  P.gameplay(true);
  P.gameplay(true);
  P.gameplay(false);
  P.gameplay(false);
  P.gameplay(true);
  assert.deepEqual(calls.slice(), ['loadingStart', 'loadingStop', 'gameplayStart', 'gameplayStop', 'gameplayStart']);
  P.store().setItem('blokus.prefs.v1', '{}');
  assert.equal(calls.sdk.data.getItem('blokus.prefs.v1'), '{}');
});

test('平台：没开进度保存（data 模块抛错）时退回 localStorage', async () => {
  const { P, calls } = loadPlatform(fakeSdk({ dataDisabled: true }));
  await P.init();
  P.store().setItem('a', '1');
  assert.equal(P.store().getItem('a'), '1');
  assert.notEqual(P.store(), calls.sdk.data);
});

test('平台：不在 CrazyGames 的网站上（disabled）时不使用 SDK，但仍算 CrazyGames 版本', async () => {
  const { P, calls } = loadPlatform(fakeSdk({ env: 'disabled' }));
  assert.equal(await P.init(), false);
  assert.equal(P.crazyGames, true);
  assert.equal(P.active, false);
  P.gameplay(true);
  assert.equal(await P.endOfGameAd(), 'none');
  assert.deepEqual(calls.slice(), []);
});

test('平台：遵守 SDK 的静音设置，设置变化时通知', async () => {
  const { P, calls } = loadPlatform(fakeSdk({ muteAudio: true }));
  await P.init();
  assert.equal(P.muted(), true);
  const seen = [];
  P.onMuteChange((m) => seen.push(m));
  calls.sdk._settings({ muteAudio: false });
  assert.equal(P.muted(), false);
  assert.deepEqual(seen, [false]);
});

test('平台：每局结束的广告——开始后才静音，结束后恢复；不会 reject', async () => {
  let cb = null;
  const { P, calls } = loadPlatform(fakeSdk({ ad: (c) => { cb = c; } }));
  await P.init();
  P.gameplay(true);
  const events = [];
  P.onMuteChange((m) => events.push('mute:' + m));
  const done = P.endOfGameAd({ started: () => events.push('started'), ended: () => events.push('ended') });
  // 请求中：停止对局上报，但还没静音
  assert.equal(P.muted(), false);
  assert.equal(P.adShowing, false);
  cb.adStarted();
  assert.equal(P.muted(), true);
  assert.equal(P.adShowing, true);
  // 广告期间再请求一次会被忽略
  assert.equal(await P.endOfGameAd(), 'none');
  cb.adFinished();
  assert.equal(await done, 'finished');
  assert.equal(P.muted(), false);
  assert.deepEqual(events, ['mute:true', 'started', 'mute:false', 'ended']);
  assert.deepEqual(calls.slice(), ['loadingStart', 'gameplayStart', 'gameplayStop', 'requestAd:midgame', 'gameplayStart']);
});

test('平台：没有广告（冷却、被拦截、未填充）时直接继续，不静音', async () => {
  for (const code of ['adCooldown', 'adblock', 'unfilled', 'adsDisabled']) {
    const { P } = loadPlatform(fakeSdk({ ad: (c) => c.adError({ code, message: '' }) }));
    await P.init();
    const events = [];
    P.onMuteChange((m) => events.push(m));
    assert.equal(await P.endOfGameAd({ started: () => events.push('started') }), code);
    assert.deepEqual(events, []);
    assert.equal(P.muted(), false);
  }
  // requestAd 自己抛错也一样
  const { P } = loadPlatform(fakeSdk({ ad: () => { throw new Error('boom'); } }));
  await P.init();
  assert.equal(await P.endOfGameAd(), 'error');
});

test('平台：只在被 CrazyGames 嵌入时加载 SDK', () => {
  const { P } = loadPlatform(null);
  const want = (env) => P.wantsSdk(Object.assign({ search: '', referrer: '', ancestors: [], framed: false }, env));
  // 直接打开网站
  assert.equal(want({}), false);
  assert.equal(want({ referrer: 'https://www.google.com/' }), false);
  // 提交给 CrazyGames 的网址带参数
  assert.equal(want({ search: '?crazygames=1' }), true);
  assert.equal(want({ search: '?crazygames' }), true);
  assert.equal(want({ search: '?a=b&CrazyGames=true' }), true);
  assert.equal(want({ search: '?crazygames=0', framed: true, referrer: 'https://games.crazygames.com/' }), false);
  assert.equal(want({ search: '?useLocalSdk=true' }), true);
  // 在 CrazyGames 的 iframe 里（网页、安卓应用、iOS 应用）
  assert.equal(want({ framed: true, referrer: 'https://games.crazygames.com/en_US/blockturf/index.html' }), true);
  assert.equal(want({ framed: true, ancestors: ['https://games.crazygames.com', 'https://www.crazygames.com'] }), true);
  assert.equal(want({ framed: true, ancestors: ['capacitor://app.crazygames.com'] }), true);
  // 不在 iframe 里时不看来源；冒充的域名不算
  assert.equal(want({ referrer: 'https://www.crazygames.com/game/blockturf' }), false);
  assert.equal(want({ framed: true, referrer: 'https://notcrazygames.com/' }), false);
  assert.equal(want({ framed: true, referrer: 'https://crazygames.com.evil.example/' }), false);
  assert.equal(want({ framed: true, ancestors: ['https://example.com'] }), false);
});

test('平台：和朋友一起玩——邀请进入、多人入口、上报房间、用户名', async () => {
  let r = loadPlatform(null);
  assert.equal(r.P.inviteRoom(), null);
  assert.equal(r.P.instantMultiplayer(), false);
  assert.equal(await r.P.username(), null);
  r.P.updateRoom('ABCDE', true);

  r = loadPlatform(fakeSdk({ inviteParams: { room: 'K7Q2M' }, instant: true, user: { username: 'Crazy_Fox' } }));
  const { P, calls } = r;
  await P.init();
  calls.length = 0;
  assert.equal(P.inviteRoom(), 'K7Q2M');
  assert.equal(P.instantMultiplayer(), true);
  assert.equal(await P.username(), 'Crazy_Fox');
  // 只在变化时上报；离开房间时 leftRoom
  P.updateRoom('ABCDE', true);
  P.updateRoom('ABCDE', true);
  P.updateRoom('ABCDE', false);
  P.updateRoom(null);
  P.updateRoom(null);
  assert.deepEqual(calls.slice(), [
    'updateRoom:{"roomId":"ABCDE","isJoinable":true,"inviteParams":{"room":"ABCDE"}}',
    'updateRoom:{"roomId":"ABCDE","isJoinable":false,"inviteParams":{"room":"ABCDE"}}',
    'leftRoom'
  ]);
  // 已经在玩时接受邀请
  const joined = [];
  P.onJoinRoom((code) => joined.push(code));
  calls.join({ room: 'ZZZZZ' });
  calls.join({});
  assert.deepEqual(joined, ['ZZZZZ']);

  // 没登录 / 出错时没有用户名
  r = loadPlatform(fakeSdk({ userError: true }));
  await r.P.init();
  assert.equal(await r.P.username(), null);
  assert.equal(r.P.inviteRoom(), null);
});
