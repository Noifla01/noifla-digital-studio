-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 9: pacchetto annuale 12+2)
-- Da eseguire dopo 20261126000000_porta_un_amico.sql.
--
-- Il cliente paga in anticipo 12 canoni e riceve 14 periodi di servizio.
-- Come funziona:
--   1. dal gestionale si crea una fattura Stripe da 12 canoni (funzione annual-package);
--   2. quando il cliente la paga, il webhook carica sul saldo Stripe un credito pari a
--      14 canoni (12 pagati + 2 in regalo);
--   3. le fatture mensili dell'abbonamento diventano da 0€ finché il credito copre il canone.
-- Ogni rinnovo da 0€ coperto dal pacchetto consuma un mese: i primi 12 contano come
-- mensilità pagate (36 mesi), gli ultimi 2 sono in regalo e non contano.
-- Le modifiche incluse ripartono a ogni rinnovo, come sempre (anche a 0€).
-- Il pacchetto non è rimborsabile: se il cliente disdice, il servizio resta attivo fino alla
-- fine dei 14 canoni. Solo se chiude il Fornitore si rimborsa la parte non goduta, in proporzione.
-- =====================================================================

-- ---------- impostazioni ----------
alter table public.settings
  add column package_enabled        boolean not null default true,
  add column package_paid_months    int     not null default 12 check (package_paid_months > 0),  -- canoni pagati in anticipo
  add column package_gift_months    int     not null default 2  check (package_gift_months >= 0), -- canoni in regalo
  add column package_days_until_due int     not null default 7  check (package_days_until_due between 1 and 60);

-- ---------- pacchetti ----------
-- in_attesa: fattura inviata, non ancora pagata
-- pagato:    fattura pagata, credito ancora da caricare su Stripe (lo fa il webhook)
-- attivo:    credito caricato, le fatture mensili sono da 0€
-- concluso:  tutti i mesi del pacchetto sono stati usati
-- annullato: fattura annullata prima del pagamento, oppure contratto chiuso prima della fine
create type public.package_status as enum ('in_attesa', 'pagato', 'attivo', 'concluso', 'annullato');

create table public.annual_packages (
  id                     bigint generated always as identity primary key,
  client_id              uuid not null references public.clients (id) on delete cascade,
  status                 public.package_status not null default 'in_attesa',
  plan                   public.plan_type not null,
  monthly_rate_cents     int  not null check (monthly_rate_cents > 0),  -- canone del cliente quando ha comprato il pacchetto
  paid_months            int  not null check (paid_months > 0),
  gift_months            int  not null check (gift_months >= 0),
  amount_cents           int  not null check (amount_cents > 0),        -- importo della fattura (canoni pagati)
  credit_cents           int,                                           -- credito caricato su Stripe (pagato + regalo)
  months_used            int  not null default 0 check (months_used >= 0),
  months_counted         int  not null default 0 check (months_counted >= 0), -- quanti hanno contato come mensilità pagate
  stripe_invoice_id      text unique,
  stripe_invoice_url     text,
  stripe_balance_txn_id  text,
  note                   text,
  created_at             timestamptz not null default now(),
  paid_at                timestamptz,
  credited_at            timestamptz,
  closed_at              timestamptz,
  updated_at             timestamptz not null default now()
);
-- un solo pacchetto aperto per cliente
create unique index annual_packages_one_open on public.annual_packages (client_id)
  where status in ('in_attesa', 'pagato', 'attivo');
create index annual_packages_client_idx on public.annual_packages (client_id, created_at desc);

create trigger annual_packages_touch before update on public.annual_packages
  for each row execute function public.touch_updated_at();

-- quale pacchetto ha coperto un rinnovo da 0€ (così non si conta due volte)
alter table public.payments add column annual_package_id bigint references public.annual_packages (id) on delete set null;

-- ---------- consumo dei mesi ----------
-- Un rinnovo dell'abbonamento pagato a 0€ mentre c'è un pacchetto attivo consuma un mese.
-- I primi `paid_months` contano come mensilità pagate. Se nello stesso periodo il cliente
-- ha anche un mese gratis «Porta un amico», i mesi a 0€ si attribuiscono prima al pacchetto:
-- il totale delle mensilità contate resta comunque giusto.
create or replace function public.payments_consume_package()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_pkg   public.annual_packages;
  v_count boolean;
begin
  if new.client_id is null or new.annual_package_id is not null or new.counted
     or new.status <> 'pagato' or coalesce(new.amount_cents, 0) <> 0
     or new.stripe_subscription_id is null
     or coalesce(new.billing_reason, '') not in ('subscription_create', 'subscription_cycle') then
    return null;
  end if;

  select * into v_pkg from public.annual_packages
   where client_id = new.client_id and status = 'attivo'
     and months_used < paid_months + gift_months
   order by credited_at, id
   limit 1
   for update;
  if not found then return null; end if;

  v_count := v_pkg.months_counted < v_pkg.paid_months;
  update public.annual_packages set
    months_used    = months_used + 1,
    months_counted = months_counted + case when v_count then 1 else 0 end,
    status         = case when months_used + 1 >= paid_months + gift_months then 'concluso' else status end,
    closed_at      = case when months_used + 1 >= paid_months + gift_months then now() else closed_at end
  where id = v_pkg.id;

  update public.payments set annual_package_id = v_pkg.id, counted = v_count where id = new.id;
  if v_count then
    update public.clients set paid_months_count = paid_months_count + 1 where id = new.client_id;
  end if;
  return null;
end $$;

create trigger payments_consume_package
  after insert or update of status, client_id on public.payments
  for each row execute function public.payments_consume_package();

-- ---------- funzioni per il gestionale (solo admin) ----------
-- apre un pacchetto per il cliente; la fattura Stripe la crea subito dopo la funzione annual-package
create or replace function public.package_open(p_client_id uuid)
returns public.annual_packages
language plpgsql
security definer
set search_path = ''
as $$
declare
  s     public.settings;
  c     public.clients;
  v_rate int;
  v_pkg public.annual_packages;
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  select * into s from public.settings where id = 1;
  if not s.package_enabled then raise exception 'Il pacchetto annuale è disattivato nelle impostazioni.' using errcode = 'P0001'; end if;

  select * into c from public.clients where id = p_client_id;
  if not found then raise exception 'cliente non trovato' using errcode = 'P0001'; end if;
  if c.stripe_customer_id is null then
    raise exception 'Inserisci prima lo Stripe customer ID del cliente.' using errcode = 'P0001';
  end if;
  if c.subscription_status = 'scaduto' then
    raise exception 'L''abbonamento è scaduto: riattivalo prima di proporre il pacchetto.' using errcode = 'P0001';
  end if;
  if exists (select 1 from public.annual_packages where client_id = p_client_id and status in ('in_attesa', 'pagato', 'attivo')) then
    raise exception 'Il cliente ha già un pacchetto annuale aperto.' using errcode = 'P0001';
  end if;

  v_rate := round(coalesce(c.monthly_rate,
                           case c.plan when 'piano_completo' then s.rate_completo else s.rate_base end) * 100)::int;
  if v_rate <= 0 then raise exception 'Il cliente non ha una tariffa valida.' using errcode = 'P0001'; end if;

  insert into public.annual_packages (client_id, plan, monthly_rate_cents, paid_months, gift_months, amount_cents)
  values (c.id, c.plan, v_rate, s.package_paid_months, s.package_gift_months, v_rate * s.package_paid_months)
  returning * into v_pkg;
  return v_pkg;
end $$;

-- collega la fattura Stripe appena creata
create or replace function public.package_set_invoice(p_id bigint, p_invoice_id text, p_url text)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  update public.annual_packages set stripe_invoice_id = p_invoice_id, stripe_invoice_url = p_url
   where id = p_id and status = 'in_attesa';
  return found;
end $$;

-- annulla: una fattura non pagata (dopo averla annullata su Stripe) o un pacchetto in corso
-- chiuso prima della fine (risoluzione, o recesso del Fornitore con rimborso fatto a mano su Stripe)
create or replace function public.package_cancel(p_id bigint, p_note text)
returns public.package_status
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.annual_packages;
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  select * into v from public.annual_packages where id = p_id for update;
  if not found then raise exception 'pacchetto non trovato' using errcode = 'P0001'; end if;
  if v.status in ('concluso', 'annullato') then return v.status; end if;
  update public.annual_packages set status = 'annullato', closed_at = now(),
         note = nullif(concat_ws('. ', note, nullif(trim(coalesce(p_note, '')), '')), '')
   where id = p_id;
  if v.status <> 'in_attesa' then
    insert into public.client_notes (client_id, kind, body)
    values (v.client_id, 'accordo', 'Pacchetto annuale chiuso prima della fine dopo ' || v.months_used || ' mesi su '
            || (v.paid_months + v.gift_months) || '.' || coalesce(' ' || nullif(trim(coalesce(p_note, '')), ''), ''));
  end if;
  return 'annullato';
end $$;

-- ---------- funzioni per il webhook (service_role) ----------
-- la fattura del pacchetto è stata pagata: il credito da caricare è pagato + mesi in regalo
create or replace function public.package_mark_paid(p_id bigint, p_invoice_id text, p_total_cents int, p_paid_at timestamptz)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v public.annual_packages;
begin
  select * into v from public.annual_packages where id = p_id for update;
  if not found then return 'pacchetto non trovato'; end if;
  if v.stripe_invoice_id is not null and v.stripe_invoice_id <> p_invoice_id then return 'fattura diversa: ignorato'; end if;
  if v.status <> 'in_attesa' then return 'già registrato (' || v.status || ')'; end if;

  update public.annual_packages set
    status            = 'pagato',
    stripe_invoice_id = p_invoice_id,
    paid_at           = coalesce(p_paid_at, now()),
    credit_cents      = coalesce(nullif(p_total_cents, 0), amount_cents) + gift_months * monthly_rate_cents
  where id = p_id;

  insert into public.client_notes (client_id, kind, body)
  values (v.client_id, 'accordo', 'Pacchetto annuale pagato: ' || v.paid_months || ' canoni + ' || v.gift_months || ' in regalo.');
  return 'pacchetto pagato';
end $$;

-- pacchetti pagati con il credito ancora da caricare su Stripe
create or replace function public.package_pending_credits()
returns table (id bigint, client_id uuid, business_name text, stripe_customer_id text, credit_cents int,
               paid_months int, gift_months int)
language sql
stable
security definer
set search_path = ''
as $$
  select p.id, c.id, c.business_name, c.stripe_customer_id, p.credit_cents, p.paid_months, p.gift_months
    from public.annual_packages p
    join public.clients c on c.id = p.client_id
   where p.status = 'pagato' and c.stripe_customer_id is not null and coalesce(p.credit_cents, 0) > 0
   order by p.paid_at
   limit 50;
$$;

create or replace function public.mark_package_credited(p_id bigint, p_txn text, p_credit_cents int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.annual_packages
     set status = 'attivo', stripe_balance_txn_id = p_txn, credit_cents = coalesce(p_credit_cents, credit_cents), credited_at = now()
   where id = p_id and status = 'pagato';
  return found;
end $$;

-- ---------- vista della dashboard ----------
-- Stesse colonne di prima più quelle del pacchetto (aggiunte in fondo).
create or replace view public.client_overview
with (security_invoker = true) as
with s as (select * from public.settings where id = 1),
month_start as (
  select (date_trunc('month', now() at time zone s.timezone) at time zone s.timezone) as ts from s
)
select
  c.*,
  coalesce(t.changes_used, 0)::int                                         as changes_used_this_month,
  case c.plan when 'piano_completo' then s.monthly_change_quota else 0 end as changes_quota,
  coalesce(t.open_tickets, 0)::int                                         as open_tickets,
  greatest(s.loyalty_months - c.paid_months_count, 0)                      as months_to_loyalty,
  case c.plan when 'piano_completo' then s.loyalty_rate_completo else s.loyalty_rate_base end as loyalty_rate,
  case
    when c.loyalty_rate_applied_at is not null            then 'applicata'
    when c.paid_months_count >= s.loyalty_months          then 'da_applicare'
    when c.paid_months_count >= s.loyalty_warning_from    then 'in_arrivo'
    else null
  end                                                                      as loyalty_state,
  p.since                                                                  as changes_period_start,
  case when p.paid_at is null then 'mese' else 'pagamento' end             as changes_period_kind,
  ref.name                                                                 as referred_by_name,
  ref.code                                                                 as referred_by_code,
  coalesce(rw.friends, 0)::int                                             as referral_friends,
  coalesce(rw.months_applied, 0)::int                                      as referral_months_applied,
  coalesce(rw.pending, 0)::int                                             as referral_pending,
  pk.id                                                                    as package_id,
  pk.status                                                                as package_status,
  pk.months_used                                                           as package_months_used,
  pk.paid_months + pk.gift_months                                          as package_months_total,
  -- rimborso dovuto SOLO se è il Fornitore a chiudere: parte non goduta, in proporzione ai canoni rimasti
  case when pk.status in ('pagato', 'attivo')
       then round(pk.amount_cents::numeric * greatest(pk.paid_months + pk.gift_months - pk.months_used, 0)
                  / (pk.paid_months + pk.gift_months))::int end                    as package_refund_cents,
  -- fine prevista: ultimo periodo coperto + i canoni rimasti da 30 giorni
  case when pk.status = 'attivo'
       then coalesce((select max(py.period_end) from public.payments py where py.annual_package_id = pk.id), pk.credited_at)
            + (pk.paid_months + pk.gift_months - pk.months_used) * interval '30 days' end as package_ends_at
from public.clients c
cross join s
left join lateral (
  select lp.paid_at, coalesce(lp.paid_at, (select ts from month_start)) as since
    from (select max(coalesce(py.paid_at, py.created_at)) as paid_at
            from public.payments py
           where py.client_id = c.id and py.status = 'pagato'
             and (py.counted or (py.stripe_subscription_id is not null
                                 and coalesce(py.billing_reason, '') in ('subscription_create', 'subscription_cycle')))) lp
) p on true
left join lateral (
  select
    count(*) filter (where tk.category = 'modifica_inclusa'
                       and tk.status <> 'rifiutato_extra'
                       and tk.created_at >= p.since)                     as changes_used,
    count(*) filter (where tk.status in ('aperto', 'in_lavorazione'))     as open_tickets
  from public.tickets tk
  where tk.client_id = c.id
) t on true
left join lateral (
  select x.business_name as name, x.referral_code as code from public.clients x where x.id = c.referred_by
) ref on true
left join lateral (
  select
    count(*) filter (where rr.kind = 'mese_presentatore')                                  as friends,
    count(*) filter (where rr.kind in ('mese_presentatore', 'mese_amico') and rr.status = 'applicato') as months_applied,
    count(*) filter (where rr.status = 'da_applicare')                                     as pending
  from public.referral_rewards rr
  where rr.beneficiary_id = c.id
) rw on true
left join lateral (
  -- il pacchetto aperto, altrimenti l'ultimo
  select ap.* from public.annual_packages ap
   where ap.client_id = c.id
   order by (ap.status in ('in_attesa', 'pagato', 'attivo')) desc, ap.created_at desc
   limit 1
) pk on true;

-- ---------- area clienti: pacchetto ----------
create or replace function public.client_portal(p_token text)
returns json
language plpgsql
stable
security definer
set search_path = ''
as $$
declare
  v_id uuid := public.portal_client_id(p_token);
  v json;
begin
  select json_build_object(
    'business_name',  o.business_name,
    'plan',           o.plan,
    'subscription_status', o.subscription_status,
    'changes_used',   o.changes_used_this_month,
    'changes_quota',  o.changes_quota,
    'changes_since',  o.changes_period_start,
    'changes_period', o.changes_period_kind,
    'can_open',       o.subscription_status <> 'scaduto',
    'referral', json_build_object(
      'enabled',        s.referral_enabled and o.subscription_status <> 'scaduto',
      'code',           o.referral_code,
      'friends',        o.referral_friends,
      'months_applied', o.referral_months_applied,
      'pending',        o.referral_pending,
      'gift_at',        s.referral_gift_at,
      'max_months',     s.referral_max_months_year),
    'package', json_build_object(
      'offer',        s.package_enabled and o.subscription_status <> 'scaduto'
                      and coalesce(o.package_status::text, '') not in ('in_attesa', 'pagato', 'attivo'),
      'status',       o.package_status,
      'months_used',  o.package_months_used,
      'months_total', o.package_months_total,
      'ends_at',      o.package_ends_at,
      'paid_months',  s.package_paid_months,
      'gift_months',  s.package_gift_months,
      'invoice_url',  case when o.package_status = 'in_attesa'
                           then (select ap.stripe_invoice_url from public.annual_packages ap where ap.id = o.package_id) end),
    'tickets', coalesce((
      select json_agg(json_build_object(
               'id', t.id, 'title', t.title, 'description', t.description,
               'category', t.category, 'status', t.status,
               'created_at', t.created_at, 'closed_at', t.closed_at)
             order by t.created_at desc)
        from (select * from public.tickets where client_id = v_id order by created_at desc limit 50) t
    ), '[]'::json)
  ) into v
  from public.client_overview o
  cross join public.settings s
  where o.id = v_id and s.id = 1;
  return v;
end $$;
-- i permessi di client_portal restano quelli già dati (create or replace non li cambia)

-- ---------- permessi ----------
alter table public.annual_packages enable row level security;
create policy "admin vede i pacchetti" on public.annual_packages for select to authenticated using (public.is_admin());
revoke all on public.annual_packages from anon;
revoke insert, update, delete on public.annual_packages from authenticated;
grant select on public.annual_packages to authenticated;

revoke execute on function public.payments_consume_package() from public, anon, authenticated;
revoke execute on function public.package_open(uuid) from public, anon;
revoke execute on function public.package_set_invoice(bigint, text, text) from public, anon;
revoke execute on function public.package_cancel(bigint, text) from public, anon;
revoke execute on function public.package_mark_paid(bigint, text, int, timestamptz) from public, anon, authenticated;
revoke execute on function public.package_pending_credits() from public, anon, authenticated;
revoke execute on function public.mark_package_credited(bigint, text, int) from public, anon, authenticated;
grant  execute on function public.package_open(uuid) to authenticated;
grant  execute on function public.package_set_invoice(bigint, text, text) to authenticated;
grant  execute on function public.package_cancel(bigint, text) to authenticated;
grant  execute on function public.package_mark_paid(bigint, text, int, timestamptz) to service_role;
grant  execute on function public.package_pending_credits() to service_role;
grant  execute on function public.mark_package_credited(bigint, text, int) to service_role;
