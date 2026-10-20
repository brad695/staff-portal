-- Applied 2026-10-19 (migration chat_links_without_html). Maverick: no links with ".html".
-- Chat lives at staff.greyscheese.com/chat, the manager console at /manager. Rewrites the links these four
-- functions put on chat cards; everything else in them is unchanged.
do $$
declare r record; def text; n int := 0;
begin
  for r in select p.oid, p.proname from pg_proc p join pg_namespace s on s.oid = p.pronamespace
           where s.nspname = 'public' and p.proname in ('chat_alert_catering_lead','chat_alert_inquiry','chat_inq_convo','chat_lead_convo') loop
    def := pg_get_functiondef(r.oid);
    def := replace(def, 'https://staff.greyscheese.com/chat.html#', 'https://staff.greyscheese.com/chat#');
    def := replace(def, 'https://staff.greyscheese.com/manager.html#', 'https://staff.greyscheese.com/manager#');
    if def ~ 'greyscheese\.com/[a-z]+\.html' then raise exception 'still has an .html link: %', r.proname; end if;
    execute def; n := n + 1;
  end loop;
  if n <> 4 then raise exception 'expected 4 functions, rewrote %', n; end if;
end $$;

-- and the 29 cards already posted:
-- update chat_messages set card = replace(replace(card::text,
--   'https://staff.greyscheese.com/chat.html#', 'https://staff.greyscheese.com/chat#'),
--   'https://staff.greyscheese.com/manager.html#', 'https://staff.greyscheese.com/manager#')::jsonb
-- where card::text ~ 'staff\.greyscheese\.com/(chat|manager)\.html#';
