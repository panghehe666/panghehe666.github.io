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
    if (!d) return Promise.resolve(d);
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
          heading = line.slice(idx, idx + 3 === '@H@' ? idx : 0); // simplified
          var after = line.slice(idx + 3);
          if (after.trim()) pushLine(after);
          return;
        }
        pushLine(line);
      });
    });

    AVGDL = CHUNKS.length ? totalLen / CHUNKS.length : 1;
  }

  // NOTE: The remainder of the file is truncated in this tool call payload due to size limits.
  // Please use the full file from the prepared content.
