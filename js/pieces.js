/*
 * 角斗士棋（BlockTurf）棋子定义，两套：
 *   square —— 方块：21 块（1 格 ×1、2 格 ×1、3 格 ×2、4 格 ×5、5 格 ×12），共 89 格
 *   tri    —— 三角：22 块（1 ×1、2 ×1、3 ×1、4 ×3、5 ×4、6 ×12），共 110 格
 *
 * 格子坐标 [x, y]：x 向右，y 向下。
 * 三角格中 (x + y) 为偶数的格子尖朝上，奇数的尖朝下；
 * 三角格的顶点坐标 [vx, vy] 满足 vx + vy 为奇数，换算成边长单位为 (vx / 2, vy · √3/2)。
 */
(function (root, factory) {
  var mod = factory();
  if (typeof module === 'object' && module.exports) module.exports = mod;
  else root.BlokusPieces = mod;
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  var H = Math.sqrt(3) / 2;

  /* ---------------- 通用 ---------------- */

  function keyOf(cells) {
    return cells.map(function (c) { return c[0] + ',' + c[1]; }).join(';');
  }

  function sortCells(cells) {
    return cells.sort(function (a, b) { return a[1] - b[1] || a[0] - b[0]; });
  }

  function bbox(points) {
    var minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity;
    points.forEach(function (p) {
      if (p[0] < minX) minX = p[0];
      if (p[1] < minY) minY = p[1];
      if (p[0] > maxX) maxX = p[0];
      if (p[1] > maxY) maxY = p[1];
    });
    return { minX: minX, minY: minY, maxX: maxX, maxY: maxY };
  }

  /* ---------------- 方格 ---------------- */

  var SQUARE_RAW = [
    { id: 'I1', name: '单格', cells: [[0, 0]] },
    { id: 'I2', name: '二连', cells: [[0, 0], [1, 0]] },
    { id: 'I3', name: '三连', cells: [[0, 0], [1, 0], [2, 0]] },
    { id: 'V3', name: '小角', cells: [[0, 0], [0, 1], [1, 1]] },
    { id: 'I4', name: '四连', cells: [[0, 0], [1, 0], [2, 0], [3, 0]] },
    { id: 'L4', name: 'L 四', cells: [[0, 0], [0, 1], [0, 2], [1, 2]] },
    { id: 'T4', name: 'T 四', cells: [[0, 0], [1, 0], [2, 0], [1, 1]] },
    { id: 'S4', name: 'S 四', cells: [[1, 0], [2, 0], [0, 1], [1, 1]] },
    { id: 'O4', name: '方块', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { id: 'F5', name: 'F 形', cells: [[1, 0], [2, 0], [0, 1], [1, 1], [1, 2]] },
    { id: 'I5', name: '五连', cells: [[0, 0], [1, 0], [2, 0], [3, 0], [4, 0]] },
    { id: 'L5', name: 'L 五', cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 3]] },
    { id: 'N5', name: 'N 形', cells: [[0, 0], [0, 1], [1, 1], [1, 2], [1, 3]] },
    { id: 'P5', name: 'P 形', cells: [[0, 0], [1, 0], [0, 1], [1, 1], [0, 2]] },
    { id: 'T5', name: 'T 五', cells: [[0, 0], [1, 0], [2, 0], [1, 1], [1, 2]] },
    { id: 'U5', name: 'U 形', cells: [[0, 0], [2, 0], [0, 1], [1, 1], [2, 1]] },
    { id: 'V5', name: '大角', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },
    { id: 'W5', name: 'W 形', cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]] },
    { id: 'X5', name: '十字', cells: [[1, 0], [0, 1], [1, 1], [2, 1], [1, 2]] },
    { id: 'Y5', name: 'Y 形', cells: [[0, 0], [0, 1], [0, 2], [0, 3], [1, 1]] },
    { id: 'Z5', name: 'Z 形', cells: [[0, 0], [1, 0], [1, 1], [1, 2], [2, 2]] }
  ];

  var SQUARE = {
    kind: 'square',
    rotations: 4,
    // 先翻转（x 取反），再顺时针旋转 rot 次：(x, y) -> (-y, x)
    transformCell: function (c, rot, flip) {
      var x = flip ? -c[0] : c[0], y = c[1];
      for (var r = 0; r < rot; r++) {
        var t = x;
        x = -y;
        y = t;
      }
      return [x, y];
    },
    normalize: function (cells) {
      var b = bbox(cells);
      return sortCells(cells.map(function (c) { return [c[0] - b.minX, c[1] - b.minY]; }));
    },
    // 格子多边形（边长单位）
    cellPoly: function (x, y) { return [[x, y], [x + 1, y], [x + 1, y + 1], [x, y + 1]]; },
    centroid: function (x, y) { return [x + 0.5, y + 0.5]; }
  };

  /* ---------------- 三角格 ---------------- */

  function triUp(x, y) { return ((x + y) & 1) === 0; }

  // 顶点（按屏幕顺时针）
  function triVerts(x, y) {
    return triUp(x, y)
      ? [[x + 1, y], [x + 2, y + 1], [x, y + 1]]
      : [[x, y], [x + 2, y], [x + 1, y + 1]];
  }

  function triFromVerts(vs) {
    var minY = Math.min(vs[0][1], vs[1][1], vs[2][1]);
    var top = vs.filter(function (v) { return v[1] === minY; });
    if (top.length === 2) return [Math.min(top[0][0], top[1][0]), minY];
    var bottom = vs.filter(function (v) { return v[1] !== minY; });
    return [Math.min(bottom[0][0], bottom[1][0]), minY];
  }

  // 顶点格的基：v = (1, 0) + a·(2, 0) + b·(1, 1)
  function triTransformVertex(v, rot, flip) {
    var b = v[1], a = (v[0] - 1 - b) / 2;
    if (flip) a = -a - b;
    for (var r = 0; r < rot; r++) {
      var t = a;
      a = -b;
      b = t + b;
    }
    return [1 + 2 * a + b, b];
  }

  function triNeighbors(x, y) {
    return [[x - 1, y], [x + 1, y], triUp(x, y) ? [x, y + 1] : [x, y - 1]];
  }

  var TRI = {
    kind: 'tri',
    rotations: 6,
    // 先沿竖轴翻转，再顺时针旋转 rot × 60°
    transformCell: function (c, rot, flip) {
      return triFromVerts(triVerts(c[0], c[1]).map(function (v) { return triTransformVertex(v, rot, flip); }));
    },
    // 平移须保持尖朝向：dx + dy 为偶数
    normalize: function (cells) {
      var b = bbox(cells);
      var dx = -b.minX, dy = -b.minY;
      if ((dx + dy) & 1) dx += 1;
      return sortCells(cells.map(function (c) { return [c[0] + dx, c[1] + dy]; }));
    },
    cellPoly: function (x, y) {
      return triVerts(x, y).map(function (v) { return [v[0] / 2, v[1] * H]; });
    },
    centroid: function (x, y) {
      return [(x + 1) / 2, (y + (triUp(x, y) ? 2 / 3 : 1 / 3)) * H];
    }
  };

  /* ---------------- 六边形格（宝石阵） ---------------- */

  // 轴坐标 (q, r)：平顶六边形（与原版棋盘一致），q 为列（向右），r 沿列向下；对边距离为 1
  var HEX_DIRS = [[1, 0], [1, -1], [0, -1], [-1, 0], [-1, 1], [0, 1]];
  // “尖对尖”的 6 个方向：隔着两个格子的公共边（距离为一条边长）
  var HEX_APEX = [[1, 1], [2, -1], [1, -2], [-1, -1], [-2, 1], [-1, 2]];
  var HEX_R = 2 * H / 3; // 外接圆半径

  function hexCenter(q, r) { return [q * H, r + q / 2]; }

  var HEX = {
    kind: 'hex',
    rotations: 6,
    // 先翻转，再旋转 rot × 60°
    transformCell: function (c, rot, flip) {
      var q = c[0], r = c[1];
      if (flip) r = -q - r;
      for (var k = 0; k < rot; k++) {
        var nq = -r;
        r = q + r;
        q = nq;
      }
      return [q, r];
    },
    normalize: function (cells) {
      var b = bbox(cells);
      return sortCells(cells.map(function (c) { return [c[0] - b.minX, c[1] - b.minY]; }));
    },
    cellPoly: function (x, y) {
      var c = hexCenter(x, y);
      return [[-1, 0], [-0.5, -1], [0.5, -1], [1, 0], [0.5, 1], [-0.5, 1]].map(function (v) {
        return [c[0] + v[0] * HEX_R, c[1] + v[1] * 0.5];
      });
    },
    centroid: function (x, y) { return hexCenter(x, y); }
  };

  /*
   * 宝石阵（Gemblo）每人 18 块：单格 1、双格 1、三格 3、四格 5、五格 8，共 72 格（原版数量）。
   * 形状按原版实物照片逐块核对：三格 3 种全用；四格 5 种（直四、拱形、波浪、菱形、三叉）；
   * 五格从 22 种里选了 8 种（直五、台阶、大拐、尖角、长浪、S 形、风车、长叉）。
   * 规则书图 2（五人局把一种颜色的 15 块摆成障碍）里的形状与此一致。
   */
  var GEMBLO_RAW = [
    { id: 'G1', name: '单格', cells: [[0, 0]] },
    { id: 'G2', name: '双格', cells: [[0, 0], [0, 1]] },
    { id: 'G3a', name: '直三', cells: [[0, 0], [0, 1], [0, 2]] },
    { id: 'G3b', name: '弯三', cells: [[0, 0], [0, 1], [1, 1]] },
    { id: 'G3c', name: '三角', cells: [[0, 0], [1, 0], [0, 1]] },
    { id: 'G4a', name: '直四', cells: [[0, 0], [0, 1], [0, 2], [0, 3]] },
    { id: 'G4b', name: '拱形', cells: [[0, 0], [1, 0], [1, 1], [0, 2]] },
    { id: 'G4c', name: '波浪', cells: [[0, 0], [0, 1], [1, 1], [1, 2]] },
    { id: 'G4d', name: '菱形', cells: [[0, 0], [1, 0], [0, 1], [1, 1]] },
    { id: 'G4e', name: '三叉', cells: [[1, 0], [1, 1], [2, 1], [0, 2]] },
    { id: 'G5a', name: '直五', cells: [[0, 0], [0, 1], [0, 2], [0, 3], [0, 4]] },
    { id: 'G5b', name: '台阶', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [1, 3]] },
    { id: 'G5c', name: '大拐', cells: [[0, 0], [0, 1], [0, 2], [1, 2], [2, 2]] },
    { id: 'G5d', name: '尖角', cells: [[0, 0], [1, 0], [2, 0], [0, 1], [0, 2]] },
    { id: 'G5e', name: '长浪', cells: [[0, 0], [0, 1], [1, 1], [1, 2], [2, 2]] },
    { id: 'G5f', name: 'S 形', cells: [[0, 0], [0, 1], [1, 1], [2, 1], [2, 2]] },
    { id: 'G5g', name: '风车', cells: [[0, 0], [1, 0], [1, 1], [2, 1], [0, 2]] },
    { id: 'G5h', name: '长叉', cells: [[1, 0], [1, 1], [1, 2], [2, 2], [0, 3]] }
  ];

  // 枚举 1–6 格的全部自由多三角形（允许旋转、翻转）
  function canonical(geom, cells) {
    var best = null;
    for (var flip = 0; flip < 2; flip++) {
      for (var rot = 0; rot < geom.rotations; rot++) {
        var k = keyOf(geom.normalize(cells.map(function (c) { return geom.transformCell(c, rot, flip); })));
        if (best === null || k < best) best = k;
      }
    }
    return best;
  }

  function parseKey(k) {
    return k.split(';').map(function (s) { return s.split(',').map(Number); });
  }

  function enumeratePolyiamonds(maxSize) {
    var levels = [[keyOf([[0, 0]])]];
    for (var size = 2; size <= maxSize; size++) {
      var seen = {};
      var next = [];
      levels[levels.length - 1].forEach(function (k) {
        var cells = parseKey(k);
        var has = {};
        cells.forEach(function (c) { has[c[0] + ',' + c[1]] = 1; });
        cells.forEach(function (c) {
          triNeighbors(c[0], c[1]).forEach(function (nb) {
            if (has[nb[0] + ',' + nb[1]]) return;
            var ck = canonical(TRI, cells.concat([nb]));
            if (!seen[ck]) {
              seen[ck] = 1;
              next.push(ck);
            }
          });
        });
      });
      next.sort();
      levels.push(next);
    }
    return levels;
  }

  function triPieceName(cells, size, letterIndex) {
    var shapes = [];
    for (var flip = 0; flip < 2; flip++) {
      for (var rot = 0; rot < 6; rot++) {
        shapes.push(TRI.normalize(cells.map(function (c) { return TRI.transformCell(c, rot, flip); })));
      }
    }
    var straight = shapes.some(function (s) { return s.every(function (c) { return c[1] === s[0][1]; }); });
    if (size === 1) return '单三角';
    if (size === 2) return '菱形';
    if (size === 3) return '梯形';
    if (straight) return (size === 4 ? '四' : size === 5 ? '五' : '六') + '格长条';
    var has = {};
    cells.forEach(function (c) { has[c[0] + ',' + c[1]] = 1; });
    if (size === 4 && cells.some(function (c) {
      return triNeighbors(c[0], c[1]).every(function (n) { return has[n[0] + ',' + n[1]]; });
    })) return '大三角';
    if (size === 6) {
      var vcount = {};
      cells.forEach(function (c) { triVerts(c[0], c[1]).forEach(function (v) { var k = v + ''; vcount[k] = (vcount[k] || 0) + 1; }); });
      if (Object.keys(vcount).some(function (k) { return vcount[k] === 6; })) return '六边形';
    }
    var prefix = size === 4 ? '四格' : size === 5 ? '五格' : '六格';
    return prefix + ' ' + 'ABCDEFGHIJKL'.charAt(letterIndex);
  }

  /* ---------------- 构建棋子集合 ---------------- */

  // 光标对准的“中心格”
  function pivotOf(geom, cells) {
    var cs = cells.map(function (c) { return geom.centroid(c[0], c[1]); });
    var mx = 0, my = 0;
    cs.forEach(function (p) { mx += p[0]; my += p[1]; });
    mx /= cs.length;
    my /= cs.length;
    var best = 0, bestD = Infinity;
    cs.forEach(function (p, i) {
      var d = (p[0] - mx) * (p[0] - mx) + (p[1] - my) * (p[1] - my);
      if (d < bestD - 1e-9) { bestD = d; best = i; }
    });
    return cells[best];
  }

  function buildSet(geom, raws) {
    var maxBox = 0;
    var pieces = raws.map(function (raw, index) {
      var orients = [];
      var byKey = {};
      var transformToOrient = new Array(geom.rotations * 2);
      for (var flip = 0; flip < 2; flip++) {
        for (var rot = 0; rot < geom.rotations; rot++) {
          var cells = geom.normalize(raw.cells.map(function (c) { return geom.transformCell(c, rot, flip); }));
          var key = keyOf(cells);
          if (!(key in byKey)) {
            var cb = bbox(cells);
            var polys = cells.map(function (c) { return geom.cellPoly(c[0], c[1]); });
            var pb = bbox([].concat.apply([], polys));
            polys = polys.map(function (poly) { return poly.map(function (p) { return [p[0] - pb.minX, p[1] - pb.minY]; }); });
            var flat = [];
            cells.forEach(function (c) { flat.push(c[0], c[1]); });
            byKey[key] = orients.length;
            orients.push({
              cells: cells,
              flat: flat,
              w: cb.maxX + 1,
              h: cb.maxY + 1,
              pivot: pivotOf(geom, cells),
              polys: polys,
              boxW: pb.maxX - pb.minX,
              boxH: pb.maxY - pb.minY,
              rot: rot,
              flip: flip
            });
            maxBox = Math.max(maxBox, pb.maxX - pb.minX, pb.maxY - pb.minY);
          }
          transformToOrient[flip * geom.rotations + rot] = byKey[key];
        }
      }
      // 托盘里展示最扁平的朝向
      var display = 0;
      orients.forEach(function (o, i) {
        var d = orients[display];
        if (o.boxH < d.boxH - 1e-9 || (Math.abs(o.boxH - d.boxH) < 1e-9 && o.boxW < d.boxW - 1e-9)) display = i;
      });
      return {
        index: index,
        id: raw.id,
        name: raw.name,
        size: raw.cells.length,
        orients: orients,
        display: geom.kind === 'square' ? 0 : display,
        transformToOrient: transformToOrient
      };
    });
    var R = geom.rotations;
    return {
      kind: geom.kind,
      rotations: R,
      pieces: pieces,
      count: pieces.length,
      total: pieces.reduce(function (s, p) { return s + p.size; }, 0),
      maxBox: maxBox,
      geom: geom,
      orientFor: function (pieceIndex, rot, flip) {
        return pieces[pieceIndex].transformToOrient[(flip ? R : 0) + (((rot % R) + R) % R)];
      }
    };
  }

  var triRaws = [];
  enumeratePolyiamonds(6).forEach(function (level, li) {
    level.forEach(function (k, i) {
      var cells = parseKey(k);
      triRaws.push({ id: 'T' + (li + 1) + String.fromCharCode(97 + i), cells: cells, letter: i });
    });
  });
  triRaws.forEach(function (r) { r.name = triPieceName(r.cells, r.cells.length, r.letter); });
  // 同尺寸里有专名的排前面，其余按字母重新编号
  [4, 5, 6].forEach(function (size) {
    var group = triRaws.filter(function (r) { return r.cells.length === size; });
    var plain = group.filter(function (r) { return / [A-L]$/.test(r.name); });
    plain.forEach(function (r, i) {
      r.name = (size === 4 ? '四格' : size === 5 ? '五格' : '六格') + ' ' + 'ABCDEFGHIJKL'.charAt(i);
    });
  });

  /* ---------------- 立方体（立体模式） ---------------- */

  // 坐标 [x, y, z]，y 朝上。只允许旋转（24 种），不允许镜像：手性相反的棋子是两块不同的棋子
  function matMul(a, b) {
    var m = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
    for (var i = 0; i < 3; i++) for (var j = 0; j < 3; j++) for (var k = 0; k < 3; k++) m[i][j] += a[i][k] * b[k][j];
    return m;
  }
  function matApply(m, c) {
    return [
      m[0][0] * c[0] + m[0][1] * c[1] + m[0][2] * c[2],
      m[1][0] * c[0] + m[1][1] * c[1] + m[1][2] * c[2],
      m[2][0] * c[0] + m[2][1] * c[1] + m[2][2] * c[2]
    ];
  }
  // 绕 x / y / z 轴转 90°
  var AXIS_ROT = [
    [[1, 0, 0], [0, 0, -1], [0, 1, 0]],
    [[0, 0, 1], [0, 1, 0], [-1, 0, 0]],
    [[0, -1, 0], [1, 0, 0], [0, 0, 1]]
  ];
  var CUBE_ROTS = (function () {
    var out = [[[1, 0, 0], [0, 1, 0], [0, 0, 1]]];
    var seen = {};
    seen[JSON.stringify(out[0])] = 1;
    for (var i = 0; i < out.length; i++) {
      for (var a = 0; a < 3; a++) {
        var m = matMul(AXIS_ROT[a], out[i]);
        var k = JSON.stringify(m);
        if (!seen[k]) { seen[k] = 1; out.push(m); }
      }
    }
    return out;
  })();

  function cubeNormalize(cells) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    cells.forEach(function (c) {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[2] < minZ) minZ = c[2];
    });
    return cells.map(function (c) { return [c[0] - minX, c[1] - minY, c[2] - minZ]; })
      .sort(function (a, b) { return a[1] - b[1] || a[2] - b[2] || a[0] - b[0]; });
  }
  function cubeKey(cells) { return cells.map(function (c) { return c.join(','); }).join(';'); }
  function cubeCanonical(cells) {
    var best = null;
    CUBE_ROTS.forEach(function (m) {
      var k = cubeKey(cubeNormalize(cells.map(function (c) { return matApply(m, c); })));
      if (best === null || k < best) best = k;
    });
    return best;
  }
  var FACE_DIRS = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];

  function enumeratePolycubes(maxSize) {
    var levels = [[cubeKey([[0, 0, 0]])]];
    for (var size = 2; size <= maxSize; size++) {
      var seen = {}, next = [];
      levels[levels.length - 1].forEach(function (k) {
        var cells = k.split(';').map(function (s) { return s.split(',').map(Number); });
        var has = {};
        cells.forEach(function (c) { has[c.join(',')] = 1; });
        cells.forEach(function (c) {
          FACE_DIRS.forEach(function (d) {
            var nb = [c[0] + d[0], c[1] + d[1], c[2] + d[2]];
            if (has[nb.join(',')]) return;
            var ck = cubeCanonical(cells.concat([nb]));
            if (!seen[ck]) { seen[ck] = 1; next.push(ck); }
          });
        });
      });
      next.sort();
      levels.push(next);
    }
    return levels;
  }

  function cubeName(cells) {
    var n = cells.length;
    if (n === 1) return '单块';
    if (n === 2) return '二连';
    function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
    function adj(a, b) { var d = sub(a, b); return Math.abs(d[0]) + Math.abs(d[1]) + Math.abs(d[2]) === 1; }
    var axes = [0, 1, 2].filter(function (a) { return cells.some(function (c) { return c[a] !== cells[0][a]; }); });
    if (axes.length === 1) return (n === 3 ? '三' : '四') + '连直条';
    if (n === 3) return '小角';
    var degree = cells.map(function (c) { return cells.filter(function (d) { return adj(c, d); }).length; });
    var planar = axes.length === 2;
    if (degree.indexOf(3) >= 0) return planar ? 'T 形' : '三脚架';
    if (degree.every(function (d) { return d === 2; })) return '方块';
    if (planar) {
      var three = cells.some(function (a) {
        return cells.some(function (b) {
          if (a === b) return false;
          var d = sub(b, a);
          var m = [a[0] + 2 * d[0], a[1] + 2 * d[1], a[2] + 2 * d[2]];
          return adj(a, b) && cells.some(function (c) { return c[0] === m[0] && c[1] === m[1] && c[2] === m[2]; });
        });
      });
      return three ? 'L 形' : 'S 形';
    }
    // 两种扭转块互为镜像：用三段连接方向的行列式区分左右
    var ends = cells.filter(function (c, i) { return degree[i] === 1; });
    var chain = [ends[0]];
    while (chain.length < n) {
      var last = chain[chain.length - 1];
      chain.push(cells.filter(function (c) { return adj(c, last) && chain.indexOf(c) < 0; })[0]);
    }
    var u = sub(chain[1], chain[0]), v = sub(chain[2], chain[1]), w = sub(chain[3], chain[2]);
    var det = u[0] * (v[1] * w[2] - v[2] * w[1]) - u[1] * (v[0] * w[2] - v[2] * w[0]) + u[2] * (v[0] * w[1] - v[1] * w[0]);
    return det > 0 ? '右旋' : '左旋';
  }

  function buildCubeSet() {
    var raws = [];
    enumeratePolycubes(4).forEach(function (level) {
      level.forEach(function (k) { raws.push(k.split(';').map(function (s) { return s.split(',').map(Number); })); });
    });
    var pieces = raws.map(function (rawCells, index) {
      var orients = [], byKey = {}, transformToOrient = [];
      CUBE_ROTS.forEach(function (m) {
        var cells = cubeNormalize(rawCells.map(function (c) { return matApply(m, c); }));
        var key = cubeKey(cells);
        if (!(key in byKey)) {
          byKey[key] = orients.length;
          var w = 0, h = 0, d = 0, flat = [], foot = {};
          cells.forEach(function (c) {
            w = Math.max(w, c[0] + 1); h = Math.max(h, c[1] + 1); d = Math.max(d, c[2] + 1);
            flat.push(c[0], c[1], c[2]);
            var fk = c[0] + ',' + c[2];
            if (!(fk in foot) || c[1] < foot[fk]) foot[fk] = c[1];
          });
          // 每一列最低的方块（计算落点用）
          var footList = [];
          Object.keys(foot).forEach(function (fk) {
            var p = fk.split(',').map(Number);
            footList.push(p[0], p[1], foot[fk]);
          });
          // 对准格：最底层里最靠近中心的方块
          var cx = (w - 1) / 2, cz = (d - 1) / 2, pivot = null, bd = Infinity;
          cells.forEach(function (c) {
            if (c[1] !== 0) return;
            var dd = (c[0] - cx) * (c[0] - cx) + (c[2] - cz) * (c[2] - cz);
            if (dd < bd - 1e-9) { bd = dd; pivot = c; }
          });
          orients.push({ cells: cells, flat: flat, foot: footList, w: w, h: h, d: d, pivot: pivot, key: key });
        }
        transformToOrient.push(byKey[key]);
      });
      // 每个朝向绕三根轴各转 ±90° 后得到的朝向
      orients.forEach(function (o) {
        o.turns = [];
        [0, 1, 2].forEach(function (a) {
          [1, -1].forEach(function (dir) {
            var m = AXIS_ROT[a];
            if (dir < 0) m = matMul(m, matMul(m, m));
            o.turns.push(byKey[cubeKey(cubeNormalize(o.cells.map(function (c) { return matApply(m, c); })))]);
          });
        });
      });
      // 托盘里展示最矮、最舒展的朝向
      var display = 0;
      orients.forEach(function (o, i) {
        var b = orients[display];
        if (o.h < b.h || (o.h === b.h && o.w > b.w) || (o.h === b.h && o.w === b.w && o.d < b.d)) display = i;
      });
      return {
        index: index,
        id: 'C' + rawCells.length + String.fromCharCode(97 + index),
        name: cubeName(rawCells),
        size: rawCells.length,
        orients: orients,
        display: display,
        transformToOrient: transformToOrient
      };
    });
    return {
      kind: 'cube',
      dims: 3,
      rotations: 24,
      pieces: pieces,
      count: pieces.length,
      total: pieces.reduce(function (s, p) { return s + p.size; }, 0),
      maxBox: 4,
      // axis: 0 = x, 1 = y（竖轴）, 2 = z；dir: +1 / -1
      turn: function (pieceIndex, orient, axis, dir) {
        return pieces[pieceIndex].orients[orient].turns[axis * 2 + (dir > 0 ? 0 : 1)];
      },
      orientFor: function (pieceIndex, rot) {
        return pieces[pieceIndex].transformToOrient[((rot % 24) + 24) % 24];
      }
    };
  }

  /* ---------------- 三棱柱（三棱柱模式） ---------------- */

  // 坐标 [x, y, z]：(x, z) 是三角格坐标（x + z 为偶数时尖朝 -z），y 是层。
  // 允许的转动：绕竖轴每次 60°，以及上下翻转（共 12 种），不允许镜像。
  function prismNormalize(cells) {
    var minX = Infinity, minY = Infinity, minZ = Infinity;
    cells.forEach(function (c) {
      if (c[0] < minX) minX = c[0];
      if (c[1] < minY) minY = c[1];
      if (c[2] < minZ) minZ = c[2];
    });
    var dx = -minX, dz = -minZ;
    if ((dx + dz) & 1) dx += 1;
    return cells.map(function (c) { return [c[0] + dx, c[1] - minY, c[2] + dz]; })
      .sort(function (a, b) { return a[1] - b[1] || a[2] - b[2] || a[0] - b[0]; });
  }

  function prismTransform(c, rot, upside) {
    var t = TRI.transformCell([c[0], c[2]], rot, upside ? 1 : 0);
    return [t[0], upside ? -c[1] : c[1], t[1]];
  }

  function prismCanonical(cells) {
    var best = null;
    for (var u = 0; u < 2; u++) {
      for (var r = 0; r < 6; r++) {
        var k = cubeKey(prismNormalize(cells.map(function (c) { return prismTransform(c, r, u); })));
        if (best === null || k < best) best = k;
      }
    }
    return best;
  }

  function prismNeighbors(c) {
    var t = triNeighbors(c[0], c[2]);
    return [[t[0][0], c[1], t[0][1]], [t[1][0], c[1], t[1][1]], [t[2][0], c[1], t[2][1]], [c[0], c[1] + 1, c[2]], [c[0], c[1] - 1, c[2]]];
  }

  function enumeratePolyprisms(maxSize) {
    var levels = [[cubeKey([[0, 0, 0]])]];
    for (var size = 2; size <= maxSize; size++) {
      var seen = {}, next = [];
      levels[levels.length - 1].forEach(function (k) {
        var cells = k.split(';').map(function (s) { return s.split(',').map(Number); });
        var has = {};
        cells.forEach(function (c) { has[c.join(',')] = 1; });
        cells.forEach(function (c) {
          prismNeighbors(c).forEach(function (nb) {
            if (has[nb.join(',')]) return;
            var ck = prismCanonical(cells.concat([nb]));
            if (!seen[ck]) { seen[ck] = 1; next.push(ck); }
          });
        });
      });
      next.sort();
      levels.push(next);
    }
    return levels;
  }

  function prismName(cells, letter) {
    var n = cells.length;
    var flat = cells.every(function (c) { return c[1] === cells[0][1]; });
    var column = cells.every(function (c) { return c[0] === cells[0][0] && c[2] === cells[0][2]; });
    if (n === 1) return '单柱';
    if (column) return (n === 2 ? '双' : n === 3 ? '三' : '四') + '层柱';
    if (flat) {
      var tn = triPieceName(cells.map(function (c) { return [c[0], c[2]]; }), n, 0);
      return / [A-L]$/.test(tn) ? '四格弯条' : tn;
    }
    return (n === 3 ? '三块' : '四块') + ' ' + 'ABCDEFGHIJKL'.charAt(letter);
  }

  function buildPrismSet() {
    var raws = [];
    enumeratePolyprisms(4).forEach(function (level) {
      level.forEach(function (k) { raws.push(k.split(';').map(function (s) { return s.split(',').map(Number); })); });
    });
    var letters = {};
    var pieces = raws.map(function (rawCells, index) {
      var orients = [], byKey = {};
      function orientOf(cells) {
        var norm = prismNormalize(cells);
        var key = cubeKey(norm);
        if (key in byKey) return byKey[key];
        byKey[key] = orients.length;
        var w = 0, h = 0, d = 0, flat = [], foot = {};
        norm.forEach(function (c) {
          w = Math.max(w, c[0] + 1); h = Math.max(h, c[1] + 1); d = Math.max(d, c[2] + 1);
          flat.push(c[0], c[1], c[2]);
          var fk = c[0] + ',' + c[2];
          if (!(fk in foot) || c[1] < foot[fk]) foot[fk] = c[1];
        });
        var footList = [];
        Object.keys(foot).forEach(function (fk) {
          var p = fk.split(',').map(Number);
          footList.push(p[0], p[1], foot[fk]);
        });
        // 对准格：最底层里最靠近整体中心的那一格
        var cs = norm.map(function (c) { return TRI.centroid(c[0], c[2]); });
        var mx = 0, mz = 0;
        cs.forEach(function (p) { mx += p[0]; mz += p[1]; });
        mx /= cs.length;
        mz /= cs.length;
        var pivot = null, bd = Infinity;
        norm.forEach(function (c, i) {
          if (c[1] !== 0) return;
          var dd = (cs[i][0] - mx) * (cs[i][0] - mx) + (cs[i][1] - mz) * (cs[i][1] - mz);
          if (dd < bd - 1e-9) { bd = dd; pivot = c; }
        });
        orients.push({ cells: norm, flat: flat, foot: footList, w: w, h: h, d: d, pivot: pivot, key: key });
        return byKey[key];
      }
      for (var u = 0; u < 2; u++) {
        for (var r = 0; r < 6; r++) orientOf(rawCells.map(function (c) { return prismTransform(c, r, u); }));
      }
      // 转动表与方块一致：轴 1 = 绕竖轴（±60°），轴 0 / 2 = 上下翻转
      orients.forEach(function (o) {
        var plus = orientOf(o.cells.map(function (c) { return prismTransform(c, 1, 0); }));
        var minus = orientOf(o.cells.map(function (c) { return prismTransform(c, 5, 0); }));
        var upside = orientOf(o.cells.map(function (c) { return prismTransform(c, 0, 1); }));
        o.turns = [upside, upside, plus, minus, upside, upside];
      });
      var display = 0;
      orients.forEach(function (o, i) {
        var b = orients[display];
        if (o.h < b.h || (o.h === b.h && o.w > b.w) || (o.h === b.h && o.w === b.w && o.d < b.d)) display = i;
      });
      var n = rawCells.length;
      letters[n] = letters[n] || 0;
      var name = prismName(rawCells, letters[n]);
      if (/ [A-L]$/.test(name)) letters[n]++;
      return { index: index, id: 'P' + n + String.fromCharCode(97 + index), name: name, size: n, orients: orients, display: display };
    });
    return {
      kind: 'prism',
      dims: 3,
      rotations: 12,
      pieces: pieces,
      count: pieces.length,
      total: pieces.reduce(function (s, p) { return s + p.size; }, 0),
      maxBox: 4,
      turn: function (pieceIndex, orient, axis, dir) {
        return pieces[pieceIndex].orients[orient].turns[axis * 2 + (dir > 0 ? 0 : 1)];
      }
    };
  }

  var SETS = {
    square: buildSet(SQUARE, SQUARE_RAW),
    tri: buildSet(TRI, triRaws),
    cube: buildCubeSet(),
    prism: buildPrismSet(),
    hex: buildSet(HEX, GEMBLO_RAW)
  };
  SETS.cube.dims = 3;

  // 界面翻译用的名字键（见 js/i18n）：方块与宝石阵按编号，其余按生成的中文名对应；字母编号的棋子带上字母
  var NAME_KEYS = {
    tri: {
      '单三角': 'single', '菱形': 'diamond', '梯形': 'trapezoid', '四格长条': 'bar4', '五格长条': 'bar5', '六格长条': 'bar6',
      '大三角': 'big', '六边形': 'hexagon', '四格': 'letter4', '五格': 'letter5', '六格': 'letter6'
    },
    cube: {
      '单块': 'mono', '二连': 'domino', '三连直条': 'bar3', '四连直条': 'bar4', '小角': 'v', 'T 形': 't', '三脚架': 'tripod',
      '方块': 'square', 'L 形': 'l', 'S 形': 's', '右旋': 'right', '左旋': 'left'
    },
    prism: {
      '单柱': 'mono', '双层柱': 'column2', '三层柱': 'column3', '四层柱': 'column4', '四格弯条': 'bent', '三块': 'letter3', '四块': 'letter4',
      '菱形': 'tri.diamond', '梯形': 'tri.trapezoid', '四格长条': 'tri.bar4', '大三角': 'tri.big'
    }
  };
  function labelOf(kind, piece) {
    if (kind === 'square') return { key: 'piece.sq.' + piece.id, letter: '' };
    if (kind === 'hex') return { key: 'piece.hex.' + piece.id, letter: '' };
    var m = / ([A-L])$/.exec(piece.name);
    var k = NAME_KEYS[kind][m ? piece.name.slice(0, -2) : piece.name];
    return { key: 'piece.' + (k.indexOf('.') > 0 ? k : kind + '.' + k), letter: m ? m[1] : '' };
  }
  Object.keys(SETS).forEach(function (kind) {
    SETS[kind].pieces.forEach(function (piece) { piece.label = labelOf(kind, piece); });
  });

  return {
    SETS: SETS,
    GEOMETRY: { square: SQUARE, tri: TRI, hex: HEX },
    HEX_DIRS: HEX_DIRS,
    HEX_APEX: HEX_APEX,
    MONOMINO: 0,
    H: H,
    triUp: triUp,
    triVerts: triVerts,
    // 兼容旧接口
    PIECES: SETS.square.pieces,
    PIECE_COUNT: SETS.square.count,
    TOTAL_SQUARES: SETS.square.total,
    orientFor: SETS.square.orientFor
  };
});
