(function () {
  var KEY = "blog_admin";

  function isAdmin() {
    try {
      return localStorage.getItem(KEY) === "1";
    } catch (e) {
      return false;
    }
  }

  function paint() {
    var on = isAdmin();
    document.documentElement.classList.toggle("is-admin", on);
    var btn = document.getElementById("admin-login-btn");
    if (!btn) return;
    // Always link to /admin/ so encrypt tool stays reachable after login.
    if (on) {
      btn.innerHTML = '<i class="fa fa-user-secret"></i> 管理台·密文';
      btn.setAttribute("title", "进入管理员页 · 生成密文");
    } else {
      btn.innerHTML = '<i class="fa fa-sign-in"></i> 管理员';
      btn.setAttribute("title", "管理员登录");
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    paint();
    if (window.PrivateCrypto) PrivateCrypto.tryRevealEncryptedPosts();
  });
})();
