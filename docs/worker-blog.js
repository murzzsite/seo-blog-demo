/**
 * SEO-блог: публикация статей по кнопке клиента (кабинет биржи / Telegram).
 *
 * POST /blog/draft      (Bearer API_KEY) — GitHub Action сайта присылает черновик; клиенту уходит сообщение с кнопками
 * POST /blog/published  (Bearer API_KEY) — уведомление клиенту, что статья вышла
 * callback_query (ap:<id>)               — «Опубликовать» -> status: approved в файле статьи (коммит в GitHub)
 *
 * Для кабинета биржи лидов (server-to-server, Bearer API_KEY):
 * POST /blog/approve         {repo, path}  — клиент нажал «Опубликовать»
 * POST /seo/index            {repo}        — отправить все страницы сайта в Яндекс и Bing (IndexNow)
 *
 * Секрет: GITHUB_TOKEN (PAT с правом Contents: write на репозитории сайтов)
 */

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};
const json = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'Content-Type': 'application/json', ...CORS } });
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const safeJson = async req => { try { return await req.json(); } catch { return null; } };
const rid = () => { const c = 'abcdefghjkmnpqrstuvwxyz23456789'; let s = ''; for (let i = 0; i < 8; i++) s += c[Math.floor(Math.random() * c.length)]; return s; };

const tg = (env, method, payload) => fetch(`https://api.telegram.org/bot${env.BOT_TOKEN}/${method}`, {
  method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload),
});
const say = (env, chat_id, text, html = false) => tg(env, 'sendMessage', { chat_id, text, disable_web_page_preview: true, ...(html ? { parse_mode: 'HTML' } : {}) });
const authOk = (request, env) => !!env.API_KEY && (request.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '') === env.API_KEY;

export async function handleBlogDraft(request, env) {
  if (!authOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await safeJson(request);
  if (!b || !b.ref || !b.repo || !b.path || !b.slug) return json({ error: 'ref, repo, path, slug required' }, 400);
  const client = await env.LEADS_KV.get(`ref:${b.ref}`, 'json');
  if (!client || !client.chat_id) return json({ error: 'Client not activated in bot' }, 412);

  const id = rid();
  await env.LEADS_KV.put(`art:${id}`, JSON.stringify({ ref: b.ref, repo: b.repo, path: b.path, slug: b.slug, title: b.title, chat_id: client.chat_id, client: client.name }), { expirationTtl: 60 * 86400 });

  const text = [
    '📝 <b>Новая статья готова к публикации</b>',
    '',
    `<b>${esc(b.title || b.slug)}</b>`,
    b.description ? esc(b.description) : '',
    b.reading_time ? `⏱ ${esc(b.reading_time)}` : '',
    '',
    'Откройте статью, прочитайте и нажмите «Опубликовать». Она выйдет на сайте по графику: раз в неделю.',
  ].filter((x, i, a) => x !== '' || (a[i - 1] !== '' && i)).join('\n');
  const resp = await tg(env, 'sendMessage', {
    chat_id: client.chat_id, text, parse_mode: 'HTML', disable_web_page_preview: true,
    reply_markup: { inline_keyboard: [
      [{ text: '👁 Открыть статью', url: b.preview_url }],
      [{ text: '✅ Опубликовать', callback_data: `ap:${id}` }],
    ] },
  });
  if (!resp.ok) return json({ error: 'Telegram error', detail: await resp.text() }, 502);
  return json({ ok: true, id });
}

export async function handleBlogPublished(request, env) {
  if (!authOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await safeJson(request);
  if (!b || !b.ref || !b.url) return json({ error: 'ref, url required' }, 400);
  const client = await env.LEADS_KV.get(`ref:${b.ref}`, 'json');
  if (!client || !client.chat_id) return json({ error: 'Client not activated in bot' }, 412);
  await say(env, client.chat_id, `🚀 <b>Статья опубликована</b>\n\n${esc(b.title || '')}\n${esc(b.url)}`, true);
  return json({ ok: true });
}

// Нажатие кнопки под черновиком
export async function handleCallback(cb, env) {
  const chatId = cb.message?.chat?.id;
  const answer = text => tg(env, 'answerCallbackQuery', { callback_query_id: cb.id, text });
  const m = (cb.data || '').match(/^ap:([a-z0-9]+)$/);
  if (!m || !env.LEADS_KV) { await answer('Неизвестное действие'); return new Response('ok'); }
  const rec = await env.LEADS_KV.get(`art:${m[1]}`, 'json');
  if (!rec) { await answer('Ссылка устарела. Запросите статью заново у менеджера.'); return new Response('ok'); }
  if (String(rec.chat_id) !== String(chatId)) { await answer('Нет доступа'); return new Response('ok'); }

  if (!env.GITHUB_TOKEN) { await answer('Сервис публикации не настроен'); return new Response('ok'); }
  const res = await githubSetStatus(env, rec.repo, rec.path, 'approved');
  if (!res.ok) {
    await answer('Не удалось опубликовать. Попробуйте ещё раз чуть позже.');
    return new Response('ok');
  }
  await answer('Готово ✅');
  await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  await say(env, chatId, `✅ Статья «${rec.title}» принята к публикации. Она выйдет на сайте по графику, о публикации пришлём сообщение.`);
  return new Response('ok');
}

const REPO_RE = /^murzzsite\/[\w.-]+$/;

export async function handleApprove(request, env) {
  if (!authOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await safeJson(request);
  if (!b || !REPO_RE.test(b.repo || '') || !/^articles\/[\w.-]+\.md$/.test(b.path || '')) return json({ error: 'repo (murzzsite/*) and path (articles/*.md) required' }, 400);
  if (!env.GITHUB_TOKEN) return json({ error: 'GITHUB_TOKEN not set' }, 500);
  const r = await githubSetStatus(env, b.repo, b.path, 'approved');
  return r.ok ? json({ ok: true, already: !!r.already }) : json({ error: r.error }, 502);
}

// Отправка страниц сайта в поисковики через IndexNow (Яндекс, Bing). Ключ и адрес берутся из blog.config.json репозитория.
export async function handleSeoIndex(request, env) {
  if (!authOk(request, env)) return json({ error: 'Unauthorized' }, 401);
  const b = await safeJson(request);
  if (!b || !REPO_RE.test(b.repo || '')) return json({ error: 'repo (murzzsite/*) required' }, 400);
  const raw = f => fetch(`https://raw.githubusercontent.com/${b.repo}/main/${f}`);
  const cr = await raw('blog.config.json');
  if (!cr.ok) return json({ error: 'blog.config.json not found (блог не установлен)' }, 404);
  const cfg = await cr.json();
  const site = String(cfg.siteUrl || '').replace(/\/+$/, '');
  if (!site || !cfg.indexNowKey) return json({ error: 'siteUrl / indexNowKey missing' }, 400);
  let urls = Array.isArray(b.urls) && b.urls.length ? b.urls : [];
  if (!urls.length) {
    const sm = await fetch(`${site}/sitemap.xml`);
    if (sm.ok) urls = [...(await sm.text()).matchAll(/<loc>([^<]+)<\/loc>/g)].map(m => m[1]);
  }
  urls = urls.filter(u => u.startsWith(site)).slice(0, 500);
  if (!urls.length) return json({ error: 'no urls' }, 400);
  const payload = { host: new URL(site).host, key: cfg.indexNowKey, keyLocation: `${site}/${cfg.indexNowKey}.txt`, urlList: urls };
  const out = {};
  for (const ep of ['https://yandex.com/indexnow', 'https://www.bing.com/indexnow']) {
    try { const r = await fetch(ep, { method: 'POST', headers: { 'Content-Type': 'application/json; charset=utf-8' }, body: JSON.stringify(payload) }); out[new URL(ep).host] = r.status; }
    catch (e) { out[new URL(ep).host] = `error: ${e.message}`; }
  }
  return json({ ok: true, urls: urls.length, results: out });
}

async function githubSetStatus(env, repo, filePath, status) {
  return githubEdit(env, repo, filePath, src => {
    if (!/^status:/m.test(src)) throw new Error('no status field');
    if (new RegExp('^status:\\s*' + status + '\\s*$', 'm').test(src)) return null;
    return src.replace(/^status:.*$/m, `status: ${status}`);
  }, `blog: клиент нажал «Опубликовать» (${filePath})`);
}

// Читает файл из GitHub, применяет transform(src) -> новый текст (или null, если менять не нужно), коммитит.
async function githubEdit(env, repo, filePath, transform, message) {
  const api = `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${String(env.GITHUB_TOKEN).trim()}`, 'User-Agent': 'lead-relay-worker', Accept: 'application/vnd.github+json' };
  const g = await fetch(api, { headers });
  if (!g.ok) return { ok: false, error: `GET ${g.status}` };
  const file = await g.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  let next;
  try { next = transform(new TextDecoder().decode(bytes)); } catch (e) { return { ok: false, error: e.message }; }
  if (next === null) return { ok: true, already: true };
  const out = new TextEncoder().encode(next); let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  const p = await fetch(api, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message, content: btoa(bin), sha: file.sha }) });
  return p.ok ? { ok: true } : { ok: false, error: `PUT ${p.status} ${await p.text()}` };
}
