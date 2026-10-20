/* =========================================================================
   ReelShort 剧集实时监控看板 — 原生 JS + 本地 ECharts 5.5.1
   数据来源：同源 /api/*（REST）与 /api/stream（SSE）；无框架、无外网 CDN。
   ========================================================================= */
(function () {
  'use strict';

  var QS = new URLSearchParams(location.search);
  var USE_MOCK = QS.get('mock') === '1';   /* 仅 ?mock=1 时用前端演示数据，默认关闭 */
  var RECONNECT_MS = 3000;
  var MONO = 'Consolas,"Cascadia Mono",Menlo,monospace';

  var RANGE_LIST = [
    { key: 'realtime', label: '实时', minutes: 30 },
    { key: '1h', label: '1h', minutes: 60 },
    { key: '6h', label: '6h', minutes: 360 },
    { key: '24h', label: '24h', minutes: 1440 },
    { key: 'all', label: '全部', minutes: 0 }
  ];
  var RANGE_MAP = {};
  RANGE_LIST.forEach(function (r) { RANGE_MAP[r.key] = r; });

  var C = {
    red: '#ff2d55', pink: '#ff6fa5', pinkSoft: '#ffb3cd', gold: '#ffc65c',
    amber: '#ffa14a', violet: '#a78bfa', blue: '#5aa9ff', green: '#2fe08a',
    txt2: '#aab0c4', txt3: '#6d7490'
  };

  var KPI_DEFS = [
    { key: 'readCount', name: '播放量', icon: '▶', unit: '次', kind: 'int', color: C.red,
      glow: 'rgba(255,45,85,.24)', fallback: 'read_count' },
    { key: 'collectCount', name: '收藏', icon: '✦', unit: '次', kind: 'int', color: C.gold,
      glow: 'rgba(255,197,92,.20)', fallback: 'collect_count' },
    { key: 'likeCount', name: '点赞', icon: '♥', unit: '次', kind: 'int', color: C.pink,
      glow: 'rgba(255,111,165,.22)', fallback: 'sum(online_base[].like_count)' },
    { key: 'engagementRate', name: '互动率', icon: '⚡', unit: '', kind: 'pct', color: C.violet,
      glow: 'rgba(167,139,250,.20)', fallback: '(收藏 + 点赞) / 播放量' },
    { key: 'collectRate', name: '收藏转化率', icon: '◈', unit: '', kind: 'pct', color: C.blue,
      glow: 'rgba(90,169,255,.18)', fallback: '收藏 / 播放量' },
    { key: 'heatIndex', name: '热度指数', icon: '◎', unit: '', kind: 'num1', color: C.amber,
      glow: 'rgba(255,161,74,.20)', fallback: '0.45×点赞率 + 0.35×收藏率 + 0.20×播放量权重' }
  ];

  var CONTRAST_META = {
    likeCount: { key: 'likeCount', name: '点赞', color: C.pink },
    collectCount: { key: 'collectCount', name: '收藏', color: C.gold }
  };
  var RATIO_META = {
    engagementRate: { key: 'engagementRate', name: '互动率', color: C.pink },
    likeRate: { key: 'likeRate', name: '点赞率', color: C.red },
    collectRate: { key: 'collectRate', name: '收藏率', color: C.gold },
    heatIndex: { key: 'heatIndex', name: '热度指数', color: C.violet }
  };

  var state = {
    meta: null, drama: null, metrics: [],
    snapshot: null, derived: {}, growth: {}, delta: null, deltaObj: null, ratePerMinVal: null,
    allPoints: [], points: [], episodes: [], funnel: null, episodesFromApi: false,
    total: 56, paidStart: 12, pollMs: 60000, sampleCount: 0,
    range: 'realtime', trendMode: 'volume', contrast: 'collectCount',
    ratioSel: { engagementRate: true, likeRate: false, collectRate: false, heatIndex: true },
    conn: 'connecting', lastTs: 0, lastReceivedAt: 0, lastStreamAt: 0,
    kpiRefs: {}, charts: {}, structureSig: '',
    es: null, reconnectTimer: null, bootTimer: null,
    mockTimer: null, mock: null, mockPoints: [], mockSnap: null
  };

  /* ------------------------------ utils ------------------------------ */
  var nf = new Intl.NumberFormat('en-US');
  function $id(id) { return document.getElementById(id); }
  function setText(id, text) { var el = $id(id); if (el) el.textContent = text; }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function isNum(v) { return typeof v === 'number' && isFinite(v); }
  function fmtInt(v) { return isNum(v) ? nf.format(Math.round(v)) : '—'; }
  function fmtAxis(v) {
    if (!isNum(v)) return '—';
    var a = Math.abs(v);
    if (a >= 1e8) return (v / 1e8).toFixed(1) + '亿';
    if (a >= 1e4) return (v / 1e4).toFixed(a >= 1e6 ? 0 : 1) + '万';
    if (a >= 1000) return (v / 1000).toFixed(1) + 'k';
    if (a >= 10) return String(Math.round(v));
    return String(Math.round(v * 10) / 10);
  }
  function fmtSigned(v) {
    if (!isNum(v)) return '—';
    var s = (v > 0 ? '+' : '') + fmtAxis(v);
    return s;
  }
  function fmtPct(v, d) {
    if (!isNum(v)) return '—';
    return (v * 100).toFixed(d == null ? 2 : d) + '%';
  }
  function fmtPP(v, d) {
    if (!isNum(v)) return '—';
    var x = v * 100, sign = x > 0 ? '+' : '';
    return sign + x.toFixed(d == null ? 2 : d) + 'pp';
  }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function fmtClock(ts) {
    if (!isNum(ts)) return '—';
    var d = new Date(ts * 1000);
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtFull(ts) {
    if (!isNum(ts)) return '—';
    var d = new Date(ts * 1000);
    return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function fmtTimeShort(ms, spanSec) {
    var d = new Date(ms);
    if (spanSec > 36 * 3600) return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' + pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    if (spanSec > 3600) return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
    return pad2(d.getHours()) + ':' + pad2(d.getMinutes()) + ':' + pad2(d.getSeconds());
  }
  function hexA(hex, a) {
    var h = String(hex).replace('#', '');
    if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
    var r = parseInt(h.substring(0, 2), 16), g = parseInt(h.substring(2, 4), 16), b = parseInt(h.substring(4, 6), 16);
    return 'rgba(' + r + ',' + g + ',' + b + ',' + a + ')';
  }
  function debounce(fn, ms) {
    var t = null;
    return function () { var args = arguments, self = this; clearTimeout(t); t = setTimeout(function () { fn.apply(self, args); }, ms); };
  }
  function relTime(ms) {
    if (!ms) return '—';
    var s = Math.round((Date.now() - ms) / 1000);
    if (s < 5) return '刚刚';
    if (s < 60) return s + ' 秒前';
    if (s < 3600) return Math.floor(s / 60) + ' 分钟前';
    if (s < 86400) return Math.floor(s / 3600) + ' 小时前';
    return Math.floor(s / 86400) + ' 天前';
  }

  /* ------------------------------ API ------------------------------ */
  function fetchJSON(url, opt) {
    var o = opt || {};
    var ctl = typeof AbortController !== 'undefined' ? new AbortController() : null;
    var timer = setTimeout(function () { if (ctl) ctl.abort(); }, o.timeout || 9000);
    var init = { method: o.method || 'GET', headers: { 'accept': 'application/json' } };
    if (ctl) init.signal = ctl.signal;
    return fetch(url, init).then(function (res) {
      clearTimeout(timer);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
    }).then(function (json) {
      if (json && json.ok === false) throw new Error(json.error || '接口返回失败');
      if (json && Object.prototype.hasOwnProperty.call(json, 'data')) return json.data;
      return json;
    }).catch(function (err) { clearTimeout(timer); throw err; });
  }
  function apiGet(path) {
    if (USE_MOCK) return Promise.resolve(mockApi(path));
    return fetchJSON(path);
  }
  function apiPost(path) {
    if (USE_MOCK) return Promise.resolve(mockApi(path));
    return fetchJSON(path, { method: 'POST' });
  }

  /* ------------------------------ 指标计算（后端缺失时兜底） ------------------------------ */
  function computeDerived(s) {
    if (!s) return {};
    var read = isNum(s.readCount) ? s.readCount : 0;
    var col = isNum(s.collectCount) ? s.collectCount : 0;
    var like = isNum(s.likeCount) ? s.likeCount : 0;
    var paidStart = isNum(s.paidStart) ? s.paidStart : state.paidStart;
    var total = isNum(s.total) ? s.total : state.total;
    var eps = Array.isArray(s.episodes) ? s.episodes : [];
    var free = 0, paid = 0, fn = 0, pn = 0;
    eps.forEach(function (e) {
      var n = e.n, l = isNum(e.likes) ? e.likes : 0;
      if (n < paidStart) { free += l; fn++; } else { paid += l; pn++; }
    });
    var freeAvg = fn ? free / fn : 0, paidAvg = pn ? paid / pn : 0;
    var likeRate = read ? like / read : 0;
    var collectRate = read ? col / read : 0;
    var first = eps.length && isNum(eps[0].likes) ? eps[0].likes : 0;
    var last = eps.length && isNum(eps[eps.length - 1].likes) ? eps[eps.length - 1].likes : 0;
    var raw = 0.45 * likeRate * 100 + 0.35 * collectRate * 100 + 0.20 * Math.min(read / 1e6, 1) * 100;
    return {
      readCount: read, collectCount: col, likeCount: like,
      engagementRate: read ? (col + like) / read : 0,
      collectRate: collectRate, likeRate: likeRate,
      paidRatio: total ? (total - paidStart + 1) / total : 0,
      freeLikes: free, paidLikes: paid,
      conversionProxy: freeAvg ? (freeAvg - paidAvg) / freeAvg : 0,
      completionProxy: first ? last / first : 0,
      heatIndex: Math.round(raw * 10) / 10
    };
  }
  function computeFunnel(eps, paidStart) {
    var free = 0, paid = 0, fn = 0, pn = 0;
    (eps || []).forEach(function (e) {
      var l = isNum(e.likes) ? e.likes : 0;
      if (e.n < paidStart) { free += l; fn++; } else { paid += l; pn++; }
    });
    var freeAvg = fn ? free / fn : 0, paidAvg = pn ? paid / pn : 0;
    var first = eps && eps.length && isNum(eps[0].likes) ? eps[0].likes : 0;
    var last = eps && eps.length && isNum(eps[eps.length - 1].likes) ? eps[eps.length - 1].likes : 0;
    return {
      freeAvgLikes: freeAvg, paidAvgLikes: paidAvg, freeTotal: free, paidTotal: paid,
      conversionProxy: freeAvg ? (freeAvg - paidAvg) / freeAvg : 0,
      completionProxy: first ? last / first : 0
    };
  }

  /* ------------------------------ 顶部信息 ------------------------------ */
  function formulaFor(key) {
    var def = KPI_DEFS.filter(function (d) { return d.key === key; })[0];
    var m = (state.metrics || []).filter(function (x) { return x && x.key === key; })[0];
    if (m && m.formula) return m.formula;
    return def ? def.fallback : '';
  }

  var coverBound = false;
  function setCover(url, title) {
    var img = $id('coverImg'), sk = $id('coverSkeleton'), box = $id('coverBox');
    if (!img || !box) return;
    if (!coverBound) {
      coverBound = true;
      img.addEventListener('load', function () {
        img.classList.add('loaded');
        if (sk) sk.hidden = true;
        box.classList.remove('cover-fail');
      });
      img.addEventListener('error', function () {
        img.classList.remove('loaded');
        if (sk) sk.hidden = true;
        box.classList.add('cover-fail');
        var initial = (title || '').trim().charAt(0).toUpperCase() || 'R';
        box.setAttribute('data-initial', initial);
      });
    }
    if (url && img.getAttribute('data-src') !== url) {
      img.setAttribute('data-src', url);
      img.classList.remove('loaded');
      if (sk) sk.hidden = false;
      if (box) box.classList.remove('cover-fail');
      img.src = url;
    }
  }

  function renderHeader() {
    var d = state.drama || {};
    if (d.title) {
      setText('dramaTitle', d.title);
      var h1 = $id('dramaTitle');
      if (h1 && d.desc) h1.title = d.desc;
      document.title = d.title + ' · ReelShort 实时监控';
    }
    var tagRow = $id('tagRow');
    if (tagRow && (d.tags || d.bookMark || USE_MOCK)) {
      var html = '';
      if (USE_MOCK) html += '<span class="tag new">MOCK 演示</span>';
      if (d.bookMark && d.bookMark.text) html += '<span class="tag new">' + esc(d.bookMark.text) + '</span>';
      (d.tags || []).slice(0, 7).forEach(function (t) { html += '<span class="tag">' + esc(t) + '</span>'; });
      if (html !== tagRow.innerHTML) tagRow.innerHTML = html;
    }
    /* 封面 */
    setCover(d.cover, d.title);
    setText('metaTotal', state.total ? state.total + ' 集' : '—');
    setText('metaPaid', isNum(state.paidStart) ? '第 ' + state.paidStart + ' 集起' : '—');
    setText('metaSamples', state.sampleCount ? fmtInt(state.sampleCount) + ' 条' : (state.points.length ? state.points.length + ' 条' : '—'));
    setText('metaPoll', state.pollMs ? Math.round(state.pollMs / 1000) + ' 秒' : '—');
    updateMetaLast();
  }
  function updateMetaLast() {
    var el = $id('metaLast');
    if (!el) return;
    if (!state.lastTs) { el.textContent = '—'; return; }
    el.textContent = fmtClock(state.lastTs) + (state.lastReceivedAt ? ' · ' + relTime(state.lastReceivedAt) : '');
  }

  /* ------------------------------ KPI 卡片 ------------------------------ */
  function buildKpiCards() {
    var grid = $id('kpiGrid');
    if (!grid) return;
    var html = '';
    KPI_DEFS.forEach(function (def, i) {
      html += '<div class="kpi" data-kpi="' + def.key + '" style="--i:' + i + ';--glow:' + def.glow + '">'
        + '<div class="kpi-head"><span class="k-ico" style="color:' + def.color + '">' + def.icon + '</span>'
        + '<span>' + def.name + '</span>'
        + '<span class="info" data-tip="' + esc('公式：' + formulaFor(def.key)) + '">i</span></div>'
        + '<div class="kpi-val"><span class="k-num" style="color:' + (def.key === 'heatIndex' ? C.amber : '#f3f4f8') + '">—</span>'
        + (def.unit ? '<span class="unit">' + def.unit + '</span>' : '') + '</div>'
        + '<div class="kpi-foot"><span class="pill flat" data-pill title="相对本次加载范围内的首个采样点"><em class="pill-tag">累计</em><span data-delta>—</span></span>'
        + '<span class="kpi-sub"><b data-rate>—</b></span></div>'
        + '<div class="spark" data-spark="' + def.key + '"></div>'
        + '</div>';
    });
    grid.innerHTML = html;
    KPI_DEFS.forEach(function (def) {
      var card = grid.querySelector('[data-kpi="' + def.key + '"]');
      state.kpiRefs[def.key] = {
        num: card.querySelector('.k-num'),
        delta: card.querySelector('[data-delta]'),
        pill: card.querySelector('[data-pill]'),
        rate: card.querySelector('[data-rate]'),
        spark: card.querySelector('[data-spark]'),
        color: def.color, kind: def.kind
      };
    });
  }

  function metricValue(key) {
    var d = state.derived || {};
    if (key === 'readCount' || key === 'collectCount' || key === 'likeCount') {
      if (state.snapshot && isNum(state.snapshot[key])) return state.snapshot[key];
    }
    if (isNum(d[key])) return d[key];
    if (state.snapshot && isNum(state.snapshot[key])) return state.snapshot[key];
    return null;
  }

  function ratePerMin(key) {
    /* 用最近 5 分钟窗口做平均速度，比「最后两点」稳定得多；
       后端 ratePerMin 在"最后两点恰好相等"时会返回 0，故不作为主口径。 */
    var pts = filteredPoints();
    if (pts.length >= 2) {
      var last = pts[pts.length - 1];
      var target = last.ts - 5 * 60;
      var base = pts[0];
      for (var i = pts.length - 1; i >= 0; i--) {
        if (pts[i].ts <= target) { base = pts[i]; break; }
      }
      var spanMin = (last.ts - base.ts) / 60;
      if (spanMin > 0 && isNum(base[key]) && isNum(last[key])) return (last[key] - base[key]) / spanMin;
    }
    return null;
  }

  function deltaValue(key) {
    var d = state.delta;
    if (d && typeof d === 'object' && isNum(d[key])) return d[key];
    if (isNum(d) && key === 'readCount') return d;
    var pts = filteredPoints();
    if (pts.length >= 1) {
      var cur = metricValue(key), base = pts[0][key];
      if (isNum(cur) && isNum(base)) return cur - base;
    }
    return null;
  }

  function fmtKpiValue(kind, v) {
    if (!isNum(v)) return '—';
    if (kind === 'pct') return (v * 100).toFixed(2) + '%';
    if (kind === 'num1') return v.toFixed(1);
    return fmtInt(v);
  }
  function fmtKpiDelta(kind, v) {
    if (!isNum(v)) return '—';
    if (kind === 'pct') return (v >= 0 ? '+' : '') + (v * 100).toFixed(2) + 'pp';
    if (kind === 'num1') return (v >= 0 ? '+' : '') + v.toFixed(1);
    return (v > 0 ? '+' : '') + fmtInt(v);
  }
  function fmtKpiRate(kind, v) {
    if (!isNum(v)) return '—';
    if (kind === 'pct') return (v > 0 ? '+' : '') + (v * 100).toFixed(3) + 'pp/分';
    if (kind === 'num1') return (v > 0 ? '+' : '') + v.toFixed(2) + '/分';
    return (v > 0 ? '+' : '') + fmtAxis(v) + '/分';
  }

  function tweenNumber(el, to, formatter) {
    if (!el) return;
    var from = el.__v;
    if (!isNum(to)) { el.textContent = formatter(to); return; }
    if (!isNum(from) || Math.abs(to - from) < 1e-9) {
      el.__v = to; el.textContent = formatter(to); return;
    }
    if (el.__raf) cancelAnimationFrame(el.__raf);
    var t0 = performance.now(), dur = 620;
    function step(t) {
      var k = Math.min(1, (t - t0) / dur);
      var e = 1 - Math.pow(1 - k, 3);
      var v = from + (to - from) * e;
      el.textContent = formatter(v);
      if (k < 1) el.__raf = requestAnimationFrame(step);
      else { el.__v = to; el.__raf = null; }
    }
    el.__raf = requestAnimationFrame(step);
  }

  function renderKPIs() {
    var pts = filteredPoints();
    KPI_DEFS.forEach(function (def) {
      var ref = state.kpiRefs[def.key];
      if (!ref) return;
      var cur = metricValue(def.key);
      if (isNum(cur)) tweenNumber(ref.num, cur, function (v) { return fmtKpiValue(def.kind, v); });
      else ref.num.textContent = '—';
      var dv = deltaValue(def.key);
      ref.delta.textContent = dv == null ? '—' : fmtKpiDelta(def.kind, dv);
      ref.pill.className = 'pill ' + (dv == null ? 'flat' : dv > 0 ? 'up' : dv < 0 ? 'down' : 'flat');
      ref.pill.title = dv == null ? '暂无对比基准' : '相对范围内首个采样点的累计变化';
      ref.rate.innerHTML = rateSubHtml(def, pts);
      var vals = pts.map(function (p) { return p[def.key]; }).filter(isNum);
      drawSpark(ref.spark, vals, def.color, 'sp-' + def.key);
    });
  }

  /* 增速文案：比率/指数类用「近 N 分钟 Δ」，计数类用「X/分」 */
  function rateSubHtml(def, pts) {
    if (def.kind === 'int') {
      var rv = ratePerMin(def.key);
      if (rv == null) {
        var d0 = deltaValue(def.key);
        return d0 == null ? '<span class="kpi-sub-na">等待更多采样</span>'
          : '累计 <b>' + fmtKpiDelta('int', d0) + '</b>';
      }
      return '增速 <b>' + fmtKpiRate('int', rv) + '</b>';
    }
    var win = recentWindowDelta(def.key, pts);
    if (!win) return '<span class="kpi-sub-na">等待更多采样</span>';
    var sign = win.delta >= 0 ? '+' : '';
    var txt, unit;
    if (def.kind === 'pct') { txt = sign + (win.delta * 100).toFixed(3); unit = 'pp'; }
    else { txt = sign + win.delta.toFixed(1); unit = ''; }
    var cls = win.delta > 0 ? 'up' : win.delta < 0 ? 'down' : '';
    return '近 ' + win.minutes + ' 分钟 <b class="' + cls + '">' + txt + unit + '</b>';
  }

  function recentWindowDelta(key, pts) {
    var arr = pts && pts.length ? pts : filteredPoints();
    if (arr.length < 2) return null;
    var last = arr[arr.length - 1];
    var targetTs = last.ts - 5 * 60;
    var base = arr[0];
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].ts <= targetTs) { base = arr[i]; break; }
      if (i === 0) base = arr[0];
    }
    var a = base[key], b = last[key];
    if (!isNum(a) || !isNum(b)) return null;
    var minutes = Math.max(1, Math.round((last.ts - base.ts) / 60));
    return { delta: b - a, minutes: minutes };
  }

    function drawSpark(host, values, color, uid) {
    if (!host) return;
    if (!values || values.length === 0) { host.innerHTML = ''; return; }
    var W = 100, H = 34, P = 4;
    var vals = values.length === 1 ? [values[0], values[0]] : values.slice();
    var min = Math.min.apply(null, vals), max = Math.max.apply(null, vals);
    var span = max - min;
    var mid = (max + min) / 2;
    /* 相对波动 < 0.15% 视为「持平」：画成平直中线，避免把 ±1 的抖动放大成满屏锯齿 */
    var isFlat = !(span > 0) || (mid !== 0 && span / Math.abs(mid) < 0.0015);
    var pts;
    if (isFlat) {
      pts = vals.map(function (v, i) { return [ (i / (vals.length - 1 || 1)) * W, H / 2 ]; });
    } else {
      var pad = span * 0.12;
      var lo = min - pad, hi = max + pad;
      var sc = hi - lo || 1;
      pts = vals.map(function (v, i) {
        return [ (i / (vals.length - 1 || 1)) * W, H - P - ((v - lo) / sc) * (H - P * 2) ];
      });
    }
    var d = pts.map(function (p, i) { return (i ? 'L' : 'M') + p[0].toFixed(2) + ' ' + p[1].toFixed(2); }).join(' ');
    var area = d + ' L ' + W + ' ' + H + ' L 0 ' + H + ' Z';
    var last = pts[pts.length - 1];
    host.innerHTML = '<svg viewBox="0 0 100 34" preserveAspectRatio="none" width="100%" height="100%">'
      + '<defs><linearGradient id="' + uid + '" x1="0" y1="0" x2="0" y2="1">'
      + '<stop offset="0" stop-color="' + color + '" stop-opacity=".34"/>'
      + '<stop offset="1" stop-color="' + color + '" stop-opacity="0"/></linearGradient></defs>'
      + '<path d="' + area + '" fill="url(#' + uid + ')"/>'
      + '<path d="' + d + '" fill="none" stroke="' + color + '" stroke-width="1.6" '
      + 'vector-effect="non-scaling-stroke" stroke-linejoin="round" stroke-linecap="round"/>'
      + '<circle cx="' + last[0].toFixed(2) + '" cy="' + last[1].toFixed(2) + '" r="2.1" fill="' + color + '"/>'
      + '</svg>';
  }

  /* ------------------------------ 表格 / 页脚 ------------------------------ */
  function renderTable() {
    var body = $id('sampleBody');
    if (!body) return;
    var pts = state.allPoints.length ? state.allPoints : state.points;
    if (!pts.length) {
      body.innerHTML = '<tr><td colspan="8" class="empty">等待数据…</td></tr>';
      setText('tableMeta', '—');
      return;
    }
    var rows = [];
    var start = Math.max(0, pts.length - 20);
    for (var i = pts.length - 1; i >= start; i--) rows.push({ p: pts[i], prev: i > 0 ? pts[i - 1] : null, newest: i === pts.length - 1 });
    var html = '';
    rows.forEach(function (r, idx) {
      var p = r.p, prev = r.prev;
      var dRead = prev && isNum(p.readCount) && isNum(prev.readCount) ? p.readCount - prev.readCount : null;
      var dCol = prev && isNum(p.collectCount) && isNum(prev.collectCount) ? p.collectCount - prev.collectCount : null;
      var isFresh = r.newest && state.lastRenderedTopTs !== p.ts;
      var cls = r.newest ? ' class="newest' + (isFresh ? ' fresh' : '') + '"' : '';
      var style = '';
      html += '<tr' + cls + style + '>'
        + '<td><span class="time-cell"><i class="dotline"></i>' + fmtFull(p.ts) + '</span></td>'
        + '<td>' + fmtInt(p.readCount) + '</td>'
        + '<td>' + dCell(dRead) + '</td>'
        + '<td>' + fmtInt(p.collectCount) + '</td>'
        + '<td>' + dCell(dCol) + '</td>'
        + '<td>' + fmtInt(p.likeCount) + '</td>'
        + '<td>' + fmtPct(p.engagementRate, 2) + '</td>'
        + '<td>' + (isNum(p.heatIndex) ? p.heatIndex.toFixed(1) : '—') + '</td>'
        + '</tr>';
    });
    state.lastRenderedTopTs = pts[pts.length - 1].ts;
    body.innerHTML = html;
    setText('tableMeta', '共 ' + pts.length + ' 个样本 · 间隔 ' + Math.round((state.pollMs || 60000) / 1000) + 's · 最新 ' + fmtClock(state.lastTs));
  }
  function dCell(v) {
    if (!isNum(v)) return '<span class="d-flat">—</span>';
    if (v > 0) return '<span class="d-up">+' + fmtInt(v) + '</span>';
    if (v === 0) return '<span class="d-zero">0</span>';
    return '<span class="d-flat">' + fmtInt(v) + '</span>';
  }

  function renderFormulas() {
    var host = $id('formulaList');
    if (!host) return;
    var metrics = state.metrics && state.metrics.length ? state.metrics : KPI_DEFS.map(function (d) {
      return { key: d.key, name: d.name, formula: d.fallback, unit: d.unit };
    });
    var html = metrics.map(function (m) {
      return '<span class="formula-chip" title="' + esc(m.name + '：' + (m.formula || '')) + '">' + esc(m.name) + '</span>';
    }).join('');
    if (host.innerHTML !== html) host.innerHTML = html;
  }

  /* ------------------------------ 数据应用 ------------------------------ */
  function pointFromSnapshot(snap, derived) {
    if (!snap || !isNum(snap.ts)) return null;
    var d = derived || {};
    var read = isNum(snap.readCount) ? snap.readCount : 0;
    var col = isNum(snap.collectCount) ? snap.collectCount : 0;
    var like = isNum(snap.likeCount) ? snap.likeCount : 0;
    var likeRate = isNum(d.likeRate) ? d.likeRate : (read ? like / read : 0);
    var collectRate = isNum(d.collectRate) ? d.collectRate : (read ? col / read : 0);
    var engagementRate = isNum(d.engagementRate) ? d.engagementRate : (read ? (col + like) / read : 0);
    var heatIndex = isNum(d.heatIndex) ? d.heatIndex :
      Math.round((0.45 * likeRate * 100 + 0.35 * collectRate * 100 + 0.20 * Math.min(read / 1e6, 1) * 100) * 10) / 10;
    return {
      ts: snap.ts, iso: snap.iso || new Date(snap.ts * 1000).toISOString(),
      readCount: read, collectCount: col, likeCount: like,
      engagementRate: engagementRate, collectRate: collectRate, likeRate: likeRate, heatIndex: heatIndex
    };
  }

  function mergePoint(p) {
    if (!p) return;
    var arr = state.allPoints;
    var i = -1;
    for (var k = arr.length - 1; k >= 0; k--) { if (arr[k].ts === p.ts) { i = k; break; } if (arr[k].ts < p.ts) break; }
    if (i >= 0) arr[i] = p;
    else {
      if (!arr.length || arr[arr.length - 1].ts < p.ts) arr.push(p);
      else { arr.push(p); arr.sort(function (a, b) { return a.ts - b.ts; }); }
    }
    if (arr.length > 5000) arr.splice(0, arr.length - 5000);
  }

  function filteredPoints() {
    var all = state.allPoints;
    if (!all.length) return [];
    var r = RANGE_MAP[state.range] || RANGE_MAP.realtime;
    if (!r.minutes) return all;
    var endTs = all[all.length - 1].ts;
    var from = endTs - r.minutes * 60;
    var out = all.filter(function (p) { return p.ts >= from; });
    if (out.length < 2 && all.length >= 2) return all.slice(-2);
    return out;
  }

  function applyMeta(meta) {
    if (!meta) return;
    if (meta.drama) {
      state.drama = meta.drama;
      if (isNum(meta.drama.total)) state.total = meta.drama.total;
      if (isNum(meta.drama.paidStart)) state.paidStart = meta.drama.paidStart;
    }
    if (Array.isArray(meta.metrics)) state.metrics = meta.metrics;
    if (isNum(meta.pollMs)) state.pollMs = meta.pollMs;
    buildKpiCards();
    renderHeader();
    renderFormulas();
    renderKPIs();
  }

  function applyLatest(data) {
    if (!data) return;
    if (data.snapshot) {
      state.snapshot = data.snapshot;
      if (isNum(data.snapshot.total)) state.total = data.snapshot.total;
      if (isNum(data.snapshot.paidStart)) state.paidStart = data.snapshot.paidStart;
      var p = pointFromSnapshot(data.snapshot, data.derived);
      if (p) { mergePoint(p); state.lastTs = Math.max(state.lastTs, p.ts); }
    }
    if (data.derived && typeof data.derived === 'object') state.derived = data.derived;
    if (data.growth && typeof data.growth === 'object') state.growth = data.growth;
    if (data.delta !== undefined) { state.delta = data.delta; state.deltaObj = data.delta; }
    if (data.ratePerMin !== undefined) {
      if (isNum(data.ratePerMin)) state.ratePerMinVal = data.ratePerMin;
      else if (data.ratePerMin && isNum(data.ratePerMin.readCount)) state.ratePerMinVal = data.ratePerMin.readCount;
    }
    if (isNum(data.sampleCount)) state.sampleCount = data.sampleCount;
    if (data.snapshot && Array.isArray(data.snapshot.episodes) && data.snapshot.episodes.length) {
      applyEpisodes(data.snapshot.episodes);
      scheduleEpisodesRefresh();
    }
    state.lastReceivedAt = Date.now();
    renderAll();
  }

  function applyEpisodes(eps, funnel) {
    if (!Array.isArray(eps) || !eps.length) return;
    state.episodes = eps.map(function (e) {
      return { n: e.n, id: e.id, likes: isNum(e.likes) ? e.likes : 0, dur: isNum(e.dur) ? e.dur : null, pic: e.pic, isPaid: e.isPaid };
    });
    var first = state.episodes[0].likes || 1;
    state.episodes.forEach(function (e) {
      e.likeRateVsFirst = isNum(e.likeRateVsFirst) ? e.likeRateVsFirst : e.likes / first;
      if (e.isPaid === undefined) e.isPaid = e.n >= state.paidStart;
    });
    state.funnel = funnel || computeFunnel(state.episodes, state.paidStart);
  }

  function renderAll() {
    renderHeader();
    renderKPIs();
    applyTrend();
    applyDelta();
    applyEpisodesChart();
    renderFunnel();
    renderTable();
    renderGrowthRow();
    renderFormulas();
  }

  /* ------------------------------ 图表基础 ------------------------------ */
  var chartReady = false;
  function initCharts() {
    if (typeof echarts === 'undefined' || !echarts || !echarts.init) {
      showAlert('图表库 /vendor/echarts.min.js 未加载，数据仍会实时刷新。', 'error');
      return false;
    }
    try {
      state.charts.trend = echarts.init($id('trendChart'), null, { renderer: 'canvas' });
      state.charts.delta = echarts.init($id('deltaChart'), null, { renderer: 'canvas' });
      state.charts.eps = echarts.init($id('epsChart'), null, { renderer: 'canvas' });
      state.charts.funnel = echarts.init($id('funnelChart'), null, { renderer: 'canvas' });
      chartReady = true;
      if (typeof ResizeObserver !== 'undefined') {
        var ro = new ResizeObserver(function (entries) {
          entries.forEach(function (en) {
            var id = en.target.id;
            var map = { trendChart: 'trend', deltaChart: 'delta', epsChart: 'eps', funnelChart: 'funnel' };
            var ch = state.charts[map[id]];
            if (ch && !ch.isDisposed()) ch.resize();
          });
        });
        ['trendChart', 'deltaChart', 'epsChart', 'funnelChart'].forEach(function (id) {
          var el = $id(id);
          if (el) ro.observe(el);
        });
        state._ro = ro;
      }
      return true;
    } catch (e) {
      showAlert('图表初始化失败：' + e.message, 'error');
      return false;
    }
  }
  function tipBase() {
    return {
      backgroundColor: 'rgba(13,14,21,.96)',
      borderColor: 'rgba(255,255,255,.14)',
      borderWidth: 1,
      padding: [9, 12],
      textStyle: { color: '#eef0f7', fontSize: 12, fontFamily: MONO },
      extraCssText: 'border-radius:10px;box-shadow:0 20px 48px -16px rgba(0,0,0,.92);backdrop-filter:blur(10px);'
    };
  }
  function axisCommon(left) {
    return {
      axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
      axisTick: { show: false },
      axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, hideOverlap: true },
      splitLine: left === false ? { show: false } : { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
    };
  }
  function areaGrad(color) {
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: hexA(color, .30) },
      { offset: 1, color: hexA(color, 0) }
    ]);
  }
  function barGrad(color) {
    return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
      { offset: 0, color: hexA(color, .98) },
      { offset: 1, color: hexA(color, .35) }
    ]);
  }
  function emptyChartOption(msg) {
    return {
      animation: false,
      title: { text: msg, left: 'center', top: 'middle', textStyle: { color: C.txt3, fontSize: 12, fontWeight: 400 } },
      xAxis: { show: false }, yAxis: { show: false }, series: []
    };
  }

  /* ------------------------------ 趋势图 ------------------------------ */
  function buildTrendOption() {
    var pts = filteredPoints();
    var mode = state.trendMode;
    if (!pts.length) return emptyChartOption('等待采样数据…');

    var spanSec = pts[pts.length - 1].ts - pts[0].ts;
    var xAxis = {
      type: 'time',
      boundaryGap: false,
      axisLine: axisCommon().axisLine,
      axisTick: { show: false },
      splitLine: { show: false },
      axisLabel: {
        color: C.txt3, fontSize: 10.5, fontFamily: MONO, hideOverlap: true,
        formatter: function (v) { return fmtTimeShort(v, Math.max(spanSec, 300)); }
      }
    };
    var grid = { left: 76, right: mode === 'volume' ? 104 : 34, top: 34, bottom: 26, containLabel: false };

    if (mode === 'volume') {
      var series = [];
      series.push({
        name: '播放量', type: 'line', smooth: pts.length >= 40 ? 'monotone' : false, showSymbol: pts.length <= 40,
        symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2.2, color: C.red, shadowColor: hexA(C.red, .55), shadowBlur: 12, shadowOffsetY: 3 },
        itemStyle: { color: C.red, borderColor: '#0a0a10', borderWidth: 1.5 },
        areaStyle: { color: areaGrad(C.red) },
        emphasis: { focus: 'series' },
        data: pts.map(function (p) { return [p.ts * 1000, p.readCount]; })
      });
      if (state.contrast === 'likeCount') {
        series.push({
          name: '点赞', type: 'line', yAxisIndex: 1, smooth: pts.length >= 40 ? 'monotone' : false, showSymbol: pts.length <= 40,
          symbol: 'circle', symbolSize: 4.5,
          lineStyle: { width: 1.9, color: C.pink },
          itemStyle: { color: C.pink, borderColor: '#0a0a10', borderWidth: 1.5 },
          data: pts.map(function (p) { return [p.ts * 1000, p.likeCount]; })
        });
      } else {
        series.push({
          name: '收藏', type: 'line', yAxisIndex: 1, smooth: pts.length >= 40 ? 'monotone' : false, showSymbol: pts.length <= 40,
          symbol: 'circle', symbolSize: 4.5,
          lineStyle: { width: 1.9, color: C.gold },
          itemStyle: { color: C.gold, borderColor: '#0a0a10', borderWidth: 1.5 },
          data: pts.map(function (p) { return [p.ts * 1000, p.collectCount]; })
        });
      }
      return {
        animation: true, animationDuration: 520, animationEasing: 'cubicOut',
        grid: grid,
        tooltip: {
          trigger: 'axis', confine: true, ...tipBase(),
          axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,45,85,.55)', width: 1, type: 'dashed' } },
          formatter: function (params) {
            if (!params || !params.length) return '';
            var head = '<div style="font-size:11px;color:#8b90a6;margin-bottom:6px">' + fmtFull(params[0].value[0] / 1000) + '</div>';
            return head + params.map(function (p) {
              return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0">'
                + '<i style="width:7px;height:7px;border-radius:50%;background:' + p.color + ';display:inline-block"></i>'
                + '<span style="color:#aab0c4">' + p.seriesName + '</span>'
                + '<b style="margin-left:auto;color:#fff">' + fmtInt(p.value[1]) + '</b></div>';
            }).join('');
          }
        },
        xAxis: xAxis,
        yAxis: [
          {
            type: 'value', scale: true, name: '播放量', nameTextStyle: { color: C.txt3, fontSize: 10, padding: [0, 0, 4, 0] },
            axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, margin: 10, formatter: function (v) { return nf.format(Math.round(v)); } },
            splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
          },
          {
            type: 'value', scale: true, name: state.contrast === 'likeCount' ? '点赞' : '收藏', nameGap: 14, nameTextStyle: { color: C.txt3, fontSize: 10, padding: [0, 0, 4, 0] },
            axisLine: { show: false }, axisTick: { show: false },
            axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, margin: 10, formatter: function (v) { return nf.format(Math.round(v)); } },
            splitLine: { show: false }
          }
        ],
        series: series
      };
    }
    /* 比率模式 */
    var ratioSeries = [];
    var ratioOrder = ['engagementRate', 'likeRate', 'collectRate', 'heatIndex'];
    ratioOrder.forEach(function (k) {
      if (!state.ratioSel[k]) return;
      var meta = RATIO_META[k];
      ratioSeries.push({
        name: meta.name, type: 'line', smooth: pts.length >= 40 ? 'monotone' : false, showSymbol: pts.length <= 40,
        symbol: 'circle', symbolSize: 5,
        lineStyle: { width: 2.1, color: meta.color },
        itemStyle: { color: meta.color, borderColor: '#0a0a10', borderWidth: 1.5 },
        emphasis: { focus: 'series' },
        data: pts.map(function (p) {
          var v = p[k];
          if (!isNum(v)) return [p.ts * 1000, null];
          return [p.ts * 1000, k === 'heatIndex' ? v : (v * 100)];
        })
      });
    });
    return {
      animation: true, animationDuration: 520,
      grid: grid,
      tooltip: {
        trigger: 'axis', confine: true, ...tipBase(),
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,45,85,.55)', type: 'dashed' } },
        formatter: function (params) {
          if (!params || !params.length) return '';
          var head = '<div style="font-size:11px;color:#8b90a6;margin-bottom:6px">' + fmtFull(params[0].value[0] / 1000) + '</div>';
          return head + params.map(function (p) {
            var isHeat = p.seriesName === '热度指数';
            return '<div style="display:flex;align-items:center;gap:8px;margin:3px 0">'
              + '<i style="width:7px;height:7px;border-radius:50%;background:' + p.color + ';display:inline-block"></i>'
              + '<span style="color:#aab0c4">' + p.seriesName + '</span>'
              + '<b style="margin-left:auto;color:#fff">' + (p.value[1] == null ? '—' : isHeat ? Number(p.value[1]).toFixed(1) : Number(p.value[1]).toFixed(2) + '%') + '</b></div>';
          }).join('');
        }
      },
      xAxis: xAxis,
      yAxis: [{
        type: 'value', scale: false, name: '比率 / 指数',
        nameTextStyle: { color: C.txt3, fontSize: 10, padding: [0, 0, 4, 0] },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, formatter: function (v) { return Math.round(v * 10) / 10; } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
      }],
      series: ratioSeries
    };
  }

  function applyTrend() {
    if (!chartReady) return;
    var ch = state.charts.trend;
    if (!ch) return;
    var opt = buildTrendOption();
    var sig = state.trendMode + '|' + state.contrast + '|' + JSON.stringify(state.ratioSel);
    if (sig !== state.trendSig) { state.trendSig = sig; ch.setOption(opt, true); }
    else ch.setOption(opt, false);
  }

  /* ------------------------------ 增量柱状图 ------------------------------ */
  /* 按时间桶聚合增量：真实数据是"突发式"更新（几十秒一次大跳），
     逐点画会把 2 秒间隔的 +775 放大成 23k/分，视觉上像噪声。
     这里按分钟（或更大）分桶求和，柱高 = 桶内增量 / 桶内观测时长，物理含义不变但更稳。 */
  function deltaSeriesData() {
    var pts = filteredPoints();
    if (pts.length < 2) return [];
    var spanMin = (pts[pts.length - 1].ts - pts[0].ts) / 60;
    var bucketMin = spanMin <= 60 ? 1 : spanMin <= 360 ? 5 : spanMin <= 1440 ? 15 : 60;
    var bucketSec = bucketMin * 60;
    var buckets = {};
    for (var i = 1; i < pts.length; i++) {
      var a = pts[i - 1], b = pts[i];
      var dt = b.ts - a.ts;
      if (!(dt > 0) || !isNum(a.readCount) || !isNum(b.readCount)) continue;
      var key = Math.floor(b.ts / bucketSec) * bucketSec;
      if (!buckets[key]) buckets[key] = { ts: key, delta: 0, durSec: 0, samples: 0 };
      buckets[key].delta += (b.readCount - a.readCount);
      buckets[key].durSec += dt;
      buckets[key].samples += 1;
    }
    var out = Object.keys(buckets).map(function (k) { return buckets[k]; }).sort(function (x, y) { return x.ts - y.ts; });
    out.forEach(function (d) {
      d.rate = d.durSec > 0 ? d.delta / (d.durSec / 60) : 0;
      d.bucketMin = bucketMin;
    });
    /* 桶太多时再合并一层 */
    var maxBars = 60;
    if (out.length <= maxBars) return out;
    var group = Math.ceil(out.length / maxBars);
    var merged = [];
    for (var k = 0; k < out.length; k += group) {
      var chunk = out.slice(k, k + group);
      var sumDelta = 0, sumDur = 0, sumSamples = 0;
      chunk.forEach(function (c) { sumDelta += c.delta; sumDur += c.durSec; sumSamples += c.samples; });
      merged.push({
        ts: chunk[0].ts, delta: sumDelta, durSec: sumDur, samples: sumSamples,
        rate: sumDur > 0 ? sumDelta / (sumDur / 60) : 0, bucketMin: bucketMin * group
      });
    }
    return merged;
  }
  function applyDelta() {
    var pts = filteredPoints();
    var data = deltaSeriesData();
    var subEl = document.querySelector('#deltaCard .card-title .sub');
    if (subEl && data.length) {
      var bm = data[0].bucketMin;
      var growthBars = data.filter(function (d) { return d.delta > 0; }).length;
      subEl.textContent = (bm > 1 ? bm + ' 分钟' : '每分钟') + '增量 · ' + data.length + ' 根柱 · ' + growthBars + ' 个区间有增长';
    }
    var rEl = $id('deltaLast');
    var recentRate = null;
    if (data.length) {
      var endTs = data[data.length - 1].ts + (data[0].bucketMin || 1) * 60;
      var recent = data.filter(function (d) { return d.ts >= endTs - 5 * 60; });
      var sumRate = 0, wsum = 0;
      recent.forEach(function (d) { sumRate += d.rate * d.durSec; wsum += d.durSec; });
      recentRate = wsum > 0 ? sumRate / wsum : null;
    }
    if (rEl) rEl.textContent = isNum(recentRate) ? fmtAxis(Math.round(recentRate * 10) / 10) : '—';
    if (!chartReady) return;
    var ch = state.charts.delta;
    if (!ch) return;
    if (!data.length) { ch.setOption(emptyChartOption('采样点不足，等待下一条数据…'), true); return; }
    var avg = data.reduce(function (sum, d) { return sum + d.rate; }, 0) / data.length;
    var spanSec = pts.length > 1 ? pts[pts.length - 1].ts - pts[0].ts : 300;
    var barCount = data.length;
    var barW = Math.max(6, Math.min(30, Math.floor(520 / Math.max(1, barCount))));
    var opt = {
      animation: true, animationDuration: 460, animationEasing: 'cubicOut',
      grid: { left: 54, right: 20, top: 30, bottom: 26 },
      tooltip: {
        trigger: 'axis', confine: true, ...tipBase(),
        axisPointer: { type: 'line', lineStyle: { color: 'rgba(255,45,85,.45)', type: 'dashed', width: 1 } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var d = data[ps[0].dataIndex];
          if (!d) return '';
          return '<div style="font-size:11px;color:#8b90a6;margin-bottom:6px">' + fmtFull(d.ts) + (d.bucketMin > 1 ? ' 起 ' + d.bucketMin + ' 分钟' : '') + '</div>'
            + '<div style="display:flex;gap:16px"><span style="color:#aab0c4">折算每分钟</span><b style="color:#ff8ab4">' + (d.rate >= 0 ? '+' : '') + fmtInt(Math.round(d.rate)) + ' /分</b></div>'
            + '<div style="display:flex;gap:16px;margin-top:2px"><span style="color:#aab0c4">区间增量</span><b style="color:#fff">' + (d.delta >= 0 ? '+' : '') + fmtInt(d.delta) + '</b></div>'
            + '<div style="display:flex;gap:16px;margin-top:2px"><span style="color:#aab0c4">观测时长</span><span style="color:#8b90a6">' + Math.round(d.durSec) + ' 秒</span></div>'
            + '<div style="display:flex;gap:16px;margin-top:2px"><span style="color:#aab0c4">采样点</span><span style="color:#8b90a6">' + d.samples + ' 个间隔</span></div>';
        }
      },
      xAxis: {
        type: 'time',
        boundaryGap: [0, 0.02],
        axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
        axisTick: { show: false },
        splitLine: { show: false },
        axisLabel: {
          color: C.txt3, fontSize: 10.5, fontFamily: MONO, hideOverlap: true,
          formatter: function (v) { return fmtTimeShort(v, Math.max(spanSec, 300)); }
        }
      },
      yAxis: {
        type: 'value',
        min: function (v) { return v.min < 0 ? Math.floor(v.min) : 0; },
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, formatter: fmtAxis },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
      },
      series: [{
        name: 'Δ 播放量/分', type: 'bar', barMaxWidth: barW, barMinWidth: 3, barMinHeight: 2,
        itemStyle: {
          borderRadius: [3, 3, 0, 0],
          color: function (p) {
            var v = p.value[1];
            if (v < 0) {
              return new echarts.graphic.LinearGradient(0, 1, 0, 0, [
                { offset: 0, color: 'rgba(140,145,180,.75)' },
                { offset: 1, color: 'rgba(96,100,132,.35)' }
              ]);
            }
            if (v === 0) return 'rgba(255,255,255,.18)';
            var k = avg > 0 ? Math.min(1, Math.abs(v) / (avg * 2)) : .6;
            return new echarts.graphic.LinearGradient(0, 0, 0, 1, [
              { offset: 0, color: 'rgba(255,150,190,' + (0.55 + k * 0.45).toFixed(2) + ')' },
              { offset: 1, color: 'rgba(255,45,85,' + (0.18 + k * 0.45).toFixed(2) + ')' }
            ]);
          }
        },
        emphasis: { itemStyle: { shadowBlur: 14, shadowColor: 'rgba(255,45,85,.65)' } },
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { color: 'rgba(255,197,92,.5)', type: 'dashed', width: 1 },
          label: { color: 'rgba(255,197,92,.9)', fontSize: 9.5, formatter: '均速 ' + Math.round(avg) + '/分', position: 'insideEndTop' },
          data: [{ yAxis: avg }]
        },
        data: data.map(function (d) { return [d.ts * 1000, Math.round(d.rate * 10) / 10]; })
      }]
    };
    ch.setOption(opt, true);
  }

  /* ------------------------------ 集数分布图 ------------------------------ */
  function applyEpisodesChart() {
    if (!chartReady) return;
    var ch = state.charts.eps;
    if (!ch) return;
    var eps = state.episodes;
    if (!eps || !eps.length) { ch.setOption(emptyChartOption('等待分集数据…'), true); return; }
    var paidStart = state.paidStart || 12;
    var maxLikes = Math.max.apply(null, eps.map(function (e) { return e.likes; }));
    var data = eps.map(function (e) {
      var paid = typeof e.isPaid === 'boolean' ? e.isPaid : e.n >= paidStart;
      return {
        value: e.likes,
        itemStyle: {
          borderRadius: [3, 3, 0, 0],
          color: paid
            ? new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(126,129,152,.85)' }, { offset: 1, color: 'rgba(70,72,92,.28)' }])
            : new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: 'rgba(255,111,165,.98)' }, { offset: 1, color: 'rgba(255,45,85,.42)' }])
        },
        emphasis: {
          itemStyle: {
            color: paid ? 'rgba(170,174,205,.98)' : '#ff8ab4',
            shadowBlur: 16, shadowColor: paid ? 'rgba(140,145,180,.6)' : 'rgba(255,45,85,.8)'
          }
        }
      };
    });
    /* 付费墙那一根高亮 */
    var wallIdx = Math.max(0, Math.min(eps.length - 1, paidStart - 1));
    data[wallIdx] = {
      value: eps[wallIdx].likes,
      itemStyle: {
        borderRadius: [3, 3, 0, 0],
        color: new echarts.graphic.LinearGradient(0, 0, 0, 1, [{ offset: 0, color: '#ffd27a' }, { offset: 1, color: 'rgba(255,161,74,.45)' }])
      },
      emphasis: { itemStyle: { color: '#ffe1a3', shadowBlur: 18, shadowColor: 'rgba(255,197,92,.9)' } }
    };
    var opt = {
      animation: true, animationDuration: 620, animationDelay: function (i) { return Math.min(i * 6, 320); },
      grid: { left: 46, right: 16, top: 30, bottom: 28 },
      tooltip: {
        trigger: 'axis', confine: true, ...tipBase(),
        axisPointer: { type: 'shadow', shadowStyle: { color: 'rgba(255,255,255,.05)' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var i = ps[0].dataIndex, e = eps[i];
          var paid = typeof e.isPaid === 'boolean' ? e.isPaid : e.n >= paidStart;
          var ratio = isNum(e.likeRateVsFirst) ? e.likeRateVsFirst : null;
          return '<div style="font-size:11.5px;color:#fff;margin-bottom:6px">第 ' + e.n + ' 集 '
            + '<span style="color:' + (paid ? '#ffc65c' : '#ff8ab4') + '">' + (paid ? '付费' : '免费') + '</span>'
            + (e.n === paidStart ? ' · <b style="color:#ffc65c">付费墙</b>' : '') + '</div>'
            + '<div style="display:flex;gap:14px"><span style="color:#aab0c4">点赞</span><b style="color:#fff">' + fmtInt(e.likes) + '</b></div>'
            + (e.dur ? '<div style="display:flex;gap:14px;margin-top:2px"><span style="color:#aab0c4">时长</span><span style="color:#8b90a6">' + Math.floor(e.dur / 60) + ' 分 ' + (e.dur % 60) + ' 秒</span></div>' : '')
            + (ratio != null ? '<div style="display:flex;gap:14px;margin-top:2px"><span style="color:#aab0c4">相对首集</span><span style="color:#8b90a6">' + (ratio * 100).toFixed(1) + '%</span></div>' : '');
        }
      },
      xAxis: {
        type: 'category',
        data: eps.map(function (e) { return String(e.n); }),
        axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
        axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10, fontFamily: MONO, interval: eps.length > 40 ? 4 : 1 }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10.5, fontFamily: MONO, formatter: function (v) { return nf.format(Math.round(v)); } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
      },
      series: [{
        name: '点赞', type: 'bar', barMaxWidth: 24, barCategoryGap: '22%',
        data: data,
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(255,197,92,.045)' },
          label: { show: true, position: 'insideTop', color: 'rgba(255,197,92,.75)', fontSize: 10, formatter: '付费区间（第 ' + paidStart + '–' + eps.length + ' 集）' },
          data: [[{ xAxis: String(paidStart) }, { xAxis: String(eps.length) }]]
        },
        markLine: {
          silent: true, symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(255,197,92,.8)', type: 'dashed', width: 1.4 },
          label: {
            show: true, position: 'end', rotate: 0, offset: [0, 6], color: '#ffd27a', fontSize: 10, fontWeight: 600,
            backgroundColor: 'rgba(255,161,74,.16)', borderColor: 'rgba(255,197,92,.45)', borderWidth: 1,
            borderRadius: 4, padding: [3, 6], formatter: '付费墙 · 第 ' + paidStart + ' 集'
          },
          data: [{ xAxis: String(paidStart) }]
        },
        markPoint: {
          symbol: 'circle', symbolSize: 0,
          data: [{ type: 'max', name: '峰值' }],
          label: { show: false }
        }
      }]
    };
    ch.setOption(opt, true);
  }

  /* ------------------------------ 付费章节热度 / 留存 ------------------------------ */
  function renderFunnel() {
    var eps = state.episodes, f = state.funnel;
    if (!eps || !eps.length) return;
    var funnel = f || computeFunnel(eps, state.paidStart);
    var paidStart = state.paidStart || 12;
    var tiles = $id('statTiles');
    if (tiles) {
      /* 热度比 = 付费集均赞 / 免费集均赞（clamp 到 [0, 2]，负值视为 0） */
      var heatRatioRaw = funnel.freeAvgLikes ? funnel.paidAvgLikes / funnel.freeAvgLikes : null;
      var heatRatio = heatRatioRaw == null ? null : Math.max(0, Math.min(2, heatRatioRaw));
      var comp = funnel.completionProxy;
      var compClamped = comp == null ? null : Math.max(0, comp);
      var over = heatRatioRaw != null && heatRatioRaw > 1;
      tiles.innerHTML =
        '<div class="tile"><span class="t-label">免费集均赞 <i class="info" data-tip="第 1–' + (paidStart - 1) + ' 集平均点赞数（真实公开数据）">i</i></span>'
        + '<span class="t-val">' + fmtInt(funnel.freeAvgLikes) + '</span>'
        + '<span class="t-hint">' + (funnel.freeTotal || paidStart - 1) + ' 集 · 合计 ' + fmtAxis(funnel.freeLikesTotal || funnel.freeAvgLikes * (funnel.freeTotal || paidStart - 1)) + '</span></div>'
        + '<div class="tile"><span class="t-label">付费集均赞 <i class="info" data-tip="第 ' + paidStart + '–' + eps.length + ' 集平均点赞数（公开数据）">i</i></span>'
        + '<span class="t-val">' + fmtInt(funnel.paidAvgLikes) + '</span>'
        + '<span class="t-hint">' + (funnel.paidTotal || (eps.length - paidStart + 1)) + ' 集 · 合计 ' + fmtAxis(funnel.paidLikesTotal || funnel.paidAvgLikes * (funnel.paidTotal || eps.length - paidStart + 1)) + '</span></div>'
        + '<div class="tile' + (over ? ' ok' : '') + '"><span class="t-label">付费章节热度比 <span class="est-badge">估算</span></span>'
        + '<span class="t-val big">' + (heatRatio == null ? '—' : (heatRatio * 100).toFixed(1) + '%') + '</span>'
        + '<span class="t-hint">' + (heatRatio == null ? '等待分集数据' : over ? '付费墙后热度持平甚至更高' : '付费墙后每集点赞略降') + '</span></div>'
        + '<div class="tile"><span class="t-label">追剧完成度 <span class="est-badge">估算</span></span>'
        + '<span class="t-val big' + (compClamped != null && compClamped < 0.5 ? ' warn-txt' : '') + '">' + (compClamped == null ? '—' : (compClamped * 100).toFixed(1) + '%') + '</span>'
        + '<span class="t-hint">末集 / 首集点赞比</span></div>';
    }
    setText('epsSub', '按集数 · 付费墙位于第 ' + paidStart + ' 集');
    if (!chartReady) return;
    var ch = state.charts.funnel;
    if (!ch) return;
    var series = eps.map(function (e) {
      var ratio = isNum(e.likeRateVsFirst) ? e.likeRateVsFirst : (eps[0].likes ? e.likes / eps[0].likes : 0);
      return { value: [e.n, Math.round(Math.max(0, ratio) * 1000) / 10], paid: e.isPaid };
    });
    var opt = {
      animation: true, animationDuration: 620,
      grid: { left: 40, right: 14, top: 16, bottom: 22 },
      tooltip: {
        trigger: 'axis', confine: true, ...tipBase(),
        axisPointer: { lineStyle: { color: 'rgba(255,45,85,.45)', type: 'dashed' } },
        formatter: function (ps) {
          if (!ps || !ps.length) return '';
          var v = ps[0].value, n = v[0], r = v[1];
          var paid = n >= paidStart;
          return '<div style="font-size:11.5px;color:#fff;margin-bottom:4px">第 ' + n + ' 集 · ' + (paid ? '付费章节' : '免费章节') + '</div>'
            + '<div style="display:flex;gap:14px"><span style="color:#aab0c4">相对首集热度</span><b style="color:#ff8ab4">' + r.toFixed(1) + '%</b></div>';
        }
      },
      xAxis: {
        type: 'value', min: 1, max: eps.length,
        axisLine: { lineStyle: { color: 'rgba(255,255,255,.12)' } },
        axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10, fontFamily: MONO, formatter: function (v) { return v % 10 === 0 ? v : ''; } },
        splitLine: { show: false }
      },
      yAxis: {
        type: 'value',
        axisLine: { show: false }, axisTick: { show: false },
        axisLabel: { color: C.txt3, fontSize: 10, fontFamily: MONO, formatter: function (v) { return v + '%'; } },
        splitLine: { lineStyle: { color: 'rgba(255,255,255,.055)', type: 'dashed' } }
      },
      series: [{
        type: 'line', name: '相对首集热度', smooth: 0.18, showSymbol: false, symbol: 'circle', symbolSize: 5,
        lineStyle: {
          width: 2.1,
          color: new echarts.graphic.LinearGradient(0, 0, 1, 0, [{ offset: 0, color: '#ff6fa5' }, { offset: .55, color: '#a78bfa' }, { offset: 1, color: '#5aa9ff' }]),
          shadowColor: 'rgba(255,45,85,.35)', shadowBlur: 10
        },
        itemStyle: { color: C.pink },
        areaStyle: { color: areaGrad(C.violet) },
        data: series,
        markArea: {
          silent: true,
          itemStyle: { color: 'rgba(255,197,92,.07)' },
          label: { show: false },
          data: [[{ xAxis: paidStart }, { xAxis: eps.length }]]
        },
        markLine: {
          silent: true, symbol: ['none', 'none'],
          lineStyle: { color: 'rgba(255,197,92,.65)', type: 'dashed', width: 1 },
          label: { show: true, position: 'insideEndTop', color: 'rgba(255,197,92,.9)', fontSize: 9.5, formatter: '付费墙' },
          data: [{ xAxis: paidStart }]
        }
      }]
    };
    ch.setOption(opt, true);
  }

    /* ------------------------------ 增长窗口 ------------------------------ */
  function renderGrowthRow() {
    var host = $id('growthStrip');
    if (!host) return;
    var all = state.allPoints;
    var keys = [['1m', '1 分', 1], ['5m', '5 分', 5], ['15m', '15 分', 15], ['1h', '1 小时', 60], ['24h', '24 小时', 1440]];
    var html = '';
    keys.forEach(function (k) {
      var v = windowDelta(all, k[2]);
      var cls = v == null ? '' : v > 0 ? 'up' : v < 0 ? 'down' : '';
      var txt = v == null ? '—' : v === 0 ? '0' : (v > 0 ? '+' : '') + fmtInt(v);
      var cov = growthCoverage(k[2]);
      var tip = v == null
        ? '历史样本不足 ' + k[1] + '，暂无法对比'
        : '与 ' + k[1] + '前的采样相比的播放量增量' + (cov ? '（实际覆盖 ' + cov + '）' : '');
      html += '<span class="g-chip' + (v == null ? ' nodata' : '') + '" title="' + esc(tip) + '"><i>' + k[1] + '</i><b class="' + cls + '">' + txt + '</b></span>';
    });
    if (host.__html !== html) { host.innerHTML = html; host.__html = html; }
  }
  /* 窗口增量：优先后端 /api/latest.growth（契约 §3 口径），缺失时前端按历史自算 */
  var GROWTH_KEYS = { 1: '1m', 5: '5m', 15: '15m', 60: '1h', 1440: '24h' };
  function windowDelta(arr, minutes) {
    var gk = GROWTH_KEYS[minutes];
    var g = state.growth || {};
    if (gk && Object.prototype.hasOwnProperty.call(g, gk)) {
      var w = g[gk];
      if (w && isNum(w.readCount)) return w.readCount;
      /* 后端窗口样本不足时，用前端历史兜底（下方逻辑），仍不足则返回 null */
    }
    if (!arr || arr.length < 2) return null;
    var last = arr[arr.length - 1];
    var target = last.ts - minutes * 60;
    var base = null;
    for (var i = arr.length - 1; i >= 0; i--) {
      if (arr[i].ts <= target) { base = arr[i]; break; }
    }
    if (!base) return null;                          /* 历史跨度不足，不用首点冒充 */
    if (!isNum(base.readCount) || !isNum(last.readCount)) return null;
    /* 实际覆盖不足目标窗口 55% 时视为不可比 */
    if ((last.ts - base.ts) < minutes * 60 * 0.55) return null;
    return last.readCount - base.readCount;
  }
  function growthCoverage(minutes) {
    var gk = GROWTH_KEYS[minutes];
    var w = gk && state.growth ? state.growth[gk] : null;
    if (!w || !isNum(w.spanSec)) return null;
    return Math.round(w.spanSec / 60) + ' 分钟样本';
  }

  /* ------------------------------ 连接状态 / SSE ------------------------------ */
  function setConn(connState, detail) {
    state.conn = connState;
    var el = $id('conn');
    if (el) el.setAttribute('data-state', connState);
    var map = { live: '实时连接', retry: '重连中', connecting: '连接中', offline: '离线' };
    setText('connText', map[connState] || connState);
    var t = $id('connText');
    if (t) t.title = detail || '';
  }

  function connectStream() {
    if (USE_MOCK) return;
    if (typeof EventSource === 'undefined') { setConn('offline', '浏览器不支持 SSE，将使用轮询'); startPollingFallback(); return; }
    if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
    clearTimeout(state.reconnectTimer);
    setConn('connecting');
    var es;
    try { es = new EventSource('/api/stream'); } catch (e) { scheduleReconnect(); return; }
    state.es = es;

    state.lastStreamAt = Date.now();
    es.addEventListener('open', function () {
      setConn('live');
      state.lastStreamAt = Date.now();
    });
    es.addEventListener('hello', function (ev) {
      setConn('live');
      state.lastStreamAt = Date.now();
      try {
        var data = JSON.parse(ev.data);
        if (data.meta) applyMeta(data.meta);
        if (data.latest) applyLatest(data.latest);
        loadEpisodes(true);
        loadHistory();
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('snapshot', function (ev) {
      setConn('live');
      state.lastStreamAt = Date.now();
      try {
        var data = JSON.parse(ev.data);
        var before = state.snapshot ? state.snapshot.ts : 0;
        applyLatest(data);
        if (data && data.snapshot && data.snapshot.ts !== before) {
          loadEpisodes(false);
          loadHistory();
          flashToast('已更新 · 播放量 ' + fmtInt(data.snapshot.readCount));
        }
      } catch (e) { /* ignore */ }
    });
    es.addEventListener('ping', function () {
      state.lastStreamAt = Date.now();
      if (state.conn !== 'live') setConn('live');
      state.lastReceivedAt = Date.now();
      updateMetaLast();
    });
    /* EventSource 自带指数/固定重连（服务端下发 retry: 3000）；
       仅在真正 CLOSED 时手动重建，避免与浏览器重连互相打架。 */
    function onStreamError() {
      if (!state.es) return;
      if (state.es.readyState === 2 /* CLOSED */) {
        try { state.es.close(); } catch (e) {}
        state.es = null;
        scheduleReconnect();
      } else {
        setConn('retry', '连接中断，自动重连中…');
      }
    }
    es.addEventListener('error', onStreamError);
    es.onerror = onStreamError;
  }

  function scheduleReconnect() {
    if (USE_MOCK) return;
    setConn('retry', '3 秒后重连');
    clearTimeout(state.reconnectTimer);
    state.reconnectTimer = setTimeout(function () {
      if (state.conn === 'retry' || state.conn === 'offline') { connectStream(); }
    }, RECONNECT_MS);
  }

  var pollTimer = null;
  function startPollingFallback() {
    if (pollTimer) return;
    pollTimer = setInterval(function () { loadLatest(true); loadHistory(); }, Math.max(15000, state.pollMs || 60000));
  }

  /* ------------------------------ 数据加载 ------------------------------ */
  function loadMeta() {
    return apiGet('/api/meta').then(function (meta) {
      applyMeta(meta);
      return meta;
    }).catch(function (err) {
      showAlert('元数据 /api/meta 加载失败：' + err.message, 'error');
    });
  }
  function loadLatest(silent) {
    return apiGet('/api/latest').then(function (data) {
      applyLatest(data);
      hideAlert();
      return data;
    }).catch(function (err) {
      if (!silent) showAlert('最新数据 /api/latest 加载失败：' + err.message + (USE_MOCK ? '' : '（后端可能尚未启动）'), 'error');
    });
  }
  function loadHistory() {
    var r = RANGE_MAP[state.range] || RANGE_MAP.realtime;
    var minutes = r.minutes || 1440;
    return apiGet('/api/history?minutes=' + minutes + '&max=2000').then(function (data) {
      if (!data || !Array.isArray(data.points)) return;
      /* 全量：/api/history 的 points 覆盖窗口，合并进 allPoints */
      data.points.forEach(function (p) { mergePoint(normalizePoint(p)); });
      if (isNum(data.pollMs)) state.pollMs = data.pollMs;
      renderAll();
      return data;
    }).catch(function (err) {
      /* 历史失败不阻断首屏 */
      console.warn('[history]', err.message);
    });
  }
  function normalizePoint(p) {
    var d = {};
    d.ts = p.ts;
    d.iso = p.iso;
    d.readCount = p.readCount;
    d.collectCount = p.collectCount;
    d.likeCount = p.likeCount;
    d.engagementRate = p.engagementRate;
    d.collectRate = p.collectRate;
    d.likeRate = p.likeRate;
    d.heatIndex = p.heatIndex;
    if (!isNum(d.engagementRate) && isNum(d.readCount)) d.engagementRate = (d.collectCount + d.likeCount) / d.readCount;
    if (!isNum(d.collectRate) && isNum(d.readCount)) d.collectRate = d.collectCount / d.readCount;
    if (!isNum(d.likeRate) && isNum(d.readCount)) d.likeRate = d.likeCount / d.readCount;
    if (!isNum(d.heatIndex)) d.heatIndex = null;
    return d;
  }
  function loadEpisodes(silent) {
    return apiGet('/api/episodes').then(function (data) {
      if (!data) return;
      if (isNum(data.paidStart)) state.paidStart = data.paidStart;
      if (isNum(data.total)) state.total = data.total;
      if (Array.isArray(data.episodes) && data.episodes.length) {
        applyEpisodes(data.episodes, data.funnel || null);
        renderHeader();
        applyEpisodesChart();
        renderFunnel();
      }
      return data;
    }).catch(function (err) {
      if (!silent) console.warn('[episodes]', err.message);
      /* 兜底：从 snapshot 的 episodes 推导 */
      if (state.snapshot && Array.isArray(state.snapshot.episodes) && state.snapshot.episodes.length) {
        applyEpisodes(state.snapshot.episodes);
        applyEpisodesChart();
        renderFunnel();
      }
    });
  }
  var episodesTimer = null;
  function scheduleEpisodesRefresh() {
    if (episodesTimer) return;
    episodesTimer = setTimeout(function () { episodesTimer = null; }, 5000);
  }

  function refreshAll(manual) {
    var btn = $id('refreshBtn');
    if (manual && btn) { btn.classList.add('busy'); btn.disabled = true; }
    var done = function () {
      if (manual && btn) { btn.classList.remove('busy'); btn.disabled = false; }
    };
    var p = USE_MOCK
      ? Promise.resolve(mockTick())
      : apiPost('/api/collect').then(function (data) {
        if (data) applyLatest(data);
        flashToast('已触发后端采样');
        return loadHistory();
      }).catch(function (err) {
        flashToast('刷新失败：' + err.message, true);
        return loadLatest(true).then(function () { return loadHistory(); });
      });
    return Promise.all([p, loadEpisodes(true)]).then(done, done);
  }

  /* ------------------------------ 时间范围 / 交互 ------------------------------ */
  function buildRangeSwitch() {
    var host = $id('rangeSwitch');
    if (!host) return;
    host.innerHTML = RANGE_LIST.map(function (r) {
      return '<button type="button" data-range="' + r.key + '" class="' + (r.key === state.range ? 'active' : '') + '">' + r.label + '</button>';
    }).join('');
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-range]');
      if (!btn) return;
      var key = btn.getAttribute('data-range');
      if (!RANGE_MAP[key] || key === state.range) return;
      state.range = key;
      Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-range') === key);
      });
      renderAll();
      loadHistory();
    });
  }

  function buildTrendChips() {
    var host = $id('trendChips');
    if (!host) return;
    function renderChips() {
      if (state.trendMode === 'volume') {
        host.innerHTML = ['likeCount', 'collectCount'].map(function (k) {
          var m = CONTRAST_META[k];
          return '<button type="button" class="chip ' + (state.contrast === k ? 'active' : '') + '" data-contrast="' + k + '">'
            + '<i style="background:' + m.color + '"></i>' + m.name + '</button>';
        }).join('');
      } else {
        host.innerHTML = ['engagementRate', 'likeRate', 'collectRate', 'heatIndex'].map(function (k) {
          var m = RATIO_META[k];
          return '<button type="button" class="chip ' + (state.ratioSel[k] ? 'active' : '') + '" data-ratio="' + k + '">'
            + '<i style="background:' + m.color + '"></i>' + m.name + '</button>';
        }).join('');
      }
    }
    renderChips();
    host.addEventListener('click', function (e) {
      var chip = e.target.closest('button');
      if (!chip) return;
      if (chip.hasAttribute('data-contrast')) {
        state.contrast = chip.getAttribute('data-contrast');
      } else if (chip.hasAttribute('data-ratio')) {
        var k = chip.getAttribute('data-ratio');
        var onCount = Object.keys(state.ratioSel).filter(function (x) { return state.ratioSel[x]; }).length;
        if (state.ratioSel[k] && onCount <= 1) { flashToast('至少保留一条指标'); return; }
        state.ratioSel[k] = !state.ratioSel[k];
      }
      renderChips();
      applyTrend();
    });
    state._renderTrendChips = renderChips;
  }

  function buildTrendMode() {
    var host = $id('trendMode');
    if (!host) return;
    host.addEventListener('click', function (e) {
      var btn = e.target.closest('button[data-mode]');
      if (!btn) return;
      var mode = btn.getAttribute('data-mode');
      if (mode === state.trendMode) return;
      state.trendMode = mode;
      Array.prototype.forEach.call(host.querySelectorAll('button'), function (b) {
        b.classList.toggle('active', b.getAttribute('data-mode') === mode);
      });
      if (state._renderTrendChips) state._renderTrendChips();
      applyTrend();
    });
  }

  /* ------------------------------ alert / toast ------------------------------ */
  var alertTimer = null;
  function showAlert(text, kind) {
    var el = $id('alertBar');
    if (!el) return;
    if (!text || !String(text).trim()) { el.hidden = true; return; }
    el.hidden = false;
    el.setAttribute('data-kind', kind || 'warn');
    setText('alertText', text);
    clearTimeout(alertTimer);
    alertTimer = setTimeout(function () { el.hidden = true; }, 12000);
  }
  function hideAlert() {
    var el = $id('alertBar');
    if (el && !el.hidden) { el.hidden = true; }
  }
  var toastTimer = null;
  function flashToast(text, isErr) {
    var el = $id('toast');
    if (!el) return;
    el.textContent = text;
    el.className = 'toast show' + (isErr ? ' err' : '');
    el.hidden = false;
    clearTimeout(toastTimer);
    toastTimer = setTimeout(function () {
      el.className = 'toast';
      setTimeout(function () { el.hidden = true; }, 260);
    }, 2200);
  }

  /* ------------------------------ 演示数据（仅 ?mock=1） ------------------------------ */
  function buildMock() {
    var base = {
      ts: Math.floor(Date.now() / 1000) - 3600,
      bookId: '6ad02fe293e1dedf6b0c1bd7',
      title: 'The Tempted DILF Is My Professor（演示数据）',
      cover: '',
      desc: 'MOCK 演示：仅用于后端未就绪时验证 UI 布局，真实数据请访问 /api/*。',
      tags: ['Female', 'Hot Daddy/DILF', 'Teacher', 'Age Gap', 'Taboo'],
      lang: 'en', isAi: 1, updateStatus: 1,
      bookMark: { type: 3, text: 'New' },
      total: 56, paidStart: 12,
      publishAt: Math.floor(Date.now() / 1000) - 86400,
      onlineAt: Math.floor(Date.now() / 1000) - 86400,
      readCount: 432000, collectCount: 12980, likeCount: 240100,
      ok: true
    };
    var eps = [];
    for (var n = 1; n <= 56; n++) {
      var decay = Math.pow(0.982, n - 1);
      eps.push({ n: n, id: 'mock' + n, likes: Math.round(5400 * decay + (n % 7) * 40), dur: 60 + (n % 5) * 20, pic: '' });
    }
    base.episodes = eps;
    var pts = [];
    for (var i = 120; i >= 0; i--) {
      var t = Math.floor(Date.now() / 1000) - i * 60;
      var k = (120 - i) * 152 + Math.round(Math.sin(i / 9) * 90);
      pts.push({
        ts: t, iso: new Date(t * 1000).toISOString(),
        readCount: 432000 + k,
        collectCount: 12980 + Math.round((120 - i) * 1.9),
        likeCount: 240100 + Math.round((120 - i) * 2.2),
      });
    }
    pts.forEach(function (p) {
      p.engagementRate = (p.collectCount + p.likeCount) / p.readCount;
      p.collectRate = p.collectCount / p.readCount;
      p.likeRate = p.likeCount / p.readCount;
      p.heatIndex = Math.round((0.45 * p.likeRate * 100 + 0.35 * p.collectRate * 100 + 0.20 * Math.min(p.readCount / 1e6, 1) * 100) * 10) / 10;
    });
    state.mock = { base: base, points: pts, idx: pts.length - 1 };
  }
  function mockSnapshot() {
    var m = state.mock;
    var p = m.points[m.points.length - 1];
    var snap = Object.assign({}, m.base, {
      ts: p.ts, iso: p.iso, readCount: p.readCount, collectCount: p.collectCount, likeCount: p.likeCount
    });
    snap.episodes = m.base.episodes.map(function (e, i) {
      var decay = Math.pow(0.982, i);
      return Object.assign({}, e, { likes: Math.round(5400 * decay + (i % 7) * 40 + (p.readCount - 432000) * 0.01) });
    });
    snap.likeCount = snap.episodes.reduce(function (s, e) { return s + e.likes; }, 0);
    return snap;
  }
  function mockApi(path) {
    if (path.indexOf('/api/meta') === 0) {
      return {
        drama: { bookId: 'mock', title: state.mock ? state.mock.base.title : 'MOCK', cover: '', desc: '演示数据', tags: ['Female', 'Teacher'], total: 56, paidStart: 12, lang: 'en', isAi: 1, bookMark: { type: 3, text: 'New' } },
        metrics: KPI_DEFS.map(function (d) { return { key: d.key, name: d.name, formula: d.fallback, unit: d.unit }; }),
        pollMs: 60000, startedAt: new Date().toISOString()
      };
    }
    if (path.indexOf('/api/latest') === 0 || path.indexOf('/api/collect') === 0) {
      var snap = mockSnapshot();
      var derived = computeDerived(snap);
      return { snapshot: snap, derived: derived, growth: mockGrowth(), delta: { readCount: snap.readCount - state.mock.points[0].readCount, collectCount: snap.collectCount - state.mock.points[0].collectCount, likeCount: snap.likeCount - state.mock.points[0].likeCount }, firstTs: state.mock.points[0].ts, sampleCount: state.mock.points.length };
    }
    if (path.indexOf('/api/history') === 0) {
      var m = state.mock;
      var r = RANGE_MAP[state.range] || RANGE_MAP.realtime;
      var src = r.minutes ? m.points.filter(function (p) { return p.ts >= m.points[m.points.length - 1].ts - r.minutes * 60; }) : m.points;
      return { points: src.slice(), count: src.length, pollMs: 60000 };
    }
    if (path.indexOf('/api/episodes') === 0) {
      var snapE = mockSnapshot();
      var eps = snapE.episodes.map(function (e, i) {
        return Object.assign({}, e, { isPaid: e.n >= 12, likeRateVsFirst: e.likes / snapE.episodes[0].likes });
      });
      return { paidStart: 12, total: 56, episodes: eps, funnel: computeFunnel(eps, 12) };
    }
    return {};
  }
  function mockGrowth() {
    var pts = state.mock.points;
    function win(min) {
      var end = pts[pts.length - 1].ts, from = end - min * 60;
      var sub = pts.filter(function (p) { return p.ts >= from; });
      if (sub.length < 2) return { readCount: null, collectCount: null, likeCount: null, samples: sub.length, spanSec: 0 };
      var a = sub[0], b = sub[sub.length - 1];
      return { readCount: b.readCount - a.readCount, collectCount: b.collectCount - a.collectCount, likeCount: b.likeCount - a.likeCount, samples: sub.length, spanSec: b.ts - a.ts };
    }
    return { '1m': win(1), '5m': win(5), '15m': win(15), '1h': win(60), '24h': win(1440) };
  }
  function mockTick() {
    var m = state.mock;
    var last = m.points[m.points.length - 1];
    var ts = last.ts + 60;
    var add = 140 + Math.round(Math.random() * 60);
    var p = {
      ts: ts, iso: new Date(ts * 1000).toISOString(),
      readCount: last.readCount + add,
      collectCount: last.collectCount + 2 + Math.round(Math.random() * 3),
      likeCount: last.likeCount + 1 + Math.round(Math.random() * 3)
    };
    p.engagementRate = (p.collectCount + p.likeCount) / p.readCount;
    p.collectRate = p.collectCount / p.readCount;
    p.likeRate = p.likeCount / p.readCount;
    p.heatIndex = Math.round((0.45 * p.likeRate * 100 + 0.35 * p.collectRate * 100 + 0.20 * Math.min(p.readCount / 1e6, 1) * 100) * 10) / 10;
    m.points.push(p);
    if (m.points.length > 400) m.points.shift();
    applyLatest(mockApi('/api/latest'));
  }
  function startMock() {
    buildMock();
    applyMeta(mockApi('/api/meta'));
    applyLatest(mockApi('/api/latest'));
    state.allPoints = [];
    state.mock.points.forEach(function (p) { state.allPoints.push(normalizePoint(p)); });
    applyEpisodes(mockApi('/api/episodes').episodes, mockApi('/api/episodes').funnel);
    setConn('live', 'MOCK 演示模式（?mock=1）');
    renderAll();
    state.mockTimer = setInterval(mockTick, 6000);
  }

  /* ------------------------------ 启动 ------------------------------ */
  function bindEvents() {
    var btn = $id('refreshBtn');
    if (btn) btn.addEventListener('click', function () { refreshAll(true); });
    var close = $id('alertClose');
    if (close) close.addEventListener('click', function () { hideAlert(); });
  }

  function onResize() {
    Object.keys(state.charts).forEach(function (k) {
      var c = state.charts[k];
      if (c && !c.isDisposed()) c.resize();
    });
    /* 窄屏时重算 sparkline 无需处理（SVG 自适应） */
  }

  function boot() {
    setConn('connecting');
    buildRangeSwitch();
    buildTrendChips();
    buildTrendMode();
    bindEvents();
    buildKpiCards();   /* 首屏先出骨架，避免白屏 */
    renderHeader();
    initCharts();

    window.addEventListener('resize', debounce(onResize, 160));
    document.addEventListener('visibilitychange', function () {
      if (document.visibilityState === 'visible') {
        loadLatest(true);
        loadHistory();
        if (!USE_MOCK && (!state.es || state.es.readyState === 2)) connectStream();
      }
    });

    if (USE_MOCK) { startMock(); return; }

    /* 首屏并行拉取 */
    loadMeta();
    var ok = loadLatest();
    loadHistory();
    loadEpisodes(true);
    connectStream();

    /* 后端未就绪时持续重试（每 5s，最多 12 次） */
    var tries = 0;
    var retry = setInterval(function () {
      tries++;
      if (state.lastReceivedAt) { clearInterval(retry); return; }
      loadMeta();
      loadLatest(true).then(function () { clearInterval(retry); });
      if (tries > 12) clearInterval(retry);
    }, 5000);

    /* 状态灯在无 SSE 事件时也要更新"最近采样"的相对时间 */
    setInterval(updateMetaLast, 10000);

    /* SSE 看门狗：超过 45s 没有任何事件（含 ping）则强制重建连接 */
    setInterval(function () {
      if (USE_MOCK || !state.lastStreamAt) return;
      if (Date.now() - state.lastStreamAt > 45000) {
        state.lastStreamAt = Date.now();
        if (state.es) { try { state.es.close(); } catch (e) {} state.es = null; }
        connectStream();
      }
    }, 15000);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
