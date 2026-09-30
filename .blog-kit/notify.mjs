// После build.mjs: шлёт клиенту черновики на согласование, сообщает о публикации, пингует IndexNow.
// Env: BLOG_API_KEY (секрет репозитория), GITHUB_REPOSITORY (задаёт Actions)
import fs from 'node:fs';
import path from 'node:path';

const ROOT = process.cwd();
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'blog.config.json'), 'utf8'));
const report = JSON.parse(fs.readFileSync(path.join(ROOT, '.blog-report.json'), 'utf8'));
const KEY = process.env.BLOG_API_KEY;
const REPO = process.env.GITHUB_REPOSITORY || CFG.repo;
const SITE = CFG.siteUrl.replace(/\/+$/, '');

async function worker(endpoint, payload) {
  if (CFG.telegramNotify !== true) return false; // согласование идёт через кабинет биржи лидов, Telegram-уведомления опциональны
  if (!KEY || !CFG.workerUrl || !CFG.ref) { console.log(`notify: пропуск ${endpoint} (нет BLOG_API_KEY / workerUrl / ref)`); return false; }
  try {
    const r = await fetch(`${CFG.workerUrl}${endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${KEY}` }, body: JSON.stringify({ ref: CFG.ref, repo: REPO, ...payload }) });
    if (!r.ok) console.log(`notify: ${endpoint} -> ${r.status} ${await r.text()}`);
    return r.ok;
  } catch (e) { console.log(`notify: ${endpoint} ошибка ${e.message}`); return false; }
}

function markNotified(rel) {
  const f = path.join(ROOT, rel); let s = fs.readFileSync(f, 'utf8');
  if (/^notified:/m.test(s)) s = s.replace(/^notified:.*$/m, 'notified: true');
  else s = s.replace(/^(---\r?\n[\s\S]*?)(\r?\n---)/, '$1\nnotified: true$2');
  fs.writeFileSync(f, s);
}

for (const d of report.drafts.filter(d => !d.notified)) {
  const ok = await worker('/blog/draft', { path: d.path, slug: d.slug, title: d.title, description: d.description, reading_time: d.reading_time, preview_url: d.preview_url });
  if (ok) { markNotified(d.path); console.log(`notify: черновик отправлен клиенту — ${d.slug}`); }
}

for (const p of report.published) {
  await worker('/blog/published', { title: p.title, url: p.url });
  if (CFG.indexNowKey) {
    const kl = `${SITE}/${CFG.indexNowKey}.txt`;
    for (const host of ['https://yandex.com/indexnow', 'https://www.bing.com/indexnow']) {
      try {
        const r = await fetch(`${host}?url=${encodeURIComponent(p.url)}&key=${CFG.indexNowKey}&keyLocation=${encodeURIComponent(kl)}`);
        console.log(`indexnow ${host} ${p.slug}: ${r.status}`);
      } catch (e) { console.log(`indexnow ${host}: ${e.message}`); }
    }
  }
}
