/* ============================================================
   PHH Blog · AI 工具注册表(动态加载)
   ------------------------------------------------------------
   1) 本地工具:任何脚本都能在运行时注册
        PHAITOOLS.register('name', '描述', {JSON Schema}, function (args) {
          return '结果';                    // 或返回 Promise
        });
   2) Kimi 官方工具(Formula API):联网搜索 / 单位换算 / 日期 / Base64 / 网页抓取
        自动拉取官方工具声明 → 注册 → 模型调用时装到 /formulas/.../fibers 执行
        需要 Kimi API Key;web-search 按次计费,可在设置里关闭。
   ============================================================ */
(function () {
  'use strict';
  var reg = {};
  var kimiState = { loaded: false, loading: false, uris: {} };

  var KIMI_BASES = ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'];
  var KIMI_FORMULAS = [
    'moonshot/web-search:latest',
    'moonshot/convert:latest',
    'moonshot/date:latest',
    'moonshot/base64:latest',
    'moonshot/fetch:latest'
  ];

  function register(name, description, parameters, handler) {
    if (!name || typeof handler !== 'function') return false;
    reg[name] = {
      name: String(name),
      description: String(description || ''),
      parameters: parameters || { type: 'object', properties: {} },
      handler: handler
    };
    return true;
  }
  function unregister(name) { delete reg[name]; }
  function list() {
    return Object.keys(reg).map(function (k) {
      return {
        type: 'function',
        function: {
          name: reg[k].name,
          description: reg[k].description,
          parameters: reg[k].parameters
        }
      };
    });
  }
  function names() { return Object.keys(reg); }
  function run(name, args) {
    var t = reg[name];
    if (!t) return Promise.reject(new Error('未知工具:' + name));
    var a = args;
    if (typeof a === 'string') {
      try { a = a.trim() ? JSON.parse(a) : {}; } catch (e) { a = {}; }
    }
    try {
      return Promise.resolve(t.handler(a || {})).then(function (out) {
        return String(out == null ? '' : out);
      });
    } catch (e) { return Promise.reject(e); }
  }

  /* ---------------- Kimi 官方工具 ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function kimiKey() {
    var k = '';
    try { k = lsGet('phh_ai_key_kimi').trim(); } catch (e) {}
    if (!k && window.PHHSECRETS) { try { k = PHHSECRETS.kimi() || ''; } catch (e) {} }
    return k;
  }
  function kimiToolsEnabled() { return lsGet('phh_ai_kimi_tools') !== '0'; }

  function chooseBase(key) {
    /* 先用国内域名,失败再换国际域名 */
    return fetch(KIMI_BASES[0] + '/formulas/moonshot/date:latest/tools', {
      headers: { 'Authorization': 'Bearer ' + key }
    }).then(function (r) {
      return r.ok ? KIMI_BASES[0] : KIMI_BASES[1];
    }).catch(function () { return KIMI_BASES[1]; });
  }

  function registerFormula(base, key, uri, tools) {
    (tools || []).forEach(function (t) {
      var fn = t && t.function;
      if (!fn || !fn.name) return;
      var name = fn.name;
      kimiState.uris[name] = uri;
      register(name, (fn.description || name) + '(Kimi 官方工具)', fn.parameters, function (args) {
        return fetch(base + '/formulas/' + uri + '/fibers', {
          method: 'POST',
          headers: {
            'Authorization': 'Bearer ' + key,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({ name: name, arguments: JSON.stringify(args || {}) })
        }).then(function (r) {
          return r.text().then(function (txt) {
            var d = {};
            try { d = txt ? JSON.parse(txt) : {}; } catch (e) {}
            if (!r.ok) throw new Error((d.error && d.error.message) || ('HTTP ' + r.status));
            var ctx = d.context || {};
            /* web-search 返回加密输出,必须原样回传给模型 */
            return String(ctx.output || ctx.encrypted_output || '');
          });
        });
      });
    });
  }

  function loadKimiOfficialTools() {
    if (kimiState.loaded || kimiState.loading) return Promise.resolve(kimiState.loaded);
    if (!kimiToolsEnabled()) {
      /* 关闭时移除已注册的 Kimi 工具 */
      Object.keys(kimiState.uris).forEach(function (n) { unregister(n); });
      kimiState.uris = {};
      return Promise.resolve(false);
    }
    var key = kimiKey();
    if (!key) return Promise.resolve(false);
    kimiState.loading = true;
    return chooseBase(key).then(function (base) {
      return Promise.all(KIMI_FORMULAS.map(function (uri) {
        return fetch(base + '/formulas/' + uri + '/tools', {
          headers: { 'Authorization': 'Bearer ' + key }
        }).then(function (r) { return r.ok ? r.json() : null; })
          .then(function (j) {
            if (j && j.tools && j.tools.length) registerFormula(base, key, uri, j.tools);
          }).catch(function () {});
      })).then(function () {
        kimiState.loading = false;
        kimiState.loaded = Object.keys(kimiState.uris).length > 0;
        return kimiState.loaded;
      });
    }).catch(function () {
      kimiState.loading = false;
      return false;
    });
  }

  window.PHAITOOLS = {
    register: register,
    unregister: unregister,
    list: list,
    names: names,
    run: run,
    loadKimiOfficialTools: loadKimiOfficialTools,
    kimiToolsEnabled: kimiToolsEnabled
  };
})();
