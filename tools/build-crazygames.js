#!/usr/bin/env node
/*
 * 打包 CrazyGames 版本：node tools/build-crazygames.js
 *
 * 输出：
 *   dist/crazygames/            —— 上传用的文件夹（index.html 在最上层）
 *   dist/blockturf-crazygames.zip —— 同样内容的 zip，直接在 CrazyGames 开发者后台上传
 *
 * 和网站版的区别只有一处：index.html 的 <head> 里在所有游戏脚本之前加载 CrazyGames SDK v3。
 * 游戏代码（js/platform.js）发现 SDK 后才会初始化、上报对局开始 / 结束、在每局结束时放广告。
 * 只打包页面需要的文件（index.html、css、js），不包含服务器、测试和文档。
 */
'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.join(__dirname, '..');
const OUT_DIR = path.join(ROOT, 'dist', 'crazygames');
const ZIP_FILE = path.join(ROOT, 'dist', 'blockturf-crazygames.zip');
const SDK_TAG = '<script src="https://sdk.crazygames.com/crazygames-sdk-v3.js"></script>';

// 页面引用的本地文件（相对路径），从 index.html 里读出来，保证不漏也不多
function localRefs(html) {
  const refs = new Set();
  const re = /\b(?:src|href)="([^"]+)"/g;
  let m;
  while ((m = re.exec(html))) {
    const ref = m[1];
    if (/^(?:[a-z]+:)?\/\//i.test(ref) || /^(?:data|mailto|javascript):/i.test(ref) || ref.startsWith('#')) continue;
    if (ref.startsWith('/')) throw new Error('index.html 里有绝对路径（CrazyGames 只支持相对路径）：' + ref);
    refs.add(ref.split(/[?#]/)[0]);
  }
  return [...refs];
}

function injectSdk(html) {
  if (html.includes('crazygames-sdk')) return html;
  const tag = '<!-- CrazyGames SDK：必须在游戏脚本之前加载 -->\n' + SDK_TAG + '\n';
  const i = html.indexOf('</head>');
  if (i < 0) throw new Error('index.html 没有 </head>');
  return html.slice(0, i) + tag + html.slice(i);
}

/* ---------- 最小的 zip 写入（deflate），不依赖第三方包 ---------- */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function dosTime(d) {
  return {
    time: (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1),
    date: ((d.getFullYear() - 1980) << 9) | ((d.getMonth() + 1) << 5) | d.getDate()
  };
}

function writeZip(file, entries) {
  const parts = [];
  const central = [];
  let offset = 0;
  const { time, date } = dosTime(new Date());
  for (const { name, data } of entries) {
    const nameBuf = Buffer.from(name, 'utf8');
    const comp = zlib.deflateRawSync(data, { level: 9 });
    const crc = crc32(data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6); // 文件名是 UTF-8
    local.writeUInt16LE(8, 8);
    local.writeUInt16LE(time, 10);
    local.writeUInt16LE(date, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(comp.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBuf, comp);
    const cen = Buffer.alloc(46);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(8, 10);
    cen.writeUInt16LE(time, 12);
    cen.writeUInt16LE(date, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(comp.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBuf.length, 28);
    cen.writeUInt32LE(offset, 42);
    central.push(cen, nameBuf);
    offset += local.length + nameBuf.length + comp.length;
  }
  const cenSize = central.reduce((n, b) => n + b.length, 0);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cenSize, 12);
  end.writeUInt32LE(offset, 16);
  fs.writeFileSync(file, Buffer.concat([...parts, ...central, end]));
}

/* ---------- 打包 ---------- */

function build() {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const files = [{ name: 'index.html', data: Buffer.from(injectSdk(html), 'utf8') }];
  for (const ref of localRefs(html)) {
    const src = path.join(ROOT, ref);
    if (!src.startsWith(ROOT + path.sep) || !fs.existsSync(src)) throw new Error('找不到页面引用的文件：' + ref);
    files.push({ name: ref.split(path.sep).join('/'), data: fs.readFileSync(src) });
  }
  fs.rmSync(OUT_DIR, { recursive: true, force: true });
  for (const f of files) {
    const dst = path.join(OUT_DIR, f.name);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.writeFileSync(dst, f.data);
  }
  writeZip(ZIP_FILE, files);
  const total = files.reduce((n, f) => n + f.data.length, 0);
  return { files: files.map((f) => f.name), total, zip: fs.statSync(ZIP_FILE).size };
}

if (require.main === module) {
  const r = build();
  console.log('CrazyGames 版本已打包：' + r.files.length + ' 个文件，共 ' + (r.total / 1024).toFixed(0) + ' KB');
  console.log('  文件夹：' + path.relative(ROOT, OUT_DIR));
  console.log('  上传用：' + path.relative(ROOT, ZIP_FILE) + '（' + (r.zip / 1024).toFixed(0) + ' KB）');
}

module.exports = { build, injectSdk, localRefs, crc32 };
