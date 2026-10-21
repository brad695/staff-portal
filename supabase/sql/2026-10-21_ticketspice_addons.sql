-- TicketSpice add-ons on imported class bookings (2026-10-21) — APPLIED to vdvtrevhqalmjwhjhjug.
-- Record of migrations ticketspice_addons_from_price_points, ticketspice_reg_addons_calc_fix_grouping and
-- ticketspice_addons_same_name_guests_and_importer (final versions below).
--
-- Problem: bookings imported from TicketSpice showed no add-ons on the class roster. The importer wrote
-- "Guests: A B; C D" with no per-guest option (the roster and booking cards read the option off each guest),
-- and its add_ons guess (ticket amount − class price = one add-on's price) missed mixed tiers, prices that
-- don't match, and any add-on the class got after the booking was imported.
-- Fix: each TicketSpice ticket's own pricePointName ("Base Ticket plus wine + charcuterie + crusty bread")
-- says what it bought; the amount over the class's base price is the cross-check and the fallback.
-- Every guest line now reads "Name (add-on)" like a ticket-site sale, and add_ons is [{qty,name,price}].
--
-- Backfill (run once 2026-10-21, upcoming classes only; 31 imported bookings checked, 22 updated):
--   select count(*) filter (where public.ticketspice_fill_reg_addons(g.id))
--     from registrations g join events e on e.id = g.event_id
--    where e.date >= current_date and g.notes ~ 'TicketSpice order' and not coalesce(g.refunded, false);
-- Re-running it is a no-op. The nightly importer (ticketspice_sync → ticketspice_sync_registrations) now
-- fills each new import itself.

-- "Base Ticket plus Charcuterie & crusty bread" → "charcuterie and crusty bread"
create or replace function public.ticketspice_addon_norm(p text)
returns text
language sql immutable
set search_path to 'public'
as $$
  select btrim(regexp_replace(
           regexp_replace(
             regexp_replace(
               regexp_replace(lower(coalesce(p, '')), '[&+]', ' and ', 'g'),
               '[^a-z0-9 ]', ' ', 'g'),
             '\s+', ' ', 'g'),
           '^\s*base ticket\s*(plus\s+)?', ''));
$$;

-- the extras a name mentions, e.g. {charcuterie,wine}
create or replace function public.ticketspice_addon_keywords(p text)
returns text[]
language sql immutable
set search_path to 'public'
as $$
  select coalesce(array_agg(k order by k), '{}'::text[])
  from unnest(array['bubbles','champagne','charcuterie','dessert','dinner','meal','prosecco','wine']) k
  where public.ticketspice_addon_norm(p) ~ ('\m' || k || 's?\M');
$$;

-- Which of the class's add-ons one TicketSpice ticket bought. No row = a plain base ticket.
--   1) same name as one of the class's add-ons      4) the biggest add-on whose extras are all named
--   2) same extras (charcuterie / wine / ...)        5) none of those: TicketSpice's own wording + what it cost
--   3) paid exactly one add-on's price over base     6) no price-point name but paid over base: says so
create or replace function public.ticketspice_ticket_option(p_ev_price integer, p_ev_addons jsonb, p_pp_name text, p_amount integer)
returns table(name text, price integer)
language plpgsql stable
set search_path to 'public'
as $$
#variable_conflict use_column
declare
  v_pp    text    := btrim(coalesce(p_pp_name, ''));
  v_base  boolean := btrim(coalesce(p_pp_name, '')) = ''
                     or (p_pp_name ~* '^\s*base\s+ticket' and p_pp_name !~* '\mplus\M');
  v_known boolean := p_amount is not null and p_ev_price is not null;
  v_delta integer := coalesce(p_amount, 0) - coalesce(p_ev_price, 0);
  v_norm  text    := public.ticketspice_addon_norm(p_pp_name);
  v_kw    text[]  := public.ticketspice_addon_keywords(p_pp_name);
  v_ao    jsonb   := case when jsonb_typeof(p_ev_addons) = 'array' then p_ev_addons else '[]'::jsonb end;
  v_hits  jsonb[];
begin
  if v_base and (not v_known or v_delta <= 0) then
    return;
  end if;

  if not v_base then
    -- 1) same name, ignoring "Base Ticket plus", case, & / + / and
    select array_agg(a order by ord) into v_hits
      from jsonb_array_elements(v_ao) with ordinality x(a, ord)
     where v_norm <> '' and public.ticketspice_addon_norm(a->>'name') = v_norm;
    if cardinality(v_hits) = 1 then
      return query select v_hits[1]->>'name', (v_hits[1]->>'price')::int;
      return;
    end if;

    -- 2) same extras; the price breaks a tie
    if cardinality(v_kw) > 0 then
      select array_agg(a order by ord) into v_hits
        from jsonb_array_elements(v_ao) with ordinality x(a, ord)
       where public.ticketspice_addon_keywords(a->>'name') = v_kw;
      if cardinality(v_hits) > 1 and v_known then
        select array_agg(h) into v_hits from unnest(v_hits) h where (h->>'price')::int = v_delta;
      end if;
      if cardinality(v_hits) = 1 then
        return query select v_hits[1]->>'name', (v_hits[1]->>'price')::int;
        return;
      end if;
    end if;
  end if;

  -- 3) paid exactly one add-on's price over the base price
  if v_known and v_delta > 0 then
    select array_agg(a order by ord) into v_hits
      from jsonb_array_elements(v_ao) with ordinality x(a, ord)
     where (a->>'price')::int = v_delta;
    if cardinality(v_hits) = 1 then
      return query select v_hits[1]->>'name', (v_hits[1]->>'price')::int;
      return;
    end if;
  end if;

  if not v_base then
    -- 4) e.g. "plus wine + charcuterie" on a class whose base already includes wine → its charcuterie add-on
    if cardinality(v_kw) > 0 then
      with c as (
        select a, ord, cardinality(public.ticketspice_addon_keywords(a->>'name')) n
          from jsonb_array_elements(v_ao) with ordinality x(a, ord)
         where cardinality(public.ticketspice_addon_keywords(a->>'name')) > 0
           and public.ticketspice_addon_keywords(a->>'name') <@ v_kw)
      select array_agg(a order by ord) into v_hits from c where n = (select max(n) from c);
      if cardinality(v_hits) = 1 then
        return query select v_hits[1]->>'name', (v_hits[1]->>'price')::int;
        return;
      end if;
    end if;
    -- 5) the class doesn't sell it here: keep TicketSpice's wording and what it cost
    return query select v_pp, greatest(case when v_known then v_delta else 0 end, 0);
    return;
  end if;

  -- 6) no add-on name at all, but more than the base price was paid
  return query select 'Paid $' || case when v_delta % 100 = 0 then (v_delta / 100)::text
                                       else to_char(v_delta / 100.0, 'FM999990.00') end || ' over base',
                      v_delta;
end $$;

-- What an imported booking's guest line and add_ons should be. Reads only.
-- Guests keep their names exactly as stored; an option a guest already has is kept (renamed to the class's
-- own add-on when it clearly is one); a blank guest gets the add-on from their own ticket (matched by name,
-- else by position when the booking lists one guest per ticket). Same-name guests: a guest who already has
-- an add-on claims the ticket that bought THAT add-on, so re-runs never move it to the other guest.
create or replace function public.ticketspice_reg_addons_calc(p_reg_id uuid)
returns table(new_notes text, new_add_ons jsonb)
language plpgsql stable security definer
set search_path to 'public'
as $$
declare
  g        public.registrations%rowtype;
  e        public.events%rowtype;
  v_ao     jsonb;
  v_oid    bigint;
  v_line   text;
  v_part   text;
  v_m      text[];
  v_opt    text;
  v_price  integer;
  o        record;
  r        record;
  t_nm     text[]    := '{}';
  t_opt    text[]    := '{}';
  t_price  integer[] := '{}';
  t_used   boolean[] := '{}';
  g_nm     text[]    := '{}';
  g_opt    text[]    := '{}';
  g_price  integer[] := '{}';
  g_done   boolean[] := '{}';
  nt int; ng int; i int; j int; v_pick int;
  v_lines  text[];
  v_newl   text;
  v_add    jsonb;
begin
  select * into g from public.registrations where id = p_reg_id;
  if not found then return; end if;
  v_oid := (regexp_match(coalesce(g.notes, ''), 'TicketSpice order 0*([0-9]+)'))[1]::bigint;
  if v_oid is null then return; end if;
  select * into e from public.events where id = g.event_id;
  if not found then return; end if;
  v_ao := case when jsonb_typeof(e.add_ons) = 'array' then e.add_ons else '[]'::jsonb end;

  -- this order's completed tickets for this class, in ticket order, each with what it bought
  for r in
    select btrim(regexp_replace(coalesce(tt.attendee_first, '') || ' ' || coalesce(tt.attendee_last, ''), '\s+', ' ', 'g')) nm,
           x.name opt, x.price oprice
      from public.ticketspice_tickets tt
      left join lateral public.ticketspice_ticket_option(e.price, v_ao, tt.raw->>'pricePointName', tt.amount_cents) x on true
     where tt.order_id = v_oid and tt.status = 'completed'
       and public.ticketspice_level_date(tt.level_label, tt.date_created) = e.date
     order by tt.ticket_id
  loop
    t_nm := t_nm || r.nm; t_opt := t_opt || r.opt; t_price := t_price || r.oprice; t_used := t_used || false;
  end loop;
  nt := coalesce(array_length(t_nm, 1), 0);

  -- the guests on the booking, as stored
  v_line := (regexp_match(coalesce(g.notes, ''), '(?:^|\n)Guests: ([^\n]*)'))[1];
  if v_line is not null and btrim(v_line) <> '' then
    foreach v_part in array string_to_array(v_line, '; ') loop
      v_m := regexp_match(v_part, '^(.*?)(?:\s*\((.*)\))?$');
      v_opt := nullif(btrim(coalesce(v_m[2], '')), '');
      v_price := null;
      if v_opt is not null then
        select x.name, x.price into o
          from public.ticketspice_ticket_option(e.price, v_ao, 'Base Ticket plus ' || v_opt, null) x;
        if found and exists (select 1 from jsonb_array_elements(v_ao) a where a->>'name' = o.name) then
          v_opt := o.name; v_price := o.price;
        end if;
      end if;
      g_nm := g_nm || coalesce(v_m[1], v_part);
      g_opt := g_opt || v_opt; g_price := g_price || v_price; g_done := g_done || (v_opt is not null);
    end loop;
  end if;
  ng := coalesce(array_length(g_nm, 1), 0);

  if ng > 0 and nt > 0 then
    -- guests that already have an option hold on to their own ticket: same name, and the one that
    -- bought that option when two guests share a name
    for i in 1..ng loop
      if g_opt[i] is not null then
        v_pick := null;
        for j in 1..nt loop
          if not t_used[j] and lower(btrim(regexp_replace(g_nm[i], '\s+', ' ', 'g'))) = lower(t_nm[j]) then
            if t_opt[j] is not distinct from g_opt[i] then v_pick := j; exit; end if;
            if v_pick is null then v_pick := j; end if;
          end if;
        end loop;
        if v_pick is not null then t_used[v_pick] := true; end if;
      end if;
    end loop;
    -- blank guests take what their own ticket bought (matched by name)
    for i in 1..ng loop
      if not g_done[i] then
        for j in 1..nt loop
          if not t_used[j] and lower(btrim(regexp_replace(g_nm[i], '\s+', ' ', 'g'))) = lower(t_nm[j]) then
            g_opt[i] := t_opt[j]; g_price[i] := t_price[j]; t_used[j] := true; g_done[i] := true; exit;
          end if;
        end loop;
      end if;
    end loop;
    -- still blank, one guest per ticket: the ticket in the same position
    if ng = nt then
      for i in 1..ng loop
        if not g_done[i] and not t_used[i] then
          g_opt[i] := t_opt[i]; g_price[i] := t_price[i]; t_used[i] := true; g_done[i] := true;
        end if;
      end loop;
    end if;
  end if;

  -- rebuild the notes with the new guest line (every other line untouched)
  new_notes := g.notes;
  if ng > 0 then
    select string_agg(g_nm[k] || coalesce(' (' || g_opt[k] || ')', ''), '; ' order by k) into v_newl
      from generate_series(1, ng) k;
    v_lines := string_to_array(g.notes, E'\n');
    for i in 1..coalesce(array_length(v_lines, 1), 0) loop
      if v_lines[i] like 'Guests: %' then
        v_lines[i] := 'Guests: ' || v_newl; exit;
      end if;
    end loop;
    new_notes := array_to_string(v_lines, E'\n');
  end if;

  -- add_ons the same shape the ticket site writes: [{qty, name, price}], first-seen order
  if ng > 0 and (nt = 0 or ng = coalesce(g.qty, ng)) then
    select coalesce(jsonb_agg(jsonb_build_object('qty', q, 'name', nm, 'price',
             coalesce(pr, (select (a->>'price')::int from jsonb_array_elements(v_ao) a where a->>'name' = nm limit 1), 0))
             order by first_k), '[]'::jsonb)
      into v_add
      from (select g_opt[k] nm, count(*) q, min(k) first_k, max(g_price[k]) pr
              from generate_series(1, ng) k
             where g_opt[k] is not null
             group by g_opt[k]) s;
  elsif nt > 0 then
    select coalesce(jsonb_agg(jsonb_build_object('qty', q, 'name', nm, 'price', coalesce(pr, 0)) order by first_k), '[]'::jsonb)
      into v_add
      from (select t_opt[k] nm, count(*) q, min(k) first_k, max(t_price[k]) pr
              from generate_series(1, nt) k
             where t_opt[k] is not null
             group by t_opt[k]) s;
  else
    v_add := coalesce(g.add_ons, '[]'::jsonb);
  end if;
  new_add_ons := v_add;
  return next;
end $$;

-- Apply it to one booking; true when something changed.
create or replace function public.ticketspice_fill_reg_addons(p_reg_id uuid)
returns boolean
language plpgsql security definer
set search_path to 'public'
as $$
declare c record;
begin
  select * into c from public.ticketspice_reg_addons_calc(p_reg_id);
  if not found then return false; end if;
  update public.registrations
     set notes = c.new_notes, add_ons = c.new_add_ons
   where id = p_reg_id
     and (notes is distinct from c.new_notes or add_ons is distinct from c.new_add_ons);
  return found;
end $$;

-- The nightly importer writes each guest's add-on as it imports (ticketspice_fill_reg_addons on the new
-- row) instead of guessing one add-on from the price. Everything else is unchanged.
create or replace function public.ticketspice_sync_registrations()
 returns table(imported integer, needs_review integer)
 language plpgsql
 security definer
 set search_path to 'public'
as $function$
declare r record; v_seq int; v_imported int := 0; v_review int := 0; v_event_id uuid; v_matches int; v_reg_id uuid;
begin
  select coalesce(max((regexp_match(code,'CHZ-TS0*([0-9]+)'))[1]::int),0)
    into v_seq from registrations where code ~ '^CHZ-TS[0-9]+$';

  for r in
    with done as (
      select distinct (regexp_match(notes,'TicketSpice order 0*([0-9]+)'))[1]::bigint oid
      from registrations where notes ~ 'TicketSpice order'
    ), t as (
      select tt.*,
             ticketspice_level_date(tt.level_label, tt.date_created) cdate,
             coalesce(fl.location, ticketspice_location(tt.form_name)) loc
      from ticketspice_tickets tt
      left join ticketspice_form_location fl on fl.form_id = tt.form_id
      where tt.status = 'completed'
        and tt.level_label !~* 'mahjong'
        and tt.order_id is not null
        and tt.order_id not in (select oid from done where oid is not null)
    )
    select order_id, min(order_email) email, min(form_name) form_name, min(level_label) level_label,
           cdate, loc, count(*) tix, sum(total_cents) total_cents,
           min(date_created) sold,
           string_agg(btrim(coalesce(attendee_first,'')||' '||coalesce(attendee_last,'')), '; ' order by ticket_id) guests,
           array_agg(amount_cents order by ticket_id) amounts
    from t
    where cdate >= current_date
    group by order_id, cdate, loc
  loop
    v_event_id := null; v_matches := 0; v_reg_id := null;
    if r.loc is not null then
      select count(*), (array_agg(id order by id))[1] into v_matches, v_event_id
      from events where date = r.cdate and location = r.loc and not coalesce(archived,false);
    end if;

    if v_matches = 1 then
      v_seq := v_seq + 1;
      insert into registrations (event_id, code, name, email, phone, qty, add_ons, seat_with, notes, total, payment_status, guest_emails, created_at)
      select v_event_id,
             'CHZ-TS' || lpad(v_seq::text, 3, '0'),
             coalesce(nullif(btrim(coalesce(o.first_name,'')||' '||coalesce(o.last_name,'')),''), split_part(r.guests,';',1)),
             r.email, o.phone, r.tix,
             '[]'::jsonb,
             '',
             'Imported from TicketSpice order ' || lpad(r.order_id::text, 10, '0') || E'\nGuests: ' || r.guests,
             r.total_cents, 'legacy', '[]'::jsonb, r.sold
      from ticketspice_orders o where o.order_id = r.order_id
      returning id into v_reg_id;

      if not found then
        insert into registrations (event_id, code, name, email, phone, qty, add_ons, seat_with, notes, total, payment_status, guest_emails, created_at)
        values (v_event_id, 'CHZ-TS'||lpad(v_seq::text,3,'0'), split_part(r.guests,';',1), r.email, null, r.tix,
                '[]'::jsonb, '', 'Imported from TicketSpice order '||lpad(r.order_id::text,10,'0')||E'\nGuests: '||r.guests,
                r.total_cents, 'legacy', '[]'::jsonb, r.sold)
        returning id into v_reg_id;
      end if;

      -- each guest's add-on from their own ticket (pricePointName, then price); a failure here must not
      -- lose the booking itself
      begin
        perform public.ticketspice_fill_reg_addons(v_reg_id);
      exception when others then
        raise warning 'ticketspice_fill_reg_addons(%) failed: %', v_reg_id, sqlerrm;
      end;

      update ticketspice_import_review set resolved = true where order_id = r.order_id;
      v_imported := v_imported + 1;
    else
      insert into ticketspice_import_review (order_id, form_name, level_label, parsed_date, parsed_location, tickets, total_cents, reason)
      values (r.order_id, r.form_name, r.level_label, r.cdate, r.loc, r.tix, r.total_cents,
              case when r.loc is null then 'no location in form name'
                   when v_matches = 0 then 'no event on that date/location'
                   else v_matches || ' events match that date/location' end)
      on conflict (order_id) do update set reason = excluded.reason, parsed_date = excluded.parsed_date, resolved = false;
      v_review := v_review + 1;
    end if;
  end loop;

  return query select v_imported, v_review;
end $function$;

-- service_role only, like the rest of the TicketSpice pipeline
revoke all on function public.ticketspice_addon_norm(text) from public, anon, authenticated;
revoke all on function public.ticketspice_addon_keywords(text) from public, anon, authenticated;
revoke all on function public.ticketspice_ticket_option(integer, jsonb, text, integer) from public, anon, authenticated;
revoke all on function public.ticketspice_reg_addons_calc(uuid) from public, anon, authenticated;
revoke all on function public.ticketspice_fill_reg_addons(uuid) from public, anon, authenticated;
revoke all on function public.ticketspice_sync_registrations() from public, anon, authenticated;
grant execute on function public.ticketspice_addon_norm(text) to service_role;
grant execute on function public.ticketspice_addon_keywords(text) to service_role;
grant execute on function public.ticketspice_ticket_option(integer, jsonb, text, integer) to service_role;
grant execute on function public.ticketspice_reg_addons_calc(uuid) to service_role;
grant execute on function public.ticketspice_fill_reg_addons(uuid) to service_role;
grant execute on function public.ticketspice_sync_registrations() to service_role;
