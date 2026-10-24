/* ============================================================
   PHH Blog · AI 问答（基于博客全文检索 + DeepSeek）
   ------------------------------------------------------------
   流程：问题 -> 本地 Bigram 检索 chat-index.json -> 取相关段落
        -> 作为 system 上下文发给 DeepSeek -> 流式渲染回答
   ============================================================ */
(function () {
  'use strict';

  var ROOT = document.getElementById('ai-chat');
  if (!ROOT) return;
  /* 管理页 / 离线页不显示 */
  if (/^\/(admin|offline)(\/|$)/.test(location.pathname)) return;

  var BASE = ROOT.getAttribute('data-base') || '';
  var CFG_PROXY = (ROOT.getAttribute('data-proxy') || '').trim();

  var LS = {
    key: 'phh_ai_key',
    proxy: 'phh_ai_proxy',
    deep: 'phh_ai_deep',
    hist: 'phh_ai_hist'
  };
  var DEF_ENDPOINT = 'https://api.deepseek.com/chat/completions';

  /* ---------------- localStorage ---------------- */
  function lsGet(k) { try { return localStorage.getItem(k) || ''; } catch (e) { return ''; } }
  function lsSet(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function lsDel(k) { try { localStorage.removeItem(k); } catch (e) {} }

  function cfg() {
    return {
      key: lsGet(LS.key).trim(),
      proxy: lsGet(LS.proxy).trim() || CFG_PROXY
    };
  }
  function ready() { var c = cfg(); return !!(c.key || c.proxy); }

  /* ---------------- DOM ---------------- */
  var $ = function (id) { return document.getElementById(id); };
  var fab = $('ai-fab'), panel = $('ai-panel'), bodyEl = $('ai-body'),
      hello = $('ai-hello'), chipsEl = $('ai-chips'), thread = $('ai-thread'),
      input = $('ai-input'), sendBtn = $('ai-send'), modelBtn = $('ai-model'),
      modelName = $('ai-model-name'), deepBtn = $('ai-deep'), micBtn = $('ai-mic'),
      warn = $('ai-warn'), warnBtn = $('ai-warn-btn'),
      sheetSet = $('ai-sheet-set'), sheetHist = $('ai-sheet-hist'),
      histList = $('ai-hist-list'), keyIn = $('ai-key'), proxyIn = $('ai-proxy');

  /* ---------------- 状态 ---------------- */
  var msgs = [];          // {role, content}
  var busy = false;
  var ctrl = null;
  var lastAsk = '';
  var started = false;

  function deep() { return lsGet(LS.deep) === '1'; }
  function modelId() { return deep() ? 'deepseek-reasoner' : 'deepseek-chat'; }

  /* ---------------- 工具 ---------------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;')
      .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /* 极简 markdown：代码块 / 行内码 / 粗体 / 链接 / 列表 / 换行 */
  function md(src) {
    var blocks = [], inls = [];
    var s = String(src || '');
    s = s.replace(/```([\s\S]*?)```/g, function (_, c) {
      blocks.push('<pre><code>' + esc(c.replace(/^[A-Za-z0-9+#._-]*\r?\n/, '').replace(/\s+$/, '')) + '</code></pre>');
      return '\u0000' + (blocks.length - 1) + '\u0000';
    });
    s = esc(s);
    s = s.replace(/`([^`\n]+)`/g, function (_, c) {
      inls.push('<code>' + c + '</code>');
      return '\u0001' + (inls.length - 1) + '\u0001';
    });
    s = s.replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>');
    s = s.replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+|\/[^)\s]*)\)/g,
      '<a href="$2" target="_blank" rel="noopener">$1</a>');
    s = s.replace(/^\s*[-*]\s+/gm, '· ');
    s = s.replace(/\n/g, '<br>');
    s = s.replace(/\u0001(\d+)\u0001/g, function (_, i) { return inls[+i] || ''; });
    s = s.replace(/\u0000(\d+)\u0000/g, function (_, i) { return blocks[+i] || ''; });
    return s;
  }

  function nearBottom() {
    return bodyEl.scrollHeight - bodyEl.scrollTop - bodyEl.clientHeight < 120;
  }
  function toBottom() { bodyEl.scrollTop = bodyEl.scrollHeight + 999; }

  /* ---------------- 索引 + 检索（BM25 + 标题加权） ---------------- */
  var IDX = null, CHUNKS = null, INV = null, AVGDL = 1, PTITLE = null, SEEN = {}, PCHUNKS = [];

  function tokenize(str) {
    var out = [], seen = {};
    function add(t) { if (t && !seen[t]) { seen[t] = 1; out.push(t); } }
    var lat = String(str).toLowerCase().match(/[a-z][a-z0-9+#._-]{1,}/g) || [];
    lat.forEach(add);
    var segs = String(str).match(/[\u4e00-\u9fff]+/g) || [];
    segs.forEach(function (seg) {
      if (seg.length === 1) { add(seg); return; }
      for (var i = 0; i < seg.length - 1; i++) add(seg.substr(i, 2));
    });
    return out;
  }

  function loadIndex() {
    if (IDX) return Promise.resolve(IDX);
    return fetch((BASE || '') + '/chat-index.json', { cache: 'force-cache' })
      .then(function (r) { if (!r.ok) throw new Error('HTTP ' + r.status); return r.text(); })
      .then(function (txt) {
        var d = JSON.parse(txt);
        if (!d || !d.posts) throw new Error('bad index');
        if (d.about) d.posts.unshift({ t: '关于这个博客', u: '/about/', d: '', g: '', x: d.about });
        IDX = d;
        return d;
      });
  }

  function buildIndex(d) {
    if (CHUNKS) return;
    CHUNKS = []; INV = {}; PTITLE = []; SEEN = {}; PCHUNKS = [];
    var totalLen = 0;

    (d.posts || []).forEach(function (p, pi) {
      PCHUNKS[pi] = [];
      PTITLE[pi] = {};
      tokenize(p.t || '').forEach(function (t) { PTITLE[pi][t] = 1; });

      var heading = '';

      function flush(txt) {
        var t = String(txt).replace(/\s+/g, ' ').trim();
        if (t.length < 10) return;
        if ((t.match(/[{};<>]/g) || []).length > t.length * 0.16) return;
        if (SEEN[t]) return;
        SEEN[t] = 1;
        var toks = tokenize((heading ? heading + ' ' : '') + t);
        if (!toks.length) return;
        var tf = {}, len = 0, i;
        for (i = 0; i < toks.length; i++) { tf[toks[i]] = (tf[toks[i]] || 0) + 1; len++; }
        var id = CHUNKS.length;
        CHUNKS.push({ p: pi, t: t, h: heading, len: len });
        PCHUNKS[pi].push(id);
        totalLen += len;
        for (var k in tf) (INV[k] || (INV[k] = [])).push([id, tf[k]]);
      }

      function pushLine(line) {
        var raw = String(line).replace(/\s+/g, ' ').trim();
        if (!raw) return;
        var buf = '';
        for (var i = 0; i < raw.length; i++) {
          var ch = raw[i];
          buf += ch;
          if (ch === '。' || ch === '！' || ch === '？' || ch === '；' || ch === '!' || ch === '?' || ch === ';' || buf.length >= 300) {
            flush(buf); buf = '';
          }
        }
        flush(buf);
      }

      String(p.x || '').split('\n').forEach(function (line) {
        var idx = line.indexOf('@H@');
        if (idx >= 0) {
          heading = line.slice(0, idx).trim().slice(0, 80);
          var after = line.slice(idx + 3);
          if (after.trim()) pushLine(after);
          return;
        }
        pushLine(line);
      });
    });

    AVGDL = CHUNKS.length ? totalLen / CHUNKS.length : 1;
  }

  function retrieve(d, q) {
    if (!CHUNKS) buildIndex(d);
    var qs = tokenize(q);
    if (!qs.length || !CHUNKS.length) return [];

    var N = CHUNKS.length, k1 = 1.2, b = 0.75;
    var scores = {}, bonus = {}, i, k;

    qs.forEach(function (t) {
      var plist = INV[t];
      if (!plist) return;
      var df = plist.length;
      if (df > N * 0.5) return;
      var idf = Math.log(1 + (N - df + 0.5) / (df + 0.5));
      for (var j = 0; j < plist.length; j++) {
        var id = plist[j][0], tf = plist[j][1], dl = CHUNKS[id].len;
        var denom = tf + k1 * (1 - b + b * dl / AVGDL);
        scores[id] = (scores[id] || 0) + idf * (tf * (k1 + 1)) / denom;
      }
    });

    var posts = d.posts || [];
    var idfCache = {};
    function termIdf(t) {
      if (idfCache[t] !== undefined) return idfCache[t];
      var pl = INV[t], r = 3.0;
      if (pl) { var df = pl.length; r = Math.log(1 + (N - df + 0.5) / (df + 0.5)); }
      idfCache[t] = r; return r;
    }
    for (var pi = 0; pi < posts.length; pi++) {
      var set = PTITLE[pi] || {};
      for (k = 0; k < qs.length; k++) {
        if (set[qs[k]]) bonus[pi] = (bonus[pi] || 0) + termIdf(qs[k]) * 1.6;
      }
    }

    var ranked = Object.keys(scores).map(Number);
    if (!ranked.length) {
      if (/你|本人|作者|自我介绍|这个网站|这个博客|关于/.test(q) && posts[0] && posts[0].t === '关于这个博客') {
        return [{ p: 0, id: -1, title: posts[0].t, url: posts[0].u, date: '', text: String(posts[0].x).slice(0, 300), h: '' }];
      }
      return [];
    }
    ranked.forEach(function (id) {
      var bn = bonus[CHUNKS[id].p];
      if (bn) scores[id] += bn;
    });
    ranked.sort(function (x, y) { return scores[y] - scores[x]; });

    var top = scores[ranked[0]], perPost = {}, hitCount = {}, out = [];
    hitCount[CHUNKS[ranked[0]].p] = 0;
    for (var j = 0; j < ranked.length && out.length < 7; j++) {
      var id2 = ranked[j];
      if (scores[id2] < top * 0.3) break;
      var c = CHUNKS[id2];
      var cap = (out.length === 0) ? 2 : 1;
      if ((perPost[c.p] || 0) >= cap) continue;
      perPost[c.p] = (perPost[c.p] || 0) + 1;
      var pp = posts[c.p] || {};
      out.push({ p: c.p, id: id2, title: pp.t || '', url: pp.u || '', date: pp.d || '', text: c.t, h: c.h || '' });
    }
    return out;
  }

  /* 把命中的文章整理成给模型的正文上下文 */
  function cleanBody(s) {
    return String(s || '')
      .replace(/@H@/g, '\n')
      .replace(/[ \t]+/g, ' ')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function buildContext(d, hits) {
    if (!hits || !hits.length || !d) return '';
    var posts = d.posts || [];
    var out = [], budget = 9000, used = {};

    var mp = posts[hits[0].p] || {};
    var head = '### 《' + (mp.t || '') + '》 ' + (mp.d || '') + ' ' + (mp.u || '');
    var body = cleanBody(mp.x);
    if (body.length <= 7000) {
      out.push(head + '\n' + body);
      budget -= body.length;
    } else {
      var ids = PCHUNKS[hits[0].p] || [];
      var pos = ids.indexOf(hits[0].id);
      if (pos < 0) pos = 0;
      var lo = Math.max(0, pos - 2), hi = Math.min(ids.length - 1, pos + 2);
      var seg = [];
      for (var j = lo; j <= hi; j++) {
        var c = CHUNKS[ids[j]];
        seg.push((c.h ? '【' + c.h + '】' : '') + c.t);
      }
      var block = head + '\n' + seg.join('\n');
      out.push(block);
      budget -= block.length;
    }
    used[hits[0].p] = 1;

    for (var i = 1; i < hits.length && out.length < 6 && budget > 300; i++) {
      var h = hits[i];
      if (used[h.p]) continue;
      var pp = posts[h.p] || {};
      var line = '### 《' + (pp.t || '') + '》 ' + (pp.d || '') + ' ' + (pp.u || '') + '\n' +
        (h.h ? '【' + h.h + '】' : '') + h.text;
      out.push(line);
      budget -= line.length;
      used[h.p] = 1;
    }
    return out.join('\n\n');
  }

  /* ---------------- Prompt ---------------- */
  function sysPrompt(hits) {
    var s = [];
    s.push('你是「庞和合」本人的 AI 分身,是个人博客 panghehe666.github.io 的问答助手。');
    s.push('身份:庞和合,网名 PHH,高三学生,喜欢折腾、热爱数码,在博客里写科技和数码的内容。');
    s.push('说话方式:中文口语,第一人称,简洁直接,像在微信里聊天。');
    s.push('');
    s.push('你的资料由两部分组成:【博客文章列表】(全部标题)和【博客正文】([]里是真实正文,不是标题摘要)。');
    s.push('');
    s.push('规则:');
    s.push('1. 【博客正文】里给的是文章真实正文(可能带【小节标题】),可以放心引用里面的结论、数据、原话、章节名。');
    s.push('2. 正文覆盖到的问题,直接按正文回答,别再说"我只看到标题""内容不在资料里"。');
    s.push('3. 正文里确实找不到的部分,就说"这篇里那段我没拿到,你可以点进去看原文",并给出文章链接。');
    s.push('4. 整篇博客都没写过的,先直说"这个我博客里没写过",再用一两句常识补充,并说明那不是博客内容。');
    s.push('5. 不要编造标题、日期、链接、数据;正文里没有的细节一律不加。');
    s.push('6. 指向文章时用 markdown 链接:[文章标题](链接),链接只能来自下面出现的 URL。');
    s.push('7. 一般回答 2~5 句;问细节时可以展开。不要说"作为 AI""根据提供的资料"。');
    s.push('8. 不知道就说不知道。');

    if (IDX && IDX.posts && IDX.posts.length) {
      s.push('');
      s.push('【博客文章列表】');
      IDX.posts.forEach(function (p) {
        s.push('- 《' + p.t + '》 ' + (p.d || '') + ' ' + (p.u || ''));
      });
    }

    var ctx = buildContext(IDX, hits);
    s.push('');
    if (ctx) {
      s.push('【博客正文】');
      s.push(ctx);
    } else {
      s.push('【博客正文】(这次没有检索到相关正文,只能靠文章列表回答)');
    }
    return s.join('\n');
  }

  /* ---------------- 渲染 ---------------- */
  function hideHello() {
    if (hello && hello.parentNode) hello.parentNode.removeChild(hello);
    hello = null;
  }

  function addUser(text) {
    var d = document.createElement('div');
    d.className = 'ai-u';
    d.textContent = text;
    thread.appendChild(d);
    toBottom();
  }

  function addAssistant() {
    var d = document.createElement('div');
    d.className = 'ai-a';
    d.innerHTML = '<div class="ai-dots"><i></i><i></i><i></i></div>';
    thread.appendChild(d);
    toBottom();
    return d;
  }

  function render(node, text, reason, hits, done) {
    var html = '';
    if (reason) html += '<div class="ai-reason">' + md(reason) + '</div>';
    if (text) html += '<div class="ai-txt">' + md(text) + '</div>';
    else if (!reason) html = '<div class="ai-dots"><i></i><i></i><i></i></div>';
    if (done && hits && hits.length) {
      var seen = {}, links = [];
      hits.forEach(function (h) {
        if (!h.url || seen[h.url] || links.length >= 3) return;
        seen[h.url] = 1;
        links.push('<a href="' + esc(h.url) + '">' + esc(h.title) + '</a>');
      });
      if (links.length) html += '<div class="ai-src">参考:' + links.join(' · ') + '</div>';
    }
    var stick = nearBottom();
    node.innerHTML = html;
    if (stick) toBottom();
  }

  function renderError(node, msg, retryText) {
    node.innerHTML = '<div class="ai-err">' + esc(msg) + '</div>' +
      (retryText ? '<div class="ai-act"><button type="button" data-retry="1">重试</button></div>' : '');
    if (retryText) {
      node.querySelector('[data-retry]').addEventListener('click', function () {
        node.parentNode && node.parentNode.removeChild(node);
        ask(retryText);
      });
    }
    toBottom();
  }

  /* ---------------- 请求 ---------------- */
  function endpoint() { var c = cfg(); return c.proxy || DEF_ENDPOINT; }

  function headers() {
    var c = cfg(), h = { 'Content-Type': 'application/json' };
    if (!c.proxy && c.key) h['Authorization'] = 'Bearer ' + c.key;
    return h;
  }

  function stream(payload, onDelta, onReason, signal) {
    return fetch(endpoint(), {
      method: 'POST',
      headers: headers(),
      body: JSON.stringify(payload),
      signal: signal
    }).then(function (res) {
      if (!res.ok) {
        return res.text().then(function (t) {
          var e = new Error('HTTP ' + res.status);
          e.status = res.status;
          e.body = t;
          throw e;
        });
      }
      var ct = (res.headers.get('content-type') || '');
      if (ct.indexOf('text/event-stream') < 0) {
        return res.json().then(function (j) {
          var ch = j.choices && j.choices[0];
          if (!ch) throw new Error((j.error && j.error.message) || '接口返回异常');
          var m = ch.message || {};
          if (m.reasoning_content && onReason) onReason(m.reasoning_content);
          if (m.content) onDelta(m.content);
        });
      }
      var reader = res.body.getReader(), dec = new TextDecoder(), buf = '';
      function pump() {
        return reader.read().then(function (r) {
          if (r.done) return;
          buf += dec.decode(r.value, { stream: true });
          buf = buf.replace(/\r\n/g, '\n');
          var parts = buf.split('\n\n');
          buf = parts.pop();
          for (var i = 0; i < parts.length; i++) {
            var lines = parts[i].split('\n');
            for (var k = 0; k < lines.length; k++) {
              var ln = lines[k];
              if (ln.indexOf('data:') !== 0) continue;
              var d = ln.slice(5).trim();
              if (!d || d === '[DONE]') continue;
              var o;
              try { o = JSON.parse(d); } catch (e) { continue; }
              if (o.error) throw new Error(o.error.message || '接口报错');
              var ch = o.choices && o.choices[0];
              if (!ch) continue;
              var dl = ch.delta || {};
              if (dl.reasoning_content && onReason) onReason(dl.reasoning_content);
              if (dl.content) onDelta(dl.content);
            }
          }
          return pump();
        });
      }
      return pump();
    });
  }

  function errText(e) {
    if (!e) return '出错了';
    if (e.name === 'AbortError') return '';
    if (e.status === 401) return 'Key 不对(401)。设置里检查一下 API Key。';
    if (e.status === 402) return 'DeepSeek 账户余额不足(402),充点钱再来。';
    if (e.status === 422) return '请求参数有问题(422)。' + (e.body || '').slice(0, 120);
    if (e.status === 429) return '请求太频繁(429),歇几秒再问。';
    if (e.status === 400) return '请求被拒(400)。' + (e.body || '').slice(0, 160);
    if (e.status >= 500) return 'DeepSeek 那边打嗝了(HTTP ' + e.status + '),等会儿再试。';
    if (/Failed to fetch|NetworkError|Load failed|network/i.test(e.message || '')) return '网络不通。检查网络,或确认代理地址可用。';
    return '出错了:' + (e.message || e);
  }

  /* ---------------- 主流程 ---------------- */
  function ask(text) {
    text = String(text || '').trim();
    if (!text || busy) return;

    if (!ready()) {
      warn.classList.add('on');
      openSheet(sheetSet);
      return;
    }

    hideHello();
    addUser(text);
    var node = addAssistant();
    lastAsk = text;
    busy = true;
    updateSend();
    ctrl = window.AbortController ? new AbortController() : null;

    var history = msgs.slice(-6);

    loadIndex().then(function (d) { return d; }, function () { return null; })
      .then(function (d) {
        var hits = [];
        if (d) { try { hits = retrieve(d, text); } catch (e) { hits = []; } }
        var messages = [{ role: 'system', content: sysPrompt(hits) }]
          .concat(history)
          .concat([{ role: 'user', content: text }]);

        var payload = { model: modelId(), messages: messages, stream: true, max_tokens: 1200 };
        if (!deep()) payload.temperature = 1.0;

        var acc = '', rea = '';
        return stream(payload,
          function (delta) { acc += delta; render(node, acc, rea, hits, false); },
          function (r) { rea += r; render(node, acc, rea, hits, false); },
          ctrl ? ctrl.signal : undefined
        ).then(function () {
          if (!acc && !rea) acc = '(没有返回内容)';
          render(node, acc, rea, hits, true);
          msgs.push({ role: 'user', content: text });
          msgs.push({ role: 'assistant', content: acc || '(空)' });
          if (msgs.length > 10) msgs = msgs.slice(-10);
          saveHist(text, acc);
        });
      })
      .catch(function (e) {
        var m = errText(e);
        if (m) renderError(node, m, text);
        else render(node, '', '', [], true);
      })
      .then(function () {
        busy = false;
        ctrl = null;
        updateSend();
      });
  }

  function updateSend() {
    if (busy) { sendBtn.classList.remove('ready'); sendBtn.classList.add('stop'); }
    else {
      sendBtn.classList.remove('stop');
      sendBtn.classList.toggle('ready', !!input.value.trim());
    }
  }

  function stopStream() {
    if (ctrl) { try { ctrl.abort(); } catch (e) {} }
    busy = false;
    ctrl = null;
    updateSend();
  }

  /* ---------------- 历史记录 ---------------- */
  function getHist() {
    try { return JSON.parse(lsGet(LS.hist) || '[]') || []; } catch (e) { return []; }
  }
  function saveHist(q, a) {
    if (!a) return;
    var h = getHist();
    h.unshift({ q: q.slice(0, 80), a: a, t: Date.now() });
    lsSet(LS.hist, JSON.stringify(h.slice(0, 24)));
  }
  function renderHist() {
    var h = getHist();
    if (!h.length) { histList.innerHTML = '<div class="ai-empty">还没有历史记录</div>'; return; }
    histList.innerHTML = '';
    h.forEach(function (it) {
      var b = document.createElement('button');
      b.type = 'button';
      b.className = 'ai-hist-item';
      var d = new Date(it.t);
      b.innerHTML = '<span class="q">' + esc(it.q) + '</span><span class="t">' +
        d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' +
        pad(d.getHours()) + ':' + pad(d.getMinutes()) + '</span>';
      b.addEventListener('click', function () {
        hideHello();
        thread.innerHTML = '';
        msgs = [];
        addUser(it.q);
        var node = addAssistant();
        node.innerHTML = '<div class="ai-txt">' + md(it.a) + '</div>';
        msgs.push({ role: 'user', content: it.q }, { role: 'assistant', content: it.a });
        toBottom();
        closeSheets();
      });
      histList.appendChild(b);
    });
  }
  function pad(n) { return (n < 10 ? '0' : '') + n; }

  /* ---------------- 面板开关 ---------------- */
  function open() {
    ROOT.classList.add('open');
    lsSet('phh_ai_opened', '1');
    warn.classList.toggle('on', !ready());
    setTimeout(function () { if (window.innerWidth > 600) input.focus(); }, 240);
    toBottom();
  }
  function close() {
    ROOT.classList.remove('open');
    closeSheets();
    try { input.blur(); } catch (e) {}
  }
  function openSheet(el) {
    [sheetSet, sheetHist].forEach(function (s) { s.classList.toggle('on', s === el); });
    if (el === sheetSet) {
      keyIn.value = lsGet(LS.key);
      proxyIn.value = lsGet(LS.proxy) || CFG_PROXY;
    }
    if (el === sheetHist) renderHist();
  }
  function closeSheets() {
    [sheetSet, sheetHist].forEach(function (s) { s.classList.remove('on'); });
  }

  /* ---------------- 快捷提问 ---------------- */
  var CHIPS = [
    '这个博客都写些什么?',
    '安卓手机上怎么玩 DeepSeek Harness?',
    'Token 怎么才能用得久一点?',
    '你为什么会开始写博客?'
  ];
  CHIPS.forEach(function (t) {
    var b = document.createElement('button');
    b.type = 'button';
    b.className = 'ai-chip';
    b.textContent = t;
    b.addEventListener('click', function () { ask(t); });
    chipsEl.appendChild(b);
  });

  /* ---------------- 事件 ---------------- */
  fab.addEventListener('click', open);
  $('ai-close').addEventListener('click', close);
  $('ai-set').addEventListener('click', function () { openSheet(sheetSet); });
  $('ai-hist').addEventListener('click', function () { openSheet(sheetHist); });
  Array.prototype.forEach.call(document.querySelectorAll('.ai-sheet-close'), function (b) {
    b.addEventListener('click', closeSheets);
  });
  warnBtn.addEventListener('click', function () { openSheet(sheetSet); });

  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && ROOT.classList.contains('open')) {
      if (sheetSet.classList.contains('on') || sheetHist.classList.contains('on')) closeSheets();
      else close();
    }
  });

  sendBtn.addEventListener('click', function () {
    if (busy) { stopStream(); return; }
    var v = input.value.trim();
    if (!v) return;
    input.value = '';
    autosize();
    updateSend();
    ask(v);
  });

  input.addEventListener('input', function () { autosize(); updateSend(); });
  input.addEventListener('keydown', function (e) {
    if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
      e.preventDefault();
      sendBtn.click();
    }
  });

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(input.scrollHeight, 112) + 'px';
  }

  /* 模型切换 */
  modelBtn.addEventListener('click', function () {
    var next = !deep();
    lsSet(LS.deep, next ? '1' : '0');
    syncModel();
  });
  deepBtn.addEventListener('click', function () {
    lsSet(LS.deep, deep() ? '0' : '1');
    syncModel();
  });
  function syncModel() {
    var d = deep();
    modelName.textContent = d ? 'DeepSeek Reasoner' : 'DeepSeek Chat';
    deepBtn.classList.toggle('on', d);
  }

  /* 设置 */
  $('ai-save').addEventListener('click', function () {
    lsSet(LS.key, keyIn.value.trim());
    lsSet(LS.proxy, proxyIn.value.trim());
    warn.classList.toggle('on', !ready());
    closeSheets();
  });
  $('ai-clear').addEventListener('click', function () {
    lsDel(LS.key); lsDel(LS.proxy);
    keyIn.value = ''; proxyIn.value = CFG_PROXY;
    warn.classList.add('on');
  });

  /* 历史清空 */
  $('ai-hist-clear').addEventListener('click', function () {
    lsDel(LS.hist);
    renderHist();
  });

  /* 语音输入 */
  var SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (SR) {
    micBtn.classList.add('avail');
    var rec = null, recording = false;
    micBtn.addEventListener('click', function () {
      if (recording) { try { rec.stop(); } catch (e) {} return; }
      try {
        rec = new SR();
        rec.lang = 'zh-CN';
        rec.interimResults = true;
        rec.continuous = false;
        rec.onresult = function (ev) {
          var t = '';
          for (var i = ev.resultIndex; i < ev.results.length; i++) t += ev.results[i][0].transcript;
          input.value = t;
          autosize(); updateSend();
        };
        rec.onend = function () { recording = false; micBtn.classList.remove('rec'); };
        rec.onerror = function () { recording = false; micBtn.classList.remove('rec'); };
        rec.start();
        recording = true;
        micBtn.classList.add('rec');
      } catch (e) {}
    });
  }

  var scrim = document.getElementById('ai-scrim');
  if (scrim) scrim.addEventListener('click', close);

  /* 初始化 */
  if (document.querySelector('.cal-fab')) ROOT.classList.add('has-cal');
  syncModel();
  updateSend();
  warn.classList.toggle('on', !ready());
})();
