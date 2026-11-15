/* ============================================================
   PHH Blog · AI 工具注册表(动态加载)
   ------------------------------------------------------------
   通用注册:PHAITOOLS.register('name','描述',{JSON Schema},handler,{free:true})
   内置:web_search —— 走 Kimi Responses API 的服务端联网搜索(stream)
         通过 reasoning.effort=low 提速到 ~13s;
         返回正文 + 来源(sources),并提供 PHAITOOLS.webSearch 直接调用。
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

  function addSources(list) {
    (list || []).forEach(function (s) {
      if (!s || !s.url) return;
      for (var i = 0; i < sources.length; i++) if (sources[i].url === s.url) return;
      sources.push({ title: s.title || s.url, url: s.url, site: s.site || '' });
    });
  }

  /* ---------------- 联网搜索(Responses API,服务端执行,流式) ---------------- */
  function kimiSearchStream(q, onDelta) {
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
      reasoning: { effort: 'low' },       /* 提速:高推理 30s+ → 低推理 ~13s */
      max_output_tokens: 2000,
      /* 这里只要「素材」:关键事实要点,最终回答交给主流程(保留深度思考与完整长度) */
      instructions: '先联网搜索,再把与问题直接相关的关键事实用中文列成要点:每条一句,尽量具体(时间、数字、名称、结论)。不要寒暄,不要输出任何工具调用语法,不要再调用工具。'
    };
    var attempt = function (i) {
      return fetch(BASES[i] + '/responses', {
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
              if (ev === 'response.output_text.delta' && d.delta) {
                text += d.delta;
                if (onDelta) { try { onDelta(text); } catch (e) {} }
              }
              if (ev === 'response.completed' && d.response) {
                var rr = parseFull(d.response);
                if (rr.sources.length) srcs = srcs.concat(rr.sources);
              }
            });
            return pump();
          });
        }
        return pump();
      }).catch(function (e) {
        if (i + 1 < BASES.length && e && !e.status && e.name !== 'AbortError') return attempt(i + 1);
        throw e;
      });
    };
    return attempt(0).then(function (out) {
      clearTimeout(timer);
      var text = String(out.text || '').replace(/<\|(open|sep|close)\|>/g, '').trim();
      var srcs = out.sources || [];
      addSources(srcs);
      return { text: text, sources: srcs };
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

  function webSearch(q, onDelta) {
    var qq = String(q || '').trim();
    if (!qq) return Promise.reject(new Error('缺少问题'));
    if (!kimiToolsEnabled()) return Promise.reject(new Error('Kimi 官方工具开关是关闭的'));
    return kimiSearchStream(qq, onDelta);
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
    return kimiSearchStream(q).then(function (r) {
      var srcLines = r.sources.slice(0, 8).map(function (s, i) {
        return (i + 1) + '. ' + (s.title || '') + ' ' + (s.url || '');
      }).join('\n');
      var txt = r.text || '(搜索完成,但模型没有给出可读内容,请再试一次)';
      return txt + (srcLines ? '\n\n【搜索结果来源】\n' + srcLines : '');
    });
  }, { free: true });

  window.PHAITOOLS = {
    register: register,
    unregister: unregister,
    list: list,
    names: names,
    run: run,
    webSearch: webSearch,
    sources: function () { return sources.slice(); },
    resetSources: function () { sources = []; },
    kimiToolsEnabled: kimiToolsEnabled,
    loadKimiOfficialTools: function () { return Promise.resolve(true); }
  };
})();
