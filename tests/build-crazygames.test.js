'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('fs');
const path = require('path');
const Build = require('../tools/build-crazygames.js');

test('CrazyGames 打包：SDK 放在 <head> 里、所有游戏脚本之前', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const out = Build.injectSdk(html);
  const sdk = out.indexOf('https://sdk.crazygames.com/crazygames-sdk-v3.js');
  assert.ok(sdk > 0);
  assert.ok(sdk < out.indexOf('</head>'));
  assert.ok(sdk < out.indexOf('<script src="js/'));
  // 网站版本身不带 SDK；重复注入不会加两次
  assert.equal(html.includes('crazygames-sdk'), false);
  assert.equal(Build.injectSdk(out), out);
});

test('CrazyGames 打包：只收页面引用的本地文件，都是相对路径且存在', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
  const refs = Build.localRefs(html);
  assert.ok(refs.includes('css/style.css'));
  assert.ok(refs.includes('js/platform.js'));
  assert.ok(refs.includes('js/app.js'));
  assert.ok(refs.indexOf('js/platform.js') < refs.indexOf('js/app.js'));
  for (const r of refs) {
    assert.ok(!r.startsWith('/') && !/^https?:/.test(r), r);
    assert.ok(fs.existsSync(path.join(__dirname, '..', r)), r);
  }
  assert.throws(() => Build.localRefs('<script src="/js/app.js"></script>'), /绝对路径/);
});

test('CrazyGames 打包：zip 用的 CRC-32', () => {
  assert.equal(Build.crc32(Buffer.from('123456789')), 0xcbf43926);
  assert.equal(Build.crc32(Buffer.alloc(0)), 0);
});
