(function () {
  var USER = "panghehe666";
  var PASS_HASH = "ae5260f88dee7b3aecf76ed91945ef3567d0683960c6f94cc5b515d59db1fa89";
  var KEY = "blog_admin";

  function isAdmin() {
    try { return localStorage.getItem(KEY) === "1"; } catch (e) { return false; }
  }

  function setAdmin(on) {
    try {
      if (on) localStorage.setItem(KEY, "1");
      else localStorage.removeItem(KEY);
    } catch (e) {}
    document.documentElement.classList.toggle("is-admin", on);
    var btn = document.getElementById("admin-login-btn");
    if (btn) btn.textContent = on ? "登出" : "登录";
  }

  function sha256Hex(text) {
    return crypto.subtle.digest("SHA-256", new TextEncoder().encode(text)).then(function (buf) {
      return Array.from(new Uint8Array(buf)).map(function (b) {
        return b.toString(16).padStart(2, "0");
      }).join("");
    });
  }

  document.addEventListener("DOMContentLoaded", function () {
    if (isAdmin()) document.documentElement.classList.add("is-admin");
    var btn = document.getElementById("admin-login-btn");
    if (btn) btn.textContent = isAdmin() ? "登出" : "登录";

    if (btn) {
      btn.addEventListener("click", function (e) {
        e.preventDefault();
        e.stopPropagation();
        if (isAdmin()) {
          setAdmin(false);
          if (document.body.classList.contains("is-private-page")) location.href = "/";
          return;
        }
        document.getElementById("admin-error").textContent = "";
        document.getElementById("admin-modal").style.display = "block";
        document.getElementById("admin-user").focus();
      });
    }

    document.getElementById("admin-cancel").addEventListener("click", function (e) {
      e.preventDefault();
      document.getElementById("admin-modal").style.display = "none";
    });

    document.getElementById("admin-form").addEventListener("submit", function (e) {
      e.preventDefault();
      var user = (document.getElementById("admin-user").value || "").trim();
      var pass = document.getElementById("admin-pass").value || "";
      var err = document.getElementById("admin-error");
      if (user !== USER) { err.textContent = "用户名或密码错误"; return; }
      sha256Hex(pass).then(function (hex) {
        if (hex === PASS_HASH) {
          setAdmin(true);
          document.getElementById("admin-modal").style.display = "none";
          document.getElementById("admin-pass").value = "";
        } else {
          err.textContent = "用户名或密码错误";
        }
      });
    });
  });
})();
