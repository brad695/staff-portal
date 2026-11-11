-- Catering proposals / invoices: charges staff pick per quote (2026-11-11).
-- Maverick: "these needs to be selectable in the invoice, as well as a 3% credit card charge,
-- customers may be tax exempt". Used by the catering edge function (save_quote / view / preview /
-- the signed PDF / the Square order) and manager.html's proposal editor.
-- Applied as migration catering_quote_charges. Existing quotes keep their totals (all off).

alter table public.catering_quotes
  add column if not exists gratuity_pct numeric(5,2) not null default 0,
  add column if not exists gratuity_cents integer not null default 0,
  add column if not exists tax_exempt boolean not null default false,
  add column if not exists tax_exempt_id text,
  add column if not exists card_fee_pct numeric(5,2) not null default 0,
  add column if not exists card_fee_cents integer not null default 0;

comment on column public.catering_quotes.gratuity_pct is
  '0 = no gratuity; otherwise the register''s "20% Grat" percentage (Square service charge 7LLRG4S72ZFKTSO7NP72OTKT), on the items. 2026-11-11.';
comment on column public.catering_quotes.gratuity_cents is 'The gratuity in cents (Square''s figure once the invoice order exists).';
comment on column public.catering_quotes.tax_exempt is 'true = no sales tax on this quote (tax_rate is kept for when it is switched back on). 2026-11-11.';
comment on column public.catering_quotes.tax_exempt_id is 'The customer''s sales tax exemption certificate number, when tax_exempt.';
comment on column public.catering_quotes.card_fee_pct is '0 = none; 3 = "Credit card fee (3%)" on everything before it (items + gratuity + tax). 2026-11-11.';
comment on column public.catering_quotes.card_fee_cents is 'The credit card fee in cents (a fixed TOTAL_PHASE service charge on the Square order).';
