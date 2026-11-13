/*
 * 三维牌桌的电脑回合：放在 Worker 里算，画面不卡。
 * 收到 { id, config, actions, level }，重放出局面后返回 { id, move }。
 */
/* global importScripts, BlokusEngine, BlokusAI */
importScripts('../pieces.js', '../engine.js', '../ai.js');

self.onmessage = function (e) {
  var d = e.data;
  var move = null;
  try {
    var state = BlokusEngine.replay(d.config, d.actions);
    if (!state.over) move = BlokusAI.chooseMove(state, d.level);
  } catch (err) {
    move = null;
  }
  self.postMessage({ id: d.id, move: move ? { piece: move.piece, orient: move.orient, x: move.x, y: move.y } : null });
};
