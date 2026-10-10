(function () {
  var KEY = "blog_admin";

  function isAdmin() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }

  function paint() {
    var on = isAdmin();
    document.documentElement.classList.toggle("is-admin", on);
    var btn = document.getElementById("admin-login-btn");
    if (!btn) return;
    if (on) {
      btn.innerHTML = '<i class="fa fa-sign-out"></i> 登出';
    } else {
      btn.innerHTML = '<i class="fa fa-sign-in"></i> 管理员';
    }
  }

  document.addEventListener("DOMContentLoaded", function () {
    paint();
    var btn = document.getElementById("admin-login-btn");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      if (!isAdmin()) return;
      e.preventDefault();
      try { localStorage.removeItem(KEY); } catch (err) {}
      document.documentElement.classList.remove("is-admin");
      paint();
      if (document.body.classList.contains("is-private-page") || location.pathname.indexOf("/admin") === 0) {
        location.href = "/";
      }
    });
  });
})();
