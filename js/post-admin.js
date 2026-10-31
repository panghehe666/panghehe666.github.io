/* ============================================================
   PHH Blog · 快速删除(文章页 × / 首页列表删除)+ 撤销
   编辑入口是 /edit/ 页面(Vditor IR 编辑器),不在此处理。
   ============================================================ */
(function () {
  'use strict';
  var REPO = 'panghehe666/panghehe666.github.io';
  var BRANCH = 'master';
  var TOKEN_KEY = 'phh_admin_gh_token';

  var toastEl = document.getElementById('pa-toast');
  if (!toastEl) return;

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
  function b64u(s) { return btoa(unescape(encodeURIComponent(s))); }
  function enc(p) { return p.split('/').map(encodeURIComponent).join('/'); }
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

  var lastOp = null, undoBusy = false;
  function toast(html) { toastEl.innerHTML = html; toastEl.classList.add('show'); }
  function toastClose() { toastEl.classList.remove('show'); }
  function bindToast() {
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
    toast('撤销中…');
    apiPut(op.path, op.prevContent, null, 'undo delete: ' + op.path).then(function () {
      undoBusy = false;
      if (op.itemEl) op.itemEl.classList.remove('adm-hidden');
      toast('已撤销 ✅ 文章已恢复');
      setTimeout(toastClose, 2600);
    }).catch(function (e) {
      undoBusy = false;
      toast('撤销失败:' + esc(e.message));
      setTimeout(toastClose, 2600);
    });
  }

  function delPost(file, itemEl) {
    if (!isAdmin()) return;
    if (!token()) {
      toast('还没有配置 GitHub Token,<a href="/admin/" style="color:#7fd7e8">去管理员页</a>填一次。' +
        '<button type="button" class="pa-btn" id="pa-toast-x">×</button>');
      bindToast();
      return;
    }
    if (!window.confirm('确定删除「' + file + '」?文章会从博客移除(可撤销)。')) return;
    toast('删除中…');
    var prev = null;
    apiGet('_posts/' + file).then(function (d) {
      prev = decodeURIComponent(escape(atob(d.content)));
      return apiDel('_posts/' + file, d.sha, 'delete: ' + file);
    }).then(function () {
      lastOp = { kind: 'del', path: '_posts/' + file, prevContent: prev, itemEl: itemEl };
      if (itemEl) itemEl.classList.add('adm-hidden');
      toast('已删除 ✅ <b>' + esc(file) + '</b> · Pages 约 30–60 秒后生效' +
        '<button type="button" class="pa-btn" id="pa-undo">撤销</button>' +
        '<button type="button" class="pa-btn" id="pa-toast-x">×</button>');
      bindToast();
    }).catch(function (e) {
      toast('删除失败:' + esc(e.message) +
        '<button type="button" class="pa-btn" id="pa-toast-x">×</button>');
      bindToast();
    });
  }

  var paDel = document.getElementById('pa-del');
  if (paDel) paDel.addEventListener('click', function () { delPost(paDel.getAttribute('data-file'), null); });

  document.addEventListener('click', function (e) {
    var b = e.target && e.target.closest ? e.target.closest('.adm-del') : null;
    if (!b) return;
    delPost(b.getAttribute('data-file'), b.closest('.post-preview'));
  });
})();
