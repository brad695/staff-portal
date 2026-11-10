-- Experiences: the card pays the price + the 20% gratuity + sales tax (2026-11-10).
-- Maverick: "experiences clearly say add 20% gratuity and tax but it's not being added".
-- square-experience-pay now charges price + gratuity + tax (the register's own Square "20% Grat" and
-- "TN Standard 9.75%") and stores the breakdown here. total_cents stays the experience price.
-- Applied as migration experience_gratuity_tax.

alter table public.rb_reservations
  add column if not exists gratuity_cents integer,
  add column if not exists tax_cents integer,
  add column if not exists paid_cents integer;

comment on column public.rb_reservations.gratuity_cents is
  'Experiences: the 20% gratuity on the card payment (Square "20% Grat" service charge), set at payment. Since 2026-11-10.';
comment on column public.rb_reservations.tax_cents is
  'Experiences: sales tax on the card payment, set at payment. Since 2026-11-10.';
comment on column public.rb_reservations.paid_cents is
  'Experiences: what the card paid = total_cents (the price) + gratuity_cents + tax_cents. Null before 2026-11-10, when the price alone was charged.';

-- The paid booking's Catering Lead + BEO (rb_experience_lead_sync) and the chat card for a booked
-- inquiry (chat_inq_update_trg) show what the card paid, not the price alone. Each function changes
-- in that one place only; the rest of its body is left exactly as it is.
do $$
declare d text; old_s text; new_s text;
begin
  d := pg_get_functiondef('public.rb_experience_lead_sync'::regproc);
  old_s := $q$money := '$' || to_char(coalesce(new.total_cents, 0) / 100.0, 'FM999,999,990.00');$q$;
  new_s := $q$money := '$' || to_char(coalesce(new.paid_cents, new.total_cents, 0) / 100.0, 'FM999,999,990.00')
        || case when coalesce(new.gratuity_cents, 0) + coalesce(new.tax_cents, 0) > 0
                then ' ($' || to_char(coalesce(new.total_cents, 0) / 100.0, 'FM999,999,990.00')
                     || ' + gratuity $' || to_char(coalesce(new.gratuity_cents, 0) / 100.0, 'FM999,999,990.00')
                     || ' + tax $' || to_char(coalesce(new.tax_cents, 0) / 100.0, 'FM999,999,990.00') || ')'
                else '' end;$q$;
  if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'rb_experience_lead_sync: the money line was not found exactly once';
  end if;
  execute replace(d, old_s, new_s);
  if pg_get_functiondef('public.rb_experience_lead_sync'::regproc) <> replace(d, old_s, new_s) then
    raise exception 'rb_experience_lead_sync: more than the money line changed';
  end if;

  d := pg_get_functiondef('public.chat_inq_update_trg'::regproc);
  old_s := $q$select x.code, x.total_cents, x.starts_at into rcode, rcents, rstart$q$;
  new_s := $q$select x.code, coalesce(x.paid_cents, x.total_cents), x.starts_at into rcode, rcents, rstart$q$;
  if (length(d) - length(replace(d, old_s, ''))) / length(old_s) <> 1 then
    raise exception 'chat_inq_update_trg: the reservation select was not found exactly once';
  end if;
  execute replace(d, old_s, new_s);
  if pg_get_functiondef('public.chat_inq_update_trg'::regproc) <> replace(d, old_s, new_s) then
    raise exception 'chat_inq_update_trg: more than the reservation select changed';
  end if;
end $$;
