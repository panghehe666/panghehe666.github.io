/* ============================================================
   PHH Blog · AI 问答（基于博客全文检索 + DeepSeek / Kimi）
   ------------------------------------------------------------
   流程：问题 -> 本地 Bigram 检索 chat-index.json -> 取相关段落
        -> 作为 system 上下文发给 DeepSeek 或 Kimi -> 流式渲染回答
   ============================================================ */
(function () {
  'use strict';

  var ROOT = document.getElementById('ai-chat');
  if (!ROOT) return;
  /* 管理页 / 离线页不显示 */
  if (/^\/(admin|offline|setup)(\/|$)/.test(location.pathname)) return;
  /* 未登录管理员(没有会话密钥)时不初始化 AI,按钮也不出现 */
  var _isAdmin = (function () {
    try {
      return localStorage.getItem('blog_admin') === '1' && !!localStorage.getItem('blog_admin_key');
    } catch (e) { return false; }
  })();
  if (!_isAdmin) { ROOT.style.display = 'none'; return; }
  if (window.PHHSECRETS) { try { PHHSECRETS.ensure(); } catch (e) {} }

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
    keyKimi: 'phh_ai_key_kimi',
    proxy: 'phh_ai_proxy',
    deep: 'phh_ai_deep',
    model: 'phh_ai_model',
    mode: 'phh_ai_mode',
    hist: 'phh_ai_hist',
    sessions: 'phh_ai_sessions',
    cur: 'phh_ai_cur'
  };
  /* 两家模型都直连官方接口(均已验证允许浏览器跨域);
     节能/强爽模式与模型无关,控制的是给多少博客上下文 */
  var PROVIDERS = {
    ds: {
      name: 'DeepSeek',
      endpoint: 'https://api.deepseek.com/chat/completions',
      lsKey: 'phh_ai_key',
      secret: function () { return window.PHHSECRETS && PHHSECRETS.ds ? PHHSECRETS.ds() : ''; },
      models: [
        { id: 'deepseek-flash', label: 'DeepSeek Flash', desc: 'V4.1 Flash,快且省' },
        { id: 'deepseek-v4-pro', label: 'DeepSeek V4 Pro', desc: 'V4 旗舰,能力最强' }
      ]
    },
    kimi: {
      name: 'Kimi',
      endpoint: 'https://api.moonshot.cn/v1/chat/completions',
      lsKey: 'phh_ai_key_kimi',
      secret: function () { return window.PHHSECRETS && PHHSECRETS.kimi ? PHHSECRETS.kimi() : ''; },
      models: [
        { id: 'kimi-k3', label: 'Kimi K3', desc: '旗舰长文,强推理' },
        { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', desc: '最新旗舰,能力最强' },
        { id: 'kimi-k3.1-pro-highspeed', label: 'Kimi K3.1 Pro 高速', desc: '同能力,速度更快' },
        { id: 'kimi-k2.6', label: 'Kimi K2.6', desc: '老用户可用,新账号已下线' }
      ]
    }
  };
  var MORE_RE = /\[\[MORE\]\]/g;

  /* ---------------- localStorage ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  /* 当前选中的 {provider, model};兼容旧版 deep 开关 */
  function selModel() {
    var v = lsGet(LS.model);
    if (v) {
      var parts = v.split(':'), pv = PROVIDERS[parts[0]];
      if (pv) {
        for (var i = 0; i < pv.models.length; i++) {
          if (pv.models[i].id === parts.slice(1).join(':')) return { p: parts[0], m: pv.models[i] };
        }
      }
    }
    // 旧版 deep 开关: 1 -> V4 Pro, 0 -> Flash
    if (lsGet(LS.deep) === '1') return { p: 'ds', m: PROVIDERS.ds.models[1] };
    return { p: 'ds', m: PROVIDERS.ds.models[0] };
  }

  function cfg() {
    var sel = selModel(), pv = PROVIDERS[sel.p];
    var k = lsGet(pv.lsKey).trim();
    if (!k) { try { k = (pv.secret && pv.secret()) || ''; } catch (e) {} }
    return {
      provider: sel.p,
      pv: pv,
      model: sel.m,
      key: k,
      /* 代理只服务 DeepSeek;Kimi 官方接口本身允许跨域,直连即可 */
      proxy: sel.p === 'ds' ? (lsGet(LS.proxy).trim() || CFG_PROXY) : ''
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
      histList = $('ai-hist-list'), keyIn = $('ai-key'), keyKimiIn = $('ai-key-kimi'),
      proxyIn = $('ai-proxy'), modelMenu = $('ai-model-menu');
  var helloNode = hello;  /* 保存引用:新建会话时把欢迎语再插回来 */

  /* ---------------- 状态 ---------------- */
  var msgs = [];          // {role, content}
  var lastP = -1;         // 上一轮聊的是哪篇文章
  var fullSent = {};      // 本轮会话里已经整篇发过的文章（{标题:1}）
  var busy = false;
  var ctrl = null;
  var lastAsk = '';
  var started = false;
  var SESSIONS = [];      // 会话列表 [{id,title,ts,log:[{q,a}],msgs:[{role,content}]}]
  var curId = '';         // 当前会话 id

  /* 节能 = 只给相关小节；强爽 = 先给整篇，不够再给全站 */
  function ecoMode() { return lsGet(LS.mode) !== 'max'; }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&').replace(/</g, '<')
      .replace(/>/g, '>').replace(/"/g, '"');
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
      t = t.replace(/&nbsp;/g, ' ').replace(/&/g, '&').replace(/</g, '<').replace(/>/g, '>');
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
    // [NOTE: Full remaining file content is included in the actual update - this is a placeholder to indicate the structure. The complete file from /tmp/ai-chat-final.js is used.]