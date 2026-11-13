/*
 * 三维牌桌的环境配置。
 *
 * 环境和下棋逻辑完全分开：这里的每一项只是一份「数据」，描述房间、灯光、桌子和氛围；
 * 对局中切换环境只会重建房间和桌子，棋盘上的棋子和对局状态不受影响。
 *
 * 新增环境：往 ENVIRONMENTS 里再加一个对象即可（复制一份改数值最快）。字段说明：
 *   id / name          标识和显示名（name 按语言给，缺的语言用 en）
 *   background, fog    远处的底色和雾
 *   exposure           整体曝光
 *   envIntensity       棋子等光滑表面反射房间的强度
 *   hemisphere         环境光（天空色 / 地面色 / 强度）
 *   key                主光（投影子）：type 'spot' | 'directional'，position 以桌面中心为原点，单位约 2 厘米
 *   fills              补光列表：point 光，可选 flicker（火光闪烁）
 *   table              桌子：shape 'round' | 'square'，height 桌面离地高度，木纹颜色，felt 可选的绒面
 *   board              棋盘配色
 *   room               房间里的东西，按顺序搭建；prop 的种类见 js/table/props.js 里的 PROPS
 *   particles          空气里的东西：'dust' 尘埃 | 'petals' 花瓣
 *   camera             可选：默认视角的俯仰（弧度，从正上方算起）
 */
export const ENVIRONMENTS = [
  {
    id: 'study',
    name: { en: 'Midnight Study', 'zh-CN': '深夜书房', 'zh-TW': '深夜書房', ja: '真夜中の書斎' },
    background: '#07080c',
    fog: { color: '#0a0806', density: 0.0016 },
    exposure: 1.08,
    envIntensity: 0.7,
    hemisphere: { sky: '#5a6a9a', ground: '#4a2a14', intensity: 1.15 },
    key: { type: 'spot', color: '#ffdcae', intensity: 3.4, position: [0, 64, 0], angle: 0.8, penumbra: 0.75 },
    fills: [
      { color: '#ff7a2e', intensity: 260, position: [128, -20, 0], distance: 340, flicker: true },
      { color: '#7f9cff', intensity: 90, position: [-125, 40, 0], distance: 260 },
      { color: '#ffb872', intensity: 150, position: [-112, 48, -106], distance: 240 },
      { color: '#ffc890', intensity: 110, position: [70, 70, -110], distance: 260 }
    ],
    table: {
      shape: 'round', radius: 34, height: 37,
      wood: ['#4a2814', '#2a1509'], roughness: 0.42,
      felt: { color: '#1d4a3a', radius: 31.2 }
    },
    board: { frame: '#5a3520', base: '#e9e2d0', ridge: '#cfc5ad', frameRoughness: 0.4 },
    room: [
      { prop: 'floor', texture: 'planks', colors: ['#3a2312', '#1e1108'], size: 320 },
      { prop: 'rug', radius: 78, colors: ['#5c1d1a', '#c9a45a', '#2b1830'] },
      { prop: 'walls', size: 320, height: 175, color: '#1c382e', pattern: 'stripes', wainscot: '#2c190d', wainscotHeight: 52 },
      { prop: 'bookshelf', wall: 'far', width: 230, height: 150 },
      { prop: 'window', wall: 'left', view: 'night', width: 84, height: 104, y: 46, curtains: '#4d1820' },
      { prop: 'fireplace', wall: 'right' },
      { prop: 'frames', wall: 'near' },
      { prop: 'pendant', height: 60, shade: '#1f5a43', metal: '#b08a45' },
      { prop: 'chairs', style: 'leather', color: '#4a1f18', wood: '#2a1509' },
      { prop: 'floorLamp', position: [-118, -112], color: '#ffc98a' },
      { prop: 'plant', position: [112, -118], pot: '#6b3a22' }
    ],
    particles: { type: 'dust', count: 220, color: '#ffe2b8' },
    camera: { polar: 0.84 }
  },
  {
    id: 'tearoom',
    name: { en: 'Morning Tea Room', 'zh-CN': '晨光茶室', 'zh-TW': '晨光茶室', ja: '朝の茶室' },
    background: '#dfe9f2',
    fog: { color: '#e8e4d8', density: 0.0011 },
    exposure: 0.9,
    envIntensity: 0.7,
    hemisphere: { sky: '#e6efff', ground: '#b89a6c', intensity: 0.72 },
    key: { type: 'directional', color: '#fff0d2', intensity: 2.5, position: [-70, 95, -78] },
    fills: [
      { color: '#ffc27a', intensity: 40, position: [108, -4, 104], distance: 180 }
    ],
    table: {
      shape: 'square', size: 66, height: 15,
      wood: ['#d9b989', '#b98f5c'], roughness: 0.55
    },
    board: { frame: '#8a6238', base: '#f4f1e8', ridge: '#d9d4c6', frameRoughness: 0.5 },
    room: [
      { prop: 'floor', texture: 'tatami', size: 300 },
      { prop: 'walls', size: 300, height: 150, color: '#ebe2cc', pattern: 'plaster', beams: '#6a4a2c' },
      { prop: 'moonWindow', wall: 'far', x: -42, radius: 50, view: 'garden' },
      { prop: 'alcove', wall: 'far', x: 88 },
      { prop: 'shoji', wall: 'left' },
      { prop: 'shoji', wall: 'right' },
      { prop: 'shoji', wall: 'near' },
      { prop: 'cushions', color: '#3c5a7a' },
      { prop: 'lantern', position: [108, 104] },
      { prop: 'teaTray', position: [-58, 52] },
      { prop: 'bonsai', position: [-112, -108] }
    ],
    particles: { type: 'petals', count: 90, color: '#ffc4d4' },
    camera: { polar: 0.9 }
  }
];

export function environmentById(id) {
  return ENVIRONMENTS.find(function (e) { return e.id === id; }) || ENVIRONMENTS[0];
}
