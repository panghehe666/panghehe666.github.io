/* Private post AES-GCM helpers. Key is derived from admin password. */
(function (global) {
  var KEY_STORAGE = "blog_admin_key";
  var FLAG = "blog_admin";
  var PBKDF_SALT = new TextEncoder().encode("panghehe666-blog-private-v1");
  var PBKDF_ITERS = 120000;

  function b64encode(buf) {
    var bytes = buf instanceof ArrayBuffer ? new Uint8Array(buf) : buf;
    var s = "";
    for (var i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
    return btoa(s);
  }

  function b64decode(str) {
    var bin = atob(str);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
  }

  function deriveKey(password) {
    return crypto.subtle
      .importKey("raw", new TextEncoder().encode(password), "PBKDF2", false, ["deriveKey"])
      .then(function (base) {
        return crypto.subtle.deriveKey(
          { name: "PBKDF2", salt: PBKDF_SALT, iterations: PBKDF_ITERS, hash: "SHA-256" },
          base,
          { name: "AES-GCM", length: 256 },
          true,
          ["encrypt", "decrypt"]
        );
      });
  }

  function exportKey(key) {
    return crypto.subtle.exportKey("raw", key).then(function (raw) {
      return b64encode(raw);
    });
  }

  function importKeyFromB64(b64) {
    return crypto.subtle.importKey("raw", b64decode(b64), { name: "AES-GCM" }, false, [
      "encrypt",
      "decrypt",
    ]);
  }

  function saveSessionKey(keyB64) {
    try {
      sessionStorage.setItem(KEY_STORAGE, keyB64);
      localStorage.setItem(FLAG, "1");
    } catch (e) {}
  }

  function clearSession() {
    try {
      sessionStorage.removeItem(KEY_STORAGE);
      localStorage.removeItem(FLAG);
    } catch (e) {}
  }

  function loadSessionKey() {
    try {
      return sessionStorage.getItem(KEY_STORAGE);
    } catch (e) {
      return null;
    }
  }

  function encryptText(plain, password) {
    return deriveKey(password).then(function (key) {
      var iv = crypto.getRandomValues(new Uint8Array(12));
      return crypto.subtle
        .encrypt({ name: "AES-GCM", iv: iv }, key, new TextEncoder().encode(plain))
        .then(function (cipher) {
          var c = new Uint8Array(cipher);
          var packed = new Uint8Array(iv.length + c.length);
          packed.set(iv, 0);
          packed.set(c, iv.length);
          return b64encode(packed);
        });
    });
  }

  function decryptText(payloadB64, key) {
    var packed = b64decode(payloadB64);
    if (packed.length < 13) return Promise.reject(new Error("bad payload"));
    var iv = packed.slice(0, 12);
    var data = packed.slice(12);
    return crypto.subtle
      .decrypt({ name: "AES-GCM", iv: iv }, key, data)
      .then(function (buf) {
        return new TextDecoder().decode(buf);
      });
  }

  function decryptWithSession(payloadB64) {
    var b64 = loadSessionKey();
    if (!b64) return Promise.reject(new Error("no key"));
    return importKeyFromB64(b64).then(function (key) {
      return decryptText(payloadB64, key);
    });
  }

  function unlockFromPassword(password) {
    return deriveKey(password)
      .then(function (key) {
        return exportKey(key);
      })
      .then(function (b64) {
        saveSessionKey(b64);
        return b64;
      });
  }

  function tryRevealEncryptedPosts() {
    var nodes = document.querySelectorAll("[data-private-cipher]");
    if (!nodes.length) return;
    var b64 = loadSessionKey();
    if (!b64) return;
    importKeyFromB64(b64).then(function (key) {
      nodes.forEach(function (el) {
        var payload = el.getAttribute("data-private-cipher");
        if (!payload) return;
        decryptText(payload, key)
          .then(function (html) {
            el.innerHTML = html;
            el.removeAttribute("data-private-cipher");
            el.classList.add("private-decrypted");
          })
          .catch(function () {
            el.innerHTML =
              '<p class="private-decrypt-error">解密失败。请重新登录管理员。</p>';
          });
      });
    });
  }

  global.PrivateCrypto = {
    unlockFromPassword: unlockFromPassword,
    clearSession: clearSession,
    encryptText: encryptText,
    decryptWithSession: decryptWithSession,
    loadSessionKey: loadSessionKey,
    tryRevealEncryptedPosts: tryRevealEncryptedPosts,
  };
})(window);
