// 路线规划本地工具（route-agent-kit 1.0）
// 核心算法与逻辑抽取自参考项目 route-optimizer（route-optimizer-api/server.js）：
//   - 固定起终点 TSP：多初始解(原始+插入+多起点NN) + 2-opt + Or-opt + 节点交换 + ILS(double-bridge) 扰动重启，
//     固定随机种子可复现，途经点 ≤9 时全排列精确解，保底不劣于原始顺序（server.js:425-765）
//   - 高德距离/时间矩阵：/v3/distance 多起点批量（100 起点/批、并发 8），失败段回退 Haversine×1.3（server.js:4490-4625）
//   - 高德过路费矩阵：/v3/direction/driving strategy=0 逐有向段取 tolls，对称查询+对级缓存 24h，
//     ≤8km 跳过、<20km 按 0（server.js:4627-4847）
//   - 线路拆分：K-means(Haversine) + 边界交换 / 均衡分配启发式（server.js:769-989），逐线 NN+2-opt 排序
//   - 坐标纠偏：WGS-84 → GCJ-02（server.js:200-228）
// 纯算法 + 高德 REST，零数据库依赖；仅在用户本地设备执行。
const fs = require('node:fs/promises');
const path = require('node:path');
const { createHash } = require('node:crypto');
const { ensureWorkspace } = require('./local-workspace.cjs');
const capabilities = ['local_route_matrix', 'local_route_optimize', 'local_route_replan', 'local_route_map'];

// 高德 JS API（Web端）key 与安全密钥（用于成果地图 HTML；可用环境变量覆盖）
const AMAP_JS_KEY = process.env.KLA_AMAP_JS_KEY || '93d6b567f9353b0f1578a4044a9bae80';
const AMAP_JS_SECURITY_CODE = process.env.KLA_AMAP_JS_SECURITY_CODE || 'd6983574c14ff6abc06ce604cd46f649';

// 指定的高德 Web 服务 apikey（可用环境变量 KLA_AMAP_KEY 覆盖）
const AMAP_KEY = process.env.KLA_AMAP_KEY || 'a81ff14db11a13443648dd92cb22f723';
const AMAP_MATRIX_TTL = 30 * 60 * 1000;
const TOLL_DIRECTION_STRATEGY = '0';   // 速度最快策略：走高速则 tolls>0，反映真实过路费
const TOLL_SKIP_LOCAL_KM = 8;          // ≤8km 段大概率无高速费，直接 0
const TOLL_QUERY_MIN_KM = 20;          // <20km 段按 0，控制 O(n²) 调用量
const MAX_TOLL_MATRIX_N = 200;
const TOLL_PAIR_TTL = 24 * 60 * 60 * 1000;
const TOLL_CONCURRENCY = 5; // 个人认证 key 的 direction QPS 上限为 3，留余量；企业 key 可用 env KLA_AMAP_CONCURRENCY 调高
const AMAP_CONCURRENCY = Math.max(1, parseInt(process.env.KLA_AMAP_CONCURRENCY || '3', 10) || 3);
const AMAP_RETRY_DELAY_MS = 600; // QPS 超限(CUQPS_HAS_EXCEEDED_THE_LIMIT)时的退避重试间隔

const matrixCache = new Map();   // 矩阵缓存（30 分钟）
const tollPairCache = new Map(); // 过路费对级缓存（24h，静态道路属性）
const tollInflight = new Map();  // 在途请求去重

// ==================== 坐标纠偏（WGS-84 → GCJ-02） ====================
const PI = Math.PI, A = 6378245, EE = 0.006693421622965943;
function transformLat(x, y) {
  let ret = -100.0 + 2.0 * x + 3.0 * y + 0.2 * y * y + 0.1 * x * y + 0.2 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(y * PI) + 40.0 * Math.sin(y / 3.0 * PI)) * 2.0 / 3.0;
  ret += (160.0 * Math.sin(y / 12.0 * PI) + 320 * Math.sin(y * PI / 30.0)) * 2.0 / 3.0;
  return ret;
}
function transformLng(x, y) {
  let ret = 300.0 + x + 2.0 * y + 0.1 * x * x + 0.1 * x * y + 0.1 * Math.sqrt(Math.abs(x));
  ret += (20.0 * Math.sin(6.0 * x * PI) + 20.0 * Math.sin(2.0 * x * PI)) * 2.0 / 3.0;
  ret += (20.0 * Math.sin(x * PI) + 40.0 * Math.sin(x / 3.0 * PI)) * 2.0 / 3.0;
  ret += (150.0 * Math.sin(x / 12.0 * PI) + 300.0 * Math.sin(x / 30.0 * PI)) * 2.0 / 3.0;
  return ret;
}
function wgs84ToGcj02(wgsLng, wgsLat) {
  let dLat = transformLat(wgsLng - 105.0, wgsLat - 35.0);
  let dLng = transformLng(wgsLng - 105.0, wgsLat - 35.0);
  const radLat = wgsLat / 180.0 * PI;
  let magic = Math.sin(radLat);
  magic = 1 - EE * magic * magic;
  const sqrtMagic = Math.sqrt(magic);
  dLat = (dLat * 180.0) / ((A * (1 - EE)) / (magic * sqrtMagic) * PI);
  dLng = (dLng * 180.0) / (A / sqrtMagic * Math.cos(radLat) * PI);
  return { lng: wgsLng + dLng, lat: wgsLat + dLat };
}

// ==================== 基础工具 ====================
function haversineDistance(lat1, lon1, lat2, lon2) {
  const R = 6371;
  const dLat = (lat2 - lat1) * Math.PI / 180;
  const dLon = (lon2 - lon1) * Math.PI / 180;
  const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
    Math.sin(dLon / 2) * Math.sin(dLon / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return R * c;
}
function estimateSegment(p1, p2) {
  const dist = haversineDistance(p1.lat, p1.lon, p2.lat, p2.lon) * 1.3;
  return { distance: dist, time: (dist / 25) * 60 };
}
async function asyncPool(poolLimit, array, iteratorFn) {
  const ret = [];
  const executing = [];
  for (const item of array) {
    const p = Promise.resolve().then(() => iteratorFn(item));
    ret.push(p);
    if (poolLimit <= array.length) {
      const e = p.then(() => undefined);
      executing.push(e);
      if (executing.length >= poolLimit) await Promise.race(executing);
    }
  }
  return Promise.all(ret);
}
function normalizePoints(raw, coordSystem) {
  return raw.map(p => {
    const lat = Number(p.lat), lon = Number(p.lon);
    if (!isFinite(lat) || !isFinite(lon)) throw new Error(`点位坐标无效：${p.name || '(未命名)'}`);
    const gcj = coordSystem === 'wgs84' ? wgs84ToGcj02(lon, lat) : { lng: lon, lat };
    return { name: p.name ? String(p.name).slice(0, 100) : '未命名点位', lat: gcj.lat, lon: gcj.lng, wgsLat: lat, wgsLon: lon };
  });
}
function validMatrix(matrix, n) {
  return Array.isArray(matrix) && matrix.length === n && Array.isArray(matrix[0]) ? matrix : null;
}
function round(value, digits) { return parseFloat(value.toFixed(digits)); }

// ==================== 固定起终点 TSP（server.js:425-765） ====================
function seqOrder(n) { return Array.from({ length: n }, (_, i) => i); }
function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function matrixDistance(points, i, j, matrix) {
  if (matrix && matrix[i] && typeof matrix[i][j] === 'number') return matrix[i][j];
  return haversineDistance(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
}
function orderCost(order, matrix, points) {
  let total = 0;
  for (let k = 0; k < order.length - 1; k++) total += matrixDistance(points, order[k], order[k + 1], matrix);
  return total;
}
function insertionOrder(points, matrix) {
  const n = points.length;
  if (n <= 2) return seqOrder(n);
  const order = [0, n - 1];
  const remaining = [];
  for (let i = 1; i < n - 1; i++) remaining.push(i);
  while (remaining.length > 0) {
    let bestPos = -1, bestRi = -1, minIncrease = Infinity;
    for (let r = 0; r < remaining.length; r++) {
      const p = remaining[r];
      for (let pos = 0; pos < order.length - 1; pos++) {
        const a = order[pos], b = order[pos + 1];
        const increase = matrixDistance(points, a, p, matrix) + matrixDistance(points, p, b, matrix) - matrixDistance(points, a, b, matrix);
        if (increase < minIncrease) { minIncrease = increase; bestPos = pos + 1; bestRi = r; }
      }
    }
    order.splice(bestPos, 0, remaining.splice(bestRi, 1)[0]);
  }
  return order;
}
function nearestNeighborOrder(points, matrix, firstOffset = 0) {
  const n = points.length;
  if (n <= 2) return seqOrder(n);
  const remaining = [];
  for (let i = 1; i < n - 1; i++) remaining.push(i);
  const order = [0];
  let current = 0;
  if (remaining.length > 0) {
    const pick = firstOffset % remaining.length;
    current = remaining.splice(pick, 1)[0];
    order.push(current);
  }
  while (remaining.length > 0) {
    let bestI = 0, bestD = Infinity;
    for (let i = 0; i < remaining.length; i++) {
      const d = matrixDistance(points, current, remaining[i], matrix);
      if (d < bestD) { bestD = d; bestI = i; }
    }
    current = remaining.splice(bestI, 1)[0];
    order.push(current);
  }
  order.push(n - 1);
  return order;
}
function twoOptOrder(order, points, matrix) {
  const n = order.length;
  if (n <= 4) return order;
  let best = order.slice();
  let improved = true, pass = 0;
  const MAX_PASS = 200; // 非对称矩阵（时间）下防环回震荡
  while (improved && pass < MAX_PASS) {
    pass++;
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const a = best[i - 1], b = best[i], c = best[j], d = best[j + 1];
        let delta = matrixDistance(points, a, c, matrix) + matrixDistance(points, b, d, matrix)
          - matrixDistance(points, a, b, matrix) - matrixDistance(points, c, d, matrix);
        for (let k = i; k < j; k++) {
          delta += matrixDistance(points, best[k + 1], best[k], matrix) - matrixDistance(points, best[k], best[k + 1], matrix);
        }
        if (delta < -1e-9) {
          let lo = i, hi = j;
          while (lo < hi) { const tmp = best[lo]; best[lo] = best[hi]; best[hi] = tmp; lo++; hi--; }
          improved = true;
        }
      }
    }
  }
  return best;
}
function orOptOrder(order, points, matrix) {
  const n = order.length;
  if (n <= 5) return order;
  let best = order.slice();
  let bestCost = orderCost(best, matrix, points);
  let improved = true;
  while (improved) {
    improved = false;
    for (let len = 1; len <= 3 && len < n - 2; len++) {
      for (let i = 1; i < n - 1 - len; i++) {
        const segment = best.slice(i, i + len);
        const rest = [...best.slice(0, i), ...best.slice(i + len)];
        for (let k = 1; k < rest.length; k++) {
          const candidate = [...rest.slice(0, k), ...segment, ...rest.slice(k)];
          const cost = orderCost(candidate, matrix, points);
          if (cost < bestCost - 1e-9) { best = candidate; bestCost = cost; improved = true; }
        }
      }
    }
  }
  return best;
}
function swapOrder(order, points, matrix) {
  const n = order.length;
  if (n <= 4) return order;
  let best = order.slice();
  let bestCost = orderCost(best, matrix, points);
  let improved = true;
  while (improved) {
    improved = false;
    for (let i = 1; i < n - 2; i++) {
      for (let j = i + 1; j < n - 1; j++) {
        const candidate = best.slice();
        const tmp = candidate[i]; candidate[i] = candidate[j]; candidate[j] = tmp;
        const cost = orderCost(candidate, matrix, points);
        if (cost < bestCost - 1e-9) { best = candidate; bestCost = cost; improved = true; }
      }
    }
  }
  return best;
}
function localSearchOrder(order, points, matrix) {
  let current = order.slice();
  let currentCost = orderCost(current, matrix, points);
  for (let round = 0; round < 20; round++) {
    const before = currentCost;
    current = twoOptOrder(current, points, matrix);
    current = orOptOrder(current, points, matrix);
    current = swapOrder(current, points, matrix);
    currentCost = orderCost(current, matrix, points);
    if (currentCost >= before - 1e-9) break;
  }
  return { order: current, cost: currentCost };
}
function doubleBridgeKick(order, rand) {
  const n = order.length;
  if (n <= 6) return order.slice();
  const cuts = [];
  while (cuts.length < 3) {
    const c = 1 + Math.floor(rand() * (n - 2));
    if (!cuts.includes(c)) cuts.push(c);
  }
  cuts.sort((a, b) => a - b);
  const seg1 = order.slice(0, cuts[0]);
  const seg2 = order.slice(cuts[0], cuts[1]);
  const seg3 = order.slice(cuts[1], cuts[2]);
  const seg4 = order.slice(cuts[2]);
  return [...seg1, ...seg4.slice(0, -1), ...seg3, ...seg2, order[n - 1]];
}
const EXACT_INTERIOR = 9; // 途经点 ≤9 时全排列精确解（9!≈36万）
function exactSolveOrder(points, matrix) {
  const n = points.length;
  const interior = [];
  for (let i = 1; i < n - 1; i++) interior.push(i);
  if (interior.length === 0) {
    const o = seqOrder(n);
    return { order: o, cost: orderCost(o, matrix, points) };
  }
  let bestOrder = null, bestCost = Infinity;
  const used = new Array(interior.length).fill(false);
  const perm = new Array(interior.length);
  const dfs = (k) => {
    if (k === interior.length) {
      const order = [0, ...perm, n - 1];
      const c = orderCost(order, matrix, points);
      if (c < bestCost - 1e-9) { bestCost = c; bestOrder = order.slice(); }
      return;
    }
    for (let i = 0; i < interior.length; i++) {
      if (used[i]) continue;
      used[i] = true; perm[k] = interior[i];
      dfs(k + 1);
      used[i] = false;
    }
  };
  dfs(0);
  return { order: bestOrder, cost: bestCost };
}
function optimizeRouteOrder(points, matrix) {
  const n = points.length;
  if (n <= 3) {
    const order = seqOrder(n);
    return { order, cost: orderCost(order, matrix, points), improved: false };
  }
  if (n - 2 <= EXACT_INTERIOR) {
    const originalOrder = seqOrder(n);
    const originalCost = orderCost(originalOrder, matrix, points);
    const exact = exactSolveOrder(points, matrix);
    return { order: exact.order, cost: exact.cost, improved: exact.cost < originalCost - 1e-9, exact: true };
  }
  const initials = [seqOrder(n), insertionOrder(points, matrix)];
  const nnStarts = Math.min(8, n - 2);
  for (let s = 0; s < nnStarts; s++) initials.push(nearestNeighborOrder(points, matrix, s));
  let bestOrder = null, bestCost = Infinity;
  for (const init of initials) {
    const { order, cost } = localSearchOrder(init, points, matrix);
    if (cost < bestCost - 1e-9) { bestCost = cost; bestOrder = order; }
  }
  const rand = mulberry32(20260811);
  const kicks = n <= 40 ? 30 : 15;
  for (let k = 0; k < kicks; k++) {
    const kicked = doubleBridgeKick(bestOrder, rand);
    const { order, cost } = localSearchOrder(kicked, points, matrix);
    if (cost < bestCost - 1e-9) { bestCost = cost; bestOrder = order; }
  }
  const originalOrder = seqOrder(n);
  const originalCost = orderCost(originalOrder, matrix, points);
  if (originalCost <= bestCost + 1e-9) return { order: originalOrder, cost: originalCost, improved: false };
  return { order: bestOrder, cost: bestCost, improved: true };
}

// ==================== 线路拆分（server.js:769-989） ====================
function calculateTotalDistance(points, distanceMatrix = null) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) {
    if (distanceMatrix && distanceMatrix[i] && typeof distanceMatrix[i][i + 1] === 'number') total += distanceMatrix[i][i + 1];
    else total += haversineDistance(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
  }
  return total;
}
function kMeansClustering(points, k, rand) {
  if (points.length <= k) return points.map(p => [p]);
  let centroids = [];
  const used = new Set();
  while (centroids.length < k) {
    const idx = Math.floor(rand() * points.length);
    if (!used.has(idx)) { used.add(idx); centroids.push({ lat: points[idx].lat, lon: points[idx].lon }); }
  }
  let assignments = new Array(points.length).fill(0);
  let changed = true, iterations = 0;
  const maxIterations = 50;
  while (changed && iterations < maxIterations) {
    changed = false; iterations++;
    for (let i = 0; i < points.length; i++) {
      let minDist = Infinity, nearest = 0;
      for (let j = 0; j < k; j++) {
        const dist = haversineDistance(points[i].lat, points[i].lon, centroids[j].lat, centroids[j].lon);
        if (dist < minDist) { minDist = dist; nearest = j; }
      }
      if (assignments[i] !== nearest) { assignments[i] = nearest; changed = true; }
    }
    for (let j = 0; j < k; j++) {
      const clusterPoints = points.filter((_, i) => assignments[i] === j);
      if (clusterPoints.length > 0) {
        centroids[j] = {
          lat: clusterPoints.reduce((s, p) => s + p.lat, 0) / clusterPoints.length,
          lon: clusterPoints.reduce((s, p) => s + p.lon, 0) / clusterPoints.length,
        };
      }
    }
  }
  const clusters = [];
  for (let j = 0; j < k; j++) clusters.push(points.filter((_, i) => assignments[i] === j));
  return clusters;
}
function boundaryExchange(clusters, maxExchange = 3) {
  let improved = true, iterations = 0;
  const maxIterations = 20;
  while (improved && iterations < maxIterations) {
    improved = false; iterations++;
    for (let i = 0; i < clusters.length; i++) {
      for (let j = i + 1; j < clusters.length; j++) {
        if (clusters[i].length === 0 || clusters[j].length === 0) continue;
        for (let ei = 0; ei < Math.min(maxExchange, clusters[i].length); ei++) {
          for (let ej = 0; ej < Math.min(maxExchange, clusters[j].length); ej++) {
            let origDist = 0;
            if (clusters[i].length > 1) origDist += haversineDistance(clusters[i][clusters[i].length - 2].lat, clusters[i][clusters[i].length - 2].lon, clusters[i][clusters[i].length - 1].lat, clusters[i][clusters[i].length - 1].lon);
            if (clusters[j].length > 1) origDist += haversineDistance(clusters[j][0].lat, clusters[j][0].lon, clusters[j][1].lat, clusters[j][1].lon);
            let newDist = 0;
            if (clusters[i].length > 1) newDist += haversineDistance(clusters[i][clusters[i].length - 2].lat, clusters[i][clusters[i].length - 2].lon, clusters[j][ej].lat, clusters[j][ej].lon);
            if (clusters[j].length > 1) newDist += haversineDistance(clusters[i][ei].lat, clusters[i][ei].lon, clusters[j][1].lat, clusters[j][1].lon);
            if (newDist < origDist) {
              const tempI = clusters[i].splice(clusters[i].length - 1, 1)[0];
              const tempJ = clusters[j].splice(0, 1)[0];
              clusters[i].push(tempJ);
              clusters[j].unshift(tempI);
              improved = true;
            }
          }
        }
      }
    }
  }
  return clusters;
}
function balancedDistribution(allPoints, numRoutes) {
  if (allPoints.length === 0) return [];
  const targetCount = Math.ceil(allPoints.length / numRoutes);
  const totalDist = calculateTotalDistance(allPoints);
  const targetDist = totalDist / numRoutes;
  const routes = [];
  for (let i = 0; i < numRoutes; i++) routes.push({ points: [], start: null, end: null, currentDist: 0 });
  const remainingPoints = [...allPoints];
  const usedPoints = new Set();
  for (let routeIdx = 0; routeIdx < numRoutes && remainingPoints.length > 0; routeIdx++) {
    const route = routes[routeIdx];
    const maxPoints = targetCount;
    const maxDist = targetDist * 1.2;
    while (route.points.length < maxPoints && remainingPoints.length > 0) {
      let bestIdx = -1, bestScore = Infinity;
      const lastPoint = route.points.length > 0 ? route.points[route.points.length - 1] : route.start;
      for (let i = 0; i < remainingPoints.length; i++) {
        const p = remainingPoints[i];
        if (usedPoints.has(p.id)) continue;
        const dist = lastPoint ? haversineDistance(lastPoint.lat, lastPoint.lon, p.lat, p.lon) : 0;
        const countDiff = Math.abs((route.points.length + 1) - targetCount);
        const distDiff = Math.abs((route.currentDist + dist) - targetDist);
        const score = distDiff * 0.3 + countDiff * 2 + dist * 0.1;
        if (score < bestScore) { bestScore = score; bestIdx = i; }
      }
      if (bestIdx >= 0) {
        const point = remainingPoints.splice(bestIdx, 1)[0];
        const last = route.points.length > 0 ? route.points[route.points.length - 1] : route.start;
        route.points.push(point);
        route.currentDist += last ? haversineDistance(last.lat, last.lon, point.lat, point.lon) : 0;
        usedPoints.add(point.id);
        if (route.currentDist > maxDist && route.points.length >= Math.floor(targetCount * 0.8)) break;
      } else break;
    }
  }
  while (remainingPoints.length > 0) {
    const point = remainingPoints.shift();
    if (usedPoints.has(point.id)) continue;
    let bestRouteIdx = 0, bestScore = Infinity;
    for (let i = 0; i < routes.length; i++) {
      const route = routes[i];
      const countDiff = route.points.length - targetCount;
      const distDiff = route.currentDist - targetDist;
      const score = Math.abs(countDiff) + Math.abs(distDiff) * 0.5;
      if (score < bestScore) { bestScore = score; bestRouteIdx = i; }
    }
    const route = routes[bestRouteIdx];
    const last = route.points.length > 0 ? route.points[route.points.length - 1] : route.start;
    route.points.push(point);
    route.currentDist += last ? haversineDistance(last.lat, last.lon, point.lat, point.lon) : 0;
    usedPoints.add(point.id);
  }
  for (let i = 0; i < routes.length; i++) {
    for (let j = i + 1; j < routes.length; j++) {
      const countDiff = Math.abs(routes[i].points.length - routes[j].points.length);
      const distDiff = Math.abs(routes[i].currentDist - routes[j].currentDist);
      if (countDiff > 2 || distDiff > targetDist * 0.5) {
        const smaller = routes[i].points.length < routes[j].points.length ? i : j;
        const larger = smaller === i ? j : i;
        while (routes[larger].points.length > routes[smaller].points.length + 1) {
          const point = routes[larger].points.pop();
          routes[smaller].points.push(point);
        }
      }
    }
  }
  return routes.map(r => ({ points: r.points, start: r.start, end: r.end }));
}
// 点对象版最近邻 + 2-opt（server.js:320-415，拆线后逐线排序用）
function nearestNeighborRoute(points) {
  if (points.length <= 1) return [...points];
  const route = [points[0]];
  const remaining = points.slice(1);
  while (remaining.length > 0) {
    let nearestIdx = 0, nearestDist = Infinity;
    const current = route[route.length - 1];
    for (let i = 0; i < remaining.length; i++) {
      const dist = haversineDistance(current.lat, current.lon, remaining[i].lat, remaining[i].lon);
      if (dist < nearestDist) { nearestDist = dist; nearestIdx = i; }
    }
    route.push(remaining.splice(nearestIdx, 1)[0]);
  }
  return route;
}
function routeHaversineLength(points) {
  let total = 0;
  for (let i = 0; i < points.length - 1; i++) total += haversineDistance(points[i].lat, points[i].lon, points[i + 1].lat, points[i + 1].lon);
  return total;
}
function twoOptPoints(points, maxIterations = 1000) {
  if (points.length <= 3) return [...points];
  let bestRoute = points.slice();
  let improved = true, iteration = 0;
  const segDist = (route, i, j) => {
    let dist = 0;
    if (i > 0) dist += haversineDistance(route[i - 1].lat, route[i - 1].lon, route[i].lat, route[i].lon);
    dist += haversineDistance(route[i].lat, route[i].lon, route[j].lat, route[j].lon);
    if (j < route.length - 1) dist += haversineDistance(route[j].lat, route[j].lon, route[j + 1].lat, route[j + 1].lon);
    return dist;
  };
  while (improved && iteration < maxIterations) {
    improved = false; iteration++;
    for (let i = 1; i < bestRoute.length - 1; i++) {
      for (let j = i + 1; j < bestRoute.length; j++) {
        const currentDist = segDist(bestRoute, i, j);
        const newRoute = [...bestRoute.slice(0, i), ...bestRoute.slice(i, j + 1).reverse(), ...bestRoute.slice(j + 1)];
        if (segDist(newRoute, i, j) < currentDist) { bestRoute = newRoute; improved = true; }
      }
    }
  }
  return bestRoute;
}

// ==================== 高德矩阵（server.js:4490-4847） ====================
function matrixCacheKey(points) {
  const keys = Array.from(new Set(points.map(p => `${Number(p.lon).toFixed(5)},${Number(p.lat).toFixed(5)}`))).sort();
  let h = 0;
  for (const s of keys) for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0;
  return `${keys.length}:${h >>> 0}`;
}
async function fetchDistanceTimeMatrix(points) {
  const n = points.length;
  const zero = () => Array.from({ length: n }, () => Array(n).fill(0));
  const distance = zero(), time = zero();
  let estimatedPairs = 0;
  let amapError = null;
  const totalPairs = (n * (n - 1)) / 2;
  if (!AMAP_KEY) {
    for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
      const seg = estimateSegment(points[i], points[j]);
      distance[i][j] = seg.distance; distance[j][i] = seg.distance;
      time[i][j] = seg.time; time[j][i] = seg.time;
    }
    return { distance, time, estimatedPairs: totalPairs, totalPairs, source: 'estimated' };
  }
  const ORIGIN_CHUNK = 100, DEST_CONCURRENCY = AMAP_CONCURRENCY;
  const tasks = [];
  for (let d = 0; d < n; d++) {
    const destStr = `${points[d].lon.toFixed(6)},${points[d].lat.toFixed(6)}`;
    for (let oStart = 0; oStart < n; oStart += ORIGIN_CHUNK) {
      const oEnd = Math.min(oStart + ORIGIN_CHUNK, n);
      const originIndices = [], originParts = [];
      for (let i = oStart; i < oEnd; i++) {
        if (i === d) continue;
        originIndices.push(i);
        originParts.push(`${points[i].lon.toFixed(6)},${points[i].lat.toFixed(6)}`);
      }
      if (originParts.length === 0) continue;
      tasks.push({ destIdx: d, destStr, originIndices, origins: originParts.join('|') });
    }
  }
  await asyncPool(DEST_CONCURRENCY, tasks, async (task) => {
    const { destIdx, destStr, originIndices, origins } = task;
    try {
      const url = `https://restapi.amap.com/v3/distance?key=${AMAP_KEY}&origins=${origins}&destination=${destStr}&type=1&output=JSON`;
      let data = null, lastErr = null;
      for (let attempt = 0; attempt < 2; attempt++) { // QPS 超限退避重试一次
        if (attempt > 0) await new Promise(r => setTimeout(r, AMAP_RETRY_DELAY_MS));
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const parsed = await resp.json();
          if (parsed.status !== '1' || !Array.isArray(parsed.results)) throw new Error(parsed.info || '高德返回异常');
          data = parsed; break;
        } catch (e) { lastErr = e; }
      }
      if (!data) throw lastErr;
      for (let r = 0; r < data.results.length && r < originIndices.length; r++) {
        const row = data.results[r];
        const oIdx = originIndices[r];
        const dist = parseFloat(row.distance), dur = parseFloat(row.duration);
        if (!isNaN(dist) && dist >= 0) {
          distance[oIdx][destIdx] = dist / 1000; // m -> km
          time[oIdx][destIdx] = !isNaN(dur) ? dur / 60 : (distance[oIdx][destIdx] / 25) * 60; // s -> min
        } else {
          const seg = estimateSegment(points[oIdx], points[destIdx]);
          distance[oIdx][destIdx] = seg.distance; time[oIdx][destIdx] = seg.time;
          estimatedPairs++;
        }
      }
    } catch (err) {
      if (!amapError) amapError = err.message; // 透出首个失败原因（限流/配额/网络），便于定位
      for (const oIdx of originIndices) {
        const seg = estimateSegment(points[oIdx], points[destIdx]);
        distance[oIdx][destIdx] = seg.distance; time[oIdx][destIdx] = seg.time;
        estimatedPairs++;
      }
    }
  });
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) {
    if (distance[i][j] === 0) { const seg = estimateSegment(points[i], points[j]); distance[i][j] = seg.distance; time[i][j] = seg.time; estimatedPairs++; }
    if (distance[j][i] === 0) { const seg = estimateSegment(points[j], points[i]); distance[j][i] = seg.distance; time[j][i] = seg.time; estimatedPairs++; }
  }
  return { distance, time, estimatedPairs: Math.min(estimatedPairs, totalPairs), totalPairs, source: estimatedPairs === 0 ? 'amap' : 'amap+estimated', ...(amapError ? { amapError } : {}) };
}
function tollFetchPair(key, url) {
  const hit = tollPairCache.get(key);
  if (hit && Date.now() - hit.at < TOLL_PAIR_TTL) return Promise.resolve(hit.t);
  const pending = tollInflight.get(key);
  if (pending) return pending;
  const p = (async () => {
    try {
      for (let attempt = 0; attempt < 3; attempt++) { // QPS 超限退避重试（个人 key QPS=3）
        if (attempt > 0) await new Promise(r => setTimeout(r, AMAP_RETRY_DELAY_MS));
        try {
          const resp = await fetch(url, { signal: AbortSignal.timeout(15000) });
          if (!resp.ok) throw new Error(`HTTP ${resp.status}`);
          const data = await resp.json();
          if (data.status === '1' && data.route && Array.isArray(data.route.paths) && data.route.paths.length > 0) {
            const t = parseFloat(data.route.paths[0].tolls);
            const v = isFinite(t) && t >= 0 ? t : 0;
            tollPairCache.set(key, { t: v, at: Date.now() });
            return v;
          }
          if (!/LIMIT|QUOTA/i.test(String(data.info || ''))) break; // 非限流错误不重试
        } catch { /* 网络错误继续重试 */ }
      }
      return null;
    } catch { return null; }
    finally { tollInflight.delete(key); }
  })();
  tollInflight.set(key, p);
  return p;
}
async function fetchTollMatrix(points) {
  const n = points.length;
  if (n > MAX_TOLL_MATRIX_N) throw new Error(`过路费矩阵点位过多：当前 ${n} 个，上限 ${MAX_TOLL_MATRIX_N}。高德 direction API 为 1→1 调用，建议拆小线路或改用里程/时间策略`);
  const toll = Array.from({ length: n }, () => Array(n).fill(0));
  const totalPairs = n * (n - 1);
  let failedPairs = 0, skippedPairs = 0;
  if (!AMAP_KEY) return { toll, failedPairs: totalPairs, skippedPairs: totalPairs, totalPairs, strategy: TOLL_DIRECTION_STRATEGY, noKey: true };
  const pairKey = (i, j) => `${points[i].lon.toFixed(5)},${points[i].lat.toFixed(5)}>${points[j].lon.toFixed(5)},${points[j].lat.toFixed(5)}`;
  const pairs = [];
  for (let i = 0; i < n; i++) {
    for (let j = 0; j < n; j++) {
      if (i === j) continue;
      if (j < i) continue; // 对称：过路费往返同价，只查 i<j，调用量减半
      const localDist = haversineDistance(points[i].lat, points[i].lon, points[j].lat, points[j].lon);
      if ((TOLL_SKIP_LOCAL_KM > 0 && localDist <= TOLL_SKIP_LOCAL_KM) || localDist < TOLL_QUERY_MIN_KM) {
        skippedPairs += 2;
        continue;
      }
      const hit = tollPairCache.get(pairKey(i, j));
      if (hit && Date.now() - hit.at < TOLL_PAIR_TTL) { toll[i][j] = hit.t; toll[j][i] = hit.t; continue; }
      pairs.push({ i, j });
    }
  }
  await asyncPool(TOLL_CONCURRENCY, pairs, async ({ i, j }) => {
    const url = `https://restapi.amap.com/v3/direction/driving?key=${AMAP_KEY}` +
      `&origin=${points[i].lon.toFixed(6)},${points[i].lat.toFixed(6)}` +
      `&destination=${points[j].lon.toFixed(6)},${points[j].lat.toFixed(6)}` +
      `&strategy=${TOLL_DIRECTION_STRATEGY}&output=JSON`;
    const v = await tollFetchPair(pairKey(i, j), url);
    if (v === null) failedPairs += 2;
    else { toll[i][j] = v; toll[j][i] = v; }
  });
  return { toll, failedPairs, skippedPairs, totalPairs, strategy: TOLL_DIRECTION_STRATEGY, source: 'amap' };
}

// ==================== 优化前后地图对比 HTML（成果文件） ====================
// 仿参考项目 route-optimizer 前端：单窗/双窗对比切换 + 双窗联动；复用本地 route-agent 算法的输入输出。
const AMAP_FILENAME_SAFE = (s) => s.replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').slice(0, 80);
const escapeHtmlText = (s) => String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
// 零依赖兜底：把路线画成内嵌 SVG（无底图），高德 JS 加载失败时显示，保证发给任何人都能看
function routeSvg(route, color) {
  const lats = route.map(s => s.p.lat), lons = route.map(s => s.p.lon);
  const minLat = Math.min(...lats), maxLat = Math.max(...lats);
  const minLon = Math.min(...lons), maxLon = Math.max(...lons);
  const pad = 0.14, W = 800, H = 600;
  const spanLat = (maxLat - minLat) || 1e-6, spanLon = (maxLon - minLon) || 1e-6;
  const px = lon => ((lon - minLon) / spanLon * (1 - 2 * pad) + pad) * W;
  const py = lat => (1 - ((lat - minLat) / spanLat * (1 - 2 * pad) + pad)) * H;
  const pts = route.map(s => `${px(s.p.lon).toFixed(1)},${py(s.p.lat).toFixed(1)}`).join(' ');
  const dots = route.map((s, i) => {
    const cx = px(s.p.lon).toFixed(1), cy = py(s.p.lat).toFixed(1);
    const isStart = i === 0, isEnd = i === route.length - 1;
    const fill = isStart ? '#059669' : isEnd ? '#111827' : '#fff';
    const fg = isStart || isEnd ? '#fff' : color;
    return `<g><circle cx="${cx}" cy="${cy}" r="13" fill="${fill}" stroke="${color}" stroke-width="3"/>` +
      `<text x="${cx}" y="${+cy + 4}" text-anchor="middle" font-size="12" font-weight="700" fill="${fg}">${i + 1}</text>` +
      `<text x="${cx}" y="${+cy - 20}" text-anchor="middle" font-size="13" fill="#111" stroke="#fff" stroke-width="3" paint-order="stroke">${escapeHtmlText(s.p.name)}</text></g>`;
  }).join('');
  // 比例尺（按纬度方向近似）
  const kmPerPx = spanLat * 111 / (H * (1 - 2 * pad));
  const barKm = 1, barPx = Math.max(30, Math.min(200, barKm / kmPerPx));
  return `<svg viewBox="0 0 ${W} ${H}" xmlns="http://www.w3.org/2000/svg" style="width:100%;height:100%;background:#f2f4f7">` +
    `<polyline points="${pts}" fill="none" stroke="${color}" stroke-width="4" stroke-linejoin="round" stroke-linecap="round" stroke-dasharray="1 0" opacity="0.9"/>` +
    dots +
    `<g><rect x="${W - 30 - barPx}" y="${H - 34}" width="${barPx}" height="4" fill="#374151"/>` +
    `<text x="${W - 30 - barPx / 2}" y="${H - 40}" text-anchor="middle" font-size="12" fill="#374151">≈${barKm} km</text></g></svg>`;
}
function buildRouteMapHtml({ routeName, points, originalOrder, optimizedOrder, strategy, distanceKm, savedPercent }) {
  const payload = {
    routeName, strategy: strategy || 'mileage',
    points: points.map(p => ({ name: p.name, lat: +p.lat.toFixed(6), lon: +p.lon.toFixed(6) })),
    originalOrder, optimizedOrder,
    distanceKm: distanceKm == null ? null : +Number(distanceKm).toFixed(3),
    savedPercent: savedPercent == null ? null : +Number(savedPercent).toFixed(2),
  };
  const stats = payload.distanceKm != null
    ? `<span class="stat">优化后总里程 <b>${payload.distanceKm} km</b></span>` +
      (payload.savedPercent != null ? `<span class="stat">节省 <b>${payload.savedPercent}%</b></span>` : '')
    : '';
  const body = JSON.stringify(payload);
  const seqOf = o => o.map((idx, pos) => ({ pos: pos + 1, p: points[idx] }));
  const svgA = routeSvg(seqOf(originalOrder), '#1677ff');
  const svgB = routeSvg(seqOf(optimizedOrder), '#e60012');
  return `<!DOCTYPE html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${routeName} · 优化前后路线对比</title>
<style>
  html,body{margin:0;height:100%;font-family:"Microsoft YaHei",system-ui,sans-serif;background:#f5f6f8;display:flex;flex-direction:column}
  header{display:flex;align-items:center;gap:10px;padding:8px 14px;background:#fff;border-bottom:1px solid #e5e7eb;flex:0 0 auto}
  header h1{font-size:15px;margin:0;color:#111;font-weight:600}
  .seg{display:flex;border:1px solid #d1d5db;border-radius:8px;overflow:hidden}
  .seg button{border:0;background:#fff;padding:5px 14px;font-size:13px;cursor:pointer;color:#374151}
  .seg button.on{background:#059669;color:#fff}
  #linkBtn{margin-left:auto;border:1px solid #059669;color:#059669;background:#fff;border-radius:8px;padding:5px 14px;font-size:13px;cursor:pointer}
  #linkBtn.on{background:#059669;color:#fff}
  .stat{font-size:13px;color:#374151;background:#ecfdf5;border-radius:6px;padding:3px 10px}
  main{flex:1;display:flex;min-height:0}
  .pane{flex:1;display:flex;flex-direction:column;min-width:0;border-right:1px solid #e5e7eb}
  .pane.hide{display:none}
  .pane h2{font-size:13px;margin:0;padding:6px 12px;background:#fff;border-bottom:1px solid #e5e7eb;color:#111;font-weight:600;flex:0 0 auto}
  .pane h2 i{display:inline-block;width:10px;height:10px;border-radius:2px;margin-right:6px;vertical-align:-1px}
  .map{flex:1;min-height:0;position:relative}
  .fallback{position:absolute;inset:0;display:none;overflow:hidden}
  footer{flex:0 0 auto;padding:4px 14px;font-size:12px;color:#6b7280;background:#fff;border-top:1px solid #e5e7eb}
</style>
</head>
<body>
<header>
  <h1>${routeName}</h1>
  <div class="seg" id="viewSeg"><button data-v="dual" class="on">双窗对比</button><button data-v="A">仅原始</button><button data-v="B">仅优化后</button></div>
  <button id="linkBtn" class="on">联动已开</button>
  ${stats}
</header>
<main>
  <section class="pane" id="paneA"><h2><i style="background:#1677ff"></i>A · 原始线路</h2><div class="map" id="mapA"><div class="fallback" id="fbA">${svgA}</div></div></section>
  <section class="pane" id="paneB"><h2><i style="background:#e60012"></i>B · 优化后</h2><div class="map" id="mapB"><div class="fallback" id="fbB">${svgB}</div></div></section>
</main>
<footer id="foot"></footer>
<script>window._AMapSecurityConfig={securityJsCode:'${AMAP_JS_SECURITY_CODE}'};</script>
<script src="https://webapi.amap.com/maps?v=2.0&key=${AMAP_JS_KEY}"></script>
<script>
const D = ${body};
const COLORS = {A:'#1677ff', B:'#e60012'};
const N = D.points.length;
const seq = o => o.map((idx, pos) => ({ pos: pos + 1, p: D.points[idx] }));
const data = { A: seq(D.originalOrder), B: seq(D.optimizedOrder) };
const maps = {}, lines = {}, realDist = {};
const syncing = { v: false }; // 全局同步标志（仿参考项目 RouteMapWorkspace：下一帧解锁防反弹）
let linkOn = true;

function buildPane(key, elId) {
  const map = new AMap.Map(elId, { zoom: 12, mapStyle: 'amap://styles/normal', viewMode: '2D' });
  const route = data[key];
  const path = route.map(s => [s.p.lon, s.p.lat]);
  const line = new AMap.Polyline({ path, strokeColor: COLORS[key], strokeWeight: 6, strokeOpacity: 0.9, showDir: true, lineJoin: 'round' });
  map.add(line);
  route.forEach(s => {
    const isStart = s.pos === 1, isEnd = s.pos === N;
    const marker = new AMap.Marker({
      position: [s.p.lon, s.p.lat],
      anchor: 'center',
      zIndex: 120,
      content: '<div style="width:22px;height:22px;border-radius:50%;background:' + (isStart ? '#059669' : isEnd ? '#111827' : '#fff') +
        ';border:2px solid ' + COLORS[key] + ';color:' + (isStart || isEnd ? '#fff' : COLORS[key]) +
        ';font-size:12px;font-weight:700;display:flex;align-items:center;justify-content:center;box-shadow:0 1px 4px rgba(0,0,0,.3)">' + s.pos + '</div>',
    });
    marker.setLabel({ direction: 'top', offset: new AMap.Pixel(0, -6),
      content: '<div style="white-space:nowrap;font-size:12px;color:#111;background:#fff;border:1px solid #e5e7eb;border-radius:4px;padding:1px 6px">' + s.p.name + '</div>' });
    map.add(marker);
  });
  map.setFitView([line], false, [40, 40, 40, 40]);
  maps[key] = map; lines[key] = line;
  // 仿参考项目：仅在 moveend/zoomend 广播（拖动过程中不联动，保证流畅），全局标志防回弹
  map.on('moveend', () => broadcast(key));
  map.on('zoomend', () => broadcast(key));
  realDist[key] = null;
  // 仿参考项目：用 AMap.Driving 驾车规划取真实道路路径（途经点分段，≤16 途经点/次，顺序请求规避 QPS），直线仅作兜底
  AMap.plugin('AMap.Driving', () => {
    const driving = new AMap.Driving({ policy: AMap.DrivingPolicy.LEAST_DISTANCE });
    const LngLat = AMap.LngLat;
    let i = 0; const path = []; let dist = 0;
    const next = () => {
      if (i >= route.length - 1) {
        if (path.length) {
          line.setPath(path);
          realDist[key] = Math.round(dist) / 1000;
          updateFoot();
        }
        return;
      }
      const j = Math.min(i + 17, route.length - 1);
      const o = route[i].p, d = route[j].p;
      const wps = route.slice(i + 1, j).map(s => new LngLat(s.p.lon, s.p.lat));
      driving.search(new LngLat(o.lon, o.lat), new LngLat(d.lon, d.lat), { waypoints: wps }, (status, result) => {
        if (status === 'complete' && result.routes && result.routes.length) {
          const r = result.routes[0];
          dist += r.distance || 0;
          (r.steps || []).forEach(st => { if (st.path) path.push(...st.path); });
        }
        i = j;
        setTimeout(next, 150); // 个人 key QPS=3，请求间留间隔
      });
    };
    next();
  });
}
function broadcast(from) {
  if (!linkOn || syncing.v) return;
  const src = maps[from];
  if (!src) return;
  syncing.v = true;
  try {
    const center = src.getCenter(), zoom = src.getZoom();
    for (const key of Object.keys(maps)) {
      if (key === from || !maps[key]) continue;
      try {
        if (center) maps[key].setCenter(center, true);   // 第二参立即生效，无动画
        if (typeof zoom === 'number') maps[key].setZoom(zoom, true);
      } catch (e) {}
    }
  } finally { setTimeout(() => { syncing.v = false; }, 60); }
}
try {
  if (!window.AMap) throw new Error('AMap 脚本未加载');
  buildPane('A', 'mapA');
  buildPane('B', 'mapB');
} catch (e) { showFallback(); }

document.getElementById('viewSeg').addEventListener('click', e => {
  const v = e.target && e.target.dataset && e.target.dataset.v;
  if (!v) return;
  document.querySelectorAll('#viewSeg button').forEach(b => b.classList.toggle('on', b === e.target));
  document.getElementById('paneA').classList.toggle('hide', v === 'B');
  document.getElementById('paneB').classList.toggle('hide', v === 'A');
  setTimeout(() => { Object.values(maps).forEach(m => { try { m.resize(); } catch (x) {} }); }, 30);
});
const linkBtn = document.getElementById('linkBtn');
linkBtn.addEventListener('click', () => { linkOn = !linkOn; linkBtn.classList.toggle('on', linkOn); linkBtn.textContent = linkOn ? '联动已开' : '联动已关'; });

function haversineKm(p1, p2) {
  const R = 6371, dLat = (p2.lat - p1.lat) * Math.PI / 180, dLon = (p2.lon - p1.lon) * Math.PI / 180;
  const a = Math.sin(dLat / 2) ** 2 + Math.cos(p1.lat * Math.PI / 180) * Math.cos(p2.lat * Math.PI / 180) * Math.sin(dLon / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}
function showFallback() {
  ['A', 'B'].forEach(k => { const el = document.getElementById('fb' + k); if (el) el.style.display = 'block'; });
  document.getElementById('foot').innerHTML += ' · ⚠ 高德地图未能加载，当前为简化示意图（无底图，仅展示路线结构）';
}
// 高德 JS 加载失败（无外网/域名白名单/key 受限）时降级为内嵌 SVG 示意图
if (!window.AMap) { showFallback(); }
const straight = key => data[key].slice(0, -1).reduce((s, seg, i) => s + haversineKm(seg.p, data[key][i + 1].p), 0);
function updateFoot() {
  const fmt = key => realDist[key] != null
    ? '<b>' + realDist[key].toFixed(1) + ' km</b>（实际道路）'
    : straight(key).toFixed(1) + ' km（直线参考）';
  document.getElementById('foot').innerHTML =
    '里程：原始 ' + fmt('A') + ' · 优化后 ' + fmt('B') +
    ' · 点位 ' + N + ' 个' + (D.strategy ? ' · 策略 ' + D.strategy : '') +
    ' · 地图数据：高德 JS API（驾车规划路径）' +
    '<br>提示：工作台内嵌预览不执行脚本、地图会空白——请点右上角「在浏览器打开」或下载后双击打开本文件。';
}
updateFoot();
</script>
</body>
</html>`;
}

async function executeRouteMap(call, root, signal) {
  const a = call.arguments || {};
  const n = a.points.length;
  const originalOrder = a.originalOrder && a.originalOrder.length ? a.originalOrder : Array.from({ length: n }, (_, i) => i);
  const optimizedOrder = a.optimizedOrder;
  const isPerm = (arr) => Array.isArray(arr) && arr.length === n && new Set(arr).size === n && arr.every(i => Number.isInteger(i) && i >= 0 && i < n);
  if (!isPerm(originalOrder)) throw new Error('originalOrder 必须是 0..' + (n - 1) + ' 的完整排列');
  if (!isPerm(optimizedOrder)) throw new Error('optimizedOrder 必须是 0..' + (n - 1) + ' 的完整排列');
  signal.throwIfAborted();
  const points = normalizePoints(a.points, a.coordSystem === 'wgs84' ? 'wgs84' : 'gcj02');
  const routeName = a.routeName ? String(a.routeName).slice(0, 200) : '路线对比';
  const html = buildRouteMapHtml({
    routeName, points, originalOrder, optimizedOrder,
    strategy: a.strategy, distanceKm: a.distanceKm, savedPercent: a.savedPercent,
  });
  const workspace = await ensureWorkspace(root, call);
  const fileName = AMAP_FILENAME_SAFE(`${routeName}-优化前后对比`) + '.html';
  const target = path.join(workspace.output, fileName);
  await fs.writeFile(target, html, 'utf8');
  const checksum = createHash('sha256').update(html).digest('hex');
  const reference = 'workspace://' + path.relative(root, target).split(path.sep).join('/');
  const artifact = process.env.KLA_LOCAL_ARTIFACT_UPLOAD === 'false' ? undefined
    : { fileName, content: html, mimeType: 'text/html', checksum };
  return { result: { fileName, sizeBytes: Buffer.byteLength(html), checksum, stored: true, uploaded: Boolean(artifact), pointsCount: n, ...(reference ? { path: reference, deviceLocal: true } : {}) }, ...(artifact ? { artifact } : {}) };
}

// ==================== 工具入口 ====================
async function executeRoute(call, root, signal) {
  if (!capabilities.includes(call.tool)) throw new Error('不支持的路线规划技能');
  signal.throwIfAborted();
  if (call.tool === 'local_route_map') return executeRouteMap(call, root, signal);
  const a = call.arguments || {};
  const coordSystem = a.coordSystem === 'wgs84' ? 'wgs84' : 'gcj02';
  if (call.tool === 'local_route_matrix') {
    const points = normalizePoints(a.points, coordSystem);
    const kind = a.kind === 'toll' ? 'toll' : 'distance';
    const cacheKey = (kind === 'toll' ? 'toll:' : '') + matrixCacheKey(points);
    const cached = matrixCache.get(cacheKey);
    if (cached && Date.now() - cached.createdAt < AMAP_MATRIX_TTL) return { result: { ...cached.data, cached: true } };
    if (kind === 'toll') {
      const data = await fetchTollMatrix(points);
      matrixCache.set(cacheKey, { data, createdAt: Date.now() });
      return { result: data };
    }
    const data = await fetchDistanceTimeMatrix(points);
    matrixCache.set(cacheKey, { data, createdAt: Date.now() });
    return { result: data };
  }
  if (call.tool === 'local_route_optimize') {
    const routeName = a.routeName ? String(a.routeName).slice(0, 200) : '未命名线路';
    const strategy = ['mileage', 'time', 'cost'].includes(a.strategy) ? a.strategy : 'mileage';
    const points = normalizePoints(a.points, coordSystem);
    if (points.length < 2) throw new Error('至少需要 2 个点位');
    const n = points.length;
    // 矩阵：调用方提供优先；缺省时自动调高德（distance 请求同时给出 distance+time）
    let distM = validMatrix(a.distanceMatrix, n);
    let timeM = validMatrix(a.timeMatrix, n);
    let tollM = validMatrix(a.tollMatrix, n);
    let matrixNote = [];
    if (!distM || !timeM) {
      const fetched = await fetchDistanceTimeMatrix(points);
      if (!distM) { distM = fetched.distance; matrixNote.push(`距离矩阵来源=${fetched.source}（估算段 ${fetched.estimatedPairs}/${fetched.totalPairs}）${fetched.amapError ? `，高德失败原因：${fetched.amapError}` : ''}`); }
      if (!timeM) timeM = fetched.time;
    }
    if (strategy === 'cost' && !tollM) {
      const fetched = await fetchTollMatrix(points);
      tollM = fetched.toll;
      const usable = fetched.noKey ? 0 : (fetched.totalPairs - fetched.failedPairs - fetched.skippedPairs);
      if (fetched.noKey || usable === 0) throw new Error('过路费矩阵不可用（高德 direction 全部失败或被跳过），成本最优策略无法执行；请改用 mileage/time 策略');
      matrixNote.push(`过路费矩阵来源=amap（失败 ${fetched.failedPairs} / 跳过 ${fetched.skippedPairs} / 总计 ${fetched.totalPairs}）`);
    }
    // 按 strategy 选择优化矩阵：cost→toll；time→time；否则 distance（server.js:4908-4924）
    let optimizeMatrix, optimizeMetric;
    if (strategy === 'cost' && tollM) { optimizeMatrix = tollM; optimizeMetric = 'toll'; }
    else if (strategy === 'time' && timeM) { optimizeMatrix = timeM; optimizeMetric = 'time'; }
    else { optimizeMatrix = distM; optimizeMetric = 'distance'; }
    const originalOrder = seqOrder(n);
    const { order, improved } = optimizeRouteOrder(points, optimizeMatrix);
    const optimizedPoints = order.map(idx => ({ ...points[idx], originalIndex: idx }));
    const originalDistance = orderCost(originalOrder, distM, points);
    const optimizedDistance = orderCost(order, distM, points);
    const originalTime = timeM ? orderCost(originalOrder, timeM, points) : null;
    const optimizedTime = timeM ? orderCost(order, timeM, points) : null;
    const originalToll = tollM ? orderCost(originalOrder, tollM, points) : null;
    const optimizedToll = tollM ? orderCost(order, tollM, points) : null;
    const segmentDistances = [], cumulativeDistances = [];
    let cumulative = 0;
    for (let k = 0; k < order.length; k++) {
      if (k < order.length - 1) {
        const seg = matrixDistance(points, order[k], order[k + 1], distM);
        segmentDistances.push(round(seg, 3));
        cumulative += seg;
      } else segmentDistances.push(0);
      cumulativeDistances.push(round(cumulative, 3));
    }
    return { result: {
      routeName,
      originalPoints: points,
      optimizedPoints,
      originalDistance: round(originalDistance, 3),
      optimizedDistance: round(optimizedDistance, 3),
      savedDistance: round(originalDistance - optimizedDistance, 3),
      savedPercent: originalDistance > 0 ? round((originalDistance - optimizedDistance) / originalDistance * 100, 2) : 0,
      originalTime: originalTime !== null ? round(originalTime, 1) : null,
      optimizedTime: optimizedTime !== null ? round(optimizedTime, 1) : null,
      savedTime: originalTime !== null && optimizedTime !== null ? round(originalTime - optimizedTime, 1) : null,
      originalToll: originalToll !== null ? round(originalToll, 2) : null,
      optimizedToll: optimizedToll !== null ? round(optimizedToll, 2) : null,
      savedToll: originalToll !== null && optimizedToll !== null ? round(originalToll - optimizedToll, 2) : null,
      savedTollPercent: originalToll !== null && originalToll > 0 ? round((originalToll - optimizedToll) / originalToll * 100, 2) : 0,
      segmentDistances,
      cumulativeDistances,
      optimizeMetric,
      strategy,
      orderChanged: improved,
      algorithm: 'multi-start(insertion+NN) + 2-opt + Or-opt + swap + ILS (fixed endpoints, ' + optimizeMetric + ' matrix)',
      matrixNote,
    } };
  }
  if (call.tool === 'local_route_replan') {
    const numRoutes = Math.max(2, Math.min(10, Number(a.numRoutes) || 2));
    const algorithm = a.algorithm === 'kmeans' ? 'kmeans' : 'balanced';
    const points = normalizePoints(a.points, coordSystem).map((p, i) => ({ ...p, id: `p${i}` }));
    if (points.length < numRoutes) throw new Error(`点位数（${points.length}）不能少于线路数（${numRoutes}）`);
    const rand = mulberry32(20260811);
    let groups;
    if (algorithm === 'kmeans') {
      groups = kMeansClustering(points, numRoutes, rand);
      groups = boundaryExchange(groups);
    } else {
      groups = balancedDistribution(points, numRoutes).map(r => r.points);
    }
    const newRoutes = [];
    let totalDistance = 0;
    groups.forEach((group, idx) => {
      if (!group || group.length === 0) return;
      const ordered = twoOptPoints(nearestNeighborRoute(group));
      const distanceKm = routeHaversineLength(ordered);
      totalDistance += distanceKm;
      newRoutes.push({
        id: idx + 1,
        name: `线路${idx + 1}`,
        points: ordered.map(p => ({ name: p.name, lat: round(p.lat, 6), lon: round(p.lon, 6), originalIndex: points.indexOf(p) })),
        pointCount: ordered.length,
        startPoint: ordered[0]?.name || null,
        endPoint: ordered[ordered.length - 1]?.name || null,
        distanceKm: round(distanceKm, 3), // 直线距离口径（Haversine），仅用于线路间均衡对比
      });
    });
    return { result: {
      algorithm,
      newRoutes,
      summary: {
        routeCount: newRoutes.length,
        totalPoints: newRoutes.reduce((s, r) => s + r.pointCount, 0),
        totalDistanceKm: round(totalDistance, 3),
      },
      note: '拆分与均衡基于 Haversine 直线距离；如需按真实道路里程评估，可对各线路再调用 local_route_optimize',
    } };
  }
  throw new Error('不支持的路线规划技能');
}

module.exports = { executeRoute, capabilities };
