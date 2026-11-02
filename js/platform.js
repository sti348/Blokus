/*
 * 游戏平台适配层（目前只有 CrazyGames）。
 *
 * 页面里有 CrazyGames SDK（打包 CrazyGames 版本时加进 index.html 的 <head>）时：
 *   - 启动前初始化 SDK，并上报加载开始 / 结束
 *   - 对局进行中 / 停下来时上报 gameplayStart / gameplayStop
 *   - 每局结束时请求一次插页广告（midgame），广告期间静音并挡住界面
 *   - 遵守平台的静音设置；界面语言优先用平台给的 locale
 *   - 偏好、对局记录等存进平台的 data 模块（登录用户跨设备同步，未登录时平台自己存在本机）
 * 没有 SDK（自己的网站、Claude 发布的页面、本地文件）时，所有方法都是空操作，行为和以前完全一样。
 */
(function (root) {
  'use strict';

  var INIT_TIMEOUT_MS = 8000;

  var sdk = null;          // 可用的 SDK（初始化成功且环境不是 disabled）
  var present = false;     // 页面带了 SDK 脚本（即 CrazyGames 版本），不管能不能用
  var playing = false;
  var adActive = false;
  var muteListeners = [];
  var dataStore = null;

  function cg() { return root.CrazyGames && root.CrazyGames.SDK; }

  function safe(fn) {
    try { return fn(); } catch (e) { return undefined; }
  }

  function settings() {
    return (sdk && safe(function () { return sdk.game.settings; })) || {};
  }

  function notifyMute() {
    var m = muted();
    muteListeners.forEach(function (fn) { safe(function () { fn(m); }); });
  }

  // data 模块和 localStorage 接口相同；没有勾选「进度保存」时会抛 dataModuleDisabled，这时退回 localStorage
  function probeData() {
    var data = safe(function () { return sdk.data; });
    if (!data || typeof data.getItem !== 'function') return null;
    try {
      data.getItem('blokus.probe');
      return data;
    } catch (e) {
      return null;
    }
  }

  function init() {
    var api = cg();
    present = !!api;
    if (!api || typeof api.init !== 'function') return Promise.resolve(false);
    var timer = 0;
    var timeout = new Promise(function (resolve) { timer = setTimeout(function () { resolve('timeout'); }, INIT_TIMEOUT_MS); });
    return Promise.race([Promise.resolve().then(function () { return api.init(); }), timeout]).then(function (r) {
      clearTimeout(timer);
      if (r === 'timeout') return false;
      var env = safe(function () { return api.environment; });
      if (env !== 'crazygames' && env !== 'local') return false;
      sdk = api;
      safe(function () { sdk.game.loadingStart(); });
      safe(function () { sdk.game.addSettingsChangeListener(notifyMute); });
      dataStore = probeData();
      return true;
    }, function () {
      clearTimeout(timer);
      return false;
    });
  }

  // 界面准备好了（可以操作）
  function loaded() {
    if (sdk) safe(function () { sdk.game.loadingStop(); });
  }

  // 对局是否正在进行；只在状态变化时上报
  function gameplay(on) {
    on = !!on && !adActive;
    if (on === playing) return;
    playing = on;
    if (!sdk) return;
    safe(function () { if (on) sdk.game.gameplayStart(); else sdk.game.gameplayStop(); });
  }

  function muted() { return adActive || settings().muteAudio === true; }

  function onMuteChange(fn) { muteListeners.push(fn); }

  // 平台给的界面语言（如 "en-US"），没有时返回 null
  function locale() {
    var info = sdk && safe(function () { return sdk.user.systemInfo; });
    return info && typeof info.locale === 'string' && info.locale ? info.locale : null;
  }

  /**
   * 每局结束时的插页广告。返回的 Promise 在广告放完、失败或没有广告时 resolve（不会 reject）。
   * hooks.started()：广告真正开始播放（此时才静音、挡住界面）；hooks.ended()：广告结束。
   * 播放频率由平台控制（太频繁的请求会直接返回 adCooldown），这里不另做限制。
   */
  function endOfGameAd(hooks) {
    hooks = hooks || {};
    if (!sdk || adActive) return Promise.resolve('none');
    var ad = safe(function () { return sdk.ad; });
    if (!ad || typeof ad.requestAd !== 'function') return Promise.resolve('none');
    var wasPlaying = playing;
    gameplay(false);
    return new Promise(function (resolve) {
      var done = false;
      var guard = 0;
      function finish(result) {
        if (done) return;
        done = true;
        clearTimeout(guard);
        var wasActive = adActive;
        adActive = false;
        if (wasActive) {
          notifyMute();
          if (hooks.ended) safe(hooks.ended);
        }
        if (wasPlaying) gameplay(true);
        resolve(result);
      }
      // 广告迟迟不开始也不回调时，不让游戏一直卡住
      guard = setTimeout(function () { if (!adActive) finish('timeout'); }, 15000);
      try {
        ad.requestAd('midgame', {
          adStarted: function () {
            if (done) return;
            clearTimeout(guard);
            adActive = true;
            notifyMute();
            if (hooks.started) safe(hooks.started);
          },
          adFinished: function () { finish('finished'); },
          adError: function (err) { finish((err && err.code) || 'error'); }
        });
      } catch (e) {
        finish('error');
      }
    });
  }

  // 玩家取得值得庆祝的成绩时让网站撒花（平台建议少用）
  function happytime() {
    if (sdk) safe(function () { sdk.game.happytime(); });
  }

  // 存储：有 data 模块时用它，否则用 localStorage；取不到存储时返回 null
  function store() {
    if (dataStore) return dataStore;
    return safe(function () { return root.localStorage; }) || null;
  }

  root.BlokusPlatform = {
    init: init,
    loaded: loaded,
    gameplay: gameplay,
    muted: muted,
    onMuteChange: onMuteChange,
    locale: locale,
    endOfGameAd: endOfGameAd,
    happytime: happytime,
    store: store,
    // CrazyGames 版本（页面带了 SDK）：静态托管，没有联机服务器
    get crazyGames() { return present; },
    get active() { return !!sdk; },
    get adShowing() { return adActive; }
  };
})(typeof self !== 'undefined' ? self : this);
