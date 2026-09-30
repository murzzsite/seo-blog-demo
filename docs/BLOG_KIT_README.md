# SEO-блог для сайтов клиентов

Статичный блог на GitHub Pages: статьи лежат в репозитории клиента как Markdown-файлы, на сайт выходят сами, после согласования клиентом в Telegram. Без CMS и серверов.

## Как это работает

```
Мастер-промт (SEO_ARTICLE_PROMPT.md) → articles/<slug>.md, status: draft → git push
      │
      ▼  GitHub Action «SEO blog» (на каждый push и каждый день в 09:00 МСК)
Собирает страницу-предпросмотр (закрыта от индексации) и шлёт клиенту в Telegram
сообщение с кнопками:  [👁 Открыть статью]  [✅ Опубликовать]  [✏️ Правки]
      │
      ├─ «Правки» → текст клиента приходит менеджеру (MANAGER_CHAT_ID), статья правится и уходит заново
      │
      ▼  «Опубликовать»: Worker меняет status: approved в файле (коммит в GitHub)
Сборщик ставит дату выхода (раз в 7 дней, cadenceDays) и в назначенный день:
  • собирает /blog/<slug>/, обновляет список блога, блок на главной, ссылку в меню
  • обновляет sitemap.xml и feed.xml, пингует IndexNow (Яндекс, Bing)
  • пишет клиенту «Статья опубликована»
```

Пока клиент не нажал «Опубликовать», на сайт ничего не попадает. Автопубликации без согласования нет.

## Подключить блог клиенту (5 шагов)

Клиент уже должен быть в Worker (`ref_code`) и нажать /start у бота. Сайт задеплоен на GitHub Pages.

```bash
# 1. В папке сайта (git-репозиторий клиента) установить блок
node C:/Users/Administrator/Desktop/seo-blog-kit/install.mjs <папка-сайта> \
  --url https://murzzsite.github.io/<repo> --repo murzzsite/<repo> --ref <REF_CODE> \
  --name "Бренд" --author "Имя эксперта или бренд" --domain-type Person

# 2. Проверить blog.config.json (ctaUrl, disclaimer для юр/мед/псих/эзо, staticPages)

# 3. Секрет для Action (ключ Worker из памяти site-builder-config)
gh secret set BLOG_API_KEY --repo murzzsite/<repo> --body "<API_KEY>"

# 4. Положить первую статью в articles/ и запушить
git add -A && git commit -m "SEO-блог" && git push

# 5. Для Pages, если используется деплой из ветки: настройки не менять, .nojekyll создаётся сам
```

`install.mjs` подхватывает цвета и шрифты из `styles.css` сайта, добавляет в `index.html` метки `<!-- BLOG:START -->` (блок статей на главной) и `<!-- BLOGNAV:START -->` (ссылка «Блог» в меню; появляется только когда есть хотя бы одна опубликованная статья).

## Разовая настройка Worker (один раз на всех клиентов)

Нужны два секрета в Cloudflare Worker `lead-relay`:

| Секрет | Что это |
|---|---|
| `GITHUB_TOKEN` | fine-grained PAT аккаунта murzzsite: доступ к репозиториям сайтов, право **Contents: Read and write** |
| `MANAGER_CHAT_ID` | chat_id менеджера (команда `/myid` у бота), сюда приходят правки клиентов |

Плюс убедиться, что webhook бота принимает `callback_query` (кнопки): `setWebhook` с `allowed_updates: ["message","callback_query"]`.

## Файлы

| Файл | Назначение |
|---|---|
| `install.mjs` | Ставит блог в папку сайта |
| `kit/.blog-kit/build.mjs` | Сборка: Markdown → HTML, расписание, sitemap, RSS, блок на главной |
| `kit/.blog-kit/blog.css` | Стили, цвета берутся из палитры сайта |
| `kit/.blog-kit/notify.mjs` | Уведомления клиенту и IndexNow |
| `kit/.github/workflows/blog.yml` | GitHub Action |
| `lead-relay-worker/src/blog.js` | Worker: кнопки согласования, коммит в GitHub |

## Поля статьи (front-matter)

`title`, `description`, `slug`, `h1`, `category`, `keywords`, `author`, `image` (путь вида `img/blog/x.jpg`), `image_alt`, `faq`, `disclaimer` (`false` / текст), `status` (`draft` → `approved` → `published`; ставится автоматически).

## Известные ограничения

- Репозитории GitHub Pages публичные, поэтому черновики видны в репозитории и по прямой ссылке предпросмотра. В черновиках не должно быть ничего конфиденциального.
- Ссылка предпросмотра содержит секретный токен, но это «безопасность через неизвестность». Для закрытого предпросмотра нужен платный приватный хостинг.
- Индексацию ускоряет IndexNow (Яндекс, Bing). Google не поддерживает его, там работает только sitemap и время.
- Публикация в Дзен и vc.ru остаётся ручной (см. `Clode/SEO_SERVICES_CHECKLIST.md`).
