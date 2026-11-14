/* ============================================================
   PHH Blog · AI 用量统计
   记录每次请求的 token 用量 → 每日聚合 → 折线图 / 饼图 / 热力图 / 花销 / 余额
   数据只存本机 localStorage(phh_ai_usage),不上传。
   ============================================================ */
(function () {
  'use strict';
  var LS = 'phh_ai_usage';

  /* 价格表:¥ / 百万 token [输入, 输出](估算值,可按官网自行调整) */
  var PRICE = {
    'ds:deepseek-flash': [2, 3],
    'ds:deepseek-v4-pro': [4, 12],
    'kimi:kimi-k2.6': [4, 16],
    'kimi:kimi-k3': [6, 24],
    'kimi:kimi-k3.1-pro': [8, 32]
  };
  var MODEL_LABEL = {
    'deepseek-flash': 'DeepSeek Flash',
    'deepseek-v4-pro': 'DeepSeek V4 Pro',
    'kimi-k2.6': 'Kimi K2.6',
    'kimi-k3': 'Kimi K3',
    'kimi-k3.1-pro': 'Kimi K3.1 Pro'
  };
  var PROV_LABEL = { ds: 'DeepSeek', kimi: 'Kimi' };

  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  function dayStr(d) { return d.getFullYear() + '-' + pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()); }
  function today() { return dayStr(new Date()); }
  function money(n) { return '¥' + (Math.round(n * 10000) / 10000).toFixed(4); }
  function num(n) { return n >= 1e6 ? (n / 1e6).toFixed(2) + 'M' : n >= 1e3 ? (n / 1e3).toFixed(1) + 'k' : String(n); }

  function load() {
    try {
      var d = JSON.parse(lsGet(LS) || '{}');
      if (!d || typeof d !== 'object') d = {};
      if (!d.days) d.days = {};
      return d;
    } catch (e) { return { days: {} }; }
  }
  function save(d) { lsSet(LS, JSON.stringify(d)); }

  function priceOf(key) { return PRICE[key] || [2, 3]; }
  function costOf(key, inTok, outTok) {
    var p = priceOf(key);
    return (inTok * p[0] + outTok * p[1]) / 1e6;
  }

  /* 记录一次请求 */
  function record(provider, model, usage, inChars, outChars) {
    var u = usage || {};
    var inTok = Number(u.prompt_tokens || u.input_tokens || 0);
    var outTok = Number(u.completion_tokens || u.output_tokens || 0);
    if (!inTok) inTok = Math.round((inChars || 0) / 1.6);
    if (!outTok) outTok = Math.round((outChars || 0) / 1.6);
    if (!inTok && !outTok) return;
    var d = load(), day = today();
    var b = d.days[day];
    if (!b) { b = d.days[day] = { in: 0, out: 0, models: {} }; }
    b.in += inTok;
    b.out += outTok;
    var key = provider + ':' + model;
    var m = b.models[key];
    if (!m) { m = b.models[key] = { in: 0, out: 0 }; }
    m.in += inTok;
    m.out += outTok;
    save(d);
  }

  /* 汇总 */
  function totals() {
    var d = load();
    var out = {
      in: 0, out: 0, cost: 0,
      models: {},           /* key -> {in,out,cost} */
      providers: {},        /* ds/kimi -> {in,out,cost} */
      days: {}              /* day -> {in,out,cost} */
    };
    Object.keys(d.days).forEach(function (day) {
      var b = d.days[day];
      if (!b) return;
      var dt = { in: b.in || 0, out: b.out || 0, cost: 0 };
      Object.keys(b.models || {}).forEach(function (key) {
        var m = b.models[key];
        var c = costOf(key, m.in || 0, m.out || 0);
        dt.cost += c;
        var pm = out.models[key] || (out.models[key] = { in: 0, out: 0, cost: 0 });
        pm.in += m.in || 0;
        pm.out += m.out || 0;
        pm.cost += c;
        var pv = key.split(':')[0];
        var pp = out.providers[pv] || (out.providers[pv] = { in: 0, out: 0, cost: 0 });
        pp.in += m.in || 0;
        pp.out += m.out || 0;
        pp.cost += c;
      });
      out.days[day] = dt;
      out.in += dt.in;
      out.out += dt.out;
      out.cost += dt.cost;
    });
    return out;
  }

  /* ---------------- 画布工具 ---------------- */
  function setupCanvas(cv, h) {
    var w = cv.parentNode ? cv.parentNode.clientWidth : 300;
    if (!w) w = 300;
    var dpr = Math.min(window.devicePixelRatio || 1, 2);
    cv.width = Math.round(w * dpr);
    cv.height = Math.round(h * dpr);
    cv.style.width = w + 'px';
    cv.style.height = h + 'px';
    var ctx = cv.getContext('2d');
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);
    return { ctx: ctx, w: w, h: h };
  }
  function isLight() {
    var r = document.getElementById('ai-chat');
    return !!(r && r.classList.contains('light'));
  }
  function theme() {
    return isLight()
      ? { axis: '#c9d1d9', text: '#6a737d', grid: '#eef1f4', line: '#0085a1', fill: 'rgba(0,133,161,.14)', bar: '#0fa0be' }
      : { axis: 'rgba(255,255,255,.14)', text: '#8b95a1', grid: 'rgba(255,255,255,.06)', line: '#4fc3d9', fill: 'rgba(79,195,217,.16)', bar: '#0fa0be' };
  }

  /* 折线:最近 14 天 token */
  function drawLine(cv, days) {
    var c = setupCanvas(cv, 150), ctx = c.ctx, th = theme();
    var keys = Object.keys(days).sort().slice(-14);
    var vals = keys.map(function (k) { return (days[k].in || 0) + (days[k].out || 0); });
    var max = Math.max.apply(null, vals.concat([1]));
    var padL = 6, padR = 6, padT = 12, padB = 22;
    var W = c.w - padL - padR, H = c.h - padT - padB;
    /* 网格 */
    ctx.strokeStyle = th.grid;
    ctx.lineWidth = 1;
    for (var g = 0; g <= 2; g++) {
      var y = padT + H * g / 2;
      ctx.beginPath(); ctx.moveTo(padL, y); ctx.lineTo(padL + W, y); ctx.stroke();
    }
    if (!keys.length) {
      ctx.fillStyle = th.text; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('还没有用量数据', c.w / 2, c.h / 2);
      return;
    }
    /* 折线 + 面积 */
    var pts = vals.map(function (v, i) {
      var x = padL + (keys.length === 1 ? W / 2 : W * i / (keys.length - 1));
      var y = padT + H - (v / max) * H;
      return [x, y];
    });
    ctx.beginPath();
    ctx.moveTo(pts[0][0], padT + H);
    pts.forEach(function (p) { ctx.lineTo(p[0], p[1]); });
    ctx.lineTo(pts[pts.length - 1][0], padT + H);
    ctx.closePath();
    ctx.fillStyle = th.fill;
    ctx.fill();
    ctx.beginPath();
    pts.forEach(function (p, i) { i ? ctx.lineTo(p[0], p[1]) : ctx.moveTo(p[0], p[1]); });
    ctx.strokeStyle = th.line;
    ctx.lineWidth = 2;
    ctx.stroke();
    /* 点 */
    ctx.fillStyle = th.line;
    pts.forEach(function (p) { ctx.beginPath(); ctx.arc(p[0], p[1], 2.6, 0, Math.PI * 2); ctx.fill(); });
    /* x 轴标签(首尾) */
    ctx.fillStyle = th.text;
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'left';
    ctx.fillText(keys[0].slice(5), padL, c.h - 6);
    ctx.textAlign = 'right';
    ctx.fillText(keys[keys.length - 1].slice(5), padL + W, c.h - 6);
  }

  var PIE_COLORS = ['#0085a1', '#4fc3d9', '#f0a45e', '#8b7bd8', '#6cc08b', '#e2726e', '#9aa4b1'];

  function drawPie(cv, entries, h) {
    var c = setupCanvas(cv, h || 140), ctx = c.ctx, th = theme();
    var total = entries.reduce(function (s, e) { return s + e.value; }, 0);
    if (!total) {
      ctx.fillStyle = th.text; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
      ctx.fillText('暂无数据', c.w / 2, c.h / 2);
      return;
    }
    var cx = c.w / 2, cy = c.h / 2, R = Math.min(c.w, c.h) / 2 - 8;
    var ang = -Math.PI / 2;
    entries.forEach(function (e, i) {
      var a = (e.value / total) * Math.PI * 2;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.arc(cx, cy, R, ang, ang + a);
      ctx.closePath();
      ctx.fillStyle = PIE_COLORS[i % PIE_COLORS.length];
      ctx.fill();
      ang += a;
    });
    /* 中心留白 */
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.48, 0, Math.PI * 2);
    ctx.fillStyle = isLight() ? '#fff' : '#171a1f';
    ctx.fill();
    ctx.fillStyle = th.text;
    ctx.font = '11px sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(num(total), cx, cy + 4);
  }

  /* 活跃热力图:最近 119 天(17 周 × 7) */
  function drawHeat(cv, days) {
    var c = setupCanvas(cv, 96), ctx = c.ctx, th = theme();
    var weeks = 17, cell = Math.floor((c.w - 20) / weeks), gap = 2;
    var grad = ['rgba(0,133,161,.12)', 'rgba(0,133,161,.32)', 'rgba(0,133,161,.55)', 'rgba(0,133,161,.78)', '#0085a1'];
    var now = new Date(), start = new Date(now.getFullYear(), now.getMonth(), now.getDate() - (weeks * 7 - 1));
    /* 对齐到周一 */
    var dow = (start.getDay() + 6) % 7;
    start.setDate(start.getDate() - dow);
    var max = 0;
    Object.keys(days).forEach(function (k) {
      var v = (days[k].in || 0) + (days[k].out || 0);
      if (v > max) max = v;
    });
    for (var w = 0; w < weeks; w++) {
      for (var d = 0; d < 7; d++) {
        var dt = new Date(start.getFullYear(), start.getMonth(), start.getDate() + w * 7 + d);
        var key = dayStr(dt);
        var v = days[key] ? (days[key].in || 0) + (days[key].out || 0) : 0;
        var lvl = v ? Math.min(4, Math.ceil(v / Math.max(max, 1) * 4)) : 0;
        ctx.fillStyle = v ? grad[lvl] : (isLight() ? '#eef1f4' : 'rgba(255,255,255,.06)');
        var x = 8 + w * cell, y = 8 + d * (cell + gap);
        ctx.fillRect(x, y, cell - gap, cell - gap);
      }
    }
  }

  /* ---------------- 页面渲染 ---------------- */
  function renderStats() {
    var t = totals();
    var sum = document.getElementById('ai-stats-sum');
    if (sum) {
      sum.innerHTML =
        '<div class="ai-st-box"><b>' + num(t.in + t.out) + '</b><span>总 token</span></div>' +
        '<div class="ai-st-box"><b>' + money(t.cost) + '</b><span>估算花销</span></div>' +
        '<div class="ai-st-box"><b>' + num(t.in) + '</b><span>输入 token</span></div>' +
        '<div class="ai-st-box"><b>' + num(t.out) + '</b><span>输出 token</span></div>';
    }
    var line = document.getElementById('ai-st-line');
    if (line) drawLine(line, t.days);
    var heat = document.getElementById('ai-st-heat');
    if (heat) drawHeat(heat, t.days);

    var modelEntries = Object.keys(t.models).map(function (k) {
      return { key: k, label: MODEL_LABEL[k.split(':')[1]] || k.split(':')[1], value: t.models[k].in + t.models[k].out };
    }).sort(function (a, b) { return b.value - a.value; });
    var provEntries = Object.keys(t.providers).map(function (k) {
      return { key: k, label: PROV_LABEL[k] || k, value: t.providers[k].in + t.providers[k].out };
    }).sort(function (a, b) { return b.value - a.value; });

    var mc = document.getElementById('ai-st-model');
    if (mc) drawPie(mc, modelEntries, 140);
    var pc = document.getElementById('ai-st-prov');
    if (pc) drawPie(pc, provEntries, 140);

    var ml = document.getElementById('ai-st-model-legend');
    if (ml) {
      ml.innerHTML = modelEntries.map(function (e, i) {
        return '<span class="ai-st-lg"><i style="background:' + PIE_COLORS[i % PIE_COLORS.length] + '"></i>' + esc(e.label) + ' · ' + num(e.value) + '</span>';
      }).join('') || '<span class="ai-st-lg">暂无</span>';
    }
    var pl = document.getElementById('ai-st-prov-legend');
    if (pl) {
      pl.innerHTML = provEntries.map(function (e, i) {
        return '<span class="ai-st-lg"><i style="background:' + PIE_COLORS[i % PIE_COLORS.length] + '"></i>' + esc(e.label) + ' · ' + num(e.value) + '</span>';
      }).join('') || '<span class="ai-st-lg">暂无</span>';
    }

    /* 各模型花销表 */
    var costEl = document.getElementById('ai-st-cost');
    if (costEl) {
      var rows = Object.keys(t.models).map(function (k) {
        var m = t.models[k];
        return { k: k, m: m };
      }).sort(function (a, b) { return b.m.cost - a.m.cost; });
      if (!rows.length) {
        costEl.innerHTML = '<div class="ai-empty">还没有数据,聊几句就会自动统计</div>';
      } else {
        var html = '<div class="ai-st-table">';
        html += '<div class="ai-st-tr ai-st-th"><span>模型</span><span>输入</span><span>输出</span><span>花销</span></div>';
        rows.forEach(function (r) {
          var pv = r.k.split(':')[0];
          html += '<div class="ai-st-tr"><span>' + esc((PROV_LABEL[pv] || pv) + ' · ' + (MODEL_LABEL[r.k.split(':')[1]] || r.k)) + '</span>' +
            '<span>' + num(r.m.in) + '</span><span>' + num(r.m.out) + '</span><span>' + money(r.m.cost) + '</span></div>';
        });
        html += '<div class="ai-st-tr ai-st-total"><span>合计</span><span>' + num(t.in) + '</span><span>' + num(t.out) + '</span><span>' + money(t.cost) + '</span></div>';
        html += '</div>';
        costEl.innerHTML = html;
      }
    }
    loadBalance();
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------------- 余额 ---------------- */
  function keyOf(provider) {
    var k = '';
    try {
      k = lsGet(provider === 'kimi' ? 'phh_ai_key_kimi' : 'phh_ai_key').trim();
    } catch (e) {}
    if (!k && window.PHHSECRETS) {
      try { k = (provider === 'kimi' ? PHHSECRETS.kimi() : PHHSECRETS.ds()) || ''; } catch (e) {}
    }
    return k;
  }
  function loadBalance() {
    var box = document.getElementById('ai-stats-balance');
    if (!box) return;
    box.innerHTML = '<div class="ai-st-bal"><b>—</b><span>DeepSeek 余额</span></div>' +
      '<div class="ai-st-bal"><b>—</b><span>Kimi 余额</span></div>';

    var dsKey = keyOf('ds');
    if (dsKey) {
      fetch('https://api.deepseek.com/user/balance', { headers: { 'Authorization': 'Bearer ' + dsKey } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var infos = (j && j.balance_infos) || [];
          var b = infos.length ? infos[0].total_balance : '';
          if (b !== '') {
            var el = box.children[0];
            if (el) el.innerHTML = '<b>¥' + esc(String(b)) + '</b><span>DeepSeek 余额</span>';
          }
        }).catch(function () {});
    }
    var kimiKey = keyOf('kimi');
    if (kimiKey) {
      fetch('https://api.moonshot.cn/v1/users/me/balance', { headers: { 'Authorization': 'Bearer ' + kimiKey } })
        .then(function (r) { return r.json(); })
        .then(function (j) {
          var d = (j && j.data) || {};
          var b = d.available_balance !== undefined ? d.available_balance : '';
          if (b !== '') {
            var el = box.children[1];
            if (el) el.innerHTML = '<b>¥' + esc(String(b)) + '</b><span>Kimi 余额</span>';
          }
        }).catch(function () {});
    }
  }

  function clear() {
    save({ days: {} });
    renderStats();
  }

  window.PHHAISTATS = {
    record: record,
    renderPage: renderStats,
    clear: clear,
    totals: totals
  };
})();
