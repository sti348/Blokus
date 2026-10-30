'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const I18n = require('../js/i18n.js');
const Pieces = require('../js/pieces.js');

const ROOT = path.join(__dirname, '..');
I18n.LANGS.forEach((l) => require(path.join(ROOT, 'js/i18n', l.code + '.js')));

const en = I18n.dict('en');
const PLURAL = /\.(zero|one|two|few|many|other)$/;
const base = (k) => k.replace(PLURAL, '');
const holes = (s) => new Set((s.match(/\{\w+\}/g) || []));
const tags = (s) => (s.match(/<\/?[a-z]+/g) || []).sort().join(' ');

// 这种语言里整数会用到的复数类别
function categories(code) {
  const out = new Set();
  for (let n = 0; n <= 200; n++) out.add(I18n.pluralOf(code, n));
  return out;
}

test('多语言：至少 8 种语言，默认英文', () => {
  assert.ok(I18n.LANGS.length >= 8);
  assert.equal(I18n.DEFAULT, 'en');
  assert.equal(I18n.LANGS[0].code, 'en');
  I18n.LANGS.forEach((l) => assert.ok(fs.existsSync(path.join(ROOT, 'js/i18n', l.code + '.js')), l.code));
});

test('多语言：按浏览器语言自动选择', () => {
  assert.equal(I18n.detect(['zh-CN']), 'zh-CN');
  assert.equal(I18n.detect(['zh']), 'zh-CN');
  assert.equal(I18n.detect(['zh-SG']), 'zh-CN');
  assert.equal(I18n.detect(['zh-TW']), 'zh-TW');
  assert.equal(I18n.detect(['zh-HK']), 'zh-TW');
  assert.equal(I18n.detect(['zh-Hant-CN']), 'zh-TW');
  assert.equal(I18n.detect(['ja-JP']), 'ja');
  assert.equal(I18n.detect(['ko']), 'ko');
  assert.equal(I18n.detect(['pt-BR']), 'pt');
  assert.equal(I18n.detect(['de_AT']), 'de');
  assert.equal(I18n.detect(['es-419']), 'es');
  assert.equal(I18n.detect(['fr-CA']), 'fr');
  assert.equal(I18n.detect(['ru']), 'ru');
  assert.equal(I18n.detect(['nl', 'fr']), 'fr');
  assert.equal(I18n.detect(['nl']), 'en');
  assert.equal(I18n.detect([]), 'en');
  assert.equal(I18n.detect(undefined), 'en');
});

test('多语言：取词、占位符、复数和退回英文', () => {
  I18n.setLang('en');
  assert.equal(I18n.t('move.total', { n: 1 }), '1 move');
  assert.equal(I18n.t('move.total', { n: 3 }), '3 moves');
  assert.equal(I18n.t('turn.placed', { name: 'Ann', piece: 'W' }), 'Ann placed “W”');
  assert.equal(I18n.t('no.such.key'), 'no.such.key');
  I18n.setLang('zh-CN');
  assert.equal(I18n.t('move.total', { n: 1 }), '共 1 手');
  I18n.setLang('ru');
  assert.notEqual(I18n.t('move.total', { n: 1 }), I18n.t('move.total', { n: 5 }));
  I18n.setLang('xx');
  assert.equal(I18n.lang(), 'en');
});

test('多语言：每种语言的词条齐全，占位符、标签与英文一致', () => {
  const groups = {};
  Object.keys(en).forEach((k) => { (groups[base(k)] = groups[base(k)] || []).push(k); });
  I18n.LANGS.forEach(({ code }) => {
    if (code === 'en') return;
    const d = I18n.dict(code);
    const need = categories(code);
    const problems = [];
    Object.keys(groups).forEach((g) => {
      const forms = groups[g];
      const plural = forms.some((k) => PLURAL.test(k));
      const allowed = new Set();
      forms.forEach((k) => holes(en[k]).forEach((h) => allowed.add(h)));
      if (!plural) {
        if (typeof d[g] !== 'string' || !d[g].trim()) { problems.push('缺少 ' + g); return; }
        const want = holes(en[g]), got = holes(d[g]);
        if ([...want].some((h) => !got.has(h)) || [...got].some((h) => !want.has(h))) problems.push('占位符不一致 ' + g + '：' + d[g]);
        if (tags(en[g]) !== tags(d[g])) problems.push('标签不一致 ' + g);
        return;
      }
      need.forEach((cat) => {
        const k = g + '.' + cat;
        const v = d[k] !== undefined ? d[k] : d[g + '.other'];
        if (typeof v !== 'string' || !v.trim()) problems.push('缺少复数形式 ' + k);
      });
      Object.keys(d).filter((k) => base(k) === g && PLURAL.test(k)).forEach((k) => {
        [...holes(d[k])].forEach((h) => { if (!allowed.has(h)) problems.push('多余的占位符 ' + k + '：' + h); });
      });
    });
    Object.keys(d).forEach((k) => { if (!groups[base(k)]) problems.push('多余的词条 ' + k); });
    assert.deepEqual(problems, [], code);
  });
});

test('多语言：代码和页面里用到的词条在英文词典里都有', () => {
  const missing = [];
  const app = fs.readFileSync(path.join(ROOT, 'js/app.js'), 'utf8');
  for (const m of app.matchAll(/\b(?:t|th)\('([a-zA-Z][\w.]*)'(?=\s*[,)])/g)) {
    if (en[m[1]] === undefined && en[m[1] + '.other'] === undefined) missing.push('app.js ' + m[1]);
  }
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const m of html.matchAll(/data-i18n(?:-html)?="([^"]+)"/g)) {
    if (en[m[1]] === undefined) missing.push('index.html ' + m[1]);
  }
  for (const m of html.matchAll(/data-i18n-attr="([^"]+)"/g)) {
    m[1].split(';').forEach((pair) => {
      const key = pair.split(':')[1].trim();
      if (en[key] === undefined) missing.push('index.html ' + key);
    });
  }
  Object.keys(Pieces.SETS).forEach((kind) => Pieces.SETS[kind].pieces.forEach((p) => {
    if (en[p.label.key] === undefined) missing.push('piece ' + p.label.key);
  }));
  assert.deepEqual(missing, []);
});
