/* ============================================================
   PHH Blog · 编辑页逻辑(基于 Vditor IR 即时渲染)
   - 读:GitHub Contents API 拉取 markdown
   - 写:保存/删除走 Contents API,带状态提示与撤销
   - 图片:粘贴/拖入/上传自动进仓库 img/in-post/
   ============================================================ */
(function () {
  'use strict';
  var REPO = 'panghehe666/panghehe666.github.io';
  var BRANCH = 'master';
  var TOKEN_KEY = 'phh_admin_gh_token';

  var root = document.getElementById('pe-root');
  var gate = document.getElementById('pe-gate');
  if (!root) return;
  function isAdmin() {
    try {
      return document.documentElement.classList.contains('is-admin') ||
        localStorage.getItem('blog_admin') === '1';
    } catch (e) { return false; }
  }
  if (!isAdmin()) {
    root.style.display = 'none';
    gate.style.display = 'block';
    var ga = gate.querySelector('a');
    if (ga) ga.href = '/admin/?next=' + encodeURIComponent(location.pathname + location.search);
    return;
  }
  document.body.classList.add('pe-page');

  var $ = function (id) { return document.getElementById(id); };
  var titleIn = $('pe-title'), tagsIn = $('pe-tags'), dateIn = $('pe-date');
  var nameEl = $('pe-name'), dirtyEl = $('pe-dirty'), statusEl = $('pe-status');

  var params = new URLSearchParams(location.search);
  var st = {
    mode: params.get('p') ? 'edit' : 'new',
    file: params.get('p') || '',
    sha: null, fm: null, url: null, busy: false
  };
  var vd = null, dirty = false, lastOp = null, undoBusy = false;

  /* ---------------- 基础 ---------------- */
  function token() {
    var t = '';
    try { t = (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) {}
    if (!t && window.PHHSECRETS && PHHSECRETS.gh) { try { t = PHHSECRETS.gh() || ''; } catch (e) {} }
    return t;
  }
  if (window.PHHSECRETS) { try { PHHSECRETS.ensure(); } catch (e) {} }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  /* 把 GitHub 的原始报错翻译成可操作的提示 */
  function errMsg(e) {
    var m = String((e && e.message) || e || '');
    if (/bad credentials|invalid token|401/i.test(m)) {
      return 'GitHub Token 已失效(Bad credentials) · <a href="/admin/">点这里去 /admin/ 重新填 Token</a>,填完回来再点保存';
    }
    if (/rate limit|403/i.test(m)) return 'GitHub 拒绝(403):' + esc(m) + ' · 可能是权限不足或请求太频繁,稍等再试';
    return esc(m);
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function b64u(s) { return btoa(unescape(encodeURIComponent(s))); }
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function spin() { return '<span class="pe-spin" aria-hidden="true"></span>'; }
  function setStatus(html, cls) {
    statusEl.className = 'pe-status ' + (cls || '');
    statusEl.innerHTML = html;
    return statusEl;
  }
  function markDirty() {
    if (dirty) return;
    dirty = true;
    dirtyEl.classList.add('on');
  }
  function clearDirty() { dirty = false; dirtyEl.classList.remove('on'); }

  function api(method, path, payload) {
    var opts = { method: method, headers: { 'Authorization': 'Bearer ' + token(), 'Accept': 'application/vnd.github+json' } };
    if (payload !== undefined) {
      opts.headers['Content-Type'] = 'application/json';
      opts.body = JSON.stringify(payload);
    }
    return fetch('https://api.github.com/repos/' + REPO + '/contents/' + enc(path), opts).then(function (resp) {
      return resp.text().then(function (t) {
        var d = {}; try { d = t ? JSON.parse(t) : {}; } catch (e) {}
        if (!resp.ok) {
          var m = d.message || ('HTTP ' + resp.status);
          if (d.errors && d.errors.length) m += ':' + d.errors[0].message;
          var e = new Error(m); e.status = resp.status; throw e;
        }
        return d;
      });
    });
  }
  function apiGet(path) { return api('GET', path); }
  function apiPutText(path, content, sha, msg) {
    var p = { message: msg, content: b64u(content), branch: BRANCH };
    if (sha) p.sha = sha;
    return api('PUT', path, p);
  }
  function apiPutRawB64(path, b64, msg) {
    /* 图片等二进制:直接给 base64,不再转码 */
    return api('PUT', path, { message: msg, content: b64, branch: BRANCH });
  }
  function apiDel(path, sha, msg) { return api('DELETE', path, { message: msg, sha: sha, branch: BRANCH }); }

  /* ---------------- front matter ---------------- */
  function parseFM(text) {
    var m = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?/);
    if (!m) return { fm: '', body: text };
    return { fm: m[1], body: text.slice(m[0].length) };
  }
  function fmGet(fm, key) {
    var m = fm.match(new RegExp('^\\s*' + key + '\\s*:\\s*(.+)$', 'm'));
    return m ? m[1].trim() : '';
  }
  function fmGetTags(fm) {
    var m = fm.match(/^tags\s*:[\s\S]*?(?=^\S|\z)/m);
    if (!m) return [];
    return (m[0].match(/^\s*-\s*([^\n]+)$/gm) || []).map(function (s) { return s.replace(/^\s*-\s*/, '').trim(); });
  }
  function fmSet(fm, key, val) {
    var re = new RegExp('^\\s*' + key + '\\s*:.*$', 'm');
    if (re.test(fm)) return fm.replace(re, key + ': ' + val);
    return fm.replace(/\s*$/, '') + '\n' + key + ': ' + val;
  }
  function fmSetTags(fm, tags) {
    var t = fm.replace(/^tags\s*:[\s\S]*?(?=^\S|\z)/m, '').replace(/\n{2,}$/, '');
    return (t ? t + '\n' : '') + 'tags:\n' + tags.map(function (x) { return '    - ' + x; }).join('\n');
  }
  function buildNewFM(title, tags) {
    return ['layout:       post',
      'title:        "' + title.replace(/"/g, '\\"') + '"',
      'author:       "PHH"',
      'header-style: text',
      'catalog:      true',
      'tags:'].join('\n') + '\n' + tags.map(function (t) { return '    - ' + t; }).join('\n');
  }
  function collectTags() {
    var tags = (tagsIn.value || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!tags.length) tags = ['开源分享'];
    return tags;
  }
  function slugify(title) {
    var s = String(title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || 'post').slice(0, 60);
  }
  function fileUrl(file) {
    var m = String(file || '').match(/^(\d{4})-(\d{2})-(\d{2})-(.+)\.(md|markdown)$/);
    if (m) return '/' + m[1] + '/' + m[2] + '/' + m[3] + '/' + m[4] + '/';
    return '/';
  }
  function todayStr() {
    var d = new Date();
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  /* ---------------- 图片上传(进仓库 img/in-post/) ---------------- */
  function readAsDataURL(file) {
    return new Promise(function (res, rej) {
      var fr = new FileReader();
      fr.onload = function () { res(fr.result); };
      fr.onerror = function () { rej(new Error('读取文件失败')); };
      fr.readAsDataURL(file);
    });
  }
  function uploadFiles(files) {
    var list = Array.prototype.slice.call(files || []);
    if (!list.length) return Promise.resolve();
    var slug = (st.url && st.file ? st.file.slice(11, -3) : slugify(titleIn.value || 'post'));
    var errFiles = [];
    setStatus('正在上传 ' + list.length + ' 个文件…' + spin(), 'busy');
    return Promise.all(list.map(function (f) {
      return readAsDataURL(f).then(function (dataUrl) {
        var b64 = String(dataUrl).split(',')[1] || '';
        var name = Date.now() + '-' + String(f.name || 'image.png').replace(/[^\w.\u4e00-\u9fff-]/g, '_');
        /* 图片进 img/,其余文件(文档/压缩包/音视频等)进 files/ */
        var isImg = /^image\//.test(f.type || '') || /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif)$/i.test(f.name || '');
        var path = (isImg ? 'img/in-post/' : 'files/in-post/') + slug + '/' + name;
        return apiPutRawB64(path, b64, 'upload file: ' + path).then(function () {
          return { name: f.name || name, url: '/' + path, isImg: isImg };
        });
      }).catch(function () {
        errFiles.push(f.name || 'unknown');
        return null;
      });
    })).then(function (results) {
      var uploaded = results.filter(Boolean);
      /* Vditor 自定义 handler 不会处理 succMap,上传成功后必须主动写入正文 */
      if (uploaded.length && vd && typeof vd.insertMD === 'function') {
        var markdown = uploaded.map(function (item) {
          var label = String(item.name).replace(/[\[\]]/g, '');
          return (item.isImg ? '!' : '') + '[' + label + '](' + item.url + ')';
        }).join('\n\n');
        vd.insertMD(markdown + '\n\n');
        markDirty();
      }
      if (errFiles.length) {
        setStatus('部分文件上传失败:' + esc(errFiles.join(', ')), 'err');
        return '上传失败:' + errFiles.join(', ');
      }
      setStatus('已上传并插入 ' + uploaded.length + ' 个文件 ✅', 'ok');
    });
  }

  /* 正文格式判断:整篇以 HTML 标签为主 → 普通编辑器;含 Markdown 结构 → Vditor
     (很多 .md 开头会内嵌一段 HTML 目录,不能只看第一行) */
  function looksLikeHtml(body) {
    var s = String(body == null ? '' : body).trim();
    if (!s) return false;
    if (/^```/.test(s)) return false;                    /* 代码块开头的 md */
    /* 有 Markdown 标题 / 分隔线 / 引用 → 按 Markdown 处理(Vditor 也能渲染内嵌 HTML) */
    if (/^#{1,6}\s+\S/m.test(s)) return false;
    var lines = s.split('\n');
    var htmlLines = 0, mdLines = 0, total = 0;
    for (var i = 0; i < lines.length; i++) {
      var l = lines[i].trim();
      if (!l) continue;
      total++;
      if (/^<\/?[a-zA-Z][^>]*>/.test(l) || /<\/[a-zA-Z]+>\s*$/.test(l)) htmlLines++;
      if (/^(#{1,6}\s|[-*+]\s|\d+\.\s|>\s|\|)/.test(l)) mdLines++;
    }
    if (!total) return false;
    /* 一半以上的行都是 HTML 标签行,才算 HTML 文章 */
    return htmlLines >= 2 && htmlLines > mdLines && htmlLines / total >= 0.5;
  }

  /* ---------------- Vditor(IR 即时渲染) ---------------- */
  var taEl = null;
  function initEditor(value) {
    if (vd) { try { vd.destroy(); } catch (e) {} vd = null; }
    taEl = null;
    st.fallback = false;
    st.origValue = value || '';
    var box = $('pe-editor');
    /* 占位文本会被 Vditor 当成初始内容吸入正文:容器必须清空,加载提示改用 CSS 伪元素(pe-booting) */
    box.innerHTML = '';
    box.classList.add('pe-booting');
    if (typeof Vditor === 'undefined') { initPlain(value); return; }
    var h = Math.max(420, window.innerHeight - 250);
    vd = new Vditor('pe-editor', {
      mode: 'ir',
      lang: 'zh_CN',
      value: value || '',
      cdn: 'https://registry.npmmirror.com/vditor/3.11.3/files',
      height: h,
      cache: { enable: false },
      toolbar: [
        'upload', 'undo', 'redo', '|',
        'headings', 'bold', 'italic', 'strike', 'link', '|',
        'list', 'ordered-list', 'check', 'quote', 'line', 'code', 'inline-code', '|',
        'table', '|',
        'edit-mode', 'preview', 'fullscreen'
      ],
      upload: {
        handler: uploadFiles,
        accept: 'image/*,video/*,audio/*,.pdf,.txt,.md,.markdown,.zip,.doc,.docx,.xls,.xlsx,.ppt,.pptx,.apk',
        multiple: true
      },
      preview: {
        hljs: { style: 'github' },
        markdown: { toc: true }
      },
      after: function () { $('pe-editor').classList.remove('pe-booting'); removeLoading(); },
      input: function () { markDirty(); }
    });
    bindWiki();
  }
  /* 普通编辑器:HTML 文章 / 私密文章 / Vditor 加载失败时用 */
  function initPlain(value, isHtml) {
    if (vd) { try { vd.destroy(); } catch (e) {} vd = null; }
    st.fallback = true;
    st.htmlMode = !!isHtml;
    st.origValue = value || '';
    var box = $('pe-editor');
    box.innerHTML = (isHtml
      ? '<p class="pe-plain-note">HTML 文章 · 普通编辑模式:直接编辑 HTML 源码,保存时按原文写入。</p>'
      : '<p class="pe-plain-note">纯文本编辑模式:支持 Markdown 源码,保存时按原文写入。</p>') +
      '<textarea class="pe-ta" id="pe-ta" spellcheck="false" placeholder="' +
      (isHtml ? '在这里输入 HTML 正文…' : '在这里输入 Markdown 正文…') + '"></textarea>';
    taEl = $('pe-ta');
    taEl.value = value || '';
    taEl.addEventListener('input', markDirty);
    removeLoading();
  }

  function removeLoading() {
    var el = document.getElementById('pe-loading');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }
  function getBody() {
    if (st.fallback && taEl) return String(taEl.value || '');
    return String((vd && vd.getValue && vd.getValue()) || '');
  }

  /* ---------------- [[ 双链自动补全(Obsidian 风格) ---------------- */
  var WIKI = null, wikiEl = null, wikiItems = [], wikiSel = 0, wikiQ = '', wikiTimer = null, wikiBound = false;

  function loadWiki() {
    if (WIKI) return Promise.resolve(WIKI);
    return fetch('/graph.json?v=' + Date.now()).then(function (r) { return r.json(); }).then(function (d) {
      WIKI = (d.posts || []).map(function (p) {
        return { t: p.t || '', u: p.u || '', d: p.d || '' };
      }).filter(function (p) { return p.t && p.u; });
      return WIKI;
    }).catch(function () { WIKI = []; return WIKI; });
  }

  function wikiHost() {
    var box = $('pe-editor');
    return box ? box.querySelector('[contenteditable="true"]') : null;
  }

  function wikiCaret() {
    var sel = window.getSelection();
    if (!sel || !sel.rangeCount) return null;
    var r = sel.getRangeAt(0);
    if (!r.collapsed) return null;
    var node = r.startContainer;
    if (!node || node.nodeType !== 3) return null;
    var host = wikiHost();
    if (!host || !host.contains(node)) return null;
    var rect = null;
    try { rect = r.getBoundingClientRect(); } catch (e) {}
    return { node: node, off: r.startOffset, rect: rect };
  }

  function wikiMatch(info) {
    if (!info) return null;
    var before = info.node.textContent.slice(0, info.off);
    var m = before.match(/\[\[([^\[\]\n]{0,40})$/);
    if (!m) return null;
    return { q: m[1], len: m[0].length };
  }

  function wikiPop() {
    if (wikiEl) return wikiEl;
    wikiEl = document.createElement('div');
    wikiEl.className = 'pe-wiki-pop';
    wikiEl.addEventListener('mousedown', function (e) { e.preventDefault(); });
    document.body.appendChild(wikiEl);
    return wikiEl;
  }

  function wikiClose() {
    wikiItems = []; wikiSel = 0; wikiQ = '';
    if (wikiEl) wikiEl.classList.remove('on');
  }

  function wikiRender() {
    var el = wikiPop();
    el.innerHTML = '<div class="pe-wiki-hd">插入 [[文章标题]]' + (wikiQ ? ' · 匹配「' + esc(wikiQ) + '」' : '') + '</div>' +
      wikiItems.map(function (p, i) {
        return '<div class="pe-wiki-item' + (i === wikiSel ? ' on' : '') + '" data-i="' + i + '">' +
          '<span class="pe-wiki-tt">' + esc(p.t) + '</span>' +
          '<span class="pe-wiki-dt">' + esc(p.d || '') + '</span></div>';
      }).join('');
    el.classList.add('on');
    var rect = null;
    try { rect = wikiCaret().rect; } catch (e) {}
    if (!rect || (!rect.width && !rect.height)) {
      var box = $('pe-editor').getBoundingClientRect();
      rect = { left: box.left + 20, top: box.top + 40, bottom: box.top + 60 };
    }
    var w = 330;
    var left = Math.max(10, Math.min(rect.left, window.innerWidth - w - 8));
    var top = rect.bottom + 8;
    if (top + 250 > window.innerHeight) top = Math.max(10, rect.top - 258);
    el.style.left = left + 'px';
    el.style.top = top + 'px';
    Array.prototype.forEach.call(el.querySelectorAll('.pe-wiki-item'), function (item) {
      item.addEventListener('click', function () {
        wikiSel = +item.getAttribute('data-i');
        wikiInsert();
      });
    });
  }

  function wikiUpdate() {
    if (st.fallback) { wikiClose(); return; }
    var hit = wikiMatch(wikiCaret());
    if (!hit) { wikiClose(); return; }
    wikiQ = hit.q;
    loadWiki().then(function (arr) {
      var hit2 = wikiMatch(wikiCaret());
      if (!hit2) { wikiClose(); return; }
      var q = hit2.q.toLowerCase();
      var items = arr.filter(function (p) {
        if (!q) return true;
        return p.t.toLowerCase().indexOf(q) > -1 || p.u.toLowerCase().indexOf(q) > -1;
      }).slice(0, 8);
      if (!items.length) { wikiClose(); return; }
      wikiItems = items;
      wikiSel = 0;
      wikiQ = hit2.q;
      wikiRender();
    });
  }

  function wikiMove(d) {
    if (!wikiItems.length) return;
    wikiSel = (wikiSel + d + wikiItems.length) % wikiItems.length;
    wikiRender();
  }

  function wikiInsert() {
    var p = wikiItems[wikiSel];
    var info = wikiCaret();
    var hit = wikiMatch(info);
    if (!p || !info || !hit) { wikiClose(); return; }
    var text = '[[' + p.t + ']]';
    var done = false;
    try {
      var sel = window.getSelection();
      var r = document.createRange();
      r.setStart(info.node, Math.max(0, info.off - hit.len));
      r.setEnd(info.node, info.off);
      sel.removeAllRanges();
      sel.addRange(r);
      done = document.execCommand('insertText', false, text);
    } catch (e) {}
    if (!done) {
      /* 兜底:直接改文本节点并通知编辑器同步(部分 WebView 不支持 execCommand) */
      try {
        var node = info.node, off = info.off;
        var before = node.textContent.slice(0, off - hit.len);
        var after = node.textContent.slice(off);
        node.textContent = before + text + after;
        var host = wikiHost();
        if (host) {
          try { host.dispatchEvent(new InputEvent('input', { bubbles: true })); }
          catch (e1) { try { host.dispatchEvent(new Event('input', { bubbles: true })); } catch (e2) {} }
        }
        var r2 = document.createRange();
        r2.setStart(node, (before + text).length);
        r2.collapse(true);
        var s2 = window.getSelection();
        s2.removeAllRanges();
        s2.addRange(r2);
      } catch (e3) {}
    }
    markDirty();
    wikiClose();
  }

  function wikiKeydown(e) {
    if (!wikiEl || !wikiEl.classList.contains('on')) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); e.stopPropagation(); wikiMove(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); wikiMove(-1); }
    else if (e.key === 'Enter' || e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); wikiInsert(); }
    else if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); wikiClose(); }
  }

  function bindWiki() {
    if (wikiBound) return;
    wikiBound = true;
    var box = $('pe-editor');
    box.addEventListener('keydown', wikiKeydown, true);
    function poke() {
      if (wikiTimer) clearTimeout(wikiTimer);
      wikiTimer = setTimeout(wikiUpdate, 70);
    }
    box.addEventListener('input', poke, true);
    box.addEventListener('keyup', function (e) {
      if (e.key === 'Enter' || e.key === 'ArrowDown' || e.key === 'ArrowUp' ||
          e.key === 'Escape' || e.key === 'Tab') return;
      poke();
    }, true);
    box.addEventListener('blur', function () { setTimeout(wikiClose, 200); }, true);
    document.addEventListener('selectionchange', function () {
      if (!wikiEl || !wikiEl.classList.contains('on')) return;
      if (wikiTimer) clearTimeout(wikiTimer);
      wikiTimer = setTimeout(function () {
        if (!wikiMatch(wikiCaret())) wikiClose(); else wikiUpdate();
      }, 140);
    });
  }
  /* 只在宽度变化(转屏)时调整编辑器;软键盘/地址栏引起的高度抖动直接忽略,避免边打字边重排 */
  var lastW = window.innerWidth, rzTimer = null;
  window.addEventListener('resize', function () {
    if (!vd || window.innerWidth === lastW) return;
    lastW = window.innerWidth;
    if (rzTimer) clearTimeout(rzTimer);
    rzTimer = setTimeout(function () {
      try { if (typeof vd.resize === 'function') vd.resize(); } catch (e) {}
    }, 260);
  });

  /* ---------------- 加载 ---------------- */
  function load() {
    if (st.mode === 'edit') {
      setStatus('读取中…' + spin(), 'busy');
      apiGet('_posts/' + st.file).then(function (d) {
        var text = decodeURIComponent(escape(atob(d.content)));
        var pf = parseFM(text);
        st.sha = d.sha;
        st.fm = pf.fm;
        st.url = fileUrl(st.file);
        titleIn.value = fmGet(pf.fm, 'title').replace(/^"|"$/g, '');
        tagsIn.value = fmGetTags(pf.fm).join(', ');
        var dt = fmGet(pf.fm, 'date') || st.file.slice(0, 10);
        dateIn.value = /^\d{4}-\d{2}-\d{2}$/.test(dt) ? dt : '';
        dateIn.disabled = true;
        st.private = !!fmGet(pf.fm, 'private_cipher');
        if (st.private) {
          nameEl.textContent = '🔒 ' + st.file;
          $('pe-editor').innerHTML = '<div class="pe-loading">正在解密…</div>';
          setStatus('私密文章:正在解密…' + spin(), 'busy');
          var dec = (window.PrivateCrypto && window.PrivateCrypto.decryptWithSession)
            ? window.PrivateCrypto.decryptWithSession(fmGet(pf.fm, 'private_cipher'))
            : Promise.reject(new Error('PrivateCrypto 未加载'));
          dec.then(function (plain) {
            /* 私密文章同样按格式选编辑器:HTML → 普通编辑器,Markdown → Vditor */
            if (looksLikeHtml(plain)) {
              initPlain(plain, true);
              setStatus('🔒 私密文章(HTML):普通编辑模式,保存时自动加密', '');
            } else {
              initEditor(plain);
              setStatus('🔒 私密文章(Markdown):Vditor 编辑模式,保存时自动加密', '');
            }
          }).catch(function (e) {
            initPlain('');
            setStatus('私密文章解密失败:' + esc(e.message) + ' · 先到 <a href="/admin/">/admin/</a> 用管理员密码登录一次,再回来编辑。', 'err');
          });
        } else {
          nameEl.textContent = st.file;
          if (looksLikeHtml(pf.body)) {
            initPlain(pf.body, true);
            setStatus('正在编辑:' + esc(st.file) + ' · HTML 文章 → 普通编辑模式', '');
          } else {
            initEditor(pf.body);
            setStatus('正在编辑:' + esc(st.file) + ' · 光标所在行显示源码,移开自动渲染', '');
          }
        }
      }).catch(function (e) { setStatus('读取失败:' + esc(e.message), 'err'); });
    } else {
      nameEl.textContent = '新文章';
      dateIn.value = todayStr();
      initEditor('');
      setStatus('新文章:写完后点「保存」。图片直接粘贴/拖进来即可。', '');
    }
  }

  /* ---------------- 保存 / 删除 / 撤销 ---------------- */
  function addUndoBtn(el) {
    if (!lastOp) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pe-btn undo';
    b.textContent = '撤销';
    b.addEventListener('click', doUndo);
    el.appendChild(b);
  }
  /* 保存成功后把最新内容缓存到本机:文章页立即显示最新版,不等 Pages 发布 */
  function cacheLocalPreview(file, url, body, title) {
    try {
      var render = (typeof Vditor !== 'undefined' && Vditor.md2html)
        ? Vditor.md2html(body, { mode: 'ir', cdn: 'https://registry.npmmirror.com/vditor/3.11.3/files' }).catch(function () { return ''; })
        : Promise.resolve('');
      render.then(function (h) {
        try {
          var store = JSON.parse(localStorage.getItem('phh_local_posts') || '{}');
          store[file] = { ts: Date.now(), html: h || '', md: body, url: url || '', title: title || '' };
          localStorage.setItem('phh_local_posts', JSON.stringify(store));
        } catch (e) {}
      });
    } catch (e) {}
  }

  function save() {
    if (st.busy || (!vd && !st.fallback)) return;
    if (!token()) { setStatus('还没有配置 GitHub Token,<a href="/admin/">去管理员页</a>填一次。', 'err'); return; }
    var body = getBody().replace(/[\s\n]+$/, '');
    var title = titleIn.value.trim() || '未命名';
    var tags = collectTags();
    st.busy = true;
    setStatus('文章上传中…' + spin(), 'busy');
    if (st.mode === 'new') {
      var date = dateIn.value || todayStr();
      var file = date + '-' + slugify(title) + '.md';
      var content = '---\n' + buildNewFM(title, tags) + '\n---\n\n' + body + '\n';
      apiPutText('_posts/' + file, content, null, 'add: ' + file).then(function (d) {
        st = { mode: 'edit', file: file, sha: d.content && d.content.sha, fm: buildNewFM(title, tags), url: fileUrl(file), busy: false };
        dateIn.disabled = true;
        nameEl.textContent = file;
        clearDirty();
        lastOp = { kind: 'add', path: '_posts/' + file, newSha: d.content && d.content.sha };
        cacheLocalPreview(file, fileUrl(file), body, title);
        var el = setStatus('已添加 ✅ <b>' + esc(file) + '</b> · 本机已缓存,文章页立即显示;Pages 30–60 秒后全网生效', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('添加失败:' + errMsg(e), 'err'); });
    } else {
      apiGet('_posts/' + st.file).then(function (d) {
        var prev = decodeURIComponent(escape(atob(d.content)));
        var fm = fmSetTags(fmSet(st.fm, 'title', '"' + title.replace(/"/g, '\\"') + '"'), tags);
        var prep;
        if (st.private) {
          prep = (window.PrivateCrypto && window.PrivateCrypto.encryptWithSession)
            ? window.PrivateCrypto.encryptWithSession(body).then(function (cipher) {
                return { fm: fmSet(fm, 'private_cipher', cipher), body: '' };
              })
            : Promise.reject(new Error('PrivateCrypto 未加载'));
        } else {
          prep = Promise.resolve({ fm: fm, body: body });
        }
        return prep.then(function (r0) {
          var content = '---\n' + r0.fm + '\n---' + (r0.body ? '\n\n' + r0.body : '') + '\n';
          return apiPutText('_posts/' + st.file, content, st.sha, 'update: ' + st.file).then(function (d2) {
            return { prev: prev, d2: d2, fm: r0.fm };
          });
        });
      }).then(function (r) {
        st.sha = r.d2.content && r.d2.content.sha;
        st.fm = r.fm;
        st.busy = false;
        clearDirty();
        lastOp = { kind: 'edit', path: '_posts/' + st.file, prevContent: r.prev, newSha: st.sha };
        cacheLocalPreview(st.file, st.url, body, title);
        var el = setStatus('已修改 ✅ <b>' + esc(st.file) + '</b> · 本机已缓存,文章页立即显示;Pages 30–60 秒后全网生效', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('修改失败:' + errMsg(e), 'err'); });
    }
  }
  function del() {
    if (st.busy) return;
    if (st.mode !== 'edit' || !st.file) { location.href = '/'; return; }
    if (!window.confirm('确定删除「' + st.file + '」?文章会从博客移除(可撤销)。')) return;
    setStatus('删除中…' + spin(), 'busy');
    var prev = null, prevSha = null;
    apiGet('_posts/' + st.file).then(function (d) {
      prev = decodeURIComponent(escape(atob(d.content)));
      prevSha = d.sha;
      return apiDel('_posts/' + st.file, d.sha, 'delete: ' + st.file);
    }).then(function () {
      st.busy = false;
      lastOp = { kind: 'del', path: '_posts/' + st.file, prevContent: prev, prevSha: prevSha };
      var el = setStatus('已删除 ✅ <b>' + esc(st.file) + '</b> · Pages 约 30–60 秒后生效', 'ok');
      addUndoBtn(el);
    }).catch(function (e) { st.busy = false; setStatus('删除失败:' + errMsg(e), 'err'); });
  }
  function doUndo() {
    if (!lastOp || undoBusy) return;
    undoBusy = true;
    var op = lastOp;
    lastOp = null;
    setStatus('撤销中…' + spin(), 'busy');
    var p;
    if (op.kind === 'add') p = apiDel(op.path, op.newSha, 'undo add: ' + op.path);
    else if (op.kind === 'edit') p = apiPutText(op.path, op.prevContent, op.newSha, 'undo edit: ' + op.path);
    else p = apiPutText(op.path, op.prevContent, null, 'undo delete: ' + op.path);
    p.then(function () {
      undoBusy = false;
      setStatus('已撤销 ✅ ' + (op.kind === 'add' ? '新文章已删除' : op.kind === 'edit' ? '已恢复原内容' : '文章已恢复') + ' · Pages 约 30–60 秒后生效', 'ok');
      if (op.kind === 'add') { setTimeout(function () { location.href = '/'; }, 1200); }
      else if (op.kind === 'del') {
        st.mode = 'edit';
        nameEl.textContent = op.path.replace('_posts/', '');
        setStatus('已撤销 ✅ 文章已恢复', 'ok');
      }
    }).catch(function (e) {
      undoBusy = false;
      setStatus('撤销失败:' + esc(e.message), 'err');
    });
  }

  /* ---------------- 事件 ---------------- */
  $('pe-save').addEventListener('click', save);
  $('pe-del').addEventListener('click', del);
  $('pe-preview').addEventListener('click', function () {
    if (st.url) window.open(st.url, '_blank');
    else setStatus('新文章保存后才有预览地址', '');
  });
  $('pe-back').addEventListener('click', function (e) {
    e.preventDefault();
    location.href = st.url || '/';
  });
  titleIn.addEventListener('input', markDirty);
  tagsIn.addEventListener('input', markDirty);
  /* Vditor 的 input 回调在部分版本/场景下不触发,容器事件委托兜底,保证「未保存」标记可靠 */
  $('pe-editor').addEventListener('input', markDirty);
  document.addEventListener('keydown', function (e) {
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
      e.preventDefault();
      save();
    }
  });
  window.addEventListener('beforeunload', function (e) {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  load();
})();
