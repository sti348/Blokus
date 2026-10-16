/*
 * 角斗士棋（Blokus）棋子定义，两套：
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

  var SETS = {
    square: buildSet(SQUARE, SQUARE_RAW),
    tri: buildSet(TRI, triRaws)
  };

  return {
    SETS: SETS,
    GEOMETRY: { square: SQUARE, tri: TRI },
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
