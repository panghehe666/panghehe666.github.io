/* ============================================================
   PHH Blog · 客户端加密与密钥信封（Password-sealed Envelope）
   ------------------------------------------------------------
   两种密文格式并存，互不破坏：
   - legacy：纯 Base64(IV12 + ciphertext)，salt 为硬编码字符串、
             PBKDF2 120000 次。仅用于解密升级前已存在的私密文章。
   - v2    ：JSON {"v":2,"s":<Base64 随机 salt>,"c":<Base64 IV+密文>}，
             PBKDF2 300000 次。升级后所有新密文一律用此格式。

   密钥信封 secrets.enc.json（随仓库分发，内容全是密文）：
     { "v":2, "s":<站点随机 salt>, "c":<加密后的 {"deepseek":..,"github":..}>,
       "k":["deepseek","github"], "created":"<ISO>" }
   登录 = 用管理员密码派生密钥并尝试解开信封：
   解得开就是管理员，解不开就不是。不再依赖前端口令哈希。
   ============================================================ */
(function (global) {
  "use strict";

  /* ---------------- 常量 ---------------- */
  var LEGACY_SALT_STR = "panghehe666-blog-private-v1";
  var LEGACY_ITERS = 120000;
  var V2_ITERS = 300000;
  var ENVELOPE_URL = "/secrets.enc.json";

  /* 存储键 */
  var K_FLAG = "blog_admin";              // CSS 门禁用的布尔标记（非安全边界）
  var K_KEY_V2 = "phh_admin_key_v2";      // v2 派生密钥（raw Base64）
  var K_KEY_LEGACY = "phh_admin_key_legacy"; // legacy 派生密钥（raw Base64）
  var K_KEY_OLD = "blog_admin_key";       // 旧版键名，等价于 legacy，保留兼容
  var K_SALT = "phh_admin_salt";          // 当前站点 salt（Base64）
  var K_REMEMBER = "phh_admin_remember";
  var K_SEC_DEEPSEEK = "phh_secret_deepseek";
  var K_SEC_GITHUB = "phh_secret_github";

  /* ---------------- Base64 / 字节工具 ---------------- */
  function b64encode(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }
  function b64decode(str) {
    var bin = atob(String(str).trim());
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }
  function concatBytes(a, b) {
    var out = new Uint8Array(a.length + b.length);
    out.set(a, 0);
    out.set(b, a.length);
    return out;
  }
  function randomBytes(n) {
    return crypto.getRandomValues(new Uint8Array(n));
  }

  /* ---------------- 密钥派生 ---------------- */
  function deriveKey(password, saltBytes, iterations) {
    return crypto.subtle
      .importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: saltBytes, iterations: iterations, hash: "SHA-256" },
          base,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"]
        );
      });
  }
  function deriveLegacy(password) {
    return deriveKey(password, new TextEncoder().encode(LEGACY_SALT_STR), LEGACY_ITERS);
  }
  function deriveV2(password, saltB64) {
    return deriveKey(password, b64decode(saltB64), V2_ITERS);
  }
  function exportKeyB64(key) {
    return crypto.subtle.exportKey("raw", key).then(b64encode);
  }
  function importKeyB64(b64) {
    return crypto.subtle.importKey("raw", b64decode(b64), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  /* ---------------- 密文格式判定与打包 ----------------
     v2 密文最终形态是 "PHH2:" + Base64(JSON)，而不是裸 JSON。
     原因：private_cipher 要写进 YAML front matter，裸 JSON 以 { 开头
     会被 YAML 当成 flow mapping 解析，直接导致整篇文章构建失败。
     加前缀后整个值是 [A-Za-z0-9+/=:] 的普通标量，YAML / JSON / HTML 属性里都安全。
     secrets.enc.json 是独立文件、不进 front matter，所以它保持裸 JSON 便于查看。 */
  var V2_PREFIX = "PHH2:";

  function isV2(payload) {
    return typeof payload === "string" && payload.indexOf(V2_PREFIX) === 0;
  }
  /* v2 载荷 = 前缀 + Base64(IV12 + 密文)，与 legacy 同构、只多 5 个字符。
     salt 不重复存进每条密文：它是站点级的，存在 secrets.enc.json 里，
     登录时随派生密钥一起进会话。这样私密文章的 front matter 体积不会膨胀。 */
  function parseV2(payload) {
    if (!isV2(payload)) return null;
    var c = payload.slice(V2_PREFIX.length).trim();
    if (!c) return null;
    return { v: 2, c: c };
  }
  function packV2(saltB64, ivBytes, cipherBytes) {
    return V2_PREFIX + b64encode(concatBytes(ivBytes, cipherBytes));
  }
  /* 信封文件用：裸 JSON（带 salt / 密文 / 已配置项名 / 创建时间） */
  function packEnvelope(saltB64, ivBytes, cipherBytes, names) {
    return JSON.stringify({
      v: 2,
      s: saltB64,
      c: b64encode(concatBytes(ivBytes, cipherBytes)),
      k: names,
      created: new Date().toISOString(),
    });
  }

  function aesEncrypt(plainText, key) {
    var iv = randomBytes(12);
    return crypto.subtle
      .encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plainText))
      .then(function (cipher) {
        return { iv: iv, cipher: new Uint8Array(cipher) };
      });
  }
  function aesDecryptPacked(packedB64, key) {
    var packed = b64decode(packedB64);
    if (packed.length < 13) return Promise.reject(new Error("bad payload"));
    var iv = packed.slice(0, 12);
    var data = packed.slice(12);
    return crypto.subtle
      .decrypt({ name: "AES-GCM", iv: iv }, key, data)
      .then(function (buf) {
        return new TextDecoder().decode(buf);
      });
  }

  /* ---------------- 会话存储 ---------------- */
  function remember() {
    try { return localStorage.getItem(K_REMEMBER) === "1"; } catch (e) { return false; }
  }
  function store(k, v) {
    try {
      sessionStorage.setItem(k, v);
      if (remember()) localStorage.setItem(k, v);
    } catch (e) {}
  }
  function load(k) {
    try {
      var v = sessionStorage.getItem(k);
      if (!v) v = localStorage.getItem(k);
      return v || "";
    } catch (e) { return ""; }
  }
  function drop(k) {
    try { sessionStorage.removeItem(k); localStorage.removeItem(k); } catch (e) {}
  }

  var ALL_KEYS = [K_KEY_V2, K_KEY_LEGACY, K_KEY_OLD, K_SALT, K_FLAG,
                  K_SEC_DEEPSEEK, K_SEC_GITHUB];

  function clearSession() {
    ALL_KEYS.forEach(drop);
    try { document.documentElement.classList.remove("is-admin"); } catch (e) {}
  }

  /* 兼容旧接口：loadSessionKey 返回 legacy 密钥 */
  function loadSessionKey() {
    return load(K_KEY_LEGACY) || load(K_KEY_OLD) || "";
  }
  function loadSessionKeyV2() {
    return load(K_KEY_V2) || "";
  }
  function isUnlocked() {
    return !!(loadSessionKeyV2() || loadSessionKey());
  }

  /* ---------------- 信封读写 ---------------- */
  function envelopeUrl() {
    return ENVELOPE_URL + "?v=" + Date.now();
  }
  /* 返回 {found:bool, env:object|null, corrupt:bool} */
  function fetchEnvelope() {
    return fetch(envelopeUrl(), { cache: "no-store" })
      .then(function (r) {
        if (r.status === 404) return { found: false, env: null, corrupt: false };
        if (!r.ok) throw new Error("HTTP " + r.status);
        return r.text().then(function (t) {
          var env = null;
          try {
            var o = JSON.parse(t);
            if (o && o.v === 2 && o.s && o.c) env = o;
          } catch (e) {}
          /* 信封文件是裸 JSON（不是 PHH2: 载荷），只有它需要携带站点 salt */
          return { found: true, env: env, corrupt: !env };
        });
      })
      .catch(function () {
        return { found: false, env: null, corrupt: false };
      });
  }

  /* 用密码尝试解开信封：成功即视为管理员登录 */
  function unlockWithEnvelope(password, env) {
    var saltB64 = env.s;
    return deriveV2(password, saltB64)
      .then(function (key) {
        return aesDecryptPacked(env.c, key).then(function (plain) {
          return { key: key, plain: plain };
        });
      })
      .then(function (r) {
        var secrets = {};
        try { secrets = JSON.parse(r.plain) || {}; } catch (e) { secrets = {}; }
        return exportKeyB64(r.key).then(function (v2b64) {
          store(K_KEY_V2, v2b64);
          store(K_SALT, saltB64);
          store(K_FLAG, "1");
          if (secrets.deepseek) store(K_SEC_DEEPSEEK, secrets.deepseek);
          if (secrets.github) store(K_SEC_GITHUB, secrets.github);
          try { document.documentElement.classList.add("is-admin"); } catch (e) {}
          return secrets;
        });
      });
  }

  /* 创建 / 更新信封。secrets = {deepseek, github}；返回信封 JSON 文本（裸 JSON，供文件使用） */
  function sealSecrets(password, secrets, saltB64) {
    var salt = saltB64 || b64encode(randomBytes(16));
    return deriveV2(password, salt).then(function (key) {
      return aesEncrypt(JSON.stringify(secrets), key).then(function (p) {
        var names = [];
        if (secrets.deepseek) names.push("deepseek");
        if (secrets.github) names.push("github");
        return packEnvelope(salt, p.iv, p.cipher, names);
      });
    });
  }

  /* 登录总入口：解信封 + 顺带派生 legacy 密钥（用于解密升级前的私密文章） */
  function login(password, opts) {
    opts = opts || {};
    try {
      if (opts.remember) localStorage.setItem(K_REMEMBER, "1");
      else localStorage.removeItem(K_REMEMBER);
    } catch (e) {}
    return fetchEnvelope().then(function (r) {
      if (r.corrupt) {
        var e0 = new Error("信封文件存在但无法解析");
        e0.code = "corrupt";
        throw e0;
      }
      if (!r.found || !r.env) {
        var e = new Error("no-envelope");
        e.code = "no-envelope";
        throw e;
      }
      return unlockWithEnvelope(password, r.env).then(function (secrets) {
        /* legacy 密钥：只为解开升级前那批旧格式私密文章，失败不影响登录 */
        return deriveLegacy(password)
          .then(exportKeyB64)
          .then(function (lb64) { store(K_KEY_LEGACY, lb64); store(K_KEY_OLD, lb64); })
          .catch(function () {})
          .then(function () { return secrets; });
      });
    });
  }

  /* ---------------- 私密文章加解密（自动识别格式） ---------------- */
  function decryptWithSession(payload) {
    if (isV2(payload)) {
      var env = parseV2(payload);
      var k2 = loadSessionKeyV2();
      if (!env || !k2) return Promise.reject(new Error("no key"));
      /* v2 密钥在派生时就绑定了站点 salt，salt 不必再随密文比对 */
      return importKeyB64(k2).then(function (key) {
        return aesDecryptPacked(env.c, key);
      });
    }
    var b64 = loadSessionKey();
    if (!b64) return Promise.reject(new Error("no key"));
    return importKeyB64(b64).then(function (key) {
      return aesDecryptPacked(payload, key);
    });
  }

  /* 新密文一律 v2，复用当前站点 salt 与已缓存密钥 */
  function encryptWithSession(plain) {
    var k2 = loadSessionKeyV2();
    if (!k2) return Promise.reject(new Error("no key"));
    return importKeyB64(k2).then(function (key) {
      return aesEncrypt(String(plain), key).then(function (p) {
        return packV2(load(K_SALT), p.iv, p.cipher);
      });
    });
  }

  /* 独立密码加密（管理页的 Encrypt 工具用），产出 v2 */
  function encryptText(plain, password) {
    var salt = load(K_SALT) || b64encode(randomBytes(16));
    return deriveV2(password, salt).then(function (key) {
      return aesEncrypt(String(plain), key).then(function (p) {
        return packV2(salt, p.iv, p.cipher);
      });
    });
  }

  /* 用旧密码解开 legacy 密文（迁移工具用） */
  function decryptLegacyWithPassword(payload, password) {
    return deriveLegacy(password).then(function (key) {
      return aesDecryptPacked(payload, key);
    });
  }
  /* 用新密码（当前会话）重新加密为 v2 */
  function reencryptToV2(plain) {
    return encryptWithSession(plain);
  }

  /* ---------------- 会话密钥取用（供 AI / 发布模块） ---------------- */
  function getSecret(name) {
    return load(name === "github" ? K_SEC_GITHUB : K_SEC_DEEPSEEK);
  }
  function loadSecrets() {
    return { deepseek: load(K_SEC_DEEPSEEK), github: load(K_SEC_GITHUB) };
  }

  /* ---------------- 轻量 Markdown 渲染（原有实现保留） ---------------- */
  function looksLikeMarkdown(text) {
    if (!text) return false;
    var t = text.trim();
    if (t.charAt(0) === "<") return false;
    return (
      /^#{1,6}\s/m.test(t) ||
      /^[-*+]\s/m.test(t) ||
      /^\d+\.\s/m.test(t) ||
      /\*\*[^*]+\*\*/.test(t) ||
      /^>\s/m.test(t) ||
      /\[[^\]]+\]\([^)]+\)/.test(t)
    );
  }
  function escapeHtml(s) {
    return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  }
  function inlineFormat(s) {
    s = escapeHtml(s);
    s = s.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/`([^`]+)`/g, "<code>$1</code>");
    s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
    return s;
  }
  function markdownToHtml(src) {
    var lines = src.replace(/\r\n/g, "\n").split("\n");
    var out = [];
    var i = 0;
    var inUl = false, inOl = false, inP = false;

    function closeLists() {
      if (inUl) { out.push("</ul>"); inUl = false; }
      if (inOl) { out.push("</ol>"); inOl = false; }
    }
    function closeP() {
      if (inP) { out.push("</p>"); inP = false; }
    }

    while (i < lines.length) {
      var line = lines[i];
      var trimmed = line.trim();

      if (trimmed === "" || trimmed === "---" || trimmed === "***") {
        closeP(); closeLists();
        if (trimmed === "---" || trimmed === "***") out.push("<hr>");
        i++;
        continue;
      }
      var hm = trimmed.match(/^(#{1,6})\s+(.+)$/);
      if (hm) {
        closeP(); closeLists();
        var lv = hm[1].length;
        out.push("<h" + lv + ">" + inlineFormat(hm[2]) + "</h" + lv + ">");
        i++;
        continue;
      }
      if (/^>\s?/.test(trimmed)) {
        closeP(); closeLists();
        var q = [];
        while (i < lines.length && /^>\s?/.test(lines[i].trim())) {
          q.push(lines[i].trim().replace(/^>\s?/, ""));
          i++;
        }
        out.push("<blockquote><p>" + inlineFormat(q.join(" ")) + "</p></blockquote>");
        continue;
      }
      if (/^[-*+]\s+/.test(trimmed)) {
        closeP();
        if (inOl) { out.push("</ol>"); inOl = false; }
        if (!inUl) { out.push("<ul>"); inUl = true; }
        out.push("<li>" + inlineFormat(trimmed.replace(/^[-*+]\s+/, "")) + "</li>");
        i++;
        continue;
      }
      if (/^\d+\.\s+/.test(trimmed)) {
        closeP();
        if (inUl) { out.push("</ul>"); inUl = false; }
        if (!inOl) { out.push("<ol>"); inOl = true; }
        out.push("<li>" + inlineFormat(trimmed.replace(/^\d+\.\s+/, "")) + "</li>");
        i++;
        continue;
      }
      closeLists();
      if (!inP) {
        out.push("<p>");
        inP = true;
        out.push(inlineFormat(trimmed));
      } else {
        out.push("<br>" + inlineFormat(trimmed));
      }
      i++;
    }
    closeP(); closeLists();
    return out.join("\n");
  }
  function toRenderableHtml(text) {
    if (looksLikeMarkdown(text)) return markdownToHtml(text);
    return text;
  }

  /* ---------------- 解密后修补标题 id 与侧边目录 ---------------- */
  function slugify(text) {
    return String(text || "")
      .trim()
      .toLowerCase()
      .replace(/\s+/g, "-")
      .replace(/[^\w\u4e00-\u9fff-]/g, "")
      .replace(/-+/g, "-")
      .replace(/^-|-$/g, "") || "section";
  }
  function ensureHeadingIds(root) {
    var used = {};
    var heads = root.querySelectorAll("h1,h2,h3,h4,h5,h6");
    for (var i = 0; i < heads.length; i++) {
      var h = heads[i];
      if (h.id) { used[h.id] = true; continue; }
      var base = slugify(h.textContent);
      var id = base;
      var n = 2;
      while (used[id] || document.getElementById(id)) { id = base + "-" + n; n++; }
      h.id = id;
      used[id] = true;
    }
  }
  function rebuildCatalog() {
    try {
      if (typeof window.jQuery === "undefined") return;
      var $ = window.jQuery;
      var body = $(".catalog-body");
      if (!body.length) return;
      var container = $("div.post-container");
      var heads = container.find("h1,h2,h3,h4,h5,h6");
      body.html("");
      heads.each(function () {
        var n = $(this).prop("tagName").toLowerCase();
        var id = $(this).prop("id");
        if (!id) return;
        var t = $(this).text();
        var c = $('<a href="#' + id + '" rel="nofollow">' + t + "</a>");
        var l = $('<li class="' + n + '_nav"></li>').append(c);
        body.append(l);
      });
      if (body.children().length && typeof body.onePageNav === "function") {
        body.onePageNav({
          currentClass: "active",
          changeHash: false,
          easing: "swing",
          filter: "",
          scrollSpeed: 700,
          scrollOffset: 0,
          scrollThreshold: 0.2,
          begin: null,
        });
      }
    } catch (e) {}
  }
  function afterReveal(el) {
    ensureHeadingIds(el);
    var post = document.querySelector("div.post-container");
    if (post) ensureHeadingIds(post);
    rebuildCatalog();
  }

  function tryRevealEncryptedPosts() {
    var nodes = document.querySelectorAll("[data-private-cipher]");
    if (!nodes.length) return;
    if (!isUnlocked()) return;
    Array.prototype.forEach.call(nodes, function (el) {
      var payload = el.getAttribute("data-private-cipher");
      if (!payload) return;
      decryptWithSession(payload)
        .then(function (text) {
          el.innerHTML = toRenderableHtml(text);
          el.removeAttribute("data-private-cipher");
          el.classList.add("private-decrypted");
          afterReveal(el);
        })
        .catch(function () {
          el.innerHTML =
            '<p class="private-decrypt-error">解密失败。请到 /admin/ 重新登录管理员。</p>';
        });
    });
  }

  global.PrivateCrypto = {
    /* 会话与登录 */
    login: login,
    unlockWithEnvelope: unlockWithEnvelope,
    clearSession: clearSession,
    isUnlocked: isUnlocked,
    remember: remember,
    /* 信封 */
    fetchEnvelope: fetchEnvelope,
    sealSecrets: sealSecrets,
    loadSecrets: loadSecrets,
    getSecret: getSecret,
    /* 兼容旧接口 */
    unlockFromPassword: function (password) {
      return deriveLegacy(password).then(exportKeyB64).then(function (b64) {
        store(K_KEY_LEGACY, b64);
        store(K_KEY_OLD, b64);
        store(K_FLAG, "1");
        try { document.documentElement.classList.add("is-admin"); } catch (e) {}
        return b64;
      });
    },
    loadSessionKey: loadSessionKey,
    loadSessionKeyV2: loadSessionKeyV2,
    /* 加解密 */
    encryptText: encryptText,
    decryptWithSession: decryptWithSession,
    encryptWithSession: encryptWithSession,
    decryptLegacyWithPassword: decryptLegacyWithPassword,
    reencryptToV2: reencryptToV2,
    /* 渲染 */
    tryRevealEncryptedPosts: tryRevealEncryptedPosts,
    toRenderableHtml: toRenderableHtml,
    markdownToHtml: markdownToHtml,
  };
})(window);
