-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 4: eventi Stripe)
-- Da eseguire dopo 20261120010000_portale_clienti.sql.
--
-- La funzione lato server `stripe-webhook` verifica la firma di Stripe e chiama
-- queste due funzioni con la chiave service_role. Ogni funzione:
--   1. registra l'evento in stripe_events (un evento già visto non conta due volte);
--   2. trova il cliente dal subscription ID o dal customer ID;
--   3. aggiorna pagamenti, mensilità pagate e stato dell'abbonamento.
-- Se qualcosa va storto la transazione si annulla e la funzione risponde errore:
-- Stripe ritenta l'invio più tardi.
-- =====================================================================

alter table public.payments
  add column stripe_customer_id     text,
  add column stripe_subscription_id text,
  add column billing_reason         text,
  add column counted                boolean not null default false;  -- già conteggiato come mensilità
create index payments_unlinked_idx on public.payments (stripe_customer_id) where client_id is null;

-- una fattura vale come mensilità se è pagata, ha un importo, appartiene a un abbonamento
-- ed è la prima fattura o un rinnovo (non un conguaglio per cambio piano)
create or replace function public.payment_is_countable(p_status public.payment_state, p_amount int, p_subscription text, p_reason text)
returns boolean language sql immutable set search_path = '' as $$
  select p_status = 'pagato' and coalesce(p_amount, 0) > 0 and p_subscription is not null
     and coalesce(p_reason, '') in ('subscription_create', 'subscription_cycle');
$$;

create or replace function public.stripe_client_id(p_customer text, p_subscription text)
returns uuid language sql stable security definer set search_path = '' as $$
  select coalesce(
    (select id from public.clients where p_subscription is not null and stripe_subscription_id = p_subscription),
    (select id from public.clients where p_customer is not null and stripe_customer_id = p_customer)
  );
$$;

-- ---------- invoice.paid / invoice.payment_failed ----------
create or replace function public.stripe_apply_invoice(
  p_event_id text, p_event_type text, p_invoice_id text, p_customer text, p_subscription text,
  p_billing_reason text, p_paid boolean, p_amount_cents int, p_currency text,
  p_paid_at timestamptz, p_period_start timestamptz, p_period_end timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_old    public.payments;
  v_new    public.payments;
begin
  insert into public.stripe_events (id, type) values (p_event_id, p_event_type) on conflict (id) do nothing;
  if not found then return 'duplicato'; end if;

  v_client := public.stripe_client_id(p_customer, p_subscription);

  select * into v_old from public.payments where stripe_invoice_id = p_invoice_id for update;
  if found and v_old.status = 'pagato' and not p_paid then
    return 'ignorato: fattura già pagata';            -- evento di fallimento arrivato in ritardo
  end if;

  insert into public.payments as p (client_id, stripe_invoice_id, stripe_customer_id, stripe_subscription_id, billing_reason,
                               amount_cents, currency, status, period_start, period_end, paid_at)
  values (v_client, p_invoice_id, p_customer, p_subscription, p_billing_reason,
          coalesce(p_amount_cents, 0), coalesce(p_currency, 'eur'),
          case when p_paid then 'pagato' else 'fallito' end::public.payment_state,
          p_period_start, p_period_end, case when p_paid then coalesce(p_paid_at, now()) end)
  on conflict (stripe_invoice_id) do update set
    client_id              = coalesce(p.client_id, excluded.client_id),
    stripe_customer_id     = coalesce(excluded.stripe_customer_id, p.stripe_customer_id),
    stripe_subscription_id = coalesce(excluded.stripe_subscription_id, p.stripe_subscription_id),
    billing_reason         = coalesce(excluded.billing_reason, p.billing_reason),
    amount_cents           = excluded.amount_cents,
    status                 = excluded.status,
    period_start           = coalesce(excluded.period_start, p.period_start),
    period_end             = coalesce(excluded.period_end, p.period_end),
    paid_at                = coalesce(excluded.paid_at, p.paid_at)
  returning * into v_new;

  if v_new.client_id is null then
    return 'cliente non trovato: pagamento salvato, verrà collegato quando inserisci il customer ID nella scheda';
  end if;

  -- mensilità pagate: +1 una sola volta per fattura
  if not v_new.counted and public.payment_is_countable(v_new.status, v_new.amount_cents, v_new.stripe_subscription_id, v_new.billing_reason) then
    update public.payments set counted = true where id = v_new.id;
    update public.clients set paid_months_count = paid_months_count + 1 where id = v_new.client_id;
  end if;

  if p_paid then
    update public.clients
       set last_payment_status = 'pagato',
           last_payment_at     = greatest(coalesce(last_payment_at, v_new.paid_at), v_new.paid_at),
           subscription_status = case when subscription_status = 'scaduto' then subscription_status else 'attivo' end
     where id = v_new.client_id;
    return 'pagato';
  else
    update public.clients
       set last_payment_status = 'fallito',
           last_payment_at     = now(),
           subscription_status = case when subscription_status = 'scaduto' then subscription_status else 'in_rinnovo' end
     where id = v_new.client_id;
    return 'fallito';
  end if;
end $$;

-- ---------- customer.subscription.updated / .deleted ----------
create or replace function public.stripe_apply_subscription(
  p_event_id text, p_event_type text, p_customer text, p_subscription text, p_status text, p_unit_amount_cents int)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_client uuid;
  v_state  public.subscription_status;
begin
  insert into public.stripe_events (id, type) values (p_event_id, p_event_type) on conflict (id) do nothing;
  if not found then return 'duplicato'; end if;

  v_client := public.stripe_client_id(p_customer, p_subscription);
  if v_client is null then return 'cliente non trovato'; end if;

  v_state := case
    when p_event_type = 'customer.subscription.deleted'               then 'scaduto'
    when p_status in ('active', 'trialing')                           then 'attivo'
    when p_status in ('past_due', 'unpaid', 'incomplete', 'paused')   then 'in_rinnovo'
    when p_status in ('canceled', 'incomplete_expired')               then 'scaduto'
  end::public.subscription_status;

  update public.clients set
    subscription_status    = coalesce(v_state, subscription_status),
    stripe_customer_id     = coalesce(stripe_customer_id, p_customer),
    stripe_subscription_id = coalesce(stripe_subscription_id, p_subscription),
    -- tariffa attuale = prezzo dell'abbonamento su Stripe (es. dopo un cambio prezzo)
    monthly_rate = case when p_unit_amount_cents is not null and p_event_type <> 'customer.subscription.deleted'
                        then round(p_unit_amount_cents / 100.0, 2) else monthly_rate end
  where id = v_client;

  return coalesce(v_state::text, 'stato invariato (' || coalesce(p_status, '?') || ')');
end $$;

-- ---------- pagamenti arrivati prima che il cliente avesse gli ID Stripe ----------
-- Quando inserisci customer o subscription ID nella scheda, i pagamenti già ricevuti
-- vengono collegati e conteggiati.
create or replace function public.link_orphan_payments()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_new_months int;
  v_last public.payments;
begin
  if new.stripe_customer_id is null and new.stripe_subscription_id is null then return null; end if;

  select count(*) into v_new_months from public.payments p
   where p.client_id is null and not p.counted
     and ((new.stripe_subscription_id is not null and p.stripe_subscription_id = new.stripe_subscription_id)
       or (new.stripe_customer_id is not null and p.stripe_customer_id = new.stripe_customer_id))
     and public.payment_is_countable(p.status, p.amount_cents, p.stripe_subscription_id, p.billing_reason);

  update public.payments p
     set client_id = new.id,
         counted = p.counted or public.payment_is_countable(p.status, p.amount_cents, p.stripe_subscription_id, p.billing_reason)
   where p.client_id is null
     and ((new.stripe_subscription_id is not null and p.stripe_subscription_id = new.stripe_subscription_id)
       or (new.stripe_customer_id is not null and p.stripe_customer_id = new.stripe_customer_id));
  if not found then return null; end if;

  select * into v_last from public.payments where client_id = new.id
   order by coalesce(paid_at, created_at) desc limit 1;

  update public.clients set
    paid_months_count   = paid_months_count + v_new_months,
    last_payment_status = coalesce(v_last.status, last_payment_status),
    last_payment_at     = coalesce(v_last.paid_at, v_last.created_at, last_payment_at)
  where id = new.id;
  return null;
end $$;

create trigger clients_link_orphan_payments
  after insert or update of stripe_customer_id, stripe_subscription_id on public.clients
  for each row execute function public.link_orphan_payments();

-- solo la funzione lato server (service_role) può registrare eventi Stripe
revoke execute on function public.stripe_apply_invoice(text, text, text, text, text, text, boolean, int, text, timestamptz, timestamptz, timestamptz) from public, anon, authenticated;
revoke execute on function public.stripe_apply_subscription(text, text, text, text, text, int) from public, anon, authenticated;
revoke execute on function public.stripe_client_id(text, text) from public, anon, authenticated;
grant  execute on function public.stripe_apply_invoice(text, text, text, text, text, text, boolean, int, text, timestamptz, timestamptz, timestamptz) to service_role;
grant  execute on function public.stripe_apply_subscription(text, text, text, text, text, int) to service_role;
grant  execute on function public.stripe_client_id(text, text) to service_role;
