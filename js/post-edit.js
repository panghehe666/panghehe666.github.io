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
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
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
    if (!list.length) return Promise.resolve({ msg: '', code: 0, data: { errFiles: [], succMap: {} } });
    var base = 'img/in-post/' + (st.url && st.file ? st.file.slice(11, -3) : slugify(titleIn.value || 'post')) + '/';
    var succMap = {}, errFiles = [];
    return Promise.all(list.map(function (f) {
      return readAsDataURL(f).then(function (dataUrl) {
        var b64 = String(dataUrl).split(',')[1] || '';
        var name = Date.now() + '-' + String(f.name || 'image.png').replace(/[^\w.\u4e00-\u9fff-]/g, '_');
        var path = base + name;
        return apiPutRawB64(path, b64, 'upload image: ' + path).then(function () {
          succMap[f.name || name] = '/img/in-post/' + base.slice('img/in-post/'.length) + name;
        });
      }).catch(function () { errFiles.push(f.name || 'unknown'); });
    })).then(function () {
      return { msg: '', code: 0, data: { errFiles: errFiles, succMap: succMap } };
    });
  }

  /* ---------------- Vditor(IR 即时渲染) ---------------- */
  function initEditor(value) {
    if (vd) { try { vd.destroy(); } catch (e) {} vd = null; }
    $('pe-editor').innerHTML = '';
    var h = Math.max(420, window.innerHeight - 250);
    vd = new Vditor('pe-editor', {
      mode: 'ir',
      lang: 'zh_CN',
      value: value || '',
      cdn: '/vditor',
      height: h,
      cache: { enable: false },
      toolbar: [
        'headings', 'bold', 'italic', 'strike', 'link', '|',
        'list', 'ordered-list', 'check', 'quote', 'line', 'code', 'inline-code', '|',
        'table', '|',
        'upload', '|',
        'undo', 'redo', '|',
        'edit-mode', 'preview', 'fullscreen'
      ],
      upload: { handler: uploadFiles },
      preview: { hljs: { style: 'github' } },
      input: function () { markDirty(); }
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
            initEditor(plain);
            setStatus('🔒 私密文章:已解密为明文编辑,保存时自动重新加密', '');
          }).catch(function (e) {
            initEditor('');
            setStatus('私密文章解密失败:' + esc(e.message) + ' · 先到 <a href="/admin/">/admin/</a> 用管理员密码登录一次,再回来编辑。', 'err');
          });
        } else {
          nameEl.textContent = st.file;
          initEditor(pf.body);
          setStatus('正在编辑:' + esc(st.file) + ' · 光标所在行显示源码,移开自动渲染', '');
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
  function save() {
    if (!vd || st.busy) return;
    if (!token()) { setStatus('还没有配置 GitHub Token,<a href="/admin/">去管理员页</a>填一次。', 'err'); return; }
    var body = String(vd.getValue() || '').replace(/[\s\n]+$/, '');
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
        var el = setStatus('已添加 ✅ <b>' + esc(file) + '</b> · Pages 约 30–60 秒后上线', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('添加失败:' + esc(e.message), 'err'); });
    } else {
      apiGet('_posts/' + st.file).then(function (d) {
        var prev = decodeURIComponent(escape(atob(d.content)));
        var fm = fmSetTags(fmSet(st.fm, 'title', '"' + title.replace(/"/g, '\\"') + '"'), tags);
        var prep;
        if (st.private) {
          prep = (window.PrivateCrypto && PrivateCrypto.encryptWithSession)
            ? PrivateCrypto.encryptWithSession(body).then(function (cipher) {
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
        var el = setStatus('已修改 ✅ <b>' + esc(st.file) + '</b> · Pages 约 30–60 秒后上线', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('修改失败:' + esc(e.message), 'err'); });
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
    }).catch(function (e) { st.busy = false; setStatus('删除失败:' + esc(e.message), 'err'); });
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
