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
    if (on) {
      btn.innerHTML = '<i class="fa fa-sign-out"></i> 登出';
    } else {
      btn.innerHTML = '<i class="fa fa-sign-in"></i> 管理员';
    }
  }

  function showNavToast(html) {
    var t = document.getElementById("admin-global-toast");
    if (!t) {
      t = document.createElement("div");
      t.id = "admin-global-toast";
      t.style.cssText =
        "position:fixed;top:78px;left:50%;z-index:4000;display:flex;align-items:center;gap:10px;padding:10px 18px;background:#111;color:#fff;font-size:13px;letter-spacing:.06em;white-space:nowrap;opacity:0;transform:translate(-50%,-10px);pointer-events:none;transition:opacity .25s ease,transform .25s ease;";
      document.body.appendChild(t);
    }
    t.innerHTML = html;
    t.style.opacity = "0";
    t.style.transform = "translate(-50%, -10px)";
    void t.offsetWidth;
    t.style.opacity = "1";
    t.style.transform = "translate(-50%, 0)";
    setTimeout(function () {
      t.style.opacity = "0";
      t.style.transform = "translate(-50%, -10px)";
    }, 1200);
  }

  document.addEventListener("DOMContentLoaded", function () {
    paint();
    if (window.PrivateCrypto) PrivateCrypto.tryRevealEncryptedPosts();

    var btn = document.getElementById("admin-login-btn");
    if (!btn) return;
    btn.addEventListener("click", function (e) {
      if (!isAdmin()) return;
      e.preventDefault();
      if (window.PrivateCrypto) PrivateCrypto.clearSession();
      else {
        try {
          localStorage.removeItem(KEY);
        } catch (err) {}
      }
      document.documentElement.classList.remove("is-admin");
      paint();
      showNavToast('<i class="fa fa-sign-out" style="color:#ffb4a2"></i> 已登出管理员');
      if (
        document.body.classList.contains("is-private-page") ||
        location.pathname.indexOf("/admin") === 0
      ) {
        setTimeout(function () {
          location.href = "/";
        }, 900);
      } else {
        setTimeout(function () {
          location.reload();
        }, 900);
      }
    });
  });
})();
