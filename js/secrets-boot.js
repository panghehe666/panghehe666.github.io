/* ============================================================
   PHH Blog · 管理员密钥开机解密
   页面加载时(已登录管理员 + 有会话密钥)解密 site-secrets.js,
   把 {gh, ds, kimi} 放进 sessionStorage,供 AI 助手 / 文章编辑使用。
   ============================================================ */
(function () {
  'use strict';
  var SS = 'phh_secrets';
  var p = null;

  function isAdmin() {
    try { return localStorage.getItem('blog_admin') === '1'; } catch (e) { return false; }
  }
  function mem() {
    try { var s = sessionStorage.getItem(SS); return s ? JSON.parse(s) : null; } catch (e) { return null; }
  }
  function save(o) {
    try { sessionStorage.setItem(SS, JSON.stringify(o)); } catch (e) {}
  }
  function ensure() {
    if (p) return p;
    p = new Promise(function (res) {
      if (!isAdmin()) return res(null);
      var m = mem();
      // 缓存里若已有完整密钥(含 kimi)直接用;否则重新解密,兼容旧会话只有 gh/ds 的情况
      if (m && (m.gh || m.ds) && m.kimi) return res(m);
      var cipher = (window.SITE_SECRETS_CIPHER || '').trim();
      var PC = window.PrivateCrypto;
      if (!cipher || !PC || !PC.decryptWithSession || !PC.loadSessionKey || !PC.loadSessionKey()) {
        return res(m || null);
      }
      PC.decryptWithSession(cipher).then(function (text) {
        var o = null;
        try { o = JSON.parse(text); } catch (e) {}
        if (o && (o.gh || o.ds || o.kimi)) {
          save(o);
          document.dispatchEvent(new CustomEvent('phh-secrets', { detail: o }));
          res(o);
        } else {
          res(m || null);
        }
      }).catch(function () { res(m || null); });
    });
    return p;
  }
  function sync(key) {
    var m = mem();
    if (m && m[key]) return m[key] || '';
    ensure();
    m = mem();
    return (m && m[key]) || '';
  }

  window.PHHSECRETS = {
    ensure: ensure,
    get: function () { return mem() || {}; },
    gh: function () { return sync('gh'); },
    ds: function () { return sync('ds'); },
    kimi: function () { return sync('kimi'); }
  };
  ensure();
})();
