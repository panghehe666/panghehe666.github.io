/**
 * DeepSeek 代理 —— Cloudflare Worker
 * ------------------------------------------------------------
 * 作用:把 DeepSeek 的 API Key 藏在服务端,访客在前端直接聊,
 *      不用自己带 Key,也不会把 Key 暴露在公开仓库里。
 *
 * 部署(手机 / 电脑都行,约 3 分钟):
 *   1. https://dash.cloudflare.com → Workers & Pages → Create → Worker
 *   2. 把本文件全文粘进编辑器,Deploy
 *   3. Settings → Variables and Secrets 添加 Secret:
 *        名称:DEEPSEEK_API_KEY   值:sk-你的key
 *        可选:ALLOW_ORIGIN      值:https://panghehe666.github.io
 *   4. 拿到形如 https://dsh-chat.你的名字.workers.dev 的地址,
 *      填到博客 js/ai-chat.js 设置页的「代理地址」,
 *      或写进 _config.yml 的 ai_chat_proxy(所有人免填)。
 *
 * 注意:免费额度每天 10 万次请求,个人博客够用。
 *      建议同时把 max_tokens 和模型白名单卡住,防止被人白嫖。
 */

const ALLOWED_MODELS = ['deepseek-chat', 'deepseek-reasoner'];
const MAX_TOKENS = 1500;

export default {
  async fetch(request, env) {
    const origin = env.ALLOW_ORIGIN || 'https://panghehe666.github.io';
    const cors = {
      'Access-Control-Allow-Origin': origin,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'content-type, authorization',
      'Access-Control-Max-Age': '86400',
      Vary: 'Origin',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: cors });
    }
    if (request.method !== 'POST') {
      return json({ error: 'method not allowed' }, 405, cors);
    }
    if (!env.DEEPSEEK_API_KEY) {
      return json({ error: 'worker missing DEEPSEEK_API_KEY' }, 500, cors);
    }

    let body;
    try {
      body = await request.json();
    } catch (e) {
      return json({ error: 'invalid json' }, 400, cors);
    }

    // 只放行白名单模型,并限制输出长度,防止被刷
    if (!ALLOWED_MODELS.includes(body.model)) body.model = 'deepseek-chat';
    body.stream = true;
    body.max_tokens = Math.min(Number(body.max_tokens) || MAX_TOKENS, MAX_TOKENS);
    delete body.n;

    const upstream = await fetch('https://api.deepseek.com/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.DEEPSEEK_API_KEY,
      },
      body: JSON.stringify(body),
    });

    const headers = {
      ...cors,
      'Content-Type': upstream.headers.get('content-type') || 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    };
    return new Response(upstream.body, { status: upstream.status, headers });
  },
};

function json(obj, status, cors) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { ...cors, 'Content-Type': 'application/json' },
  });
}
