-- Greys Chat: client email replies come back by a code in the subject (2026-10-12, migration chat_client_mail_code)
--
-- chat-api gives a client conversation a 6-character code on its first email (first letter G–Z, so it can
-- never match an inquiry's or a catering lead's hex code) and sends "Your GREYS question [#CODE]" with
-- Reply-To the inquiry inbox. The inquiry Gmail sync (Apps Script in brad@greyscheese.com) posts the
-- customer's reply to inquiries?action=ingest; after inquiries and catering_leads it looks the code up here
-- and adds the reply to that conversation (chat_messages: author_kind client, via email, ext_id gmail:<id>).
alter table public.chat_convos add column if not exists mail_code text;
create unique index if not exists chat_convos_mail_code_uidx on public.chat_convos(mail_code) where mail_code is not null;
