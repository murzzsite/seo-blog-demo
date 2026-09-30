/**
 * SEO-блог: согласование статей клиентом в Telegram.
 *
 * POST /blog/draft      (Bearer API_KEY) — GitHub Action сайта присылает черновик; клиенту уходит сообщение с кнопками
 * POST /blog/published  (Bearer API_KEY) — уведомление клиенту, что статья вышла
 * callback_query (ap:<id> / rv:<id>)     — «Опубликовать» -> status: approved в файле статьи (коммит в GitHub),
 *                                          «Правки» -> следующее сообщение клиента пересылается менеджеру
 *
 * Секреты: GITHUB_TOKEN (PAT с правом Contents: write на репозитории сайтов), MANAGER_CHAT_ID (необязательно)
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
    '📝 <b>Новая статья на согласование</b>',
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
      [{ text: '✅ Опубликовать', callback_data: `ap:${id}` }, { text: '✏️ Правки', callback_data: `rv:${id}` }],
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
  const m = (cb.data || '').match(/^(ap|rv):([a-z0-9]+)$/);
  if (!m || !env.LEADS_KV) { await answer('Неизвестное действие'); return new Response('ok'); }
  const rec = await env.LEADS_KV.get(`art:${m[2]}`, 'json');
  if (!rec) { await answer('Ссылка устарела. Запросите статью заново у менеджера.'); return new Response('ok'); }
  if (String(rec.chat_id) !== String(chatId)) { await answer('Нет доступа'); return new Response('ok'); }

  if (m[1] === 'rv') {
    await env.LEADS_KV.put(`rev:${chatId}`, JSON.stringify(rec), { expirationTtl: 86400 });
    await answer('Напишите правки одним сообщением');
    await say(env, chatId, `✏️ Напишите одним сообщением, что поправить в статье «${rec.title}». Мы внесём изменения и пришлём её заново.`);
    return new Response('ok');
  }

  if (!env.GITHUB_TOKEN) { await answer('Сервис публикации не настроен'); return new Response('ok'); }
  const res = await githubSetStatus(env, rec.repo, rec.path, 'approved');
  if (!res.ok) {
    await answer('Не удалось согласовать. Менеджер уже уведомлён.');
    if (env.MANAGER_CHAT_ID) await say(env, env.MANAGER_CHAT_ID, `⚠️ Ошибка согласования ${rec.repo}/${rec.path}: ${res.error}`);
    return new Response('ok');
  }
  await answer('Согласовано ✅');
  await tg(env, 'editMessageReplyMarkup', { chat_id: chatId, message_id: cb.message.message_id, reply_markup: { inline_keyboard: [] } });
  await say(env, chatId, `✅ Статья «${rec.title}» согласована. Она выйдет на сайте по графику, о публикации пришлём сообщение.`);
  return new Response('ok');
}

// Текст после кнопки «Правки» -> менеджеру. Возвращает true, если сообщение обработано.
export async function handleRevisionText(msg, env) {
  const text = msg.text || '';
  if (!text || text.startsWith('/') || !env.LEADS_KV) return false;
  const chatId = msg.chat.id;
  const pend = await env.LEADS_KV.get(`rev:${chatId}`, 'json');
  if (!pend) return false;
  await env.LEADS_KV.delete(`rev:${chatId}`);
  if (env.MANAGER_CHAT_ID) {
    await say(env, env.MANAGER_CHAT_ID, `✏️ <b>Правки к статье</b> «${esc(pend.title)}»\nКлиент: ${esc(pend.client || '')}\nРепозиторий: ${esc(pend.repo)}\nФайл: ${esc(pend.path)}\n\n${esc(text)}`, true);
  }
  await say(env, chatId, '👌 Приняли. Внесём правки и пришлём статью на повторное согласование.');
  return true;
}

async function githubSetStatus(env, repo, filePath, status) {
  const api = `https://api.github.com/repos/${repo}/contents/${filePath.split('/').map(encodeURIComponent).join('/')}`;
  const headers = { Authorization: `Bearer ${env.GITHUB_TOKEN}`, 'User-Agent': 'lead-relay-worker', Accept: 'application/vnd.github+json' };
  const g = await fetch(api, { headers });
  if (!g.ok) return { ok: false, error: `GET ${g.status}` };
  const file = await g.json();
  const bytes = Uint8Array.from(atob(file.content.replace(/\n/g, '')), c => c.charCodeAt(0));
  let src = new TextDecoder().decode(bytes);
  if (!/^status:/m.test(src)) return { ok: false, error: 'no status field' };
  if (new RegExp('^status:\\s*' + status + '\\s*$', 'm').test(src)) return { ok: true, already: true };
  src = src.replace(/^status:.*$/m, `status: ${status}`);
  const out = new TextEncoder().encode(src); let bin = '';
  for (let i = 0; i < out.length; i += 0x8000) bin += String.fromCharCode(...out.subarray(i, i + 0x8000));
  const p = await fetch(api, { method: 'PUT', headers: { ...headers, 'Content-Type': 'application/json' }, body: JSON.stringify({ message: `blog: клиент согласовал статью (${filePath})`, content: btoa(bin), sha: file.sha }) });
  return p.ok ? { ok: true } : { ok: false, error: `PUT ${p.status} ${await p.text()}` };
}
