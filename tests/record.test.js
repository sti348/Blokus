'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const Engine = require('../js/engine.js');
const AI = require('../js/ai.js');
const Record = require('../js/record.js');

function config(mode, count) {
  const seats = Engine.MODES[mode].seats;
  return Engine.buildConfig(mode, seats.slice(0, count).map((s, i) => ({
    seat: i, name: i ? s.label + '方电脑' : '你', type: i ? 'ai' : 'human', level: 'easy'
  })));
}

// 用简单电脑下完一局
function playOut(cfg) {
  const st = Engine.createGame(cfg);
  for (let guard = 0; !st.over && guard < 1000; guard++) {
    const move = AI.chooseMove(st, 'easy');
    Engine.applyAction(st, move ? { type: 'place', piece: move.piece, orient: move.orient, x: move.x, y: move.y, z: move.z } : { type: 'resign' });
  }
  return st;
}

test('对局记录：保存、导出、再导入后重放得到同一局面', () => {
  for (const [mode, count] of [['classic', 4], ['gemblo', 3], ['cube', 2], ['trigon', 3]]) {
    const cfg = config(mode, count);
    const st = playOut(cfg);
    assert.ok(st.over);
    st.actions[2].note = '先占中间';
    const rec = Record.fromGame(cfg, st.actions, { online: false });
    assert.equal(rec.actions.length, st.actions.length, mode);
    assert.equal(rec.actions[2].note, '先占中间');
    // 存进本机再读出来
    const stored = Record.parse(JSON.parse(JSON.stringify(rec)));
    assert.deepEqual(stored, rec);
    assert.deepEqual(Array.from(Record.stateAt(rec).board), Array.from(st.board));
    // 导出的文件带可读的流程和结果，导入后与原记录一致
    const file = Record.toExport(rec);
    const placed = st.actions.filter((a) => a.type === 'place').length;
    assert.equal(file.moves.filter((m) => m.n).length, placed);
    assert.equal(file.moves[file.moves.length - 1].event, '对局结束');
    assert.equal(file.moves[0].player, cfg.players[0].label + '方 · 你');
    assert.ok(Array.isArray(file.moves[0].cells) && file.moves[0].cells.length === file.moves[0].size);
    assert.equal(file.finished, true);
    assert.equal(file.result.length, count);
    assert.equal(file.result[0].rank, 1);
    const back = Record.parse(JSON.parse(JSON.stringify(file)));
    assert.deepEqual(back, rec);
    // 导出的文本每步一行，读回来也一样
    const text = Record.stringify(rec);
    assert.deepEqual(Record.parse(JSON.parse(text)), rec);
    assert.ok(text.split('\n').length > placed);
    // 摘要
    const sum = Record.summary(rec);
    assert.equal(sum.moves, placed);
    assert.ok(sum.over && sum.winners.length >= 1);
    // 回放到中途
    const half = Record.stateAt(rec, 5);
    assert.equal(half.actions.length, 5);
  }
});

test('对局记录：没下完的局也能保存，停手会出现在流程里', () => {
  const cfg = config('classic', 2);
  const st = Engine.createGame(cfg);
  for (let i = 0; i < 6; i++) {
    const m = AI.chooseMove(st, 'easy');
    Engine.applyAction(st, { type: 'place', piece: m.piece, orient: m.orient, x: m.x, y: m.y });
  }
  Engine.applyAction(st, { type: 'resign' });
  const rec = Record.fromGame(cfg, st.actions);
  const file = Record.toExport(rec);
  assert.equal(file.finished, false);
  assert.equal(file.result, undefined);
  assert.ok(file.moves.some((m) => m.event === '停手' && m.player.startsWith('蓝方')));
  assert.equal(Record.summary(rec).over, false);
});

test('对局记录：导入的文件不可信，只取座位和动作并重新校验', () => {
  const cfg = config('classic', 4);
  const st = playOut(cfg);
  const good = Record.toExport(Record.fromGame(cfg, st.actions));
  const clone = () => JSON.parse(JSON.stringify(good));

  assert.equal(Record.parse(null), null);
  assert.equal(Record.parse({}), null);
  assert.equal(Record.parse(Object.assign(clone(), { format: 'other' })), null);
  assert.equal(Record.parse(Object.assign(clone(), { v: 99 })), null);
  assert.equal(Record.parse(Object.assign(clone(), { mode: '__proto__' })), null);
  assert.equal(Record.parse(Object.assign(clone(), { mode: 'gemblo', players: clone().players.slice(0, 2) })), null);
  // 座位重复或越界
  let f = clone();
  f.players[1].seat = 0;
  assert.equal(Record.parse(f), null);
  f = clone();
  f.players[3].seat = 9;
  assert.equal(Record.parse(f), null);

  // 名字、颜色、难度、日期都会被清理；颜色总是由座位决定
  f = clone();
  f.players[0].name = '‮"><img src=x onerror=alert(1)>很长很长很长很长的名字';
  f.players[0].color = '"><script>';
  f.players[1].level = 'god';
  f.players[1].model = 'x';
  f.date = 'not a date';
  f.id = '../../etc';
  let r = Record.parse(f);
  assert.equal(r.players[0].name.length, 12);
  assert.ok(!/[‮]/.test(r.players[0].name));
  assert.equal(r.players[0].color, undefined);
  assert.equal(r.players[1].level, 'normal');
  assert.equal(r.players[1].model, undefined);
  assert.ok(!Number.isNaN(Date.parse(r.date)));
  assert.match(r.id, /^[a-z0-9]+$/);
  assert.deepEqual(Record.configOf(r).players.map((p) => p.color), cfg.players.map((p) => p.color));

  // 动作：类型不对、不合法、或不是当前玩家时截断
  f = clone();
  f.actions[7].x = '3';
  assert.equal(Record.parse(f).actions.length, 7);
  f = clone();
  f.actions[9] = Object.assign({}, f.actions[8]);
  assert.equal(Record.parse(f).actions.length, 9);
  f = clone();
  f.actions[4].piece = 999;
  assert.equal(Record.parse(f).actions.length, 4);
  f = clone();
  f.actions[3].note = 42;
  assert.equal(Record.parse(f).actions[3].note, undefined);
  assert.equal(Record.parse(f).actions.length, st.actions.length);
});
