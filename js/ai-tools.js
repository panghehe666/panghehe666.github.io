/* ============================================================
   PHH Blog · AI 工具注册表(动态加载)
   ------------------------------------------------------------
   1) 通用注册:任何脚本运行时都能加工具
        PHAITOOLS.register('name', '描述', {JSON Schema}, handler, { free: true });
      opts.free = true 表示「白嫖模式也能用」(不涉及博客内容)
   2) 内置 Kimi 联网工具(走 Moonshot REST,返回结构化结果 → 可显示来源)
        web_search  : POST /v1/tools/search_pro
        fetch_url   : POST /v1/tools/fetch
   ============================================================ */
(function () {
  'use strict';
  var reg = {};
  var sources = [];          /* 本轮工具搜到的网页来源 */
  var BASES = ['https://api.moonshot.cn/v1', 'https://api.moonshot.ai/v1'];

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

  /* filter: {free:true} 只返回白嫖模式可用的工具 */
  function list(filter) {
    return Object.keys(reg).filter(function (k) {
      if (filter && filter.free) return reg[k].free;
      return true;
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

  /* ---------------- Kimi 联网 ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function kimiKey() {
    var k = '';
    try { k = lsGet('phh_ai_key_kimi').trim(); } catch (e) {}
    if (!k && window.PHHSECRETS) { try { k = PHHSECRETS.kimi() || ''; } catch (e) {} }
    return k;
  }
  function kimiToolsEnabled() { return lsGet('phh_ai_kimi_tools') !== '0'; }
  function kimiPost(path, body) {
    var key = kimiKey();
    if (!key) return Promise.reject(new Error('没配置 Kimi API Key'));
    var attempt = function (i) {
      return fetch(BASES[i] + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body)
      }).then(function (r) {
        return r.text().then(function (t) {
          var d = {};
          try { d = t ? JSON.parse(t) : {}; } catch (e) {}
          if (!r.ok) {
            var msg = (d.error && d.error.message) || ('HTTP ' + r.status);
            var e = new Error(msg);
            e.status = r.status;
            throw e;
          }
          return d;
        });
      }).catch(function (e) {
        /* 网络层失败(常见于域名不可达/CORS)换国际域名重试一次 */
        if (i + 1 < BASES.length && !e.status) return attempt(i + 1);
        throw e;
      });
    };
    return attempt(0);
  }

  function addSources(list) {
    (list || []).forEach(function (s) {
      if (!s || !s.url) return;
      for (var i = 0; i < sources.length; i++) if (sources[i].url === s.url) return;
      sources.push({ title: s.title || s.url, url: s.url, site: s.site_name || '' });
    });
  }

  if (window.PHAITOOLS === undefined) { /* 兼容下面统一导出 */ }

  register('web_search', '联网搜索实时信息。需要最新资讯、新闻、价格、事件进展时调用;返回若干网页的正文摘录。', {
    type: 'object',
    properties: {
      query: { type: 'string', description: '搜索关键词,尽量具体(实体+时间+限定词)' }
    },
    required: ['query']
  }, function (a) {
    var q = String(a.query || '').trim();
    if (!q) return Promise.reject(new Error('缺少 query'));
    if (!kimiToolsEnabled()) return Promise.reject(new Error('Kimi 官方工具开关是关闭的'));
    return kimiPost('/tools/search_pro', { text_query: q, limit: 5, timeout_seconds: 30 }).then(function (d) {
      var rs = d.search_results || [];
      if (!rs.length) return '没有搜到结果。';
      var out = [];
      rs.forEach(function (r, i) {
        var pass = (r.chunks || []).map(function (c) { return c.text; }).join('\n');
        if (!pass) pass = r.snippet || '';
        out.push('[' + (i + 1) + '] 《' + (r.title || '') + '》 ' + (r.url || '') +
          (r.date ? ' (' + r.date + ')' : '') + '\n' + String(pass).slice(0, 900));
      });
      addSources(rs);
      return out.join('\n\n');
    });
  }, { free: true });

  register('fetch_url', '抓取指定网页的正文(Markdown),用于读某条链接的详细内容。', {
    type: 'object',
    properties: {
      url: { type: 'string', description: '要抓取的网页地址' }
    },
    required: ['url']
  }, function (a) {
    var u = String(a.url || '').trim();
    if (!/^https?:\/\//i.test(u)) return Promise.reject(new Error('url 需要 http(s) 开头'));
    if (!kimiToolsEnabled()) return Promise.reject(new Error('Kimi 官方工具开关是关闭的'));
    return kimiPost('/tools/fetch', { url: u }).then(function (d) {
      var body = d.content || d.markdown || d.text || '';
      if (!body && d.data) body = d.data.content || '';
      addSources([{ title: d.title || u, url: u, site_name: d.site_name || '' }]);
      return '《' + (d.title || u) + '》 ' + u + '\n' + String(body).slice(0, 6000);
    });
  }, { free: true });

  window.PHAITOOLS = {
    register: register,
    unregister: unregister,
    list: list,
    names: names,
    run: run,
    sources: function () { return sources.slice(); },
    resetSources: function () { sources = []; },
    addSources: addSources,
    kimiToolsEnabled: kimiToolsEnabled
  };
})();
