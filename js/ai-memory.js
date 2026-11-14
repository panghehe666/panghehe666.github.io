/* ============================================================
   PHH Blog · 长期记忆模块(仿豆包记忆)
   ------------------------------------------------------------
   和旧版的区别:
   1. 结构化条目 {cat,key,val,text,w,src,ts,up,n,pin},不再是裸字符串
   2. 三条写入路径:
       - 模型标记 [[MEM:偏好|辣|不吃辣]]
       - 用户显式指令/自我描述(本地直接抓,零 token)
       - 自动整理(每 N 轮一次小请求,把整段对话压成记忆)
   3. 读取按「相关度 + 权重 + 新近度」挑 Top-N 注入,不再全量塞 system
   4. 冲突合并:同分类同属性直接覆盖;文本相似度 >0.72 合并;超上限按分数淘汰
   5. 全部存 localStorage,可查看、编辑、置顶、删除、导出、导入、一键清空
   6. 白嫖模式由 ai-chat.js 控制,不读不写,完全隔离
   ============================================================ */
(function () {
  'use strict';

  var LS = {
    v2: 'phh_ai_mem_v2',
    legacy: 'phh_ai_mem',
    on: 'phh_ai_mem_on',
    auto: 'phh_ai_mem_auto',
    meta: 'phh_ai_mem_meta'
  };
  var MAX = 60;          // 条目上限,超出按分数淘汰
  var INJECT = 6;        // 每轮最多注入条数
  var MERGE_SIM = 0.72;  // 文本相似度合并阈值

  var CATS = [
    { id: 'profile', label: '身份' },
    { id: 'pref', label: '偏好' },
    { id: 'habit', label: '习惯' },
    { id: 'plan', label: '目标' },
    { id: 'rel', label: '关系' },
    { id: 'event', label: '经历' },
    { id: 'other', label: '其他' }
  ];
  var CAT_LABEL = {};
  var CAT_ORDER = {};
  CATS.forEach(function (c, i) { CAT_LABEL[c.id] = c.label; CAT_ORDER[c.id] = i; });

  var ALIAS = {
    '身份': 'profile', '资料': 'profile', '个人信息': 'profile', 'profile': 'profile', 'info': 'profile',
    '偏好': 'pref', '喜好': 'pref', '口味': 'pref', 'pref': 'pref', 'preference': 'pref',
    '习惯': 'habit', 'habit': 'habit',
    '目标': 'plan', '计划': 'plan', '规划': 'plan', 'plan': 'plan', 'goal': 'plan',
    '关系': 'rel', '人际': 'rel', 'rel': 'rel', 'relation': 'rel',
    '经历': 'event', '事件': 'event', 'event': 'event',
    '其他': 'other', 'other': 'other', 'misc': 'other'
  };

  /* ---------------- 基础 ---------------- */
  function ls(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function now() { return Date.now(); }
  function uid() { return 'm' + now().toString(36) + Math.random().toString(36).slice(2, 6); }
  function trimStr(s, n) { s = String(s == null ? '' : s).replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n) : s; }

  var PUNCT_RE = /[\s\u3000!！?？。．，,、;；:：'"“”‘’()（）\[\]【】<>《》\-—_~`/\\|…·]/g;
  function norm(s) {
    return String(s == null ? '' : s)
      .toLowerCase()
      .replace(PUNCT_RE, '')
      .replace(/^我(的)?/, '');
  }
  function grams(s) {
    var o = {}, t = norm(s), i, g;
    if (!t) return o;
    if (t.length < 2) { o[t] = 1; return o; }
    for (i = 0; i < t.length - 1; i++) { g = t.substr(i, 2); o[g] = (o[g] || 0) + 1; }
    return o;
  }
  function sim(a, b) {
    var na = norm(a), nb = norm(b);
    if (!na || !nb) return 0;
    if (na === nb) return 1;
    if (na.indexOf(nb) >= 0 || nb.indexOf(na) >= 0) return 0.9;
    var ga = grams(na), gb = grams(nb), inter = 0, union = 0, k;
    for (k in ga) { if (ga[k]) union++; if (gb[k]) inter++; }
    for (k in gb) { if (gb[k] && !ga[k]) union++; }
    return union ? inter / union : 0;
  }
  /* 查询词被记忆覆盖的比例:短问题也能命中长条目 */
  function cover(q, t) {
    var gq = grams(q), gt = grams(t), hit = 0, total = 0, k;
    for (k in gq) { total++; if (gt[k]) hit++; }
    return total ? hit / total : 0;
  }
  function recency(ts) {
    var d = (now() - (ts || 0)) / 86400000;
    return Math.exp(-d / 60);  // 60 天半衰
  }
  function guessCat(text) {
    var s = String(text || '');
    if (/(名字|称呼|叫|住在|家住|来自|年龄|岁|生日|学校|大学|高中|专业|职业|工作|上班|年级|坐标)/.test(s)) return 'profile';
    if (/(喜欢|偏好|讨厌|不吃|爱吃|爱喝|不喝|口味|反感|受不了|最爱)/.test(s)) return 'pref';
    if (/(每天|每周|经常|习惯|总是|一般会|规律|作息)/.test(s)) return 'habit';
    if (/(想|打算|计划|目标|准备|希望|立志|以后要)/.test(s)) return 'plan';
    if (/(女朋友|男朋友|老婆|老公|爸|妈|父母|家人|朋友|同事|舍友|室友|老师)/.test(s)) return 'rel';
    return 'other';
  }
  function catOf(v) {
    var k = String(v || '').trim().toLowerCase();
    return ALIAS[k] || ALIAS[String(v || '').trim()] || (CAT_LABEL[k] ? k : 'other');
  }

  /* ---------------- 读写 ---------------- */
  function mk(cat, key, val, w, src) {
    cat = catOf(cat);
    key = trimStr(key, 24);
    val = trimStr(val, 160);
    if (!val) return null;
    if (cat === 'other' && !key) cat = guessCat(val);
    return {
      id: uid(),
      cat: cat,
      key: key,
      val: val,
      text: key ? key + '：' + val : val,
      w: Math.max(1, Math.min(5, parseInt(w, 10) || 3)),
      src: src || 'ai',
      ts: now(),
      up: now(),
      n: 0,
      pin: false
    };
  }
  function fix(e) {
    if (!e) return null;
    if (typeof e === 'string') return mk('', '', e, 3, 'ai');
    if (!e.val && !e.text) return null;
    var o = {
      id: e.id || uid(),
      cat: catOf(e.cat),
      key: trimStr(e.key, 24),
      val: trimStr(e.val || e.text, 160),
      w: Math.max(1, Math.min(5, parseInt(e.w, 10) || 3)),
      src: e.src || 'ai',
      ts: e.ts || now(),
      up: e.up || e.ts || now(),
      n: e.n || 0,
      pin: !!e.pin
    };
    o.prev = Array.isArray(e.prev) ? e.prev.slice(-3) : [];
    o.text = o.key ? o.key + '：' + o.val : o.val;
    return o;
  }
  function load() {
    var out = [];
    try {
      var raw = JSON.parse(ls(LS.v2) || '[]');
      if (Array.isArray(raw)) raw.forEach(function (e) { var f = fix(e); if (f) out.push(f); });
    } catch (e) { out = []; }
    if (!out.length) {
      /* 迁移旧版纯字符串记忆 */
      try {
        var old = JSON.parse(ls(LS.legacy) || '[]');
        if (!Array.isArray(old)) old = [];
        old.forEach(function (s) {
          var f = mk('', '', s, 3, 'user');
          if (f) out.push(f);
        });
        if (out.length) { save(out); lsSet(LS.legacy, '[]'); }
      } catch (e2) {}
    }
    return out;
  }
  function save(arr) {
    var out = [];
    (arr || []).forEach(function (e) { var f = fix(e); if (f) out.push(f); });
    lsSet(LS.v2, JSON.stringify(out.slice(0, MAX * 2)));
    return out;
  }
  function all() { return load(); }

  function keepScore(e) {
    return (e.pin ? 1000 : 0) + e.w * 10 + recency(e.up) * 20 +
      Math.min(e.n || 0, 12) * 2 + (e.src === 'user' ? 5 : 0);
  }
  function trimList(arr) {
    if (arr.length <= MAX) return arr;
    return arr.slice().sort(function (a, b) { return keepScore(b) - keepScore(a); }).slice(0, MAX);
  }

  /* ---------------- 写入:合并 / 冲突 ---------------- */
  function add(items, opt) {
    opt = opt || {};
    var list = load();
    var src = opt.src || 'user';
    var added = 0, updated = 0, merged = 0, skipped = 0;

    (Array.isArray(items) ? items : [items]).forEach(function (it) {
      var e = fix(typeof it === 'string' ? mk('', '', it, 3, src) : it);
      if (!e) { skipped++; return; }
      if (src === 'ai' && !it.src) e.src = 'ai';
      else e.src = it.src || src;

      /* 1) 同分类 + 同属性:直接覆盖,旧的存进 prev 便于回溯 */
      var hitIdx = -1, i;
      if (e.key) {
        for (i = 0; i < list.length; i++) {
          if (list[i].cat === e.cat && list[i].key && norm(list[i].key) === norm(e.key)) { hitIdx = i; break; }
        }
        if (hitIdx >= 0) {
          var oldE = list[hitIdx];
          if (norm(oldE.val) === norm(e.val)) {
            oldE.up = now();
            oldE.w = Math.max(oldE.w, e.w);
            skipped++;
            return;
          }
          oldE.prev = oldE.prev || [];
          oldE.prev.push({ v: oldE.val, t: oldE.up });
          if (oldE.prev.length > 3) oldE.prev = oldE.prev.slice(-3);
          oldE.val = e.val;
          oldE.text = oldE.key + '：' + e.val;
          oldE.up = now();
          oldE.w = Math.max(oldE.w, e.w);
          oldE.src = e.src;
          updated++;
          return;
        }
      }

      /* 2) 文本相似:合并为一条,保留更具体的那句 */
      var bestIdx = -1, best = 0;
      for (i = 0; i < list.length; i++) {
        var s = Math.max(sim(e.text, list[i].text), sim(e.key || e.val, list[i].val));
        if (s > best) { best = s; bestIdx = i; }
      }
      if (best >= MERGE_SIM && bestIdx >= 0) {
        var tgt = list[bestIdx];
        if (norm(e.val).indexOf(norm(tgt.val)) < 0) {
          tgt.prev = tgt.prev || [];
          tgt.prev.push({ v: tgt.val, t: tgt.up });
          if (tgt.prev.length > 3) tgt.prev = tgt.prev.slice(-3);
          tgt.val = e.val;
          tgt.text = tgt.key ? tgt.key + '：' + e.val : e.val;
        }
        tgt.up = now();
        tgt.w = Math.max(tgt.w, e.w);
        tgt.src = tgt.src === 'user' ? 'user' : e.src;
        merged++;
        return;
      }

      /* 3) 新条目 */
      list.push(e);
      added++;
    });

    var saved = save(trimList(list));
    return { added: added, updated: updated, merged: merged, skipped: skipped, total: saved.length };
  }

  function forget(keys) {
    var ks = (Array.isArray(keys) ? keys : [keys]).map(norm).filter(Boolean);
    if (!ks.length) return 0;
    var list = load(), out = [];
    list.forEach(function (e) {
      var target = norm(e.text);
      var hit = false;
      for (var i = 0; i < ks.length; i++) {
        if (ks[i] && target.indexOf(ks[i]) >= 0) { hit = true; break; }
      }
      if (!hit) out.push(e);
    });
    var removed = list.length - out.length;
    save(out);
    return removed;
  }
  function clear() { save([]); }

  /* ---------------- 开关 ---------------- */
  function enabled() { return ls(LS.on) !== '0'; }
  function setEnabled(on) { lsSet(LS.on, on ? '1' : '0'); }
  function autoOn() { return ls(LS.auto) !== '0'; }
  function setAutoOn(on) { lsSet(LS.auto, on ? '1' : '0'); }

  /* ---------------- 读取:相关度挑选 ---------------- */
  var lastInjected = [];

  function scoreOf(e, q) {
    var rel = q ? Math.max(cover(q, e.text), sim(q, e.text) * 0.8) : 0;
    return rel * 10 + (e.pin ? 100 : 0) + e.w * 0.6 + recency(e.up) * 1.2 + (e.src === 'user' ? 1 : 0);
  }

  function pick(q) {
    var list = load();
    if (!list.length) return [];
    var used = {}, out = [];
    function take(e) { if (!used[e.id]) { used[e.id] = 1; out.push(e); } }

    /* 置顶 + 身份常驻(称呼/所在地这类每轮都用得上) */
    list.forEach(function (e) { if (e.pin) take(e); });
    list.filter(function (e) { return e.cat === 'profile'; })
      .sort(function (a, b) { return b.w - a.w || b.up - a.up; })
      .slice(0, 2).forEach(take);

    /* 求推荐/建议类问题:口味、习惯这类偏好即使字面不重合也带上 */
    if (/(推荐|建议|挑|选|买|吃|喝|穿|用哪个|看什么|玩什么|怎么选)/.test(String(q || ''))) {
      list.filter(function (e) {
        return !used[e.id] && (e.cat === 'pref' || e.cat === 'habit');
      }).sort(function (a, b) { return b.w - a.w || recency(b.up) - recency(a.up); })
        .slice(0, 2).forEach(take);
    }

    /* 其余按相关度补满 */
    list.filter(function (e) { return !used[e.id]; })
      .map(function (e) {
        return {
          e: e,
          s: scoreOf(e, q),
          rel: q ? Math.max(cover(q, e.text), sim(q, e.text) * 0.8) : 0
        };
      })
      .sort(function (a, b) { return b.s - a.s; })
      .forEach(function (x) {
        if (out.length >= INJECT) return;
        if (q && x.rel < 0.1) return;   // 和本轮完全无关的不带
        take(x.e);
      });

    return out.slice(0, INJECT);
  }

  function block(q) {
    if (!enabled()) { lastInjected = []; return ''; }
    var picked = pick(q);
    lastInjected = picked.map(function (e) { return e.id; });
    if (!picked.length) return '';

    /* 记录使用次数,给淘汰和排序用 */
    var list = load(), map = {};
    picked.forEach(function (e) { map[e.id] = 1; });
    list.forEach(function (e) { if (map[e.id]) { e.n = (e.n || 0) + 1; e.use = now(); } });
    save(list);

    var total = list.length;
    var lines = ['【长期记忆·关于用户(本轮按相关度挑出的条目,回答时优先尊重;不要逐条复述,也别主动说"根据记忆")】'];
    picked.forEach(function (e) {
      lines.push('- [' + CAT_LABEL[e.cat] + '] ' + e.text);
    });
    if (total > picked.length) lines.push('(共 ' + total + ' 条,其余与本轮无关,没有列出来)');
    return lines.join('\n');
  }

  /* ---------------- 解析模型标记 ---------------- */
  function fromMarker(v) {
    var raw = trimStr(v, 200);
    if (!raw) return null;
    var parts = raw.split('|');
    if (parts.length >= 3) return mk(parts[0], parts[1], parts.slice(2).join('|'), 4, 'ai');
    if (parts.length === 2) return mk(parts[0], '', parts[1], 3, 'ai');
    return mk('', '', raw, 3, 'ai');
  }
  function extract(text) {
    var mems = [], fgs = [];
    var clean = String(text || '');
    clean = clean.replace(/\[\[MEM:\s*([^\]]*)\]\]/g, function (_, v) {
      var e = fromMarker(v);
      if (e) mems.push(e);
      return '';
    });
    clean = clean.replace(/\[\[FORGET:\s*([^\]]*)\]\]/g, function (_, v) {
      var s = trimStr(v, 80);
      if (s) fgs.push(s);
      return '';
    });
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();
    return { mems: mems, fgs: fgs, clean: clean };
  }

  /* ---------------- 本地零 token:显式指令 / 自我描述 / 记忆问答 ---------------- */
  function isQuestion(t) { return /[?？]\s*$|(吗|呢|么)\s*$/.test(t); }

  function quickCapture(text) {
    var t = trimStr(text, 160);
    if (!t || t.length < 3 || isQuestion(t)) return [];
    var out = [];
    var m;

    /* 显式:记住:xxx */
    m = t.match(/^(请|帮我)?记(住|一下|下来)[：:,，\s]+(.{2,120})$/);
    if (m) {
      out.push(mk('', '', m[3], 4, 'user'));
      return out;
    }
    /* 称呼 */
    m = t.match(/^我(叫|的名字叫)\s*(.{1,20})$/);
    if (m) { out.push(mk('profile', '称呼', m[2], 5, 'user')); return out; }
    /* 所在地 */
    m = t.match(/^我(住在|家在|来自)\s*(.{1,16})$/);
    if (m) { out.push(mk('profile', '所在地', m[2], 4, 'user')); return out; }
    /* 身份/职业/学业 */
    m = t.match(/^我(是|在)\s*(.{2,24}?)(学生|工作|上班|读书|上学|老师|工程师|程序员|设计师)?$/);
    if (m && (m[3] || /学生|工作|上学|读书/.test(m[2]))) {
      out.push(mk('profile', '身份', (m[2] + (m[3] || '')), 4, 'user'));
      return out;
    }
    /* 偏好/禁忌 */
    m = t.match(/^我(不)?(喜欢|爱吃|爱喝|讨厌|受不了|不吃|不喝)\s*(.{1,20})$/);
    if (m) {
      var neg = m[1] || /讨厌|受不了|不吃|不喝/.test(m[2]);
      out.push(mk('pref', '', (neg ? '不喜欢' : '喜欢') + m[3], 3, 'user'));
      return out;
    }
    /* 长期目标 */
    m = t.match(/^我(想|打算|计划|准备)\s*(.{2,30})$/);
    if (m) { out.push(mk('plan', '', m[2], 3, 'user')); return out; }
    return out;
  }

  function listAnswer() {
    if (!enabled()) return '记忆功能现在是关着的,在「设置 → 记忆」里打开就能记。';
    var list = all();
    if (!list.length) return '我还没记住关于你的事。直接聊你的偏好或者背景,或者说「记住：我不吃辣」,我就会自己存下来。';
    var groups = {};
    list.forEach(function (e) { (groups[e.cat] = groups[e.cat] || []).push(e); });
    var s = ['我记得这些(共 ' + list.length + ' 条):'];
    CATS.forEach(function (c) {
      var g = groups[c.id];
      if (!g || !g.length) return;
      s.push('');
      s.push('【' + c.label + '】');
      g.forEach(function (e) { s.push('- ' + e.text); });
    });
    s.push('');
    s.push('可以在「设置 → 记忆」里逐条改、删、置顶,或者直接说「忘掉 X」。');
    return s.join('\n');
  }

  function handleLocal(text) {
    var t = trimStr(text, 60);
    if (!t) return null;
    if (/^(请|帮我)?(你)?(都)?(记得|记住)(了)?我(什么|啥|哪些)[?？。!！]?$/.test(t) ||
        /^(你)?(现在)?(有|存)(了)?(哪些|什么)记忆[?？。]?$/.test(t) ||
        /^查看(一下)?(我的)?记忆[?？。]?$/.test(t) ||
        /^我的记忆[?？。]?$/.test(t)) {
      return listAnswer();
    }
    if (/^(请|帮我)?(清空|删除|忘掉|忘记)(全部|所有|我的)?记忆[。!！]?$/.test(t)) {
      clear();
      return '记忆已经清空了。';
    }
    var m = t.match(/^(请|帮我)?忘(记|掉)(一下)?(关于)?[「“']?(.{1,12}?)[」”']?(的)?记忆[。!！]?$/);
    if (m) {
      var kw = m[5] || '';
      var n = forget([kw]);
      return n ? '已经忘掉关于「' + kw + '」的 ' + n + ' 条记忆。' : '我这儿没有关于「' + kw + '」的记忆。';
    }
    return null;
  }

  /* ---------------- 自动整理(每 N 轮一次) ---------------- */
  function meta() { try { return JSON.parse(ls(LS.meta) || '{}') || {}; } catch (e) { return {}; } }
  function metaSet(o) { lsSet(LS.meta, JSON.stringify(o)); }
  function countTurn() { var m = meta(); m.turns = (m.turns || 0) + 1; metaSet(m); return m.turns; }
  function shouldConsolidate(every) {
    var m = meta();
    every = every || 6;
    if ((m.turns || 0) < every) return false;
    if ((m.turns || 0) % every !== 0) return false;
    if (m.last && now() - m.last < 60000) return false;
    return true;
  }
  function markConsolidated() { var m = meta(); m.last = now(); m.turns = 0; metaSet(m); }
  function compactForPrompt(limit) {
    var list = all().slice().sort(function (a, b) { return keepScore(b) - keepScore(a); }).slice(0, limit || 20);
    return list.map(function (e) { return '[' + CAT_LABEL[e.cat] + '] ' + e.text; }).join('\n');
  }

  /* ---------------- 导入导出 ---------------- */
  function exportJSON() {
    var obj = { v: 2, exported: new Date().toISOString(), memories: all() };
    var txt = JSON.stringify(obj, null, 2);
    var name = 'phh-memory-' + new Date().toISOString().slice(0, 10) + '.json';
    try {
      var blob = new Blob([txt], { type: 'application/json' });
      var a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = name;
      document.body.appendChild(a);
      a.click();
      setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 300);
    } catch (e) {
      try { window.prompt('复制下面的 JSON 保存:', txt); } catch (e2) {}
    }
    return txt;
  }
  function importJSON(txtOrObj) {
    var obj = txtOrObj;
    if (typeof obj === 'string') {
      try { obj = JSON.parse(obj); } catch (e) { return { error: '不是合法的 JSON' }; }
    }
    var arr = Array.isArray(obj) ? obj : (obj && obj.memories) || [];
    if (!Array.isArray(arr)) return { error: '没找到 memories 字段' };
    return add(arr, { src: 'user' });
  }

  /* ---------------- UI ---------------- */
  var filter = 'all', q = '';
  function $(id) { return document.getElementById(id); }
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }
  function ago(ts) {
    var d = Math.floor((now() - (ts || 0)) / 1000);
    if (d < 60) return '刚刚';
    if (d < 3600) return Math.floor(d / 60) + ' 分钟前';
    if (d < 86400) return Math.floor(d / 3600) + ' 小时前';
    if (d < 86400 * 30) return Math.floor(d / 86400) + ' 天前';
    var dt = new Date(ts);
    return (dt.getMonth() + 1) + '月' + dt.getDate() + '日';
  }
  function srcLabel(s) { return s === 'user' ? '你说过' : (s === 'ai' ? '自动记的' : '手动加的'); }

  function stat() {
    var list = all();
    var el = $('ai-mem-count');
    if (el) {
      var vis = list.filter(function (e) { return visibleByFilter(e); }).length;
      el.textContent = (filter !== 'all' || q) ? (vis + ' / ' + list.length) : String(list.length);
    }
    var inj = $('ai-mem-inj');
    if (inj) inj.textContent = enabled() ? ('本轮注入 ' + (lastInjected ? lastInjected.length : 0) + ' 条') : '已关闭';
    var tg = $('ai-mem-toggle');
    if (tg) tg.checked = enabled();
    var au = $('ai-mem-auto');
    if (au) au.checked = autoOn();
  }
  var filterFn = null;
  function visibleByFilter(e) {
    if (filter !== 'all' && e.cat !== filter) return false;
    if (!q) return true;
    return norm(e.text).indexOf(norm(q)) >= 0;
  }

  function renderCats() {
    var box = $('ai-mem-cats');
    if (!box) return;
    var list = all(), cnt = {};
    list.forEach(function (e) { cnt[e.cat] = (cnt[e.cat] || 0) + 1; });
    var html = '<button type="button" class="ai-mem-chip' + (filter === 'all' ? ' on' : '') +
      '" data-c="all">全部 ' + list.length + '</button>';
    CATS.forEach(function (c) {
      if (!cnt[c.id] && filter !== c.id) return;
      html += '<button type="button" class="ai-mem-chip' + (filter === c.id ? ' on' : '') +
        '" data-c="' + c.id + '">' + c.label + ' ' + (cnt[c.id] || 0) + '</button>';
    });
    box.innerHTML = html;
    Array.prototype.forEach.call(box.querySelectorAll('.ai-mem-chip'), function (b) {
      b.addEventListener('click', function () {
        filter = b.getAttribute('data-c');
        renderPanel();
      });
    });
  }

  function renderPanel() {
    var listEl = $('ai-mem-list');
    if (!listEl) return;
    stat();
    renderCats();

    var rows = all().filter(function (e) { return visibleByFilter(e); });
    rows.sort(function (a, b) {
      return (b.pin ? 1 : 0) - (a.pin ? 1 : 0) ||
        CAT_ORDER[a.cat] - CAT_ORDER[b.cat] ||
        (b.up || 0) - (a.up || 0);
    });
    if (!rows.length) {
      listEl.innerHTML = '<div class="ai-empty">' +
        (all().length ? '没有匹配的记忆' : '还没有记忆。聊你的偏好和背景,或者说「记住：我不吃辣」') +
        '</div>';
      return;
    }
    var html = '', lastCat = '';
    rows.forEach(function (e) {
      if (e.cat !== lastCat) {
        lastCat = e.cat;
        html += '<div class="ai-mem-group">' + CAT_LABEL[e.cat] + '</div>';
      }
      html += '<div class="ai-mem-item' + (e.pin ? ' pinned' : '') + '" data-id="' + e.id + '">' +
        '<div class="ai-mem-body">' +
        '<div class="ai-mem-t">' + esc(e.text) + '</div>' +
        '<div class="ai-mem-meta">' + esc(srcLabel(e.src)) + ' · ' + ago(e.up) +
        ((e.n || 0) > 1 ? ' · 用过 ' + e.n + ' 次' : '') +
        (e.prev && e.prev.length ? ' · 改过 ' + e.prev.length + ' 次' : '') +
        '</div></div>' +
        '<button type="button" class="ai-mem-btn pin" data-act="pin" title="' +
        (e.pin ? '取消置顶' : '置顶:每轮必带') + '" aria-label="置顶">' + (e.pin ? '★' : '☆') + '</button>' +
        '<button type="button" class="ai-mem-btn edit" data-act="edit" title="编辑" aria-label="编辑">✎</button>' +
        '<button type="button" class="ai-mem-btn del" data-act="del" title="删除这条" aria-label="删除">×</button>' +
        '</div>';
    });
    listEl.innerHTML = html;

    Array.prototype.forEach.call(listEl.querySelectorAll('.ai-mem-item'), function (row) {
      var id = row.getAttribute('data-id');
      row.addEventListener('click', function (ev) {
        var act = ev.target.getAttribute('data-act');
        if (!act) return;
        ev.stopPropagation();
        if (act === 'del') {
          save(all().filter(function (e) { return e.id !== id; }));
          renderPanel();
        } else if (act === 'pin') {
          var list = all();
          list.forEach(function (e) { if (e.id === id) e.pin = !e.pin; });
          save(list);
          renderPanel();
        } else if (act === 'edit') {
          startEdit(row, id);
        }
      });
    });
  }

  function startEdit(row, id) {
    var list = all(), e = null;
    list.forEach(function (x) { if (x.id === id) e = x; });
    if (!e) return;
    var body = row.querySelector('.ai-mem-body');
    body.innerHTML = '<input class="ai-mem-edit" type="text" value="' + esc(e.text) + '">' +
      '<div class="ai-mem-meta">回车保存,Esc 取消;写成「属性：内容」更规整</div>';
    var inp = body.querySelector('.ai-mem-edit');
    var done = false;
    inp.focus();
    inp.select();
    function commit() {
      if (done) return;
      done = true;
      var v = trimStr(inp.value, 160);
      if (!v) { renderPanel(); return; }
      var idx = v.indexOf('：') >= 0 ? '：' : (v.indexOf(':') >= 0 ? ':' : -1);
      var key2 = '', val2 = v;
      if (idx > 0 && idx <= 24) { key2 = v.slice(0, idx); val2 = v.slice(idx + 1); }
      var arr = all();
      arr.forEach(function (x) {
        if (x.id !== id) return;
        x.key = trimStr(key2, 24);
        x.val = trimStr(val2, 160);
        x.text = x.key ? x.key + '：' + x.val : x.val;
        x.up = now();
        x.src = 'user';
      });
      save(trimList(arr));
      renderPanel();
    }
    inp.addEventListener('keydown', function (ev) {
      if (ev.key === 'Enter') { ev.preventDefault(); commit(); }
      if (ev.key === 'Escape') { ev.preventDefault(); renderPanel(); }
    });
    inp.addEventListener('blur', commit);
  }

  function bindOnce() {
    var qEl = $('ai-mem-q');
    if (qEl && !qEl.__bound) {
      qEl.__bound = 1;
      qEl.addEventListener('input', function () { q = qEl.value; renderPanel(); });
    }
    var ex = $('ai-mem-export');
    if (ex && !ex.__bound) { ex.__bound = 1; ex.addEventListener('click', exportJSON); }
    var im = $('ai-mem-import');
    var file = $('ai-mem-file');
    if (im && file && !im.__bound) {
      im.__bound = 1;
      im.addEventListener('click', function () { file.click(); });
      file.addEventListener('change', function () {
        var f = file.files && file.files[0];
        if (!f) return;
        var rd = new FileReader();
        rd.onload = function () {
          var r = importJSON(String(rd.result || ''));
          renderPanel();
          if (r && r.error) { try { alert('导入失败:' + r.error); } catch (e) {} }
        };
        rd.readAsText(f);
        file.value = '';
      });
    }
    var au = $('ai-mem-auto');
    if (au && !au.__bound) {
      au.__bound = 1;
      au.addEventListener('change', function () { setAutoOn(au.checked); });
    }
    var tg = $('ai-mem-toggle');
    if (tg && !tg.__bound) {
      tg.__bound = 1;
      tg.addEventListener('change', function () {
        setEnabled(tg.checked);
        stat();
      });
    }
  }

  /* ---------------- 对外接口 ---------------- */
  window.PHHMEM = {
    all: all,
    add: add,
    forget: forget,
    clear: clear,
    extract: extract,
    block: block,
    pick: pick,
    handleLocal: handleLocal,
    quickCapture: quickCapture,
    listAnswer: listAnswer,
    enabled: enabled,
    setEnabled: setEnabled,
    autoOn: autoOn,
    setAutoOn: setAutoOn,
    countTurn: countTurn,
    shouldConsolidate: shouldConsolidate,
    markConsolidated: markConsolidated,
    compactForPrompt: compactForPrompt,
    exportJSON: exportJSON,
    importJSON: importJSON,
    renderPanel: function () { bindOnce(); renderPanel(); },
    lastInjected: function () { return lastInjected.slice(); },
    labels: CAT_LABEL
  };
})();
