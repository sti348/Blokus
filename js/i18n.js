/*
 * 界面文字的多语言：语言列表、按浏览器语言自动选择、取词（占位符与复数）。
 * 词典在 js/i18n/<语言>.js 里，用 BlokusI18n.add(语言, 词典) 注册；缺词时退回英文，再退回键名。
 * 不依赖 DOM，Node 里也能用（测试检查各语言词典是否齐全）。
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.BlokusI18n = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // name 是这种语言自己的写法（显示在语言菜单里），english 给大模型提示词用
  var LANGS = [
    { code: 'en', name: 'English', english: 'English' },
    { code: 'zh-CN', name: '简体中文', english: 'Simplified Chinese' },
    { code: 'zh-TW', name: '繁體中文', english: 'Traditional Chinese' },
    { code: 'ja', name: '日本語', english: 'Japanese' },
    { code: 'ko', name: '한국어', english: 'Korean' },
    { code: 'es', name: 'Español', english: 'Spanish' },
    { code: 'fr', name: 'Français', english: 'French' },
    { code: 'de', name: 'Deutsch', english: 'German' },
    { code: 'pt', name: 'Português', english: 'Portuguese' },
    { code: 'ru', name: 'Русский', english: 'Russian' }
  ];
  var DEFAULT = 'en';

  var dicts = {};
  var current = DEFAULT;
  var pluralRules = {};

  function hasOwn(o, k) { return Object.prototype.hasOwnProperty.call(o, k); }

  function supported(code) {
    return LANGS.some(function (l) { return l.code === code; });
  }

  function info(code) {
    return LANGS.filter(function (l) { return l.code === (code || current); })[0] || LANGS[0];
  }

  function add(code, dict) {
    var d = dicts[code] || (dicts[code] = {});
    for (var k in dict) if (hasOwn(dict, k)) d[k] = dict[k];
  }

  // 一个浏览器语言标签（如 zh-Hant-TW、pt-BR）对应的支持语言；不支持时为 null
  function match(tag) {
    if (typeof tag !== 'string' || !tag) return null;
    var t = tag.toLowerCase().replace(/_/g, '-');
    if (t === 'zh' || t.indexOf('zh-') === 0) return /-(hant|tw|hk|mo)(-|$)/.test(t) ? 'zh-TW' : 'zh-CN';
    var base = t.split('-')[0];
    return supported(base) ? base : null;
  }

  // 按用户的语言偏好顺序找第一个支持的语言，都不支持时用英文
  function detect(list) {
    for (var i = 0; list && i < list.length; i++) {
      var m = match(list[i]);
      if (m) return m;
    }
    return DEFAULT;
  }

  function setLang(code) {
    current = supported(code) ? code : DEFAULT;
    return current;
  }

  function lang() { return current; }

  function pluralOf(code, n) {
    try {
      if (!pluralRules[code]) pluralRules[code] = new Intl.PluralRules(code);
      return pluralRules[code].select(n);
    } catch (e) {
      return n === 1 ? 'one' : 'other';
    }
  }

  function lookup(code, key) {
    var d = dicts[code];
    return d && hasOwn(d, key) ? d[key] : undefined;
  }

  // 参数里有数字 n 时先找复数形式（key.one / key.few / key.many / key.other）
  function raw(key, params) {
    var n = params && typeof params.n === 'number' ? params.n : null;
    var order = current === DEFAULT ? [DEFAULT] : [current, DEFAULT];
    for (var i = 0; i < order.length; i++) {
      var s;
      if (n !== null) {
        s = lookup(order[i], key + '.' + pluralOf(order[i], n));
        if (s === undefined) s = lookup(order[i], key + '.other');
        if (s !== undefined) return s;
      }
      s = lookup(order[i], key);
      if (s !== undefined) return s;
    }
    return null;
  }

  function fill(s, params) {
    if (!params) return s;
    return s.replace(/\{(\w+)\}/g, function (m, k) {
      return params[k] !== undefined && params[k] !== null ? String(params[k]) : m;
    });
  }

  function t(key, params) {
    var s = raw(key, params);
    return s === null ? key : fill(s, params);
  }

  function has(key) { return raw(key) !== null; }

  return {
    LANGS: LANGS,
    DEFAULT: DEFAULT,
    add: add,
    match: match,
    detect: detect,
    setLang: setLang,
    lang: lang,
    info: info,
    t: t,
    has: has,
    dict: function (code) { return dicts[code] || {}; },
    pluralOf: pluralOf
  };
});
