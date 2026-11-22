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
    mem: 'phh_ai_mem',
    memOn: 'phh_ai_mem_on',
    keyKimi: 'phh_ai_key_kimi',
    proxy: 'phh_ai_proxy',
    deep: 'phh_ai_deep',
    model: 'phh_ai_model',
    mode: 'phh_ai_mode',
    web: 'phh_ai_web',
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
        { id: 'kimi-k2.6', label: 'Kimi K2.6', desc: '通用,性价比高' },
        { id: 'kimi-k3', label: 'Kimi K3', desc: '旗舰长文,强推理' },
        { id: 'kimi-k3.1-pro', label: 'Kimi K3.1 Pro', desc: '最新旗舰,能力最强' }
      ]
    }
  };
  var MORE_RE = /\[\[MORE\]\]/g;

  /* ---------------- 长期记忆(实现在 js/ai-memory.js,仿豆包) ----------------
     结构化条目 + 冲突合并 + 按相关度注入;白嫖模式不读不写。 */
  var MEM = window.PHHMEM || null;

  /* 记忆开关:关闭只暂停(不写不读),不删除已存条目 */
  function memOn() { return MEM ? MEM.enabled() : lsGet(LS.memOn) !== '0'; }
  /* 联网搜索手动开关(仿 DeepSeek):开=本轮走联网直搜,关=正常对话 */
  function webOn() { return lsGet(LS.web) === '1'; }
  function addMem(items, src) {
    if (!MEM) return null;
    try { return MEM.add(items, { src: src || 'ai' }); } catch (e) { return null; }
  }
  function forgetMem(keys) { if (MEM) { try { MEM.forget(keys); } catch (e) {} } }
  /* 每轮按相关度挑几条注入,不再全量塞 system */
  function memBlock(text) {
    if (!MEM || !memOn()) return '';
    try { return MEM.block(text); } catch (e) { return ''; }
  }
  /* 本地零 token 处理「你记得我什么」「忘掉 X 的记忆」 */
  function memLocal(text) {
    if (!MEM || !memOn()) return null;
    try { return MEM.handleLocal(text); } catch (e) { return null; }
  }
  /* 显式声明(我叫 X / 我住在 X / 记住:X)本地直接存,不等模型 */
  function memCapture(text) {
    if (!MEM || !memOn()) return [];
    try { return MEM.quickCapture(text); } catch (e) { return []; }
  }
  /* 从模型输出里提取 [[MEM:分类|键|值]] 保存、[[FORGET:...]] 删除,并去掉标记 */
  function extractMem(text) {
    if (MEM) { try { return MEM.extract(text); } catch (e) {} }
    var mems = [], fgs = [], clean = String(text || '');
    clean = clean.replace(/\[\[MEM:\s*([^\]]*)\]\]/g, function (_, v) { if (v.trim()) mems.push(v.trim()); return ''; });
    clean = clean.replace(/\[\[FORGET:\s*([^\]]*)\]\]/g, function (_, v) { if (v.trim()) fgs.push(v.trim()); return ''; });
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();
    return { mems: mems, fgs: fgs, clean: clean };
  }
  /* [[SRC:标题|链接]] 来源标记 */
  var SRC_RE = /\[\[SRC:\s*([^\]|]*?)\s*\|\s*([^\]]*?)\s*\]\]/g;
  function extractSources(text) {
    var out = [], clean = String(text || '');
    clean = clean.replace(SRC_RE, function (_, title, url) {
      if (/^https?:\/\//i.test(url)) out.push({ title: title || url, url: url });
      return '';
    });
    /* 先压缩空行再清尾标签,否则结尾的 \n\n 会让 $ 匹配不到 */
    clean = clean.replace(/\n{3,}/g, '\n\n').trim();
    if (out.length) {
      clean = clean.replace(/(^|\n)[ \t]*[-—]*[ \t]*((参考)?来源|参考|参考资料)[ \t]*[:：]?[ \t]*$/g, '').trim();
      /* 去掉来源清单前遗留的分隔线 */
      clean = clean.replace(/(^|\n)[ \t]*([-*_]\s*){2,}$/g, '').trim();
    }
    return { list: out, clean: clean };
  }
  function stripMarkers(s) {
    return String(s || '')
      .replace(/\[\[(MEM|FORGET):[^\]]*\]\]/g, '')
      .replace(/\[\[SRC:[^\]]*\]\]/g, '')
      .replace(/\[\[SRC:[^\]]*$/, '')
      .replace(MORE_RE, '');
  }

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
      sheetSet = $('ai-sheet-set'), sheetHist = $('ai-sheet-hist'), sheetMem = $('ai-sheet-mem'),
      sheetStats = $('ai-sheet-stats'),
      memListEl = $('ai-mem-list'), memToggle = $('ai-mem-toggle'),
      histList = $('ai-hist-list'), keyIn = $('ai-key'), keyKimiIn = $('ai-key-kimi'),
      proxyIn = $('ai-proxy'), modelMenu = $('ai-model-menu');
  var helloNode = hello;  /* 保存引用:新建会话时把欢迎语再插回来 */

  /* ---------------- 明暗主题 ---------------- */
  var THEME_LS = 'phh_ai_theme';
  var themeBtn = $('ai-theme');
  function applyTheme(t) {
    ROOT.classList.toggle('light', t === 'light');
    if (themeBtn) {
      themeBtn.setAttribute('title', t === 'light' ? '切到深色' : '切到浅色');
      themeBtn.setAttribute('aria-label', t === 'light' ? '切到深色' : '切到浅色');
    }
  }
  if (themeBtn) {
    themeBtn.addEventListener('click', function () {
      var t = lsGet(THEME_LS) === 'light' ? 'dark' : 'light';
      lsSet(THEME_LS, t);
      applyTheme(t);
    });
  }
  applyTheme(lsGet(THEME_LS) === 'light' ? 'light' : 'dark');

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
  /* 白嫖模式:纯聊天,完全不读博客文章(不检索、不带正文、不带文章列表) */
  function freeMode() { return lsGet(LS.mode) === 'free'; }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* ---------- Markdown 渲染:标题/引用/列表/表格/代码块/分隔线/行内格式 ---------- */
  function md(src) {
    var text = String(src || '').replace(/\r\n?/g, '\n');
    var codes = [];
    text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, function (_, lang, code) {
      codes.push('<pre><code' + (lang.trim() ? ' class="language-' + esc(lang.trim()) + '"' : '') + '>' +
        esc(code.replace(/\s+$/, '')) + '</code></pre>');
      return '\u0000' + (codes.length - 1) + '\u0000';
    });
    var lines = text.split('\n');
    var out = [];
    var i = 0;
    var boundary = /^(#{1,6}\s|\s*>|\s*[-*+]\s+|\s*\d+[.)]\s+|\s*\|)/;
    while (i < lines.length) {
      var ln = lines[i];
      if (!ln.trim()) { i++; continue; }
      var cm = ln.match(/^\u0000(\d+)\u0000$/);
      if (cm) { out.push(codes[+cm[1]] || ''); i++; continue; }
      var hm = ln.match(/^(#{1,6})\s+(.*)$/);
      if (hm) {
        var lv = hm[1].length;
        out.push('<h' + lv + '>' + inlineMd(hm[2]) + '</h' + lv + '>');
        i++; continue;
      }
      if (/^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(ln)) { out.push('<hr>'); i++; continue; }
      if (/^\s*>\s?/.test(ln)) {
        var q = [];
        while (i < lines.length && /^\s*>\s?/.test(lines[i])) {
          q.push(inlineMd(lines[i].replace(/^\s*>\s?/, '')));
          i++;
        }
        out.push('<blockquote>' + q.join('<br>') + '</blockquote>');
        continue;
      }
      var lm = ln.match(/^\s*([-*+]|\d+[.)])\s+/);
      if (lm) {
        var ordered = /^\d/.test(lm[1]);
        var ptn = ordered ? /^\s*\d+[.)]\s+(.*)$/ : /^\s*[-*+]\s+(.*)$/;
        var items = [];
        while (i < lines.length) {
          var im = lines[i].match(ptn);
          if (!im) break;
          items.push(im[1]);
          i++;
        }
        var tag = ordered ? 'ol' : 'ul';
        out.push('<' + tag + '>' + items.map(function (t) { return '<li>' + inlineMd(t) + '</li>'; }).join('') + '</' + tag + '>');
        continue;
      }
      if (/^\s*\|/.test(ln)) {
        var rows = [];
        while (i < lines.length && /^\s*\|/.test(lines[i])) { rows.push(lines[i]); i++; }
        out.push(renderTable(rows));
        continue;
      }
      var para = [];
      while (i < lines.length && lines[i].trim() && !boundary.test(lines[i]) && !/^\u0000\d+\u0000$/.test(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      if (para.length) out.push('<p>' + para.map(inlineMd).join('<br>') + '</p>');
    }
    return out.join('');
  }

  function renderTable(rows) {
    var cells = rows.map(function (l) {
      return l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map(function (c) { return c.trim(); });
    });
    var isSep = function (r) { return r.length > 0 && r.every(function (c) { return /^:?-{2,}:?$/.test(c); }); };
    var head = cells[0] || [];
    var body = (cells.length > 1 && isSep(cells[1])) ? cells.slice(2) : cells.slice(1);
    return '<table><thead><tr>' + head.map(function (c) { return '<th>' + inlineMd(c) + '</th>'; }).join('') + '</tr></thead><tbody>' +
      body.map(function (r) { return '<tr>' + r.map(function (c) { return '<td>' + inlineMd(c) + '</td>'; }).join('') + '</tr>'; }).join('') +
      '</tbody></table>';
  }

  function inlineMd(s) {
    var inls = [];
    var t = esc(String(s == null ? '' : s));
    t = t.replace(/`([^`\n]+)`/g, function (_, c) {
      inls.push('<code>' + c + '</code>');
      return '\u0001' + (inls.length - 1) + '\u0001';
    });
    t = t.replace(/!\[([^\]]*)\]\((https?:[^)\s]+|\/[^)\s]*)\)/g, function (_, alt, u) {
      inls.push('<img src="' + u + '" alt="' + alt + '" loading="lazy">');
      return '\u0001' + (inls.length - 1) + '\u0001';
    });
    t = t.replace(/\[([^\]]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g, function (_, txt, u) {
      inls.push('<a href="' + u + '" target="_blank" rel="noopener">' + txt + '</a>');
      return '\u0001' + (inls.length - 1) + '\u0001';
    });
    t = t.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
    t = t.replace(/~~([^~\n]+)~~/g, '<del>$1</del>');
    t = t.replace(/\u0001(\d+)\u0001/g, function (_, n) { return inls[+n] || ''; });
    return t;
  }

  function nearBottom() {
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
  }
  /* 用户手动往上翻时暂停自动跟随,否则流式输出时一直强制到底 */
  var bodyPinned = false;
  bodyEl.addEventListener('scroll', function () {
    bodyPinned = (bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight) > 90;
  }, { passive: true });
  function toBottom() { bodyEl.scrollTop = bodyEl.scrollHeight + 999; bodyPinned = false; }

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

  /* 白嫖模式 system:隔离环境(无博客内容),无分身身份、无长度限定;记忆走用户消息注入 */
  function sysPromptFree() {
    var s = [];
    s.push('你是一个通用 AI 助手,如实、完整地回答用户的问题。');
    s.push('当前是隔离模式:你手上没有博客文章或笔记。若用户消息里附带【联网检索资料】,那是刚联网搜到的网页摘要,任何问题都优先采用,可用 [n] 标注出处或引用链接;没有资料时就凭常识作答,不要假装查过。');
    s.push('用户消息里如果附带【长期记忆·关于用户】,那是你以前对话记住的偏好,回答时自然照顾到,但不要逐条复述,也不要因此改变自己的回答方式。');
    s.push('如果提供了工具(如 web_search),需要实时信息时直接调用它,不要自称"不能联网"。');
    s.push('用过联网搜索的话,在回答末尾单独列出参考来源,每行一个:[[SRC:标题|网址]](3~6 条,网址必须来自搜索结果)。');
    return s.join('\n');
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
      s.push('3. 你拿到的是【已选文章】的完整正文(从最相关的开始,不够会再补)。回答前先自评:只凭这些正文,我的回答能不能算「顶配」——把问题答透、有具体结论/步骤/数据、能直接拿去用?');
      s.push('3.1 够顶配:直接给最终回答。');
      s.push('3.2 不够顶配(缺关键细节、要跨文章对比、答案明显在别的文章):只输出 [[MORE]] 这一个标记,不要输出任何别的字;系统会再找几篇相关文章给你,你再自评,循环到够顶配或材料用尽为止。');
      s.push('3.3 如果问题天然需要覆盖全站(给所有文章排名、全站对比、汇总、挑最好的几篇):不要只看手头两三篇就下结论,连续输出 [[MORE]] 把其余文章一篇篇要过来,拿到全部后再统一排名/对比。');
      s.push('3.5 强爽模式下允许你答得更展开,该列点列点、该给结论给结论,上限 12 句。');
    }
    s.push('4. 补了全文还找不到的部分,就说"这篇里那段我没拿到,你点进去看原文",并给出链接。');
    s.push('5. 整篇博客都没写过的,先直说"这个我博客里没写过",再用一两句常识补充,并说明那不是博客内容。');
    s.push('6. 不要编造标题、日期、链接、数据。');
    s.push('6.1 如果用户消息里还带【联网检索资料】,那是刚联网搜到的网页摘要:优先用它回答(任何类型的问题都可以用),可用 [n] 标注出处,也可以在末尾给出链接;此时不受第 5 条「博客里没写过」的限制。');
    s.push('7. 指向文章时用 markdown 链接:[文章标题](链接),链接只能来自下面出现的 URL。');
    s.push('8. 尽量 2~4 句答完;确实需要展开时不超过 8 句。不要说"作为 AI""根据提供的资料"。');
    s.push('');
    if (memOn()) {
      s.push('8.5 如果本轮调用了联网搜索,回答末尾单独列出参考来源,每行一个:[[SRC:标题|网址]](3~6 条,网址必须来自搜索结果)。');
      s.push('【记忆规则】');
      s.push('9. 用户说"记住…""记一下…"时,在回答末尾加 [[MEM:一句话的事实]];写成结构化 [[MEM:分类|属性|内容]] 更好,分类可用 身份/偏好/习惯/目标/关系/经历/其他。');
      s.push('9.1 用户提到稳定的偏好、背景、禁忌、长期目标时,每轮最多主动存 1 条;临时信息、闲聊、一次性的安排不要存。');
      s.push('10. 用户说"忘了…""忘掉…"时,输出 [[FORGET:要忘掉的关键词]]。');
      s.push('10.1 不要主动罗列记忆,也不要声称记住了没记录过的事;用户问起时按系统给出的记忆条目答。');
    } else {
      s.push('【记忆功能已关闭】不要输出 [[MEM:]] 或 [[FORGET:]];用户让你记住时,只回一句"记忆功能关着,可在设置→记忆里打开"。');
    }

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
    ROOT.classList.remove('hero-on');
  }
  function showHello() {
    if (!helloNode) return;
    if (!helloNode.parentNode) bodyEl.insertBefore(helloNode, thread);
    hello = helloNode;
    ROOT.classList.add('hero-on');
  }

  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'ai-u';
    d.textContent = text;
    thread.appendChild(d);
    toBottom();
  }

  var lastNode = null, stoppedFlag = false;
  function addAssistant() {
    var d = document.createElement('div');
    d.className = 'ai-a';
    d.innerHTML = '<div class="ai-dots"><i></i><i></i><i></i></div>';
    thread.appendChild(d);
    lastNode = d;
    toBottom();
    return d;
  }

  /* 独立搜索状态条:完全在思考框(.ai-reason)之外,单独成行。
     阶段:搜索中(实时计时,200ms 局部刷新)→ 完成(真实网页数+总用时,2.6s 后弱化保留摘要)→ 失败降级 */
  function mkSearchBar() {
    var bar = document.createElement('div');
    bar.className = 'ai-web-bar';
    bar.setAttribute('role', 'status');
    bar.innerHTML =
      '<svg class="ai-web-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" aria-hidden="true">' +
      '<circle cx="10.6" cy="10.6" r="6.4"/><path d="M15.4 15.4L20 20"/></svg>' +
      '<span class="ai-web-txt" aria-live="polite">正在搜索…</span>' +
      '<span class="ai-web-cnt"></span>' +
      '<span class="ai-web-tm">已用时 0.0s</span>';
    var t0 = Date.now();
    var timer = null;
    var ended = false;
    var EST = '（预计 10~30s）';
    function tick() {
      if (ended) return;
      var tm = bar.querySelector('.ai-web-tm');
      if (tm) tm.textContent = '已用时 ' + ((Date.now() - t0) / 1000).toFixed(1) + 's' + EST;
    }
    tick();
    timer = setInterval(tick, 200);
    return {
      el: bar,
      done: function (n) {
        if (ended) return;
        ended = true;
        if (timer) { clearInterval(timer); timer = null; }
        var sec = ((Date.now() - t0) / 1000).toFixed(1);
        var txt = bar.querySelector('.ai-web-txt');
        var cnt = bar.querySelector('.ai-web-cnt');
        var tm = bar.querySelector('.ai-web-tm');
        if (txt) txt.textContent = '';
        if (cnt) cnt.textContent = n ? ('搜索到 ' + n + ' 个网页') : '未触发联网搜索';
        if (tm) tm.textContent = '用时 ' + sec + 's' + EST;
        bar.classList.add('done');
        /* 短暂停留后弱化,保留最终摘要 */
        setTimeout(function () { bar.classList.add('fold'); }, 2600);
      },
      stop: function () {
        if (ended) return;
        ended = true;
        if (timer) { clearInterval(timer); timer = null; }
        var txt = bar.querySelector('.ai-web-txt');
        var cnt = bar.querySelector('.ai-web-cnt');
        var tm = bar.querySelector('.ai-web-tm');
        if (txt) txt.textContent = '已停止';
        if (cnt) cnt.textContent = '';
        if (tm) tm.textContent = '';
        bar.classList.add('fail', 'fold');
      },
      fail: function () {
        if (ended) return;
        ended = true;
        if (timer) { clearInterval(timer); timer = null; }
        var txt = bar.querySelector('.ai-web-txt');
        var cnt = bar.querySelector('.ai-web-cnt');
        var tm = bar.querySelector('.ai-web-tm');
        if (txt) txt.textContent = '搜索未完成,已直接回答';
        if (cnt) cnt.textContent = '';
        if (tm) tm.textContent = '';
        bar.classList.add('fail');
      }
    };
  }

  var REASON_OPEN = true, REASON_T0 = 0, REASON_T1 = 0;
  function render(node, text, reason, hits, done) {
    var html = '';
    if (reason) {
      var secs = 0;
      if (REASON_T0) secs = Math.max(1, Math.round(((REASON_T1 || Date.now()) - REASON_T0) / 1000));
      var tt = REASON_T1
        ? ('已思考 · 用时 ' + secs + ' 秒')
        : ('正在深度思考… ' + secs + ' 秒');
      html += '<div class="ai-reason-wrap' + (REASON_OPEN ? '' : ' collapsed') + '">' +
        '<button type="button" class="ai-reason-hd" aria-expanded="' + (REASON_OPEN ? 'true' : 'false') + '">' +
        '<span class="ai-reason-tt">' + tt + '</span><span class="ai-reason-chev">⌄</span></button>' +
        '<div class="ai-reason">' + md(reason) +
        (!done && !text ? '<span class="ai-caret">▍</span>' : '') + '</div></div>';
    }
    if (text) html += '<div class="ai-txt">' + md(text) + '</div>';
    else if (!reason) {
      html = done
        ? '<div class="ai-dim">已停止生成</div>'
        : '<div class="ai-dots"><i></i><i></i><i></i></div>';
    }
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
    var hd = node.querySelector('.ai-reason-hd');
    if (hd) hd.addEventListener('click', function () {
      REASON_OPEN = !REASON_OPEN;
      var wrap = hd.parentNode;
      if (wrap) { if (REASON_OPEN) wrap.classList.remove('collapsed'); else wrap.classList.add('collapsed'); }
      hd.setAttribute('aria-expanded', REASON_OPEN ? 'true' : 'false');
    });
    /* 下一帧再滚,确保新内容已布局(思考框滚到最新一行;对话流默认跟随到底) */
    requestAnimationFrame(function () {
      var rz = node.querySelector('.ai-reason');
      if (rz) { rz.scrollTop = rz.scrollHeight + 999; }
      if (!done) {
        if (!bodyPinned) bodyEl.scrollTop = bodyEl.scrollHeight + 999;
      } else if (stick) {
        bodyEl.scrollTop = bodyEl.scrollHeight + 999;
      }
    });
  }

  /* 本轮来源(取自模型输出 [[SRC:标题|链接]]) */
  var curSources = [];
  function renderSources(node, srcArg) {
    var src = [];
    try { if (window.PHAITOOLS && window.PHAITOOLS.sources) src = window.PHAITOOLS.sources(); } catch (e) {}
    if (srcArg && srcArg.length) src = srcArg.concat(src);
    if (!src.length) return;
    /* 去重 */
    var seen = {}, uniq = [];
    src.forEach(function (s) { if (s && s.url && !seen[s.url]) { seen[s.url] = 1; uniq.push(s); } });
    src = uniq;
    var old = node.querySelector('.ai-srcbox');
    if (old) old.parentNode.removeChild(old);
    var box = document.createElement('div');
    box.className = 'ai-srcbox';
    var head = document.createElement('button');
    head.type = 'button';
    head.className = 'ai-srcchip';
    head.innerHTML = '🔗 来源 · ' + src.length + ' 个网页';
    var list = document.createElement('div');
    list.className = 'ai-srclist';
    list.innerHTML = src.map(function (s) {
      return '<a href="' + esc(s.url) + '" target="_blank" rel="noopener">' +
        esc(s.title) + (s.site ? '<span class="ai-srcsite">' + esc(s.site) + '</span>' : '') + '</a>';
    }).join('');
    head.addEventListener('click', function () {
      list.classList.toggle('on');
    });
    box.appendChild(head);
    box.appendChild(list);
    node.appendChild(box);
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
  function endpoint() { var c = cfg(); return c.proxy || c.pv.endpoint; }

  function headers() {
    var c = cfg(), h = { 'Content-Type': 'application/json' };
    if (!c.proxy && c.key) h['Authorization'] = 'Bearer ' + c.key;
    return h;
  }

  var lastUsage = null;   /* 最近一次请求的 usage(流式末尾块里) */
  var lastToolCalls = []; /* 最近一次请求的 tool_calls(流式分片累积) */
  function stream(payload, onDelta, onReason, signal) {
    lastUsage = null;
    lastToolCalls = [];
    if (payload && payload.stream) {
      payload.stream_options = payload.stream_options || { include_usage: true };
    }
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
          if (j.usage) lastUsage = j.usage;
          var ch = j.choices && j.choices[0];
          if (!ch) throw new Error((j.error && j.error.message) || '接口返回异常');
          var m = ch.message || {};
          if (m.tool_calls) {
            m.tool_calls.forEach(function (tc, i) {
              lastToolCalls[i] = { id: tc.id || ('call_' + i), name: (tc.function && tc.function.name) || '', args: (tc.function && tc.function.arguments) || '{}' };
            });
          }
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
              if (o.usage) lastUsage = o.usage;
              if (o.error) throw new Error(o.error.message || '接口报错');
              var ch = o.choices && o.choices[0];
              if (!ch) continue;
              var dl = ch.delta || {};
              if (dl.reasoning_content && onReason) onReason(dl.reasoning_content);
              if (dl.content) onDelta(dl.content);
              if (dl.tool_calls) {
                dl.tool_calls.forEach(function (tc) {
                  var i = typeof tc.index === 'number' ? tc.index : lastToolCalls.length;
                  var cur = lastToolCalls[i] || (lastToolCalls[i] = { id: '', name: '', args: '' });
                  if (tc.id) cur.id = tc.id;
                  if (tc.function) {
                    if (tc.function.name) cur.name = (cur.name || '') + tc.function.name;
                    if (tc.function.arguments) cur.args = (cur.args || '') + tc.function.arguments;
                  }
                });
              }
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
    var pname = cfg().pv.name;
    if (e.status === 401) return pname + ' 的 Key 不对(401)。设置里检查一下 API Key。';
    if (e.status === 402) return pname + ' 账户余额不足(402),充点钱再来。';
    if (e.status === 422) return '请求参数有问题(422)。' + (e.body || '').slice(0, 120);
    if (e.status === 429) return '请求太频繁(429),歇几秒再问。';
    if (e.status === 400) return '请求被拒(400)。' + (e.body || '').slice(0, 160);
    if (e.status >= 500) return pname + ' 那边打嗝了(HTTP ' + e.status + '),等会儿再试。';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(e.message || '')) return '网络不通。检查网络,或确认代理地址可用。';
    return '出错了:' + (e.message || e);
  }

  /* ---------------- 内置工具:博客检索(动态注册) ---------------- */
  function registerBlogTools() {
    if (!window.PHAITOOLS || !window.PHAITOOLS.register) return;
    if (window.PHAITOOLS.names && window.PHAITOOLS.names().indexOf('search_posts') >= 0) return;
    PHAITOOLS.register('search_posts', '在博客文章里按关键词搜索,返回最相关的几篇(标题/链接/片段)', {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索关键词' } },
      required: ['query']
    }, function (a) {
      return loadIndex().then(function (d) {
        if (!CHUNKS) buildIndex(d);
        var hs = retrieve(d, String(a.query || ''));
        if (!hs.length) return '没有找到相关文章。';
        return hs.slice(0, 5).map(function (h) {
          return '《' + h.title + '》 ' + h.url + '\n' + (h.h ? '【' + h.h + '】' : '') + String(h.t || '').slice(0, 300);
        }).join('\n\n');
      });
    });
    PHAITOOLS.register('read_post', '按文章标题(可部分匹配)或链接读取全文', {
      type: 'object',
      properties: { title: { type: 'string', description: '文章标题或 URL' } },
      required: ['title']
    }, function (a) {
      return loadIndex().then(function (d) {
        var q = String(a.title || '').trim();
        var posts = (d && d.posts) || [];
        var hit = null;
        for (var i = 0; i < posts.length; i++) {
          var p = posts[i];
          if ((p.u && p.u === q) || (p.t && p.t.indexOf(q) >= 0)) { hit = p; break; }
        }
        if (!hit) return '没有找到标题匹配的文章:' + q;
        return '《' + hit.t + '》 ' + hit.u + '\n' + cleanBody(hit.x).slice(0, 8000);
      });
    });
    PHAITOOLS.register('list_posts', '列出博客全部文章的标题/日期/链接/标签', {
      type: 'object',
      properties: {}
    }, function () {
      return loadIndex().then(function (d) {
        return ((d && d.posts) || []).map(function (p) {
          return '- 《' + p.t + '》 ' + (p.d || '') + ' ' + (p.u || '') + ' ' + (p.g || '');
        }).join('\n');
      });
    });
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

    /* 会话快照:即使中途切换会话,本轮也存回发起时的会话 */
    var sid0 = curId;
    var tMsgs = msgs;

    /* 附件:本轮固定带走,后续重试/工具轮次复用同一份 */
    var turnParts = ATTACH.map(function (a) {
      return a.kind === 'image'
        ? { type: 'image_url', image_url: { url: a.url } }
        : { type: 'text', text: '【附件 ' + a.name + '】\n' + a.text };
    });
    var attachLabel = ATTACH.map(function (a) { return '📎' + a.name; }).join(' ');
    ATTACH = [];
    renderFiles();
    if (attachLabel) text = text + ' ' + attachLabel;
    function ucParts(uc) {
      return turnParts.length ? [{ type: 'text', text: uc }].concat(turnParts) : uc;
    }

    /* 联网开关开:先搜一轮拿实时资料【只当素材】,再走正常回答流程
       —— 这样深度思考/完整长度/记忆/模式都保留,只有素材多了联网内容 */
    if (webOn() && window.PHAITOOLS && window.PHAITOOLS.webSearch) {
      /* 记忆类问题不需要联网,直接走本地答案,省一次搜索 */
      if (memLocal(text)) return runAsk(text, sid0, tMsgs, '', null);
      if (window.PHAITOOLS.resetSources) { try { window.PHAITOOLS.resetSources(); } catch (e) {} }
      hideHello();
      addUser(text);
      var wbar = mkSearchBar();
      thread.appendChild(wbar.el);
      toBottom();
      var wnode = addAssistant();
      lastAsk = text;
      busy = true;
      updateSend();
      /* 和回答流共用 ctrl:搜索阶段点「停止」也能立刻中断 */
      ctrl = window.AbortController ? new AbortController() : null;
      return PHAITOOLS.webSearch(text, null, ctrl ? ctrl.signal : undefined).then(function (r) {
        var txt = String((r && r.text) || '').trim();
        var src = (r && r.sources) || [];
        var block = '';
        if (src.length) {
          /* 资料块:通用表述,不限定新闻类问题;要求引用来编号 */
          var head = '\n\n【联网检索资料(刚搜到的网页内容摘要;回答时优先采用,与你的旧知识冲突时以资料为准,可用 [n] 标注出处)】\n';
          if (txt) {
            block = head + txt;
          } else {
            /* 摘要为空但搜到了网页:至少把标题/链接给模型参考 */
            block = head + src.slice(0, 10).map(function (s, i) {
              return (i + 1) + '. ' + (s.title || '') + ' ' + (s.url || '');
            }).join('\n') + '\n(本次没拿到正文摘要,只能按标题和链接回答,回答里说明这一点)';
          }
          block += '\n\n来源清单:\n' + src.slice(0, 10).map(function (s, i) {
            return '[' + (i + 1) + '] ' + (s.title || '') + ' ' + (s.url || '');
          }).join('\n');
        }
        /* 搜索完成:状态条展示真实网页数 + 总用时(2.6s 后自动弱化) */
        try { wbar.done(src.length); } catch (e) {}
        if (window.PHHAISTATS) {
          try { PHHAISTATS.record('kimi', 'kimi-k3', null, text.length + 60, txt.length); } catch (e) {}
        }
        busy = false;
        updateSend();
        return runAsk(text, sid0, tMsgs, block, wnode);
      }, function (e) {
        var aborted = !!(ctrl && ctrl.signal && ctrl.signal.aborted);
        busy = false;
        ctrl = null;
        updateSend();
        if (aborted) {
          /* 用户主动停止:只显示已停止,不再继续回答 */
          try { wbar.stop(); } catch (e3) {}
          return;
        }
        /* 搜索失败也别卡住:状态条降级提示,退回普通回答 */
        try { wbar.fail(); } catch (e2) {}
        return runAsk(text, sid0, tMsgs, '', wnode);
      });
    }

    return runAsk(text, sid0, tMsgs, '', null);
  }

  /* 正常回答流程:webBlock = 联网资料(可空),preNode = 复用已建气泡(可空) */
  function runAsk(text, sid0, tMsgs, webBlock, preNode) {
    stoppedFlag = false;
    /* 记忆类问题本地直接答,不发请求(零 token、零等待) */
    var localReply = memLocal(text);
    if (localReply) {
      hideHello();
      addUser(text);
      var ln = addAssistant();
      render(ln, localReply, '', [], true);
      tMsgs.push({ role: 'user', content: '【我的问题】\n' + text });
      tMsgs.push({ role: 'assistant', content: localReply });
      saveTurnTo(sid0, text, localReply, '【我的问题】\n' + text);
      return;
    }

    /* 用户自己说"我叫 X""我住在 X""记住:X"→ 本地先存,当轮就能用到 */
    var caps = memCapture(text);
    if (caps && caps.length) {
      var cr = addMem(caps, 'user');
      if (cr && (cr.added || cr.updated || cr.merged)) syncMemBadge();
    }
    var memCtx = memBlock(text);

    if (!webBlock && window.PHAITOOLS && window.PHAITOOLS.resetSources) {
      try { window.PHAITOOLS.resetSources(); } catch (e) {}
    }

    var node = preNode;
    if (!node) {
      hideHello();
      addUser(text);
      node = addAssistant();
    }
    lastAsk = text;
    busy = true;
    updateSend();
    ctrl = window.AbortController ? new AbortController() : null;

    var history = trimMsgs(msgs);
    var escalated = false;
    var eco = ecoMode();
    var startLv = eco ? 0 : 1;
    var maxLv = eco ? 1 : 2;

    if (freeMode()) {
      /* 白嫖模式:不加载索引、不检索;问题原样发送;只挂「联网类」工具,博客工具仍隔离 */
      var furi = text + (webBlock || '') + (memCtx ? '\n\n' + memCtx : '');
      var freeToolMsgs = [];
      var freeDepth = 0;
      var freeToolsOff = false;
      function freePass() {
        var fmessages = [{ role: 'system', content: sysPromptFree() }]
          .concat(history)
          .concat(freeToolMsgs)
          .concat([{ role: 'user', content: ucParts(furi) }]);
        var fmaxTok = cfg().provider === 'kimi' ? 4000 : 2600;
        var fpayload = { model: cfg().model.id, messages: fmessages, stream: true, max_tokens: fmaxTok };
        if (cfg().model.id === 'deepseek-flash') fpayload.temperature = 1.0;
        if (!freeToolsOff && freeDepth < 3 && window.PHAITOOLS && window.PHAITOOLS.list) {
          try {
            var ftl = [];
            if (ftl.length) fpayload.tools = ftl;
          } catch (e) {}
        }
        var facc = '', frea = ''; REASON_T0 = 0; REASON_T1 = 0;
        var foD = function (delta) { facc += delta; if (!REASON_T1) REASON_T1 = Date.now(); render(node, stripMarkers(facc), frea, [], false); };
        var foR = function (r) { frea += r; if (!REASON_T0) REASON_T0 = Date.now(); render(node, stripMarkers(facc), frea, [], false); };
        return stream(fpayload, foD, foR, ctrl ? ctrl.signal : undefined).catch(function (e) {
          if (fpayload.tools && /tool|function/i.test((e.message || '') + (e.body || ''))) {
            freeToolsOff = true;
            delete fpayload.tools;
            return stream(fpayload, foD, foR, ctrl ? ctrl.signal : undefined);
          }
          throw e;
        }).then(function () {
          /* 工具调用:执行后带结果重新请求 */
          if (lastToolCalls.length && window.PHAITOOLS && freeDepth < 3) {
            var fcs = lastToolCalls.slice();
            lastToolCalls = [];
            freeDepth++;
            node.innerHTML = '<div class="ai-dim">🔧 调用工具:' +
              esc(fcs.map(function (c) { return c.name; }).join('、')) + '…</div>';
            return Promise.all(fcs.map(function (c) {
              return window.PHAITOOLS.run(c.name, c.args).then(
                function (out) { return { c: c, out: out }; },
                function (e) { return { c: c, out: '工具出错:' + String((e && e.message) || e) }; }
              );
            })).then(function (results) {
              freeToolMsgs.push({
                role: 'assistant',
                content: null,
                tool_calls: fcs.map(function (c) {
                  return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
                })
              });
              results.forEach(function (r) {
                freeToolMsgs.push({ role: 'tool', tool_call_id: r.c.id, content: String(r.out).slice(0, 6000) });
              });
              return freePass();
            });
          }
          return { acc: facc, rea: frea };
        });
      }
      return freePass().then(function (fr) {
        var facc = fr.acc, frea = fr.rea;
        var fraw = String(facc || '');
        var fsrc = extractSources(fraw);
        if (fsrc.list.length) curSources = fsrc.list;
        var fout = fsrc.clean.replace(MORE_RE, '').trim();
        /* 记忆:与强爽/节能共用同一份(开关关闭时不写) */
        if (memOn()) {
          var fmm = extractMem(fraw);
          if (fmm.mems.length) addMem(fmm.mems);
          if (fmm.fgs.length) forgetMem(fmm.fgs);
          fout = fmm.clean.replace(MORE_RE, '').replace(SRC_RE, '').trim();
        }
        if (!fout) fout = frea ? '(模型只给了思考过程,没有正文输出,再问一次试试)' : '(这次模型没有返回内容,再问一次试试)';
        render(node, fout, frea, [], true);
        try { renderSources(node, curSources); } catch (e) {}
        if (window.PHHAISTATS) {
          try { PHHAISTATS.record(cfg().provider, cfg().model.id, lastUsage, (furi || '').length + 200, fout.length); } catch (e) {}
        }
        lastUsage = null;
        tMsgs.push({ role: 'user', content: furi });
        tMsgs.push({ role: 'assistant', content: fout || '(空)' });
        saveTurnTo(sid0, text, fout, furi);
      }).catch(function (e) {
        if (stoppedFlag || (e && e.name === 'AbortError')) { stoppedFlag = false; return; }
        var m = errText(e);
        if (m) renderError(node, m, text);
        else render(node, '', '', [], true);
      }).then(function () {
        busy = false;
        ctrl = null;
        updateSend();
      });
    }

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

        /* ---- 上下文组装 ---- */
        var MAX_ADDS = 12;  /* 强爽:最多追加 12 轮(足以覆盖全站,排名/对比类问题用) */

        function ctxByPosts(idxs, fullSet) {
          var posts = (IDX && IDX.posts) || [];
          var bodies = [], totalFull = 0;
          for (var bi = 0; bi < idxs.length; bi++) {
            var bp = posts[idxs[bi]];
            var bb = bp ? cleanBody(bp.x) : '';
            bodies.push(bb);
            totalFull += bb.length;
          }
          /* 全站全文放得下(<=52K 字符)就给全文;放不下就每篇给摘要,需要时再补全文 */
          var condensed = totalFull > 52000;
          var totalCap = 52000;
          var parts = [], total = 0;
          for (var ci = 0; ci < idxs.length; ci++) {
            var cp = posts[idxs[ci]];
            if (!cp) continue;
            var giveFull = !condensed || (fullSet && fullSet[idxs[ci]]);
            var line;
            if (giveFull) {
              var cb = bodies[ci] || '';
              if (!cb) continue;
              if (cb.length > 9000) cb = cb.slice(0, 9000) + '…';
              line = '### 《' + (cp.t || '') + '》 ' + (cp.d || '') + ' ' + (cp.u || '') + '\n' + cb;
            } else {
              var raw = String(cp.x || '');
              var heads = (raw.match(/([^\n@]{1,60})@H@/g) || []).slice(0, 6).map(function (h) {
                return h.replace(/@H@$/, '').trim();
              });
              var snip = cleanBody(raw).replace(/\s+/g, ' ').slice(0, 280);
              line = '### 《' + (cp.t || '') + '》 ' + (cp.d || '') + ' ' + (cp.u || '') +
                '\n【小节】' + (heads.length ? heads.join(' / ') : '(无)') +
                '\n【开头】' + snip;
            }
            if (total + line.length > totalCap) { parts.push(line.slice(0, Math.max(0, totalCap - total))); break; }
            parts.push(line);
            total += line.length;
          }
          return parts.join('\n\n');
        }

        var toolDepth = 0, toolsOff = false;
        function pass(level, force, idxs, fullSet, toolMsgs) {
          var uc;
          if (idxs) {
            var ctx = ctxByPosts(idxs, fullSet);
            uc = '【博客正文·已选 ' + idxs.length + ' 篇】\n' +
              (ctx || '(这次没检索到相关正文,只能靠文章列表回答)') +
              '\n\n【我的问题】\n' + text;
          } else {
            uc = userMsg(text, hits, level, history);
          }
          if (webBlock) uc += webBlock;
          if (memCtx) uc += '\n\n' + memCtx;
          if (force) uc += '\n\n(材料已经给全了。请直接给出最终回答,不要输出 [[MORE]];确实不知道就用一两句话说明。)';
          var messages = [{ role: 'system', content: sysPrompt() }]
            .concat(history)
            .concat(toolMsgs || [])
            .concat([{ role: 'user', content: ucParts(uc) }]);

          /* Kimi 是推理模型,思考过程也占 max_tokens,多给一些余量 */
          var maxTok = cfg().provider === 'kimi' ? (eco ? 1600 : 2600) : (eco ? 800 : 1400);
          var payload = { model: cfg().model.id, messages: messages, stream: true, max_tokens: maxTok };
          if (cfg().model.id === 'deepseek-flash') payload.temperature = 1.0;
          /* 动态工具:注册表里有什么就给模型什么(白嫖模式不挂工具,保持隔离) */
          if (!toolsOff && toolDepth < 3 && window.PHAITOOLS && window.PHAITOOLS.list) {
            try {
              /* 白嫖模式只挂「不涉及博客内容」的工具(联网搜索/抓网页) */
              var tl = freeMode() ? [] : window.PHAITOOLS.list().filter(function (t) { return t.function.name !== 'web_search'; });
              if (tl.length) payload.tools = tl;
            } catch (e) {}
          }

          var acc = '', rea = ''; REASON_T0 = 0; REASON_T1 = 0;
          var onD = function (delta) { acc += delta; if (!REASON_T1) REASON_T1 = Date.now(); render(node, stripMarkers(acc), rea, hits, false); };
          var onR = function (r) { rea += r; if (!REASON_T0) REASON_T0 = Date.now(); render(node, stripMarkers(acc), rea, hits, false); };
          return stream(payload, onD, onR, ctrl ? ctrl.signal : undefined).catch(function (e) {
            /* 模型不支持 tools 时自动降级:去掉工具重试一次 */
            if (payload.tools && /tool|function/i.test((e.message || '') + (e.body || ''))) {
              toolsOff = true;
              delete payload.tools;
              return stream(payload, onD, onR, ctrl ? ctrl.signal : undefined);
            }
            throw e;
          }).then(function () {
            /* 模型要求调用工具 → 执行后带结果重新请求(最多 3 轮) */
            if (lastToolCalls.length && window.PHAITOOLS && toolDepth < 3) {
              var calls = lastToolCalls.slice();
              lastToolCalls = [];
              toolDepth++;
              node.innerHTML = '<div class="ai-dim">🔧 调用工具:' +
                esc(calls.map(function (c) { return c.name; }).join('、')) + '…</div>';
              return Promise.all(calls.map(function (c) {
                return window.PHAITOOLS.run(c.name, c.args).then(
                  function (out) { return { c: c, out: out }; },
                  function (e) { return { c: c, out: '工具出错:' + String((e && e.message) || e) }; }
                );
              })).then(function (results) {
                var extra = [];
                extra.push({
                  role: 'assistant',
                  content: null,
                  tool_calls: calls.map(function (c) {
                    return { id: c.id, type: 'function', function: { name: c.name, arguments: c.args || '{}' } };
                  })
                });
                results.forEach(function (r) {
                  extra.push({ role: 'tool', tool_call_id: r.c.id, content: String(r.out).slice(0, 6000) });
                });
                return pass(level, force, idxs, fullSet, (toolMsgs || []).concat(extra));
              });
            }
            if (!force && !idxs && level < maxLv && !escalated && acc.indexOf('[[MORE]]') >= 0) {
              escalated = true;
              node.innerHTML = '<div class="ai-dim">这一节不够,翻一下全文…</div>';
              return pass(level + 1, false);
            }
            return { acc: acc, rea: rea, uc: uc, lv: level, force: !!force, idxs: idxs || null };
          });
        }

        /* ---- 问答:节能=节选→整篇;强爽=自评,不够顶配就继续找文章 ---- */
        function run() {
          if (eco) {
            return pass(0, false).then(function (res) {
              if (res.acc.indexOf('[[MORE]]') >= 0) return pass(1, false);
              return res;
            });
          }
          /* 强爽:每轮都读全站(全文放得下给全文;放不下给摘要,不够再补相关文章全文) */
          var order = [];
          hits.forEach(function (h) { if (order.indexOf(h.p) < 0) order.push(h.p); });
          (IDX.posts || []).forEach(function (p, i) { if (order.indexOf(i) < 0) order.push(i); });
          var fullSet = null;
          function grow(round) {
            var force = round >= 2;
            return pass(0, force, order, fullSet).then(function (res) {
              if (force) return res;
              if (String(res.acc || '').indexOf('[[MORE]]') < 0) return res;
              if (!fullSet) {
                fullSet = {};
                hits.slice(0, 3).forEach(function (h) { fullSet[h.p] = 1; });
                if (!hits.length && order.length) fullSet[order[0]] = 1;
                node.innerHTML = '<div class="ai-dim">全站摘要不够顶配,补相关文章全文…</div>';
                return grow(round + 1);
              }
              return pass(0, true, order, fullSet);
            });
          }
          return grow(0);
        }

        return run().then(function (res) {
          var raw = String(res.acc || '');
          var out = raw.replace(MORE_RE, '').trim();
          var hasMarker = /\[\[(MEM|FORGET):/.test(raw);
          if (out || res.force || hasMarker) return res;
          /* 只回了 [[MORE]] 或空:强制再答一次,避免空气泡 */
          node.innerHTML = '<div class="ai-dim">这次没答上来,再试一次…</div>';
          return pass(0, true, res.idxs || (hits.length ? [hits[0].p] : null));
        }).then(function (res) {
          var raw2 = String(res.acc || '');
          var out = raw2.replace(MORE_RE, '').trim();
          /* 记忆:提取 [[MEM:...]] 保存 / [[FORGET:...]] 删除 */
          curSources = extractSources(raw2).list;
          var mm = extractMem(raw2);
          if (memOn()) {
            var wrote = null;
            if (mm.mems.length) wrote = addMem(mm.mems, 'ai');
            if (mm.fgs.length) forgetMem(mm.fgs);
            if (wrote && (wrote.added || wrote.updated || wrote.merged)) syncMemBadge();
          }
          out = mm.clean.replace(MORE_RE, '').replace(SRC_RE, '').trim();
          if (!out) out = (mm.mems.length || mm.fgs.length)
            ? '已记住 ✅ 之后对话我会记得'
            : (res.rea ? '(模型只给了思考过程,没有正文输出,再问一次试试)' : '(这次模型没有返回内容,再问一次试试)');
          render(node, out, res.rea, hits, true);
          try { renderSources(node, curSources); } catch (e) {}
          if (window.PHHAISTATS) {
            try { PHHAISTATS.record(cfg().provider, cfg().model.id, lastUsage, (res.uc || '').length, out.length); } catch (e) {}
          }
          lastUsage = null;
          /* 存带上下文的完整消息：下一轮它就成了稳定前缀，命中缓存 */
          tMsgs.push({ role: 'user', content: res.uc });
          tMsgs.push({ role: 'assistant', content: out || '(空)' });
          if (hits.length) {
            if (res.idxs) {
              res.idxs.forEach(function (ii) {
                var p2 = (IDX.posts || [])[ii];
                if (p2 && p2.t) fullSent[p2.t] = 1;
              });
            } else {
              fullSent[hits[0].title] = 1;
            }
          }
          saveTurnTo(sid0, text, out, res.uc);
          maybeConsolidate();
        });
      })
      .catch(function (e) {
        if (stoppedFlag || (e && e.name === 'AbortError')) { stoppedFlag = false; return; }
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
    var n = lastNode;
    if (n && n.parentNode) {
      var hasTxt = !!n.querySelector('.ai-txt');
      var hasReason = !!n.querySelector('.ai-reason');
      if (!hasTxt && !hasReason) {
        n.innerHTML = '<div class="ai-dim">已停止生成</div>';
      } else if (hasTxt && !n.querySelector('.ai-stop-tag')) {
        var tag = document.createElement('div');
        tag.className = 'ai-dim ai-stop-tag';
        tag.textContent = '已停止生成 · 回答不完整';
        n.appendChild(tag);
      }
      stoppedFlag = true;
    }
  }

  /* ---------------- 会话管理 ---------------- */
  function newSessionId() {
    return 's' + Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
  }
  function persistSessions() {
    if (SESSIONS.length > 20) SESSIONS = SESSIONS.slice(0, 20);
    lsSet(LS.sessions, JSON.stringify(SESSIONS));
  }
  function findSession(id) {
    for (var i = 0; i < SESSIONS.length; i++) if (SESSIONS[i].id === id) return SESSIONS[i];
    return null;
  }
  function curSession() {
    var s = findSession(curId);
    if (!s) {
      curId = SESSIONS.length ? SESSIONS[0].id : '';
      s = findSession(curId);
    }
    if (!s) {
      s = { id: newSessionId(), title: '', ts: Date.now(), log: [], msgs: [] };
      SESSIONS.unshift(s);
      persistSessions();
    }
    lsSet(LS.cur, curId);
    return s;
  }
  /* 把一条问答存进「指定会话」:切走也能落盘到原会话,不会被串到新会话 */
  function saveTurnTo(sid, q, a, uc) {
    if (!a && !uc) return;
    var s = findSession(sid);
    if (!s) return;
    s.log.push({ q: q, a: a });
    s.msgs.push({ role: 'user', content: uc }, { role: 'assistant', content: a || '(空)' });
    if (!s.title) s.title = String(q).slice(0, 40);
    s.ts = Date.now();
    persistSessions();
  }
  function saveTurn(q, a, uc) { saveTurnTo(curId, q, a, uc); }
  /* 把某会话的对话渲染到聊天区 */
  function renderLog(lg) {
    thread.innerHTML = '';
    if (!lg || !lg.length) { showHello(); return; }
    hideHello();
    for (var i = 0; i < lg.length; i++) {
      addUser(lg[i].q);
      var node = addAssistant();
      node.innerHTML = '<div class="ai-txt">' + md(lg[i].a) + '</div>';
    }
    toBottom();
  }
  function newSession() {
    if (busy) stopStream();
    var s = { id: newSessionId(), title: '', ts: Date.now(), log: [], msgs: [] };
    SESSIONS.unshift(s);
    curId = s.id;
    persistSessions();
    lsSet(LS.cur, curId);
    msgs = []; lastP = -1; fullSent = {};
    renderLog([]);
    renderSessions();
    if (typeof heroInput !== 'undefined' && heroInput) {
      heroInput.value = '';
      try { heroInput.style.height = 'auto'; } catch (e) {}
    }
    showToast('✨ 已开启新对话');
    if (!ROOT.classList.contains('open') && !ROOT.classList.contains('hero-on')) open();
  }
  function switchSession(id) {
    var s = findSession(id);
    if (!s) return;
    curId = id;
    lsSet(LS.cur, curId);
    msgs = (s.msgs || []).slice();
    lastP = -1; fullSent = {};
    renderLog(s.log || []);
    closeSheets();
    renderSessions();
  }
  function deleteSession(id) {
    for (var i = 0; i < SESSIONS.length; i++) {
      if (SESSIONS[i].id === id) { SESSIONS.splice(i, 1); break; }
    }
    if (curId === id) {
      if (SESSIONS.length) switchSession(SESSIONS[0].id);
      else newSession();
    }
    persistSessions();
    renderSessions();
  }
  function renderSessions() {
    if (!SESSIONS.length) {
      histList.innerHTML = '<div class="ai-empty">还没有会话,点「新建会话」开始</div>';
      return;
    }
    histList.innerHTML = '';
    for (var i = 0; i < SESSIONS.length; i++) {
      (function (s) {
        var row = document.createElement('div');
        row.className = 'ai-sess' + (s.id === curId ? ' cur' : '');
        var d = new Date(s.ts);
        var n = (s.log || []).length;
        row.innerHTML =
          '<button type="button" class="ai-sess-main">' +
          '<span class="q">' + esc(s.title || '新会话') + '</span>' +
          '<span class="t">' + n + ' 条消息 · ' + d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) +
          ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</span>' +
          '</button>' +
          '<button type="button" class="ai-sess-del" aria-label="删除会话" title="删除会话">×</button>';
        row.querySelector('.ai-sess-main').addEventListener('click', function () { switchSession(s.id); });
        row.querySelector('.ai-sess-del').addEventListener('click', function (e) {
          e.stopPropagation();
          deleteSession(s.id);
        });
        histList.appendChild(row);
      })(SESSIONS[i]);
    }
  }
  /* 启动时:读会话、迁移旧历史、恢复当前会话 */
  function loadSessions() {
    try { SESSIONS = JSON.parse(lsGet(LS.sessions) || '[]') || []; } catch (e) { SESSIONS = []; }
    if (!Array.isArray(SESSIONS)) SESSIONS = [];
    /* 旧版「历史记录」迁移:每条问答 -> 一个会话 */
    var old = null;
    try { old = JSON.parse(lsGet(LS.hist) || '[]') || []; } catch (e) { old = null; }
    if (old && old.length && !SESSIONS.length) {
      SESSIONS = old.map(function (it) {
        return {
          id: 's' + (it.t || Date.now()) + Math.floor(Math.random() * 1e4),
          title: String(it.q || '新会话').slice(0, 40),
          ts: it.t || Date.now(),
          log: [{ q: it.q || '', a: it.a || '' }],
          msgs: [
            { role: 'user', content: it.q || '' },
            { role: 'assistant', content: it.a || '' }
          ]
        };
      });
      persistSessions();
      lsDel(LS.hist);
    }
    curId = lsGet(LS.cur);
    if (!findSession(curId)) {
      curId = SESSIONS.length ? SESSIONS[0].id : '';
      if (!findSession(curId)) {
        SESSIONS.unshift({ id: newSessionId(), title: '', ts: Date.now(), log: [], msgs: [] });
        curId = SESSIONS[0].id;
        persistSessions();
      }
      lsSet(LS.cur, curId);
    }
    var s = findSession(curId);
    if (s) {
      msgs = (s.msgs || []).slice();
      renderLog(s.log || []);
    }
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
    [sheetSet, sheetHist, sheetMem, sheetStats].forEach(function (s) { s.classList.toggle('on', s === el); });
    if (el === sheetStats && window.PHHAISTATS) { try { PHHAISTATS.renderPage(); } catch (e) {} }
    if (el === sheetMem) { renderMemList(); syncMemBadge(); }
    if (el === sheetSet) {
      keyIn.value = lsGet(LS.key);
      keyKimiIn.value = lsGet(LS.keyKimi);
      proxyIn.value = lsGet(LS.proxy) || CFG_PROXY;
    }
    if (el === sheetHist) renderSessions();
  }
  function closeSheets() {
    [sheetSet, sheetHist, sheetMem, sheetStats].forEach(function (s) { s.classList.remove('on'); });
  }

  /* ---------------- 快捷提问 ---------------- */
  var CHIPS = [
    '这个博客都写些什么?',
    '安卓手机上怎么玩 DeepSeek Harness?',
    'Token 怎么才能用得久一点?',
    '你为什么会开始写博客?'
  ];
  var CHIP_ICON = '<svg class="ai-chip-ico" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"><path d="M4 6.5h16M4 12h10.5M4 17.5h13"/></svg>';
  CHIPS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-chip';
    b.innerHTML = CHIP_ICON + '<span>' + esc(t) + '</span>';
    b.addEventListener('click', function () { ask(t); });
    chipsEl.appendChild(b);
  });

  /* ---------------- 附件上传 ---------------- */
  var ATTACH = [], fileBtn = $('ai-file-btn'), fileInp = $('ai-file'), filesEl = $('ai-files');
  var toastEl = $('ai-toast'), toastTimer = null;
  function showToast(html) {
    if (!toastEl) return;
    toastEl.innerHTML = html;
    toastEl.classList.add('on');
    if (toastTimer) clearTimeout(toastTimer);
    toastTimer = setTimeout(function () { toastEl.classList.remove('on'); }, 2600);
  }
  function renderFiles() {
    if (!filesEl) return;
    filesEl.innerHTML = '';
    filesEl.classList.toggle('on', !!ATTACH.length);
    ATTACH.forEach(function (a, i) {
      var c = document.createElement('div');
      c.className = 'ai-file-chip';
      c.innerHTML = '<span class="ai-file-name">' + (a.kind === 'image' ? '🖼 ' : '📄 ') + esc(a.name) + '</span>' +
        '<button type="button" class="ai-file-x" data-i="' + i + '" aria-label="移除">×</button>';
      filesEl.appendChild(c);
    });
    Array.prototype.forEach.call(filesEl.querySelectorAll('.ai-file-x'), function (b) {
      b.addEventListener('click', function () {
        ATTACH.splice(+b.getAttribute('data-i'), 1);
        renderFiles();
      });
    });
  }
  function readAsDataURL(f) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取失败')); };
      fr.readAsDataURL(f);
    });
  }
  function shrinkImage(dataUrl) {
    return new Promise(function (res) {
      var img = new Image();
      img.onload = function () {
        try {
          var w = img.naturalWidth || img.width, h = img.naturalHeight || img.height;
          var maxSide = 1568;
          var scale = Math.min(1, maxSide / Math.max(w, h));
          if (scale >= 1 && w * h <= 2600000) { res(dataUrl); return; }
          var cw = Math.max(1, Math.round(w * scale)), ch = Math.max(1, Math.round(h * scale));
          var cv = document.createElement('canvas');
          cv.width = cw; cv.height = ch;
          var ctx = cv.getContext('2d');
          ctx.drawImage(img, 0, 0, cw, ch);
          var mime = dataUrl.indexOf('data:image/png') === 0 ? 'image/png' : 'image/jpeg';
          res(cv.toDataURL(mime, mime === 'image/png' ? undefined : 0.85));
        } catch (e) { res(dataUrl); }
      };
      img.onerror = function () { res(dataUrl); };
      img.src = dataUrl;
    });
  }
  function onFilesPicked() {
    var files = Array.prototype.slice.call((fileInp && fileInp.files) || []);
    if (fileInp) fileInp.value = '';
    if (!files.length) return;
    var jobs = files.map(function (f) {
      if (/^image\//.test(f.type || '')) {
        return readAsDataURL(f).then(shrinkImage).then(function (url) {
          ATTACH.push({ kind: 'image', name: f.name, url: url });
        }).catch(function () { showToast('🖼 图片读取失败'); });
      }
      if (f.size > 300 * 1024) { showToast('「' + f.name + '」超过 300KB,只支持小文本文件'); return null; }
      return readAsDataURL(f).then(function (d) {
        var b64 = String(d).split(',')[1] || '';
        var txt = '';
        try { txt = decodeURIComponent(escape(atob(b64))); } catch (e) { txt = ''; }
        if (!txt) { showToast('「' + f.name + '」不是可读文本'); return null; }
        ATTACH.push({ kind: 'text', name: f.name, text: txt.slice(0, 60000) });
      }).catch(function () { showToast('「' + f.name + '」读取失败'); });
    });
    Promise.all(jobs).then(function () { renderFiles(); });
  }
  if (fileBtn && fileInp) {
    fileBtn.addEventListener('click', function () { fileInp.click(); });
    fileInp.addEventListener('change', onFilesPicked);
  }

  /* ---------------- 事件 ---------------- */
  fab.addEventListener('click', open);
  $('ai-close').addEventListener('click', close);
  $('ai-set').addEventListener('click', function () { openSheet(sheetSet); });
  $('ai-hist').addEventListener('click', function () { openSheet(sheetHist); });
  $('ai-new').addEventListener('click', function () { newSession(); closeSheets(); });
  $('ai-sess-new').addEventListener('click', function () { newSession(); });
  Array.prototype.forEach.call(document.querySelectorAll('.ai-sheet-close'), function (b) {
    b.addEventListener('click', closeSheets);
  });
  warnBtn.addEventListener('click', function () { openSheet(sheetSet); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ROOT.classList.contains('open')) {
      if (sheetSet.classList.contains('on') || sheetHist.classList.contains('on') ||
          (sheetMem && sheetMem.classList.contains('on')) || (sheetStats && sheetStats.classList.contains('on'))) closeSheets();
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

  /* 模型图标:DeepSeek = 鲸鱼(官方 logo), Kimi = 字母 K(官方 logo) */
  var MODEL_ICONS = {
    ds: '<svg class="ai-mi ds" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M23.748 4.651c-.254-.124-.364.113-.512.233-.051.04-.094.09-.137.137-.372.397-.806.657-1.373.626-.829-.046-1.537.214-2.163.848-.133-.782-.575-1.248-1.247-1.548-.352-.155-.708-.311-.955-.65-.172-.24-.219-.509-.305-.774-.055-.16-.11-.323-.293-.35-.2-.031-.278.136-.356.276-.313.572-.434 1.202-.422 1.84.027 1.436.633 2.58 1.838 3.393.137.094.172.187.129.323-.082.28-.18.553-.266.833-.055.179-.137.218-.328.14a5.5 5.5 0 0 1-1.737-1.179c-.857-.828-1.631-1.743-2.597-2.46a12 12 0 0 0-.689-.47c-.985-.957.13-1.743.387-1.836.27-.098.094-.433-.778-.428-.872.003-1.67.295-2.687.685a3 3 0 0 1-.465.136 9.6 9.6 0 0 0-2.883-.101c-1.885.21-3.39 1.1-4.497 2.622C.082 8.776-.231 10.854.152 13.02c.403 2.284 1.568 4.175 3.36 5.653 1.857 1.533 3.997 2.284 6.438 2.14 1.482-.085 3.132-.284 4.994-1.86.47.234.962.328 1.78.398.629.058 1.235-.031 1.705-.129.735-.155.684-.836.418-.961-2.155-1.004-1.682-.595-2.112-.926 1.095-1.295 2.768-3.598 3.284-6.733.05-.346.115-.834.108-1.114-.004-.171.035-.238.23-.257a4.2 4.2 0 0 0 1.545-.475c1.397-.763 1.96-2.016 2.093-3.517.02-.23-.004-.467-.247-.588M11.58 18.168c-2.088-1.642-3.101-2.183-3.52-2.16-.39.024-.32.472-.234.763.09.288.207.487.371.74.114.167.192.416-.113.603-.673.416-1.842-.14-1.897-.168-1.361-.801-2.5-1.86-3.301-3.306-.775-1.393-1.225-2.888-1.299-4.482-.02-.385.094-.522.477-.592a4.7 4.7 0 0 1 1.53-.038c2.131.311 3.946 1.264 5.467 2.774.868.86 1.525 1.887 2.202 2.89.72 1.066 1.494 2.082 2.48 2.915.348.291.626.513.892.677-.802.09-2.14.109-3.055-.615zm1.001-6.44a.306.306 0 0 1 .415-.287.3.3 0 0 1 .113.074.3.3 0 0 1 .086.214c0 .17-.136.307-.308.307a.303.303 0 0 1-.306-.307m3.11 1.596c-.2.081-.4.151-.591.16a1.25 1.25 0 0 1-.798-.254c-.274-.23-.47-.358-.551-.758a1.7 1.7 0 0 1 .015-.588c.07-.327-.007-.537-.238-.727-.188-.156-.426-.199-.689-.199a.6.6 0 0 1-.254-.078.253.253 0 0 1-.114-.358 1 1 0 0 1 .192-.21c.356-.202.767-.136 1.146.016.352.144.618.408 1.001.782.392.451.462.576.685.915.176.264.336.536.446.848.066.194-.02.353-.25.45"/></svg>',
    kimi: '<svg class="ai-mi kimi" viewBox="0 0 24 24" aria-hidden="true"><path fill="currentColor" d="M21.765.351C22.998.351 24 1.353 24 2.586S22.998 4.82 21.765 4.82h-1.974c-.15 0-.26-.12-.26-.26V2.586A2.237 2.237 0 0 1 21.765.35M9.41 13.388l8.447-8.377c.16-.16.07-.471-.14-.471h-4.55s-.1.02-.14.06l-9.099 9.029c-.14.14-.35.02-.35-.21V4.81c0-.15-.1-.27-.221-.27H.22c-.12 0-.22.12-.22.27v18.57c0 .15.1.27.22.27h3.137c.12 0 .22-.12.22-.27v-3.79c0-.08.03-.16.08-.21l2.826-2.796c.07-.07.16-.08.241-.03l7.546 5.551a8.9 8.9 0 0 0 4.018 1.493c.12.01.23-.11.23-.27V19.76c0-.14-.08-.25-.19-.26a5.8 5.8 0 0 1-2.355-.942l-6.533-4.73c-.14-.09-.15-.32-.03-.441"/></svg>'
  };
  function modelIcon(p) { return MODEL_ICONS[p] || MODEL_ICONS.ds; }

  /* 模型选择菜单(DeepSeek / Kimi 全部可用模型) */
  function buildModelMenu() {
    if (!modelMenu) return;
    modelMenu.innerHTML = '';
    Object.keys(PROVIDERS).forEach(function (pk) {
      var pv = PROVIDERS[pk];
      var g = document.createElement('div');
      g.className = 'ai-mm-group';
      g.textContent = pv.name;
      modelMenu.appendChild(g);
      pv.models.forEach(function (m) {
        var b = document.createElement('button');
        b.type = 'button';
        b.className = 'ai-mm-item';
        b.dataset.sel = pk + ':' + m.id;
        b.innerHTML = modelIcon(pk) +
          '<span class="ai-mm-label">' + esc(m.label) + '</span>' +
          '<span class="ai-mm-desc">' + esc(m.desc || '') + '</span>';
        b.addEventListener('click', function () {
          lsSet(LS.model, pk + ':' + m.id);
          closeModelMenu();
          syncModel();
          warn.classList.toggle('on', !ready());
        });
        modelMenu.appendChild(b);
      });
    });
  }
  function closeModelMenu() { if (modelMenu) modelMenu.classList.remove('on'); }
  modelBtn.addEventListener('click', function (e) {
    e.stopPropagation();
    if (!modelMenu) return;
    var willOpen = !modelMenu.classList.contains('on');
    closeModelMenu();
    if (willOpen) {
      var cur = selModel();
      var sel = cur.p + ':' + cur.m.id;
      Array.prototype.forEach.call(modelMenu.querySelectorAll('.ai-mm-item'), function (b) {
        b.classList.toggle('cur', b.dataset.sel === sel);
      });
      modelMenu.classList.add('on');
    }
  });
  document.addEventListener('click', function (e) {
    if (modelMenu && modelMenu.classList.contains('on') &&
        !modelMenu.contains(e.target) && e.target !== modelBtn &&
        !(heroModel && heroModel.contains(e.target))) closeModelMenu();
  });
  function cycleMode() {
    var cur = lsGet(LS.mode);
    lsSet(LS.mode, cur === 'max' ? 'free' : (cur === 'free' ? 'eco' : 'max'));
    syncModel();
  }
  modeBtn.addEventListener('click', cycleMode);

  /* 新对话首屏 hero:＋新对话 / 点击输入 / 模式 / 模型 */
  var heroPlus = $('ai-hero-plus'), heroInput = $('ai-hero-input'), heroSend = $('ai-hero-send'),
      heroMode = $('ai-hero-mode'), heroModeName = $('ai-hero-mode-name'),
      heroModel = $('ai-hero-model'), heroModelName = $('ai-hero-model-name'),
      heroModelIco = $('ai-hero-model-ico'), modelIco = $('ai-model-ico');
  function sendHero() {
    if (!heroInput) return;
    var v = heroInput.value.trim();
    if (!v) return;
    heroInput.value = '';
    heroInput.style.height = 'auto';
    ask(v);
  }
  if (heroPlus) heroPlus.addEventListener('click', function () { newSession(); closeSheets(); });
  if (heroSend) heroSend.addEventListener('click', sendHero);
  if (heroInput) {
    heroInput.addEventListener('input', function () {
      heroInput.style.height = 'auto';
      heroInput.style.height = Math.min(heroInput.scrollHeight, 96) + 'px';
    });
    heroInput.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
        e.preventDefault();
        sendHero();
      }
    });
  }
  if (heroMode) heroMode.addEventListener('click', cycleMode);
  if (heroModel) heroModel.addEventListener('click', function (e) {
    if (e && e.stopPropagation) e.stopPropagation();
    if (modelBtn) modelBtn.click();
  });
  function syncModel() {
    var cur = selModel(), eco = ecoMode(), free = freeMode();
    var label = cur.m.label, modeEn = free ? 'Free' : (eco ? 'Eco' : 'Max');
    modelName.textContent = label;
    modeName.textContent = modeEn;
    if (heroModeName) heroModeName.textContent = modeEn;
    if (heroModelName) heroModelName.textContent = label;
    if (heroModelIco) heroModelIco.innerHTML = modelIcon(cur.p);
    if (modelIco) modelIco.innerHTML = modelIcon(cur.p);
    modeBtn.classList.toggle('on', !eco);
    modeBtn.classList.toggle('free', free);
    if (tipEl) {
      tipEl.textContent = free
        ? '白嫖模式：隔离聊天（只带你的偏好记忆，不读博客内容）'
        : (eco
          ? '节能模式：只带相关小节，够不够由它自己开口要'
          : '强爽模式：每轮读全站（全文/摘要），不够顶配再补相关文章全文');
    }
  }

  /* 联网搜索手动开关(仿 DeepSeek) */
  var webBtn = $('ai-web');
  function applyWeb() {
    var on = webOn();
    if (webBtn) webBtn.classList.toggle('on', on);
    if (webBtn) {
      webBtn.setAttribute('title', on ? '联网搜索:开' : '联网搜索:关');
      webBtn.setAttribute('aria-label', on ? '联网搜索:开' : '联网搜索:关');
    }
  }
  if (webBtn) {
    webBtn.addEventListener('click', function () {
      lsSet(LS.web, webOn() ? '0' : '1');
      applyWeb();
    });
  }
  applyWeb();

  /* Kimi 官方工具开关 */
  var kimiToolsToggle = $('ai-kimi-tools');
  if (kimiToolsToggle) {
    kimiToolsToggle.checked = lsGet('phh_ai_kimi_tools') !== '0';
    kimiToolsToggle.addEventListener('change', function () {
      lsSet('phh_ai_kimi_tools', kimiToolsToggle.checked ? '1' : '0');
      if (window.PHAITOOLS && kimiToolsToggle.checked && PHAITOOLS.loadKimiOfficialTools) {
        try { PHAITOOLS.loadKimiOfficialTools(); } catch (e) {}
      }
    });
  }

  /* 记忆管理(列表/编辑/置顶/导入导出都在 js/ai-memory.js 里) */
  function renderMemList() {
    if (MEM) { try { MEM.renderPanel(); } catch (e) {} return; }
    if (memListEl) memListEl.innerHTML = '<div class="ai-empty">记忆模块没加载上,检查 js/ai-memory.js</div>';
  }
  function syncMemBadge() {
    var b = $('ai-mem-open');
    if (!b) return;
    var n = MEM ? MEM.all().length : 0;
    b.textContent = '查看 / 管理记忆' + (n ? '(' + n + ')' : '');
  }
  if (memToggle) {
    memToggle.checked = memOn();
    memToggle.addEventListener('change', function () {
      if (MEM) MEM.setEnabled(memToggle.checked); else lsSet(LS.memOn, memToggle.checked ? '1' : '0');
      syncMemBadge();
      renderMemList();
    });
  }
  if ($('ai-mem-open')) $('ai-mem-open').addEventListener('click', function () { openSheet(sheetMem); });
  if ($('ai-stats-open')) $('ai-stats-open').addEventListener('click', function () { openSheet(sheetStats); });
  if ($('ai-stats-clear')) $('ai-stats-clear').addEventListener('click', function () {
    if (window.PHHAISTATS) { try { PHHAISTATS.clear(); } catch (e) {} }
  });
  if ($('ai-mem-clear')) $('ai-mem-clear').addEventListener('click', function () {
    if (MEM) MEM.clear();
    renderMemList();
    syncMemBadge();
  });

  /* ---- 记忆自动整理:每 6 轮用一次小请求,把最近对话压成结构化记忆 ---- */
  var memBusy = false;
  function parseMemJSON(t) {
    var m = String(t || '').match(/\[[\s\S]*\]/);
    if (!m) return null;
    try { var a = JSON.parse(m[0]); return Array.isArray(a) ? a : null; } catch (e) { return null; }
  }
  function maybeConsolidate() {
    if (!MEM || memBusy || !memOn() || freeMode() || !MEM.autoOn() || !ready()) return;
    try { MEM.countTurn(); } catch (e) { return; }
    if (!MEM.shouldConsolidate(6)) return;
    var ss = curSession();
    var log = (ss && ss.log ? ss.log : []).slice(-4);
    if (log.length < 2) return;
    var pairs = log.map(function (x, i) {
      return '第' + (i + 1) + '轮\n用户:' + String(x.q || '').slice(0, 120) +
        '\nAI:' + String(x.a || '').slice(0, 180);
    }).join('\n');
    var sys = '你是记忆整理器。只抽取关于用户本人的长期稳定信息:称呼/身份/所在地/职业或学业、长期偏好与禁忌、习惯、长期目标、重要关系、重要经历。' +
      '输出 JSON 数组,元素 {"cat":"profile|pref|habit|plan|rel|event|other","key":"简短属性名,可为空","val":"一句话","w":1到5的整数}。' +
      '没有值得长期记的就输出 []。只输出 JSON,不要解释;已有记忆不要重复输出。';
    var usr = '【已有记忆】\n' + (MEM.compactForPrompt(16) || '(空)') + '\n\n【最近对话】\n' + pairs;
    var payload = {
      model: cfg().model.id,
      messages: [{ role: 'system', content: sys }, { role: 'user', content: usr }],
      stream: false,
      max_tokens: 320,
      temperature: 0.2
    };
    var acc = '';
    memBusy = true;
    stream(payload, function (d) { acc += d; }).then(function () {
      var items = parseMemJSON(acc);
      memBusy = false;
      try { MEM.markConsolidated(); } catch (e) {}
      if (items && items.length) {
        var r = addMem(items, 'ai');
        if (r && (r.added || r.updated || r.merged)) syncMemBadge();
      }
    }, function () {
      memBusy = false;
      try { MEM.markConsolidated(); } catch (e) {}
    });
  }

  /* 设置 */
  $('ai-save').addEventListener('click', function () {
    lsSet(LS.key, keyIn.value.trim());
    lsSet(LS.keyKimi, keyKimiIn.value.trim());
    lsSet(LS.proxy, proxyIn.value.trim());
    warn.classList.toggle('on', !ready());
    closeSheets();
  });
  $('ai-clear').addEventListener('click', function () {
    lsDel(LS.key); lsDel(LS.keyKimi); lsDel(LS.proxy);
    keyIn.value = ''; keyKimiIn.value = ''; proxyIn.value = CFG_PROXY;
    warn.classList.add('on');
  });

  /* 清空全部会话 */
  $('ai-hist-clear').addEventListener('click', function () {
    SESSIONS = [];
    persistSessions();
    newSession();
    renderSessions();
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
  syncMemBadge();
  if (document.querySelector('.cal-fab')) ROOT.classList.add('has-cal');
  loadSessions();
  buildModelMenu();
  syncModel();
  updateSend();
  warn.classList.toggle('on', !ready());

  /* 动态工具:注册内置博客工具 + 拉取 Kimi 官方工具声明 */
  try { registerBlogTools(); } catch (e) {}
  if (window.PHAITOOLS && window.PHAITOOLS.loadKimiOfficialTools) {
    try { window.PHAITOOLS.loadKimiOfficialTools(); } catch (e) {}
  }
})();
