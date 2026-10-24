/* ============================================================
   PHH Blog · AI 问答（基于博客全文检索 + DeepSeek）
   ------------------------------------------------------------
   流程：问题 -> 本地 Bigram 检索 chat-index.json -> 取相关段落
        -> 作为 system 上下文发给 DeepSeek -> 流式渲染回答
   ============================================================ */
(function () {
  'use strict';

  var ROOT = document.getElementById('ai-chat');
  if (!ROOT) return;
  /* 管理页 / 离线页不显示 */
  if (/^\/(admin|offline)(\/|$)/.test(location.pathname)) return;

  var BASE = ROOT.getAttribute('data-base') || '';
  var CFG_PROXY = (ROOT.getAttribute('data-proxy') || '').trim();
  /* 每次构建换一个版本号：既躲开 GitHub Pages 的 10 分钟缓存，
     也躲开 sw.js 的 stale-while-revalidate（否则文章更新后要刷两次才生效） */
  var BUILD = ROOT.getAttribute('data-build') || '';
  function idxUrl(name) {
    return (BASE || '') + '/' + name + (BUILD ? '?v=' + BUILD : '');
  }

  var LS = {
    key: 'phh_ai_key',
    proxy: 'phh_ai_proxy',
    deep: 'phh_ai_deep',
    mode: 'phh_ai_mode',
    hist: 'phh_ai_hist'
  };
  var DEF_ENDPOINT = 'https://api.deepseek.com/chat/completions';
  var MORE_RE = /\[\[MORE\]\]/g;

  /* ---------------- localStorage ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function cfg() {
    return {
      key: lsGet(LS.key).trim(),
      proxy: lsGet(LS.proxy).trim() || CFG_PROXY
    };
  }
  function ready() { var c = cfg(); return !!(c.key || c.proxy); }

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var fab = $('ai-fab'), panel = $('ai-panel'), bodyEl = $('ai-body'),
      hello = $('ai-hello'), chipsEl = $('ai-chips'), thread = $('ai-thread'),
      input = $('ai-input'), sendBtn = $('ai-send'), modelBtn = $('ai-model'),
      modelName = $('ai-model-name'), modeBtn = $('ai-mode'), modeName = $('ai-mode-name'),
      tipEl = $('ai-tip'), micBtn = $('ai-mic'),
      warn = $('ai-warn'), warnBtn = $('ai-warn-btn'),
      sheetSet = $('ai-sheet-set'), sheetHist = $('ai-sheet-hist'),
      histList = $('ai-hist-list'), keyIn = $('ai-key'), proxyIn = $('ai-proxy');

  /* ---------------- 状态 ---------------- */
  var msgs = [];          // {role, content}
  var lastP = -1;         // 上一轮聊的是哪篇文章
  var fullSent = {};      // 本轮会话里已经整篇发过的文章（{标题:1}）
  var busy = false;
  var ctrl = null;
  var lastAsk = '';
  var started = false;

  function deep() { return lsGet(LS.deep) === '1'; }
  /* 节能 = 只给相关小节；强爽 = 先给整篇，不够再给全站 */
  function ecoMode() { return lsGet(LS.mode) !== 'max'; }
  function modelId() { return deep() ? 'deepseek-reasoner' : 'deepseek-chat'; }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 极简 markdown：代码块 / 行内码 / 粗体 / 链接 / 列表 / 换行 */
  function md(src) {
    var blocks = [], inls = [];
    var s = String(src || '');
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) {
      blocks.push('<pre><code>' + esc(c.replace(/^[A-Za-z0-9+#._-]*\r?\n/, '').replace(/\s+$/, '')) + '</code></pre>');
      return '\u0000' + (blocks.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      inls.push('<code>' + c + '</code>');
      return '\u0001' + (inls.length - 1) + '\u0001';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/^\s*[-*]\s+/gm, '· ');
    s = s.replace(/\n/g, '<br>');
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return inls[+i] || ''; });
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return blocks[+i] || ''; });
    return s;
  }

  function nearBottom() {
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
  }
  function toBottom() { bodyEl.scrollTop = bodyEl.scrollHeight + 999; }

  /* ---------------- 索引 + 检索（BM25 + 标题加权） ---------------- */
  var IDX = null, CHUNKS = null, INV = null, AVGDL = 1, PTITLE = null, SEEN = {}, PCHUNKS = [], SECT = [];

  function tokenize(str) {
    var out = [], seen = {};
    function add(t) { if (t && !seen[t]) { seen[t] = 1; out.push(t); } }
    var lat = String(str).toLowerCase().match(/[a-z][a-z0-9+#._]{1,}/g) || [];
    lat.forEach(add);
    var segs = String(str).match(/[\u4e00-\u9fff]+/g) || [];
    segs.forEach(function (seg) {
      if (seg.length === 1) { add(seg); return; }
      for (var i = 0; i < seg.length - 1; i++) add(seg.substr(i, 2));
    });
    return out;
  }

  /* ---------- 权限分层：私密文章只对管理员解锁 ---------- */
  var privState = '';   // '' 未处理 | 'done' 已合并 | 'off' 非管理员

  function isAdmin() {
    try {
      if (window.PrivateCrypto && window.PrivateCrypto.loadSessionKey &&
          window.PrivateCrypto.loadSessionKey()) return true;
      if (document.documentElement.classList.contains('is-admin')) return true;
      return localStorage.getItem('blog_admin') === '1';
    } catch (e) { return false; }
  }

  /* 解密后的 markdown/HTML 转成检索用的纯文本，标题行补 @H@ 标记 */
  function plainify(txt) {
    var t = String(txt || '');
    if (/<\/?[a-z][^>]*>/i.test(t)) {
      t = t.replace(/<h[1-6][^>]*>/gi, '\n')
           .replace(/<\/h[1-6]>/gi, '@H@\n')
           .replace(/<br\s*\/?>/gi, '\n')
           .replace(/<\/(p|div|li|tr|blockquote)>/gi, '\n')
           .replace(/<[^>]+>/g, '');
      t = t.replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>');
    } else {
      t = t.replace(/^\s{0,3}#{1,6}\s+(.+)$/gm, '$1@H@');
      t = t.replace(/```[\s\S]*?```/g, ' ');
    }
    return t.replace(/\n{3,}/g, '\n\n').trim();
  }

  /* 登出后立刻把已解密的私密文章从索引里摘掉 */
  function syncAdminState(d) {
    if (!d) return d;
    if (privState === 'done' && !isAdmin()) {
      d.posts = d.posts.filter(function (p) { return !p.priv; });
      CHUNKS = null; INV = null;
      privState = 'off';
      var tg = $('ai-admin-tag');
      if (tg) tg.classList.remove('on');
    }
    return d;
  }

  function ensurePrivate(d) {
    if (!d || privState) return Promise.resolve(d);
    var PC = window.PrivateCrypto;
    if (!PC || !PC.decryptWithSession || !isAdmin()) {
      privState = 'off';
      return Promise.resolve(d);
    }
    privState = 'done';
    /* 私密索引单独一个文件：非管理员根本不会去下载它 */
    return fetch(idxUrl('chat-private.json'), { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (j) { return (j && j.private) || []; }, function () { return []; })
      .then(function (arr) {
        if (!arr.length) return d;
        return Promise.all(arr.map(function (p) {
          return PC.decryptWithSession(p.c).then(function (txt) {
            var body = plainify(txt);
            if (!body) return null;
            return { t: p.t, u: p.u, d: p.d, g: '私密', x: body, priv: 1 };
          }, function () { return null; });
        })).then(function (list) {
          var added = 0;
          list.forEach(function (p) {
            if (!p) return;
            d.posts.push(p);
            added++;
          });
          if (added) {
            if (CHUNKS) { CHUNKS = null; INV = null; }
            var tg = $('ai-admin-tag');
            if (tg) { tg.classList.add('on'); tg.textContent = '管理员 · 含私密 ' + added; }
          }
          return d;
        });
      }, function () { return d; });
  }

  function loadIndex() {
    if (IDX) return Promise.resolve(IDX);
    return fetch(idxUrl('chat-index.json'), { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (txt) {
        var d = JSON.parse(txt);
        if (!d || !d.posts) throw new Error('bad index');
        if (d.about) d.posts.unshift({ t: '关于这个博客', u: '/about/', d: '', g: '', x: d.about });
        IDX = d;
        return d;
      });
  }

  /* 目录 / 纯编号列表：进索引只会污染检索，命中后也没信息量 */
  function isToc(t) {
    if (t.indexOf('📑') >= 0 || t.indexOf('目录') >= 0) return true;
    var num = (t.match(/(^|\s)\d+(\.\d+)*[、.\s]/g) || []).length;
    return num >= 3 && !/[。！？]/.test(t) && t.length < 220;
  }

  function buildIndex(d) {
    if (CHUNKS) return;
    CHUNKS = []; INV = {}; PTITLE = []; SEEN = {}; PCHUNKS = []; SECT = [];
    var totalLen = 0;

    (d.posts || []).forEach(function (p, pi) {
      PCHUNKS[pi] = [];
      SECT[pi] = [];
      PTITLE[pi] = {};
      tokenize(p.t || '').forEach(function (t) { PTITLE[pi][t] = 1; });

      var heading = '';

      function flush(txt) {
        var t = String(txt).replace(/\s+/g, ' ').trim();
        if (t.length < 24 && !/[。！？，；]/.test(t)) return;  // 标题/列表碎片，没信息量
        if (t.length < 8) return;
        if ((t.match(/[{};<>]/g) || []).length > t.length * 0.16) return;
        if (SEEN[t]) return;
        if (isToc(t)) return;
        SEEN[t] = 1;
        var toks = tokenize((heading ? heading + ' ' : '') + t);
        if (!toks.length) return;
        var tf = {}, len = 0, i;
        for (i = 0; i < toks.length; i++) { tf[toks[i]] = (tf[toks[i]] || 0) + 1; len++; }
        var id = CHUNKS.length;
        var last = SECT[pi][SECT[pi].length - 1];
        if (!last || last.h !== heading) {
          last = { h: heading, ids: [] };
          SECT[pi].push(last);
        }
        CHUNKS.push({ p: pi, t: t, h: heading, len: len, s: SECT[pi].length - 1 });
        last.ids.push(id);
        PCHUNKS[pi].push(id);
        totalLen += len;
        for (var k in tf) (INV[k] || (INV[k] = [])).push([id, tf[k]]);
      }

      function pushLine(line) {
        var raw = String(line).replace(/\s+/g, ' ').trim();
        if (!raw) return;
        var buf = '';
        for (var i = 0; i < raw.length; i++) {
          var ch = raw[i];
          buf += ch;
          if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';' || buf.length >= 300) {
            flush(buf); buf = '';
          }
        }
        flush(buf);
      }

      String(p.x || '').split('\n').forEach(function (line) {
        var idx = line.indexOf('@H@');
        if (idx >= 0) {
          heading = line.slice(0, idx).trim().slice(0, 80);
          var after = line.slice(idx + 3);
          if (after.trim()) pushLine(after);
          return;
        }
        pushLine(line);
      });
    });

    AVGDL = CHUNKS.length ? totalLen / CHUNKS.length : 1;
  }

  function retrieve(d, q) {
    if (!CHUNKS) buildIndex(d);
    var qs = tokenize(q);
    if (!qs.length || !CHUNKS.length) return [];

    var N = CHUNKS.length, k1 = 1.2, b = 0.75;
    var scores = {}, bonus = {}, i, k;

    qs.forEach(function (t) {
      var plist = INV[t];
      if (!plist) return;
      var df = plist.length;
      if (df > N * 0.5) return;
      var idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (var j = 0; j < plist.length; j++) {
        var id = plist[j][0], tf = plist[j][1], dl = CHUNKS[id].len;
        var denom = tf + k1 * (1 - b + b * dl / AVGDL);
        scores[id] = (scores[id] || 0) + idf * (tf * (k1 + 1)) / denom;
      }
    });

    var posts = d.posts || [];
    var idfCache = {};
    function termIdf(t) {
      if (idfCache[t] !== undefined) return idfCache[t];
      var pl = INV[t], r = 3.0;
      if (pl) { var df = pl.length; r = Math.log(1 + (N - df + 0.5) / (df + 0.5)); }
      idfCache[t] = r; return r;
    }
    for (var pi = 0; pi < posts.length; pi++) {
      var set = PTITLE[pi] || {};
      for (k = 0; k < qs.length; k++) {
        if (set[qs[k]]) bonus[pi] = (bonus[pi] || 0) + termIdf(qs[k]) * 1.6;
      }
    }

    var ranked = Object.keys(scores).map(Number);
    if (!ranked.length) {
      if (/你|本人|作者|自我介绍|这个网站|这个博客|关于/.test(q) && posts[0] && posts[0].t === '关于这个博客') {
        return [{ p: 0, id: -1, s: 0, title: posts[0].t, url: posts[0].u, date: '', text: String(posts[0].x).slice(0, 300), h: '' }];
      }
      return [];
    }
    ranked.forEach(function (id) {
      var bn = bonus[CHUNKS[id].p];
      if (bn) scores[id] += bn;
    });
    ranked.sort(function (x, y) { return scores[y] - scores[x]; });

    var top = scores[ranked[0]], perPost = {}, hitCount = {}, out = [];
    hitCount[CHUNKS[ranked[0]].p] = 0;
    for (var j = 0; j < ranked.length && out.length < 7; j++) {
      var id2 = ranked[j];
      if (scores[id2] < top * 0.3) break;
      var c = CHUNKS[id2];
      var cap = (out.length === 0) ? 2 : 1;
      if ((perPost[c.p] || 0) >= cap) continue;
      perPost[c.p] = (perPost[c.p] || 0) + 1;
      var pp = posts[c.p] || {};
      out.push({ p: c.p, id: id2, s: c.s, title: pp.t || '', url: pp.u || '', date: pp.d || '', text: c.t, h: c.h || '' });
    }

    /* 标题命中更可信：把标题最匹配的那篇提到第一位（后面会拿它整篇正文） */
    var best = out[0].p, bestBn = bonus[best] || 0;
    for (var pi2 = 0; pi2 < posts.length; pi2++) {
      var bn2 = bonus[pi2] || 0;
      if (bn2 > bestBn + 0.9) { best = pi2; bestBn = bn2; }
    }
    if (best !== out[0].p) {
      for (var m = 1; m < out.length; m++) {
        if (out[m].p === best) {
          var tmp = out[0]; out[0] = out[m]; out[m] = tmp;
          break;
        }
      }
    }
    return out;
  }

  /* 把命中的文章整理成给模型的正文上下文
     full=false：只给命中那一小节（+ 开头引言），约 800~1400 字
     full=true ：整篇正文，用在模型主动要全文时 */
  function cleanBody(s) {
    return String(s || '')
      .replace(/@H@/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function secText(pi, si, cap) {
    var sec = (SECT[pi] || [])[si];
    if (!sec) return '';
    var out = [], total = 0;
    for (var i = 0; i < sec.ids.length && total < (cap || 1600); i++) {
      var c = CHUNKS[sec.ids[i]];
      out.push(c.t);
      total += c.t.length;
    }
    return out.join('\n');
  }

  function isFollowUp(q) {
    if (!q) return false;
    return /^(它|他|她|这|那|该|其|此|上面|刚才|前面|继续|再|还|那么|所以|然后|另外|而且)/.test(q);
  }

  /* 这篇文章的正文是不是已经在前面几轮里发过了 */
  function alreadySent(history, title) {
    if (!history || !history.length) return false;
    var tag = '### 《' + title + '》';
    for (var i = 0; i < history.length; i++) {
      var c = history[i] && history[i].content;
      if (c && c.indexOf(tag) >= 0) return true;
    }
    return false;
  }

  /* level 0：命中那一小节
     level 1：命中文章整篇
     level 2：全站所有文章（强爽模式的最后一级） */
  function corpusContext(d, history) {
    var posts = d.posts || [], out = [], total = 0;
    for (var i = 0; i < posts.length && total < 26000; i++) {
      var p = posts[i];
      var body = cleanBody(p.x);
      if (!body) continue;
      var head = '### 《' + (p.t || '') + '》 ' + (p.d || '') + ' ' + (p.u || '');
      if (alreadySent(history, p.t)) { out.push(head + '\n(正文见前几轮)'); continue; }
      if (body.length > 3200) body = body.slice(0, 3200) + '…';
      out.push(head + '\n' + body);
      total += body.length;
    }
    return out.join('\n\n');
  }

  function buildContext(d, hits, level, history) {
    if (!d) return '';
    level = level || 0;
    if (level >= 2) return corpusContext(d, history);
    var full = level >= 1;
    if (!hits || !hits.length) return '';
    var posts = d.posts || [];
    var main = hits[0];
    var mp = posts[main.p] || {};
    var head = '### 《' + (mp.t || '') + '》 ' + (mp.d || '') + ' ' + (mp.u || '');

    /* 这篇前面已经发过（小节或整篇）：正文不再重发，靠历史里的缓存命中 */
    var skipMain = full ? !!fullSent[mp.t] : alreadySent(history, mp.t);
    if (skipMain) {
      var rest = [];
      var used0 = {}; used0[main.p] = 1;
      for (var q = 1; q < hits.length && rest.length < 2; q++) {
        var hq = hits[q];
        if (used0[hq.p]) continue;
        var pq = posts[hq.p] || {};
        var tq = (hq.h ? '【' + hq.h + '】' : '') + secText(hq.p, hq.s, 260);
        if (!tq) continue;
        rest.push('### 《' + (pq.t || '') + '》 ' + (pq.u || '') + '\n' + tq);
        used0[hq.p] = 1;
      }
      return head + '\n(这篇的正文在前几轮已经给过了,直接引用前文即可)\n\n' + rest.join('\n\n');
    }

    var body;

    if (full) {
      body = cleanBody(mp.x);
      if (body.length > 9000) body = body.slice(0, 9000) + '…';
    } else {
      var pieces = [];
      var secs = SECT[main.p] || [];
      var sec = secs[main.s];
      /* 文章开头的引子，给个背景，避免只有半截 */
      if (secs[0] && secs[0] !== sec && secs[0].ids.length) {
        var intro = secText(main.p, 0, 300);
        if (intro && (!sec || intro !== secText(main.p, main.s, 300))) pieces.push(intro);
      }
      var st = secText(main.p, main.s, 1800);
      pieces.push((sec && sec.h ? '【' + sec.h + '】' : '') + st);
      body = pieces.join('\n');
    }

    var out = [head + '\n' + body];
    var used = {};
    used[main.p] = 1;
    var budget = (full ? 9000 : 3200) - body.length;

    for (var i = 1; i < hits.length && out.length < 5 && budget > 240; i++) {
      var h = hits[i];
      if (used[h.p]) continue;
      var pp = posts[h.p] || {};
      var t2 = (h.h ? '【' + h.h + '】' : '') + secText(h.p, h.s, 400);
      if (!t2) continue;
      var line = '### 《' + (pp.t || '') + '》 ' + (pp.u || '') + '\n' + t2;
      out.push(line);
      budget -= line.length;
      used[h.p] = 1;
    }
    return out.join('\n\n');
  }

  /* system 内容保持逐字不变，Good for DeepSeek 的前缀缓存 */
  function sysPrompt() {
    var s = [];
    s.push('你是「庞和合」本人的 AI 分身,是个人博客 panghehe666.github.io 的问答助手。');
    s.push('身份:庞和合,网名 PHH,高三学生,喜欢折腾、热爱数码,在博客里写科技和数码的内容。');
    s.push('说话方式:中文口语,第一人称,简洁直接,像在微信里聊天。');
    s.push('');
    s.push('每轮对话里,用户消息会带两部分:【博客正文】(真实正文,可能只是命中的那一小节)和【我的问题】。');
    s.push('');
    s.push('规则:');
    s.push('1. 【博客正文】是文章真实正文(可能带【小节标题】),里面的结论、数据、原话、章节名都可以直接引用。');
    s.push('2. 正文覆盖到的问题,直接按正文回答,不要说"我只看到标题""内容不在资料里"。');
    if (ecoMode()) {
      s.push('3. 如果正文明显不够答准(比如只剩半句话、或答案在别的小节),你就只输出 [[MORE]] 这个标记(不要输出任何别的字),系统会自动把整篇补给你。能答就不要用。');
    } else {
      s.push('3. 你现在拿到的是整篇正文。如果需要跨文章对比、或答案明显在别的文章里,你就只输出 [[MORE]] 这个标记(不要输出任何别的字),系统会把全站文章都调给你。能答就不要用。');
      s.push('3.5 强爽模式下允许你答得更展开,该列点列点、该给结论给结论,上限 12 句。');
    }
    s.push('4. 补了全文还找不到的部分,就说"这篇里那段我没拿到,你点进去看原文",并给出链接。');
    s.push('5. 整篇博客都没写过的,先直说"这个我博客里没写过",再用一两句常识补充,并说明那不是博客内容。');
    s.push('6. 不要编造标题、日期、链接、数据。');
    s.push('7. 指向文章时用 markdown 链接:[文章标题](链接),链接只能来自下面出现的 URL。');
    s.push('8. 尽量 2~4 句答完;确实需要展开时不超过 8 句。不要说"作为 AI""根据提供的资料"。');

    if (IDX && IDX.posts && IDX.posts.length) {
      var hasPriv = false;
      s.push('');
      s.push('【博客文章列表】');
      IDX.posts.forEach(function (p) {
        if (p.priv) hasPriv = true;
        s.push('- 《' + p.t + '》 ' + (p.d || '') + ' ' + (p.u || '') + (p.priv ? ' 【私密】' : ''));
      });
      if (hasPriv) {
        s.push('');
        s.push('标注【私密】的文章是管理员才看得到的加密文章。当前会话已解锁,可以正常引用它的内容;' +
               '但如果提问的人明显不是本人(比如自称访客),只说"这部分是私密内容,不方便展开"。');
      }
    }
    return s.join('\n');
  }

  function userMsg(text, hits, level, history) {
    var ctx = buildContext(IDX, hits, level, history);
    var label = level >= 2 ? '·全站' : (level >= 1 ? '·整篇' : '·节选');
    return '【博客正文' + label + '】\n' +
      (ctx || '(这次没检索到相关正文,只能靠文章列表回答)') +
      '\n\n【我的问题】\n' + text;
  }

  /* ---------------- 渲染 ---------------- */
  function hideHello() {
    if (hello && hello.parentNode) hello.parentNode.removeChild(hello);
    hello = null;
  }

  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'ai-u';
    d.textContent = text;
    thread.appendChild(d);
    toBottom();
  }

  function addAssistant() {
    var d = document.createElement('div');
    d.className = 'ai-a';
    d.innerHTML = '<div class="ai-dots"><i></i><i></i><i></i></div>';
    thread.appendChild(d);
    toBottom();
    return d;
  }

  function render(node, text, reason, hits, done) {
    var html = '';
    if (reason) html += '<div class="ai-reason">' + md(reason) + '</div>';
    if (text) html += '<div class="ai-txt">' + md(text) + '</div>';
    else if (!reason) html = '<div class="ai-dots"><i></i><i></i><i></i></div>';
    if (done && hits && hits.length) {
      var seen = {}, links = [];
      hits.forEach(function (h) {
        if (!h.url || seen[h.url] || links.length >= 3) return;
        seen[h.url] = 1;
        links.push('<a href="' + esc(h.url) + '">' + esc(h.title) + '</a>');
      });
      if (links.length) html += '<div class="ai-src">参考:' + links.join(' · ') + '</div>';
    }
    var stick = nearBottom();
    node.innerHTML = html;
    if (stick) toBottom();
  }

  function renderError(node, msg, retryText) {
    node.innerHTML = '<div class="ai-err">' + esc(msg) + '</div>' +
      (retryText ? '<div class="ai-act"><button type="button" data-retry="1">重试</button></div>' : '');
    if (retryText) {
      node.querySelector('[data-retry]').addEventListener('click', function () {
        node.parentNode && node.parentNode.removeChild(node);
        ask(retryText);
      });
    }
    toBottom();
  }

  /* ---------------- 请求 ---------------- */
  function endpoint() { var c = cfg(); return c.proxy || DEF_ENDPOINT; }

  function headers() {
    var c = cfg(), h = { 'Content-Type': 'application/json' };
    if (!c.proxy && c.key) h['Authorization'] = 'Bearer ' + c.key;
    return h;
  }

  function stream(payload, onDelta, onReason, signal) {
    return fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var e = new Error('HTTP ' + res.status);
          e.status = res.status;
          e.body = t;
          throw e;
        });
      }
      var ct = (res.headers.get('content-type') || '');
      if (ct.indexOf('text/event-stream') < 0) {
        return res.json().then(function (j) {
          var ch = j.choices && j.choices[0];
          if (!ch) throw new Error((j.error && j.error.message) || '接口返回异常');
          var m = ch.message || {};
          if (m.reasoning_content && onReason) onReason(m.reasoning_content);
          if (m.content) onDelta(m.content);
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          buf = buf.replace(/\r\n/g, '\n');
          var parts = buf.split('\n\n');
          buf = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var lines = parts[i].split('\n');
            for (var k = 0; k < lines.length; k++) {
              var ln = lines[k];
              if (ln.indexOf('data:') !== 0) continue;
              var d = ln.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              var o;
              try { o = JSON.parse(d); } catch (e) { continue; }
              if (o.error) throw new Error(o.error.message || '接口报错');
              var ch = o.choices && o.choices[0];
              if (!ch) continue;
              var dl = ch.delta || {};
              if (dl.reasoning_content && onReason) onReason(dl.reasoning_content);
              if (dl.content) onDelta(dl.content);
            }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function errText(e) {
    if (!e) return '出错了';
    if (e.name === 'AbortError') return '';
    if (e.status === 401) return 'Key 不对(401)。设置里检查一下 API Key。';
    if (e.status === 402) return 'DeepSeek 账户余额不足(402),充点钱再来。';
    if (e.status === 422) return '请求参数有问题(422)。' + (e.body || '').slice(0, 120);
    if (e.status === 429) return '请求太频繁(429),歇几秒再问。';
    if (e.status === 400) return '请求被拒(400)。' + (e.body || '').slice(0, 160);
    if (e.status >= 500) return 'DeepSeek 那边打嗝了(HTTP ' + e.status + '),等会儿再试。';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(e.message || '')) return '网络不通。检查网络,或确认代理地址可用。';
    return '出错了:' + (e.message || e);
  }

  /* ---------------- 主流程 ---------------- */
  function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;

    if (!ready()) {
      warn.classList.add('on');
      openSheet(sheetSet);
      return;
    }

    hideHello();
    addUser(text);
    var node = addAssistant();
    lastAsk = text;
    busy = true;
    updateSend();
    ctrl = window.AbortController ? new AbortController() : null;

    var history = trimMsgs(msgs);
    var escalated = false;
    var eco = ecoMode();
    var startLv = eco ? 0 : 1;
    var maxLv = eco ? 1 : 2;

    loadIndex().then(function (d) { return d; }, function () { return null; })
      .then(function (d) {
        return ensurePrivate(syncAdminState(d)).then(function () { return d; }, function () { return d; });
      })
      .then(function (d) {
        var hits = [];
        if (d) { try { hits = retrieve(d, text); } catch (e) { hits = []; } }

        /* 追问（"那它呢""再细说"）时，尽量接着上一篇聊，别中途换车 */
        if (hits.length && lastP >= 0 && isFollowUp(text)) {
          for (var hi = 0; hi < hits.length; hi++) {
            if (hits[hi].p === lastP) {
              var t0 = hits[0]; hits[0] = hits[hi]; hits[hi] = t0;
              break;
            }
          }
        }
        if (hits.length) lastP = hits[0].p;

        function pass(level) {
          var uc = userMsg(text, hits, level, history);
          var messages = [{ role: 'system', content: sysPrompt() }]
            .concat(history)
            .concat([{ role: 'user', content: uc }]);

          var payload = { model: modelId(), messages: messages, stream: true, max_tokens: eco ? 800 : 1400 };
          if (!deep()) payload.temperature = 1.0;

          var acc = '', rea = '';
          return stream(payload,
            function (delta) { acc += delta; render(node, acc.replace(MORE_RE, ''), rea, hits, false); },
            function (r) { rea += r; render(node, acc.replace(MORE_RE, ''), rea, hits, false); },
            ctrl ? ctrl.signal : undefined
          ).then(function () {
            /* 节选不够 → 整篇；整篇不够 → 全站。每问最多升级一次 */
            if (level < maxLv && !escalated && acc.indexOf('[[MORE]]') >= 0) {
              escalated = true;
              node.innerHTML = '<div class="ai-dim">' +
                (level === 0 ? '这一节不够,翻一下全文…' : '这篇不够,翻整个博客…') + '</div>';
              return pass(level + 1);
            }
            return { acc: acc, rea: rea, uc: uc, lv: level };
          });
        }

        return pass(startLv).then(function (res) {
          var out = String(res.acc || '').replace(MORE_RE, '').trim();
          if (!out && !res.rea) out = '(没有返回内容)';
          render(node, out, res.rea, hits, true);
          /* 存带上下文的完整消息：下一轮它就成了稳定前缀，命中缓存 */
          msgs.push({ role: 'user', content: res.uc });
          msgs.push({ role: 'assistant', content: out || '(空)' });
          msgs = trimMsgs(msgs);
          if (res.lv >= 1 && hits.length) {
            if (res.lv >= 2) (d.posts || []).forEach(function (pp) { fullSent[pp.t] = 1; });
            else fullSent[hits[0].title] = 1;
          }
          saveHist(text, out);
        });
      })
      .catch(function (e) {
        var m = errText(e);
        if (m) renderError(node, m, text);
        else render(node, '', '', [], true);
      })
      .then(function () {
        busy = false;
        ctrl = null;
        updateSend();
      });
  }

  /* 历史按字数裁剪，保留最近的问答对（前缀越稳定，缓存命中越高） */
  function trimMsgs(arr, budget) {
    budget = budget || 8000;
    var out = [], total = 0;
    for (var i = arr.length - 1; i >= 0; i--) {
      var len = (arr[i].content || '').length;
      if (total + len > budget && out.length >= 2) break;
      out.unshift(arr[i]);
      total += len;
    }
    return out;
  }

  function updateSend() {
    if (busy) { sendBtn.classList.remove('ready'); sendBtn.classList.add('stop'); }
    else {
      sendBtn.classList.remove('stop');
      sendBtn.classList.toggle('ready', !!input.value.trim());
    }
  }

  function stopStream() {
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    busy = false;
    ctrl = null;
    updateSend();
  }

  /* ---------------- 历史记录 ---------------- */
  function getHist() {
    try { return JSON.parse(lsGet(LS.hist) || '[]') || []; } catch (e) { return []; }
  }
  function saveHist(q, a) {
    if (!a) return;
    var h = getHist();
    h.unshift({ q: q.slice(0, 80), a: a, t: Date.now() });
    lsSet(LS.hist, JSON.stringify(h.slice(0, 24)));
  }
  function renderHist() {
    var h = getHist();
    if (!h.length) { histList.innerHTML = '<div class="ai-empty">还没有历史记录</div>'; return; }
    histList.innerHTML = '';
    h.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ai-hist-item';
      var d = new Date(it.t);
      b.innerHTML = '<span class="q">' + esc(it.q) + '</span><span class="t">' +
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</span>';
      b.addEventListener('click', function () {
        hideHello();
        thread.innerHTML = '';
        msgs = [];
        lastP = -1;
        fullSent = {};
        addUser(it.q);
        var node = addAssistant();
        node.innerHTML = '<div class="ai-txt">' + md(it.a) + '</div>';
        msgs.push({ role: 'user', content: it.q }, { role: 'assistant', content: it.a });
        toBottom();
        closeSheets();
      });
      histList.appendChild(b);
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- 面板开关 ---------------- */
  function open() {
    ROOT.classList.add('open');
    lsSet('phh_ai_opened', '1');
    warn.classList.toggle('on', !ready());
    setTimeout(function () { if (window.innerWidth > 600) input.focus(); }, 240);
    toBottom();
  }
  function close() {
    ROOT.classList.remove('open');
    closeSheets();
    try { input.blur(); } catch (e) {}
  }
  function openSheet(el) {
    [sheetSet, sheetHist].forEach(function (s) { s.classList.toggle('on', s === el); });
    if (el === sheetSet) {
      keyIn.value = lsGet(LS.key);
      proxyIn.value = lsGet(LS.proxy) || CFG_PROXY;
    }
    if (el === sheetHist) renderHist();
  }
  function closeSheets() {
    [sheetSet, sheetHist].forEach(function (s) { s.classList.remove('on'); });
  }

  /* ---------------- 快捷提问 ---------------- */
  var CHIPS = [
    '这个博客都写些什么?',
    '安卓手机上怎么玩 DeepSeek Harness?',
    'Token 怎么才能用得久一点?',
    '你为什么会开始写博客?'
  ];
  CHIPS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-chip';
    b.textContent = t;
    b.addEventListener('click', function () { ask(t); });
    chipsEl.appendChild(b);
  });

  /* ---------------- 事件 ---------------- */
  fab.addEventListener('click', open);
  $('ai-close').addEventListener('click', close);
  $('ai-set').addEventListener('click', function () { openSheet(sheetSet); });
  $('ai-hist').addEventListener('click', function () { openSheet(sheetHist); });
  Array.prototype.forEach.call(document.querySelectorAll('.ai-sheet-close'), function (b) {
    b.addEventListener('click', closeSheets);
  });
  warnBtn.addEventListener('click', function () { openSheet(sheetSet); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ROOT.classList.contains('open')) {
      if (sheetSet.classList.contains('on') || sheetHist.classList.contains('on')) closeSheets();
      else close();
    }
  });

  sendBtn.addEventListener('click', function () {
    if (busy) { stopStream(); return; }
    var v = input.value.trim();
    if (!v) return;
    input.value = '';
    autosize();
    updateSend();
    ask(v);
  });

  input.addEventListener('input', function () { autosize(); updateSend(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  }

  /* 模型切换 */
  modelBtn.addEventListener('click', function () {
    var next = !deep();
    lsSet(LS.deep, next ? '1' : '0');
    syncModel();
  });
  modeBtn.addEventListener('click', function () {
    lsSet(LS.mode, ecoMode() ? 'max' : 'eco');
    syncModel();
  });
  function syncModel() {
    var d = deep(), eco = ecoMode();
    modelName.textContent = d ? 'DeepSeek Reasoner' : 'DeepSeek Chat';
    modeName.textContent = eco ? '节能' : '强爽';
    modeBtn.classList.toggle('on', !eco);
    if (tipEl) {
      tipEl.textContent = eco
        ? '节能模式：只带相关小节，够不够由它自己开口要'
        : '强爽模式：先给整篇，不够再调全站，答案最全也最费 token';
    }
  }

  /* 设置 */
  $('ai-save').addEventListener('click', function () {
    lsSet(LS.key, keyIn.value.trim());
    lsSet(LS.proxy, proxyIn.value.trim());
    warn.classList.toggle('on', !ready());
    closeSheets();
  });
  $('ai-clear').addEventListener('click', function () {
    lsDel(LS.key); lsDel(LS.proxy);
    keyIn.value = ''; proxyIn.value = CFG_PROXY;
    warn.classList.add('on');
  });

  /* 历史清空 */
  $('ai-hist-clear').addEventListener('click', function () {
    lsDel(LS.hist);
    renderHist();
  });

  /* 语音输入 */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    micBtn.classList.add('avail');
    var rec = null, recording = false;
    micBtn.addEventListener('click', function () {
      if (recording) { try { rec.stop(); } catch (e) {} return; }
      try {
        rec = new SR();
        rec.lang = 'zh-CN';
        rec.interimResults = true;
        rec.continuous = false;
        rec.onresult = function (ev) {
          var t = '';
          for (var i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
          input.value = t;
          autosize(); updateSend();
        };
        rec.onend = function () { recording = false; micBtn.classList.remove('rec'); };
        rec.onerror = function () { recording = false; micBtn.classList.remove('rec'); };
        rec.start();
        recording = true;
        micBtn.classList.add('rec');
      } catch (e) {}
    });
  }

  var scrim = document.getElementById('ai-scrim');
  if (scrim) scrim.addEventListener('click', close);

  /* 初始化 */
  if (isAdmin()) { var ap = $('ai-admin-tag'); if (ap) ap.classList.add('on'); }
  if (document.querySelector('.cal-fab')) ROOT.classList.add('has-cal');
  syncModel();
  updateSend();
  warn.classList.toggle('on', !ready());
})();
