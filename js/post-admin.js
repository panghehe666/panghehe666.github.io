/* ============================================================
   PHH Blog · 文章管理(悬浮按钮 + 编辑面板 + 撤销)
   仅管理员可用;GitHub Token 存在 localStorage(phh_admin_gh_token,
   在 /admin/ 页填写),直接用 Contents API 增删改 _posts。
   ============================================================ */
(function () {
  'use strict';
  var REPO = 'panghehe666/panghehe666.github.io';
  var BRANCH = 'master';
  var TOKEN_KEY = 'phh_admin_gh_token';

  var panel = document.getElementById('pa-panel');
  var toastEl = document.getElementById('pa-toast');
  if (!panel) return;

  var $ = function (id) { return document.getElementById(id); };
  var editBtn = $('pa-edit'), delBtn = $('pa-del'), addBtn = $('pa-add');
  var st = { mode: null, file: null, sha: null, fm: null, busy: false };
  var lastOp = null, undoBusy = false;

  /* ---------------- 基础 ---------------- */
  function isAdmin() {
    try {
      return document.documentElement.classList.contains('is-admin') ||
        localStorage.getItem('blog_admin') === '1';
    } catch (e) { return false; }
  }
  function token() {
    try { return (localStorage.getItem(TOKEN_KEY) || '').trim(); } catch (e) { return ''; }
  }
  function esc(s) { return String(s == null ? '' : s).replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;'); }
  function pad(n) { return (n < 10 ? '0' : '') + n; }
  function b64u(s) { return btoa(unescape(encodeURIComponent(s))); }
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
  function spin() { return '<span class="pa-spin" aria-hidden="true"></span>'; }
  function setStatus(html, cls) {
    var el = $('pa-status');
    el.className = 'pa-status ' + (cls || '');
    el.innerHTML = html;
    return el;
  }
  function toast(html) { toastEl.innerHTML = html; toastEl.classList.add('show'); }
  function toastClose() { toastEl.classList.remove('show'); }

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
  function apiPut(path, content, sha, msg) {
    var p = { message: msg, content: b64u(content), branch: BRANCH };
    if (sha) p.sha = sha;
    return api('PUT', path, p);
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
  function buildFM(existing) {
    var title = ($('pa-t').value || '').trim() || '未命名';
    var tags = ($('pa-tags').value || '').split(/[,，]/).map(function (s) { return s.trim(); }).filter(Boolean);
    if (!tags.length) tags = ['开源分享'];
    if (existing) {
      var fm = existing;
      fm = fmSet(fm, 'title', '"' + title.replace(/"/g, '\\"') + '"');
      fm = fmSetTags(fm, tags);
      return fm;
    }
    var lines = ['---', 'layout:       post', 'title:        "' + title.replace(/"/g, '\\"') + '"',
      'author:       "PHH"', 'header-style: text', 'catalog:      true'];
    lines.push('tags:');
    tags.forEach(function (tg) { lines.push('    - ' + tg); });
    lines.push('---');
    return lines.join('\n');
  }
  function slugify(title, slug) {
    if (slug) {
      slug = slug.trim().replace(/[^\w\u4e00-\u9fff-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
      if (slug) return slug.slice(0, 60);
    }
    var s = String(title || '').toLowerCase().replace(/[^a-z0-9\u4e00-\u9fff]+/g, '-').replace(/^-+|-+$/g, '');
    return (s || 'post').slice(0, 60);
  }

  /* ---------------- 面板 ---------------- */
  function openPanel() { panel.classList.add('on'); }
  function closePanel() { panel.classList.remove('on'); st.mode = null; st.busy = false; lastOp = null; }
  function fillDate(d) {
    $('pa-date').value = d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate());
  }

  function newPost() {
    if (st.busy) return;
    if (!isAdmin() || !token()) { needAuth(); return; }
    $('pa-title-h').textContent = '写新文章';
    $('pa-sub').innerHTML = '保存后自动发布到 <code>_posts/</code>,Pages 约 30–60 秒上线。';
    $('pa-t').value = '';
    fillDate(new Date());
    $('pa-date').disabled = false;
    $('pa-slug').value = ''; $('pa-slug').disabled = false;
    $('pa-tags').value = '开源分享, 前沿科技';
    $('pa-body').value = '';
    $('pa-del2').style.display = 'none';
    st = { mode: 'new', file: null, sha: null, fm: null, busy: false };
    setStatus('新文章:填好内容后点「保存并上传」', '');
    openPanel();
    $('pa-t').focus();
  }

  function editPost(file) {
    if (st.busy) return;
    if (!isAdmin() || !token()) { needAuth(); return; }
    $('pa-title-h').textContent = '编辑文章';
    $('pa-sub').innerHTML = '文件:' + esc(file);
    setStatus('读取中…' + spin(), 'busy');
    openPanel();
    apiGet('_posts/' + file).then(function (d) {
      var text = decodeURIComponent(escape(atob(d.content)));
      var pf = parseFM(text);
      var dt = fmGet(pf.fm, 'date') || file.slice(0, 10);
      $('pa-t').value = fmGet(pf.fm, 'title').replace(/^"|"$/g, '');
      $('pa-date').value = /^\d{4}-\d{2}-\d{2}$/.test(dt) ? dt : '';
      $('pa-date').disabled = true;
      $('pa-slug').value = ''; $('pa-slug').disabled = true;
      $('pa-tags').value = fmGetTags(pf.fm).join(', ');
      $('pa-body').value = pf.body;
      var note = '';
      if (/private_cipher\s*:/.test(pf.fm)) note = '<br><span class="warn">⚠ 这篇文章是加密的:正文框里的内容不会解密,建议只改标题/标签,front matter 里的密文会自动保留。</span>';
      $('pa-sub').innerHTML = '文件:' + esc(file) + note;
      $('pa-del2').style.display = '';
      st = { mode: 'edit', file: file, sha: d.sha, fm: pf.fm, busy: false };
      setStatus('正在编辑:' + esc(file), '');
    }).catch(function (e) {
      setStatus('读取失败:' + esc(e.message), 'err');
    });
  }

  function needAuth() {
    openPanel();
    $('pa-title-h').textContent = '还没有配置';
    $('pa-sub').innerHTML = '先去 <a href="/admin/">管理员页</a> 登录并填写 GitHub Token(存在本机浏览器),回来就能直接改。';
    setStatus('需要管理员登录 + GitHub Token', 'err');
  }

  /* ---------------- 增删改 + 撤销 ---------------- */
  function savePost() {
    if (st.busy) return;
    var title = ($('pa-t').value || '').trim();
    var body = $('pa-body').value || '';
    var slug = slugify(title, $('pa-slug').value);
    st.busy = true;
    if (st.mode === 'new') {
      var date = $('pa-date').value || new Date().toISOString().slice(0, 10);
      var file = date + '-' + slug + '.md';
      var content = '---\n' + buildFM(null) + '\n---\n\n' + body + '\n';
      setStatus('文章上传中…' + spin(), 'busy');
      apiPut('_posts/' + file, content, null, 'add: ' + file).then(function (d) {
        st.busy = false;
        st = { mode: 'edit', file: file, sha: d.content && d.content.sha, fm: buildFM(null), busy: false };
        $('pa-date').disabled = true;
        $('pa-slug').disabled = true;
        $('pa-del2').style.display = '';
        $('pa-sub').innerHTML = '文件:' + esc(file);
        lastOp = { kind: 'add', path: '_posts/' + file, newSha: d.content && d.content.sha, surface: 'panel' };
        var el = setStatus('已添加 ✅ <b>' + esc(file) + '</b> · Pages 约 30–60 秒后上线', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('添加失败:' + esc(e.message), 'err'); });
    } else if (st.mode === 'edit') {
      /* 保存前的旧内容:用于撤销 */
      var oldContent = null;
      apiGet('_posts/' + st.file).then(function (d) {
        oldContent = decodeURIComponent(escape(atob(d.content)));
        var fm = buildFM(st.fm);
        var content2 = '---\n' + fm + '\n---' + (body ? '\n\n' + body : '') + '\n';
        setStatus('文章上传中…' + spin(), 'busy');
        return apiPut('_posts/' + st.file, content2, st.sha, 'update: ' + st.file);
      }).then(function (d) {
        st.busy = false;
        st.sha = d.content && d.content.sha;
        st.fm = buildFM(st.fm);
        lastOp = { kind: 'edit', path: '_posts/' + st.file, prevContent: oldContent, newSha: d.content && d.content.sha, surface: 'panel' };
        var el = setStatus('已修改 ✅ <b>' + esc(st.file) + '</b> · Pages 约 30–60 秒后上线', 'ok');
        addUndoBtn(el);
      }).catch(function (e) { st.busy = false; setStatus('修改失败:' + esc(e.message), 'err'); });
    }
  }

  function delPost(file) {
    if (st.busy) return;
    if (!window.confirm('确定删除「' + file + '」?文章会从博客移除(可撤销)。')) return;
    setStatus('删除中…' + spin(), 'busy');
    var prevContent = null, prevSha = null;
    apiGet('_posts/' + file).then(function (d) {
      prevContent = decodeURIComponent(escape(atob(d.content)));
      prevSha = d.sha;
      return apiDel('_posts/' + file, d.sha, 'delete: ' + file);
    }).then(function () {
      st.busy = false;
      if (st.file === file) closePanel();
      lastOp = { kind: 'del', path: '_posts/' + file, prevContent: prevContent, prevSha: prevSha, surface: 'toast' };
      toast('已删除 ✅ <b>' + esc(file) + '</b> · Pages 约 30–60 秒后生效' +
        '<button type="button" class="pa-btn" id="pa-undo">撤销</button>' +
        '<button type="button" class="pa-btn" id="pa-toast-x">×</button>');
      bindToastBtns();
    }).catch(function (e) { st.busy = false; setStatus('删除失败:' + esc(e.message), 'err'); });
  }

  function addUndoBtn(statusEl) {
    if (!lastOp) return;
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'pa-btn undo';
    b.textContent = '撤销';
    b.addEventListener('click', doUndo);
    statusEl.appendChild(b);
  }
  function bindToastBtns() {
    var u = document.getElementById('pa-undo');
    var x = document.getElementById('pa-toast-x');
    if (u) u.addEventListener('click', doUndo);
    if (x) x.addEventListener('click', function () { toastClose(); lastOp = null; });
  }
  function doUndo() {
    if (!lastOp || undoBusy) return;
    undoBusy = true;
    var op = lastOp;
    lastOp = null;
    toastClose();
    setStatus('撤销中…' + spin(), 'busy');
    var p;
    if (op.kind === 'add') {
      p = apiDel(op.path, op.newSha, 'undo add: ' + op.path);
    } else if (op.kind === 'edit') {
      p = apiPut(op.path, op.prevContent, op.newSha, 'undo edit: ' + op.path);
    } else {
      p = apiPut(op.path, op.prevContent, null, 'undo delete: ' + op.path);
    }
    p.then(function () {
      undoBusy = false;
      if (op.surface === 'toast') {
        toast('已撤销 ✅ ' + (op.kind === 'del' ? '文章已恢复' : '') +
          '<button type="button" class="pa-btn" id="pa-toast-x">×</button>');
        bindToastBtns();
      } else {
        setStatus('已撤销 ✅ ' + (op.kind === 'add' ? '新文章已删除' : '已恢复原内容') + ' · Pages 约 30–60 秒后生效', 'ok');
        if (op.kind === 'add') closePanel();
      }
    }).catch(function (e) {
      undoBusy = false;
      if (op.surface === 'toast') { toast('撤销失败:' + esc(e.message) + '<button type="button" class="pa-btn" id="pa-toast-x">×</button>'); bindToastBtns(); }
      else setStatus('撤销失败:' + esc(e.message), 'err');
    });
  }

  /* ---------------- 事件 ---------------- */
  if (editBtn) editBtn.addEventListener('click', function () { editPost(editBtn.getAttribute('data-file')); });
  if (delBtn) delBtn.addEventListener('click', function () { delPost(delBtn.getAttribute('data-file')); });
  if (addBtn) addBtn.addEventListener('click', newPost);
  $('pa-scrim').addEventListener('click', function () { if (!st.busy) closePanel(); });
  $('pa-cancel').addEventListener('click', function () { if (!st.busy) closePanel(); });
  $('pa-save').addEventListener('click', savePost);
  $('pa-del2').addEventListener('click', function () {
    if (st.busy) return;
    if (st.mode === 'edit' && st.file) delPost(st.file);
  });
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && panel.classList.contains('on') && !st.busy) closePanel();
  });
})();
