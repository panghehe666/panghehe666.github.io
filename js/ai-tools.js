/* ============================================================
   PHH Blog · AI 工具注册表(动态加载)
   ------------------------------------------------------------
   通用注册:PHAITOOLS.register('name','描述',{JSON Schema},handler,{free:true})
   内置:Kimi 官方工具走 Formula API(GET /formulas/{uri}/tools + POST .../fibers)
         该通道已开启 CORS,可在浏览器直接调用;web-search 返回加密输出,原样回传即可。
   ============================================================ */
(function () {
  'use strict';
  var reg = {};
  var kimi = { loaded: false, loading: false, uris: {} };

  var KIMI_BASES = ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'];
  var KIMI_FORMULAS = [
    'moonshot/web-search:latest',
    'moonshot/convert:latest',
    'moonshot/date:latest',
    'moonshot/base64:latest',
    'moonshot/fetch:latest'
  ];

  function register(name, description, parameters, handler, opts) {
    if (!name || typeof handler !== 'function') return false;
    reg[name] = {
      name: String(name),
      description: String(description || ''),
      parameters: parameters || { type: 'object', properties: {} },
      handler: handler,
      free: !!(opts && opts.free)
    };
    return true;
  }
  function unregister(name) { delete reg[name]; }
  function list(filter) {
    return Object.keys(reg).filter(function (k) {
      return (filter && filter.free) ? reg[k].free : true;
    }).map(function (k) {
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

  /* ---------------- Kimi 官方工具(Formula API) ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function kimiKey() {
    var k = '';
    try { k = lsGet('phh_ai_key_kimi').trim(); } catch (e) {}
    if (!k && window.PHHSECRETS) { try { k = PHHSECRETS.kimi() || ''; } catch (e) {} }
    return k;
  }
  function kimiToolsEnabled() { return lsGet('phh_ai_kimi_tools') !== '0'; }

  function kimiFetch(path, opts) {
    var key = kimiKey();
    if (!key) return Promise.reject(new Error('没配置 Kimi API Key'));
    var attempt = function (i) {
      return fetch(KIMI_BASES[i] + path, {
        method: (opts && opts.method) || 'GET',
        headers: (function () {
          var h = { 'Authorization': 'Bearer ' + key };
          if (opts && opts.body) h['Content-Type'] = 'application/json';
          return h;
        })(),
        body: opts && opts.body ? JSON.stringify(opts.body) : undefined
      }).then(function (r) {
        return r.text().then(function (t) {
          var d = {};
          try { d = t ? JSON.parse(t) : {}; } catch (e) {}
          if (!r.ok) {
            var e = new Error((d.error && d.error.message) || ('HTTP ' + r.status));
            e.status = r.status;
            throw e;
          }
          return d;
        });
      }).catch(function (e) {
        if (i + 1 < KIMI_BASES.length && !e.status) return attempt(i + 1);
        throw e;
      });
    };
    return attempt(0);
  }

  function registerFormula(uri, tools) {
    (tools || []).forEach(function (t) {
      var fn = t && t.function;
      if (!fn || !fn.name) return;
      var name = fn.name;
      kimi.uris[name] = uri;
      register(name, (fn.description || name) + '(Kimi 官方工具)', fn.parameters, function (args) {
        return kimiFetch('/formulas/' + uri + '/fibers', {
          method: 'POST',
          body: { name: name, arguments: JSON.stringify(args || {}) }
        }).then(function (d) {
          var ctx = d.context || {};
          /* web-search 返回加密输出,必须原样回传给模型 */
          return String(ctx.output || ctx.encrypted_output || '');
        });
      }, { free: true });
    });
  }

  function loadKimiOfficialTools() {
    if (kimi.loaded || kimi.loading) return Promise.resolve(kimi.loaded);
    if (!kimiToolsEnabled()) {
      Object.keys(kimi.uris).forEach(function (n) { unregister(n); });
      kimi.uris = {};
      return Promise.resolve(false);
    }
    if (!kimiKey()) return Promise.resolve(false);
    kimi.loading = true;
    return Promise.all(KIMI_FORMULAS.map(function (uri) {
      return kimiFetch('/formulas/' + uri + '/tools').then(function (j) {
        if (j && j.tools && j.tools.length) registerFormula(uri, j.tools);
      }, function () {});
    })).then(function () {
      kimi.loading = false;
      kimi.loaded = Object.keys(kimi.uris).length > 0;
      return kimi.loaded;
    }, function () {
      kimi.loading = false;
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
    kimiToolsEnabled: kimiToolsEnabled,
    sources: function () { return []; },
    resetSources: function () {}
  };
})();
