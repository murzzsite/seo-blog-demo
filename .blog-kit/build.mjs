// SEO-блог для статичного сайта: articles/*.md -> blog/*.html, sitemap.xml, feed.xml, блок на главной.
// Без зависимостей. Запуск: node .blog-kit/build.mjs   (из корня репозитория сайта)
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const ROOT = process.cwd();
const CFG = JSON.parse(fs.readFileSync(path.join(ROOT, 'blog.config.json'), 'utf8'));
const SITE = CFG.siteUrl.replace(/\/+$/, '');
const BASE = new URL(SITE).pathname.replace(/\/+$/, ''); // '' для своего домена, '/repo' для github.io
const CADENCE = CFG.cadenceDays ?? 7;
const HOME_LATEST = CFG.homeLatest ?? 3;
const GATE = CFG.designApproved === false; // оформление блога ещё не согласовано клиентом: блог скрыт, доступен только предпросмотр

const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const nowMsk = new Date(Date.now() + 3 * 3600e3);
const TODAY = nowMsk.toISOString().slice(0, 10);
const addDays = (d, n) => new Date(Date.parse(d + 'T00:00:00Z') + n * 864e5).toISOString().slice(0, 10);
const RU_MONTHS = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
const ruDate = d => { const [y, m, dd] = d.split('-').map(Number); return `${dd} ${RU_MONTHS[m - 1]} ${y}`; };

// ---------- frontmatter ----------
const unq = v => (/^".*"$/.test(v) || /^'.*'$/.test(v)) ? v.slice(1, -1).replace(/\\"/g, '"') : v;
const val = v => {
  v = v.trim();
  if (v === '') return '';
  if (v.startsWith('[') && v.endsWith(']')) return v.slice(1, -1).split(',').map(x => unq(x.trim())).filter(Boolean);
  if (v === 'true') return true;
  if (v === 'false') return false;
  return unq(v);
};
function parseFm(src) {
  const m = src.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
  if (!m) return { fm: {}, body: src };
  const fm = {}; const lines = m[1].split(/\r?\n/);
  for (let i = 0; i < lines.length; i++) {
    const kv = lines[i].match(/^([A-Za-z_][\w-]*):\s*(.*)$/);
    if (!kv) continue;
    const [, k, rest] = kv;
    if (rest.trim() === '' && /^\s+-\s/.test(lines[i + 1] || '')) { // блок-список (faq)
      const arr = []; let cur = null;
      while (i + 1 < lines.length && /^\s+(-\s|\w)/.test(lines[i + 1])) {
        i++; const l = lines[i];
        const item = l.match(/^\s+-\s+(?:([\w-]+):\s*(.*))?$/);
        if (item) { cur = {}; arr.push(cur); if (item[1]) cur[item[1]] = val(item[2]); continue; }
        const f = l.match(/^\s+([\w-]+):\s*(.*)$/);
        if (f && cur) cur[f[1]] = val(f[2]);
      }
      fm[k] = arr;
    } else fm[k] = val(rest);
  }
  return { fm, body: m[2] };
}
function setFm(file, key, value) {
  let src = fs.readFileSync(file, 'utf8');
  const plainVal = typeof value === 'boolean' || /^[\w-]+$/.test(String(value));
  const line = `${key}: ${plainVal ? value : JSON.stringify(value)}`;
  const head = src.match(/^---\r?\n([\s\S]*?)\r?\n---/);
  if (!head) return;
  const re = new RegExp(`^${key}:.*$`, 'm');
  const nextHead = re.test(head[1]) ? head[0].replace(re, line) : head[0].replace(/\r?\n---$/, `\n${line}\n---`);
  fs.writeFileSync(file, src.replace(head[0], () => nextHead));
}

// ---------- markdown ----------
const TR = { а:'a',б:'b',в:'v',г:'g',д:'d',е:'e',ё:'e',ж:'zh',з:'z',и:'i',й:'y',к:'k',л:'l',м:'m',н:'n',о:'o',п:'p',р:'r',с:'s',т:'t',у:'u',ф:'f',х:'h',ц:'c',ч:'ch',ш:'sh',щ:'sch',ъ:'',ы:'y',ь:'',э:'e',ю:'yu',я:'ya' };
const slugify = s => s.toLowerCase().replace(/[а-яё]/g, c => TR[c] ?? '').replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'section';
const fixUrl = u => {
  if (/^(https?:|mailto:|tel:|#|data:)/i.test(u)) return u;
  if (u.startsWith('/')) return BASE + u;
  return BASE + '/' + u;
};
function inline(raw) {
  const codes = [];
  let s = raw.replace(/`([^`]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
  s = esc(s);
  s = s.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, a, u) => `<img src="${esc(fixUrl(u.replace(/&amp;/g, '&')))}" alt="${a}" loading="lazy">`);
  s = s.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, u) => {
    u = u.replace(/&amp;/g, '&'); const ext = /^https?:/i.test(u) && !u.startsWith(SITE);
    return `<a href="${esc(fixUrl(u))}"${ext ? ' target="_blank" rel="noopener"' : ''}>${t}</a>`;
  });
  s = s.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>').replace(/(^|[\s(])\*([^*\s][^*]*)\*/g, '$1<em>$2</em>');
  return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[i])}</code>`);
}
function md(src) {
  const lines = src.replace(/\r/g, '').split('\n'); const out = []; const toc = [];
  let i = 0; const used = new Set();
  const isBlank = l => /^\s*$/.test(l);
  const isUl = /^\s*[-*+]\s+/; const isOl = /^\s*\d+[.)]\s+/;
  while (i < lines.length) {
    const l = lines[i];
    if (isBlank(l)) { i++; continue; }
    let m;
    if ((m = l.match(/^(#{2,4})\s+(.+?)\s*#*$/))) {
      const lvl = m[1].length; let id = slugify(m[2]); while (used.has(id)) id += '-2'; used.add(id);
      if (lvl === 2) toc.push({ id, text: m[2].replace(/[*_`]/g, '') });
      out.push(`<h${lvl} id="${id}">${inline(m[2])}</h${lvl}>`); i++; continue;
    }
    if (/^(-{3,}|\*{3,})\s*$/.test(l)) { out.push('<hr>'); i++; continue; }
    if (/^</.test(l)) { const buf = []; while (i < lines.length && !isBlank(lines[i])) buf.push(lines[i++]); out.push(buf.join('\n')); continue; }
    if (/^```/.test(l)) { const buf = []; i++; while (i < lines.length && !/^```/.test(lines[i])) buf.push(lines[i++]); i++; out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`); continue; }
    if (/^>\s?/.test(l)) { const buf = []; while (i < lines.length && /^>\s?/.test(lines[i])) buf.push(lines[i++].replace(/^>\s?/, '')); out.push(`<blockquote>${md(buf.join('\n')).html}</blockquote>`); continue; }
    if (/^\|.+\|\s*$/.test(l) && /^\|?\s*:?-{2,}/.test(lines[i + 1] || '')) {
      const row = r => r.trim().replace(/^\||\|$/g, '').split('|').map(c => c.trim());
      const head = row(l); i += 2; const rows = [];
      while (i < lines.length && /^\|.+\|\s*$/.test(lines[i])) rows.push(row(lines[i++]));
      out.push(`<div class="b-table"><table><thead><tr>${head.map(c => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>${rows.map(r => `<tr>${r.map(c => `<td>${inline(c)}</td>`).join('')}</tr>`).join('')}</tbody></table></div>`);
      continue;
    }
    if (isUl.test(l) || isOl.test(l)) {
      const ord = isOl.test(l); const rx = ord ? isOl : isUl; const items = [];
      while (i < lines.length && rx.test(lines[i])) items.push(lines[i++].replace(rx, ''));
      const tag = ord ? 'ol' : 'ul';
      out.push(`<${tag}>${items.map(t => `<li>${inline(t)}</li>`).join('')}</${tag}>`); continue;
    }
    const buf = [];
    while (i < lines.length && !isBlank(lines[i]) && !/^(#{2,4}\s|>|```|\|.+\||<)/.test(lines[i]) && !isUl.test(lines[i]) && !isOl.test(lines[i])) buf.push(lines[i++]);
    if (!buf.length) buf.push(lines[i++]);
    out.push(`<p>${inline(buf.join(' '))}</p>`);
  }
  return { html: out.join('\n'), toc };
}
const plain = html => html.replace(/<[^>]+>/g, ' ').replace(/&\w+;/g, ' ').replace(/\s+/g, ' ').trim();

// ---------- site chrome (из index.html) ----------
let indexHtml, headerHtml, footerHtml, metrika, headLinks, themeColor, hasScript;
const rewrite = html => html.replace(/(\s(?:href|src))="([^"]*)"/g, (_, a, u) => `${a}="${/^(https?:|\/\/|mailto:|tel:|data:|javascript:)/i.test(u) ? u : u.startsWith('#') ? BASE + '/' + u : fixUrl(u)}"`);
function loadChrome() {
  indexHtml = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const grab = re => { const m = indexHtml.match(re); return m ? rewrite(m[0]) : ''; };
  headerHtml = grab(/<header[\s\S]*?<\/header>/i);
  footerHtml = grab(/<footer[\s\S]*?<\/footer>/i);
  metrika = (indexHtml.match(/<!--\s*Yandex\.Metrika counter\s*-->[\s\S]*?<!--\s*\/Yandex\.Metrika counter\s*-->/i) || [''])[0];
  headLinks = (indexHtml.match(/<head>([\s\S]*?)<\/head>/i)?.[1].match(/<link[^>]+>/gi) || [])
    .filter(t => /rel="(icon|preconnect|stylesheet|apple-touch-icon)"/.test(t)).map(rewrite).join('\n');
  themeColor = (indexHtml.match(/<meta name="theme-color"[^>]*>/i) || [''])[0];
  hasScript = /<script[^>]+src="script\.js"/.test(indexHtml);
}
loadChrome();
const theme = CFG.theme || {};

function page({ title, description, canonical, robots, ogImage, ogType = 'website', body, jsonld = [], bodyClass = '' }) {
  return `<!DOCTYPE html>
<html lang="${CFG.lang || 'ru'}">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>${esc(title)}</title>
<meta name="description" content="${esc(description)}">
<link rel="canonical" href="${canonical}">
<meta name="robots" content="${CFG.noindex ? 'noindex, nofollow' : (robots || 'index, follow, max-image-preview:large')}">
<meta property="og:type" content="${ogType}">
<meta property="og:title" content="${esc(title)}">
<meta property="og:description" content="${esc(description)}">
<meta property="og:url" content="${canonical}">
<meta property="og:locale" content="ru_RU">
${ogImage ? `<meta property="og:image" content="${ogImage}">` : ''}
<link rel="alternate" type="application/rss+xml" title="${esc(CFG.siteName)} — блог" href="${SITE}/feed.xml">
${themeColor}
${headLinks}
<link rel="stylesheet" href="${BASE}/blog/blog.css">
${jsonld.map(j => `<script type="application/ld+json">${JSON.stringify(j)}</script>`).join('\n')}
</head>
<body class="${bodyClass}">
${headerHtml}
<main class="blog">
${body}
</main>
${footerHtml}
${hasScript ? `<script src="${BASE}/script.js" defer></script>` : ''}
${metrika}
</body>
</html>`;
}

// ---------- load articles ----------
const ART_DIR = path.join(ROOT, 'articles');
const files = fs.existsSync(ART_DIR) ? fs.readdirSync(ART_DIR).filter(f => f.endsWith('.md') && !f.startsWith('_') && f.toLowerCase() !== 'readme.md') : [];
const arts = files.map(f => {
  const file = path.join(ART_DIR, f); const { fm, body } = parseFm(fs.readFileSync(file, 'utf8'));
  const slug = fm.slug || slugify(f.replace(/\.md$/, ''));
  return { file, rel: 'articles/' + f, fm, body, slug, status: (fm.status || 'draft').toLowerCase(), date: fm.date || '' };
});

// планирование: approved без даты -> следующий слот (раз в CADENCE дней)
const newlyPublished = [];
let last = arts.filter(a => ['approved', 'published'].includes(a.status) && a.date).map(a => a.date).sort().pop();
for (const a of arts.filter(a => !GATE && a.status === 'approved' && !a.date).sort((x, y) => x.slug.localeCompare(y.slug))) {
  a.date = last ? (addDays(last, CADENCE) > TODAY ? addDays(last, CADENCE) : TODAY) : TODAY;
  last = a.date; setFm(a.file, 'date', a.date);
}
for (const a of arts) {
  if (!GATE && a.status === 'approved' && a.date && a.date <= TODAY) { a.status = 'published'; setFm(a.file, 'status', 'published'); newlyPublished.push(a); }
}
const published = arts.filter(a => a.status === 'published' && a.date <= TODAY).sort((a, b) => b.date.localeCompare(a.date));
const drafts = arts.filter(a => a.status === 'draft' || (GATE && a.status === 'approved'));

// ---------- render ----------
const outBlog = path.join(ROOT, 'blog');
fs.rmSync(outBlog, { recursive: true, force: true });
fs.mkdirSync(outBlog, { recursive: true });
fs.writeFileSync(path.join(outBlog, 'blog.css'), fs.readFileSync(path.join(ROOT, '.blog-kit', 'blog.css'), 'utf8') + (Object.keys(theme).length ? `
/* тема сайта */
:root{${Object.entries(theme).map(([k, v]) => `--b-${k}:${v}`).join(';')}}
` : ''));

const authorName = CFG.author?.name || CFG.siteName;
const ctaUrl = fixUrl(CFG.ctaUrl || '/#contact');
const cardHtml = (a, prefix = BASE + '/') => `<article class="b-card">
  ${a.fm.image ? `<a class="b-card__img" href="${prefix}blog/${a.slug}/"><img src="${esc(prefix + a.fm.image.replace(/^\//, ''))}" alt="${esc(a.fm.image_alt || a.fm.h1 || a.fm.title)}" loading="lazy"></a>` : ''}
  <div class="b-card__body">
    <div class="b-meta">${a.fm.category ? `<span class="b-chip">${esc(a.fm.category)}</span>` : ''}<time datetime="${a.date}">${ruDate(a.date)}</time>${a.fm.reading_time ? `<span>${esc(a.fm.reading_time)}</span>` : ''}</div>
    <h3><a href="${prefix}blog/${a.slug}/">${esc(a.fm.h1 || a.fm.title)}</a></h3>
    <p>${esc(a.fm.description || '')}</p>
    <a class="b-more" href="${prefix}blog/${a.slug}/">Читать статью</a>
  </div>
</article>`;

function prepare(a) {
  const r = md(a.body);
  const words = plain(r.html).split(' ').length;
  a.fm.reading_time = a.fm.reading_time || `${Math.max(2, Math.round(words / 180))} мин чтения`;
  return r;
}
published.forEach(prepare);

function renderArticle(a, { preview = false } = {}) {
  const { html, toc } = prepare(a);
  const rt = a.fm.reading_time;
  const url = `${SITE}/blog/${a.slug}/`;
  const h1 = a.fm.h1 || a.fm.title;
  const related = published.filter(x => x.slug !== a.slug).sort((x, y) => (y.fm.category === a.fm.category) - (x.fm.category === a.fm.category) || y.date.localeCompare(x.date)).slice(0, 3);
  const faq = Array.isArray(a.fm.faq) ? a.fm.faq.filter(f => f.q && f.a) : [];
  const img = a.fm.image ? (/^https?:/.test(a.fm.image) ? a.fm.image : SITE + '/' + a.fm.image.replace(/^\//, '')) : '';
  const jsonld = [
    { '@context': 'https://schema.org', '@type': 'Article', headline: h1, description: a.fm.description, inLanguage: 'ru', datePublished: a.date, dateModified: a.fm.updated || a.date, mainEntityOfPage: url, ...(img ? { image: img } : {}), author: { '@type': CFG.author?.type || 'Person', name: a.fm.author || authorName }, publisher: { '@type': 'Organization', name: CFG.siteName, url: SITE + '/' } },
    { '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [ { '@type': 'ListItem', position: 1, name: 'Главная', item: SITE + '/' }, { '@type': 'ListItem', position: 2, name: 'Блог', item: SITE + '/blog/' }, { '@type': 'ListItem', position: 3, name: h1, item: url } ] },
  ];
  if (faq.length) jsonld.push({ '@context': 'https://schema.org', '@type': 'FAQPage', mainEntity: faq.map(f => ({ '@type': 'Question', name: f.q, acceptedAnswer: { '@type': 'Answer', text: f.a } })) });
  const disclaimer = a.fm.disclaimer === false ? '' : (typeof a.fm.disclaimer === 'string' && a.fm.disclaimer ? a.fm.disclaimer : CFG.disclaimer);
  const body = `
<article class="b-article">
  <nav class="b-crumbs" aria-label="Хлебные крошки"><a href="${BASE}/">Главная</a><span>/</span><a href="${BASE}/blog/">Блог</a></nav>
  ${preview ? '<div class="b-preview">Черновик для согласования. Эта страница не индексируется и не видна в блоге.</div>' : ''}
  <header class="b-head">
    <div class="b-meta">${a.fm.category ? `<span class="b-chip">${esc(a.fm.category)}</span>` : ''}<time datetime="${a.date || TODAY}">${ruDate(a.date || TODAY)}</time><span>${esc(rt)}</span></div>
    <h1>${esc(h1)}</h1>
    <p class="b-lead">${esc(a.fm.description || '')}</p>
    <p class="b-author">Автор: ${esc(a.fm.author || authorName)}${CFG.author?.jobTitle ? `, ${esc(CFG.author.jobTitle)}` : ''}</p>
  </header>
  ${img ? `<figure class="b-cover"><img src="${esc(fixUrl(a.fm.image))}" alt="${esc(a.fm.image_alt || h1)}"></figure>` : ''}
  ${toc.length > 3 ? `<nav class="b-toc" aria-label="Содержание"><strong>Содержание</strong><ol>${toc.map(t => `<li><a href="#${t.id}">${esc(t.text)}</a></li>`).join('')}</ol></nav>` : ''}
  <div class="b-content">${html}</div>
  ${faq.length ? `<section class="b-faq"><h2>Частые вопросы</h2>${faq.map(f => `<details><summary>${esc(f.q)}</summary><p>${esc(f.a)}</p></details>`).join('')}</section>` : ''}
  ${disclaimer ? `<p class="b-disclaimer">${esc(disclaimer)}</p>` : ''}
  <aside class="b-cta"><h2>${esc(CFG.ctaTitle || 'Остались вопросы?')}</h2><p>${esc(CFG.ctaText || 'Оставьте заявку — разберём вашу ситуацию и подскажем следующий шаг.')}</p><a class="btn btn--primary b-cta__btn" href="${ctaUrl}">${esc(CFG.ctaButton || 'Оставить заявку')}</a></aside>
</article>
${related.length && !preview ? `<section class="b-related"><h2>Читайте также</h2><div class="b-grid">${related.map(x => cardHtml(x)).join('')}</div></section>` : ''}`;
  return page({ title: a.fm.title || h1, description: a.fm.description || '', canonical: url, robots: preview ? 'noindex, nofollow' : '', ogImage: img, ogType: 'article', body, jsonld: preview ? [] : jsonld, bodyClass: 'b-page' });
}

// ---------- главная: блок «Полезные статьи» ----------
const MARK = /<!-- BLOG:START -->[\s\S]*?<!-- BLOG:END -->/;
let nextIndex = indexHtml;
if (MARK.test(indexHtml)) {
  const latest = published.slice(0, HOME_LATEST);
  const block = (latest.length && !GATE) ? `<!-- BLOG:START -->
<section class="b-home" id="blog">
  <div class="container">
    <div class="b-home__head"><div><p class="section-tag">${esc(CFG.blogTitle || 'Блог')}</p><h2>${esc(CFG.homeTitle || 'Полезные статьи')}</h2></div><a class="b-more" href="blog/">Все статьи</a></div>
    <div class="b-grid">${latest.map(a => cardHtml(a, '')).join('')}</div>
  </div>
</section>
<!-- BLOG:END -->` : '<!-- BLOG:START --><!-- BLOG:END -->';
  nextIndex = nextIndex.replace(MARK, () => block);
}

const NAVMARK = /<!-- BLOGNAV:START -->[\s\S]*?<!-- BLOGNAV:END -->/;
if (NAVMARK.test(nextIndex)) nextIndex = nextIndex.replace(NAVMARK, () => `<!-- BLOGNAV:START -->${(published.length && !GATE) ? '<a href="blog/">Блог</a>' : ''}<!-- BLOGNAV:END -->`);
if (nextIndex !== indexHtml) fs.writeFileSync(path.join(ROOT, 'index.html'), nextIndex);
loadChrome();

for (const a of published) {
  fs.mkdirSync(path.join(outBlog, a.slug), { recursive: true });
  fs.writeFileSync(path.join(outBlog, a.slug, 'index.html'), renderArticle(a));
}
const secret = CFG.previewSecret || CFG.siteName;
const previewToken = slug => crypto.createHash('sha1').update(slug + secret).digest('hex').slice(0, 12);
const draftReport = [];
for (const a of drafts) {
  const tok = previewToken(a.slug); const dir = path.join(outBlog, 'preview', tok, a.slug);
  fs.mkdirSync(dir, { recursive: true }); a.date ||= TODAY;
  fs.writeFileSync(path.join(dir, 'index.html'), renderArticle(a, { preview: true }));
  draftReport.push({ slug: a.slug, path: a.rel, title: a.fm.h1 || a.fm.title, description: a.fm.description || '', reading_time: a.fm.reading_time, notified: !!a.fm.notified, preview_url: `${SITE}/blog/preview/${tok}/${a.slug}/` });
}

// список блога
const listBody = `
<section class="b-list">
  <nav class="b-crumbs" aria-label="Хлебные крошки"><a href="${BASE}/">Главная</a><span>/</span><span>Блог</span></nav>
  <header class="b-head"><h1>${esc(CFG.blogTitle || 'Блог')}</h1><p class="b-lead">${esc(CFG.blogDescription || '')}</p></header>
  ${published.length ? `<div class="b-grid">${published.map(a => cardHtml(a)).join('')}</div>` : '<p class="b-empty">Первые статьи скоро появятся.</p>'}
</section>`;
if (!GATE) {
  fs.writeFileSync(path.join(outBlog, 'index.html'), page({
    title: `${CFG.blogTitle || 'Блог'} — ${CFG.siteName}`, description: CFG.blogDescription || `Статьи ${CFG.siteName}`, canonical: `${SITE}/blog/`, body: listBody,
    jsonld: [{ '@context': 'https://schema.org', '@type': 'Blog', name: `${CFG.blogTitle || 'Блог'} — ${CFG.siteName}`, url: `${SITE}/blog/`, blogPost: published.slice(0, 20).map(a => ({ '@type': 'BlogPosting', headline: a.fm.h1 || a.fm.title, url: `${SITE}/blog/${a.slug}/`, datePublished: a.date })) }],
    bodyClass: 'b-page',
  }));
}
const designPreviewUrl = `${SITE}/blog/preview/${previewToken('_design')}/`;
if (GATE) {
  const tok = previewToken('_design'); const dir = path.join(outBlog, 'preview', tok); fs.mkdirSync(dir, { recursive: true });
  const cards = arts.filter(a => a.status === 'draft' || a.status === 'approved' || a.status === 'published').map(a => { a.date ||= TODAY; return cardHtml(a).split(`/blog/${a.slug}/`).join(`/blog/preview/${previewToken(a.slug)}/${a.slug}/`); });
  fs.writeFileSync(path.join(dir, 'index.html'), page({ title: `Предпросмотр блога — ${CFG.siteName}`, description: 'Предпросмотр оформления блога', canonical: designPreviewUrl, robots: 'noindex, nofollow',
    body: `<section class="b-list"><div class="b-preview">Предпросмотр оформления блога. Страница закрыта от поисковиков и видна только по этой ссылке.</div><header class="b-head"><h1>${esc(CFG.blogTitle || 'Блог')}</h1><p class="b-lead">${esc(CFG.blogDescription || '')}</p></header><div class="b-grid">${cards.join('')}</div></section>`, bodyClass: 'b-page' }));
}


// ---------- sitemap / feed / robots ----------
const pages = (CFG.staticPages || ['/']).map(p => ({ loc: SITE + (p === '/' ? '/' : p), lastmod: TODAY, pr: p === '/' ? '1.0' : '0.5' }));
const urls = [...pages, ...(GATE ? [] : [{ loc: `${SITE}/blog/`, lastmod: published[0]?.date || TODAY, pr: '0.8' }]), ...published.map(a => ({ loc: `${SITE}/blog/${a.slug}/`, lastmod: a.fm.updated || a.date, pr: '0.7' }))];
fs.writeFileSync(path.join(ROOT, 'sitemap.xml'), `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls.map(u => `  <url><loc>${u.loc}</loc><lastmod>${u.lastmod}</lastmod><priority>${u.pr}</priority></url>`).join('\n')}\n</urlset>\n`);

const rfc = d => new Date(d + 'T09:00:00+03:00').toUTCString();
const origin = new URL(SITE).origin;
fs.writeFileSync(path.join(ROOT, 'feed.xml'), `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:content="http://purl.org/rss/1.0/modules/content/">
<channel>
<title>${esc(CFG.siteName)} — блог</title>
<link>${SITE}/blog/</link>
<description>${esc(CFG.blogDescription || CFG.siteName)}</description>
<language>ru</language>
${published.slice(0, 30).map(a => `<item>
<title>${esc(a.fm.h1 || a.fm.title)}</title>
<link>${SITE}/blog/${a.slug}/</link>
<guid isPermaLink="true">${SITE}/blog/${a.slug}/</guid>
<pubDate>${rfc(a.date)}</pubDate>
<description>${esc(a.fm.description || '')}</description>
${a.fm.category ? `<category>${esc(a.fm.category)}</category>` : ''}
<content:encoded><![CDATA[${md(a.body).html.replace(/(src|href)="\//g, `$1="${origin}/`)}]]></content:encoded>
</item>`).join('\n')}
</channel>
</rss>
`);

const robotsPath = path.join(ROOT, 'robots.txt');
if (!fs.existsSync(robotsPath)) fs.writeFileSync(robotsPath, `User-agent: *\nAllow: /\nDisallow: ${BASE}/blog/preview/\n\nSitemap: ${SITE}/sitemap.xml\n`);
fs.writeFileSync(path.join(ROOT, '.nojekyll'), '');

fs.writeFileSync(path.join(outBlog, 'queue.json'), JSON.stringify({
  site: SITE, updated: TODAY, design_approved: !GATE, design_preview_url: GATE ? designPreviewUrl : null,
  awaiting: draftReport.map(d => ({ slug: d.slug, path: d.path, title: d.title, description: d.description, reading_time: d.reading_time, preview_url: d.preview_url })),
  scheduled: arts.filter(a => a.status === 'approved' && a.date && a.date > TODAY && !GATE).map(a => ({ slug: a.slug, title: a.fm.h1 || a.fm.title, date: a.date })),
  published: published.map(a => ({ slug: a.slug, title: a.fm.h1 || a.fm.title, url: `${SITE}/blog/${a.slug}/`, date: a.date })),
}, null, 2));
fs.writeFileSync(path.join(ROOT, '.blog-report.json'), JSON.stringify({
  today: TODAY,
  published: newlyPublished.map(a => ({ slug: a.slug, title: a.fm.h1 || a.fm.title, url: `${SITE}/blog/${a.slug}/`, date: a.date })),
  drafts: draftReport,
  scheduled: arts.filter(a => a.status === 'approved' && a.date > TODAY).map(a => ({ slug: a.slug, date: a.date })),
}, null, 2));
console.log(`blog: опубликовано ${published.length}, черновиков ${drafts.length}, новых сегодня ${newlyPublished.length}`);
