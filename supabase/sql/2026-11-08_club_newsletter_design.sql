-- Cheese Club newsletter template (2026-11-08)
-- Maverick: "a pre-built template that resembles the website with our logos and coloring … the ability to
-- enter text and pictures. that's all we need."
-- The newsletter made in the template editor (manager.html → Cheese Club → Newsletter) is saved as
-- club_newsletters.design:
--   { v: 1, headline, hero: { url } | null,
--     blocks: [ {t:"text", title, html} | {t:"photo", url, caption} | {t:"pickup"} ] }
-- The club-newsletter edge function (v10) draws the email from it in the club site's look.
-- NULL = an older newsletter written as HTML (body_html), drawn exactly as before.
-- Migration name: club_newsletter_design.
alter table public.club_newsletters add column if not exists design jsonb;
comment on column public.club_newsletters.design is 'Template newsletter: {v:1, headline, hero:{url}|null, blocks:[{t:text,title,html}|{t:photo,url,caption}|{t:pickup}]}. NULL = older HTML newsletter (body_html). Drawn by the club-newsletter edge function.';
