/* ============================================================
   PHH Blog · AI 工具注册表(动态加载)
   ------------------------------------------------------------
   通用注册:PHAITOOLS.register('name','描述',{JSON Schema},handler,{free:true})
   内置:web_search —— 走 Kimi Responses API 的服务端联网搜索
         POST /v1/responses {tools:[{type:'web_search'}], include:[sources]}
         返回:答案文本 + 命中的网页来源(sources)
   ============================================================ */
(function () {
  'use strict';
  var reg = {};
  var sources = [];        /* 本轮搜到的来源 */
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
  function list(filter) {
    return Object.keys(reg).filter(function (k) {
      return (filter && filter.free) ? reg[k].free : true;
    }).map(function (k) {
      return {
        type: 'function',
        function: { name: reg[k].name, description: reg[k].description, parameters: reg[k].parameters }
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
      var ctl = window.AbortController ? new AbortController() : null;
      var timer = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, 100000);
      return fetch(BASES[i] + path, {
        method: 'POST',
        headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: ctl ? ctl.signal : undefined
      }).then(function (r) {
        clearTimeout(timer);
        return r.text().then(function (t) {
          var d = {};
          try { d = t ? JSON.parse(t) : {}; } catch (e) {}
          if (!r.ok) {
            var e = new Error((d.error && d.error.message) || ('HTTP ' + r.status));
            e.status = r.status;
            throw e;
          }
          if (d && d.error && d.error.message) throw new Error(d.error.message);
          return d;
        });
      }).catch(function (e) {
        clearTimeout(timer);
        if (e && e.name === 'AbortError') throw new Error('搜索超时(100 秒),稍后再试');
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
      sources.push({ title: s.title || s.url, url: s.url, site: s.site || '' });
    });
  }

  /* ---------------- 联网搜索(Responses API,服务端执行) ---------------- */
  /* 流式联网搜索:Responses API(stream) —— output_text.delta 拿正文,completed 事件拿来源 */
  function kimiSearchStream(q) {
    var key = kimiKey();
    if (!key) return Promise.reject(new Error('没配置 Kimi API Key'));
    var ctl = window.AbortController ? new AbortController() : null;
    var timer = setTimeout(function () { try { ctl && ctl.abort(); } catch (e) {} }, 100000);
    var body = {
      model: 'kimi-k3',
      input: q,
      tools: [{ type: 'web_search' }],
      include: ['web_search_call.action.sources'],
      stream: true,
      instructions: '根据搜索到的实时信息直接给出最终中文回答。不要输出任何工具调用语法,不要再调用工具。'
    };
    return fetch(BASES[0] + '/responses', {
      method: 'POST',
      headers: { 'Authorization': 'Bearer ' + key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: ctl ? ctl.signal : undefined
    }).then(function (r) {
      if (!r.ok) {
        return r.text().then(function (tx) {
          var e = new Error('HTTP ' + r.status);
          e.status = r.status;
          e.body = tx;
          throw e;
        });
      }
      /* 不支持流式则退化解析 */
      if (!r.body || !r.body.getReader) {
        return r.json().then(function (d) { return parseFull(d); });
      }
      var reader = r.body.getReader(), dec = new TextDecoder(), buf = '', text = '', srcs = [];
      function pump() {
        return reader.read().then(function (res) {
          if (res.done) return { text: text, sources: srcs };
          buf += dec.decode(res.value, { stream: true });
          var parts = buf.split('\n\n');
          buf = parts.pop();
          parts.forEach(function (part) {
            var ev = '', data = '';
            part.split('\n').forEach(function (line) {
              if (line.indexOf('event:') === 0) ev = line.slice(6).trim();
              else if (line.indexOf('data:') === 0) data += line.slice(5).trim();
            });
            if (!data) return;
            var d = null;
            try { d = JSON.parse(data); } catch (e) { return; }
            if (ev === 'response.output_text.delta' && d.delta) text += d.delta;
            if (ev === 'response.completed' && d.response) {
              var rr = parseFull(d.response);
              if (rr.sources.length) srcs = srcs.concat(rr.sources);
            }
          });
          return pump();
        });
      }
      return pump();
    }).then(function (out) {
      clearTimeout(timer);
      var text = String(out.text || '').trim();
      var srcs = out.sources || [];
      text = text.replace(/<\|(open|sep|close)\|>/g, '').trim();
      addSources(srcs);
      var srcLines = srcs.slice(0, 8).map(function (s, i) {
        return (i + 1) + '. ' + (s.title || '') + ' ' + (s.url || '');
      }).join('\n');
      if (!text) text = '(搜索完成,但模型没有给出可读内容,请再试一次)';
      return text + (srcLines ? '\n\n【搜索结果来源】\n' + srcLines : '');
    }).catch(function (e) {
      clearTimeout(timer);
      if (e && e.name === 'AbortError') throw new Error('搜索超时(100 秒),稍后再试');
      throw e;
    });
  }

  function parseFull(d) {
    var text = '', srcs = [];
    (d.output || []).forEach(function (it) {
      if (it.type === 'message') {
        (it.content || []).forEach(function (c) {
          if (c.type === 'output_text' && c.text) text += c.text;
        });
      }
      if (it.type === 'web_search_call') {
        srcs = srcs.concat(((it.action || {}).sources) || []);
      }
    });
    return { text: text, sources: srcs };
  }

  register('web_search', '联网搜索实时信息。需要今天的新闻、最新进展、价格、事件、政策等实时信息时调用本工具;返回搜索后的整理答案和来源网页。', {
    type: 'object',
    properties: {
      query: { type: 'string', description: '要搜索的问题或关键词(可包含实体、时间、限定词)' }
    },
    required: ['query']
  }, function (a) {
    var q = String(a.query || '').trim();
    if (!q) return Promise.reject(new Error('缺少 query'));
    if (!kimiToolsEnabled()) return Promise.reject(new Error('Kimi 官方工具开关是关闭的'));
    return kimiSearchStream(q);
  }, { free: true });

  window.PHAITOOLS = {
    register: register,
    unregister: unregister,
    list: list,
    names: names,
    run: run,
    sources: function () { return sources.slice(); },
    resetSources: function () { sources = []; },
    kimiToolsEnabled: kimiToolsEnabled,
    /* 兼容旧调用 */
    loadKimiOfficialTools: function () { return Promise.resolve(true); }
  };
})();
