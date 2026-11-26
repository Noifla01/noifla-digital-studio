-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 8: promo «Porta un amico»)
-- Da eseguire dopo 20261121010000_avvisi_ticket.sql.
--
-- Ogni cliente ha un codice amico di 6 caratteri. Quando un nuovo cliente
-- indica chi lo ha presentato e paga il primo canone:
--   - l'amico riceve 1 mese gratis (il secondo canone);
--   - chi lo ha presentato riceve 1 mese gratis (fino a 12 all'anno);
--   - al 3° amico portato, chi presenta riceve anche una targhetta recensioni.
-- I mesi gratis diventano un credito sul saldo del cliente su Stripe: il webhook
-- lo crea al pagamento successivo di un qualsiasi cliente, solo per chi è in regola.
-- I mesi gratis non contano come mensilità pagate (36 mesi), ma azzerano le
-- modifiche incluse come un normale rinnovo.
-- Regolamento pubblico: porta-un-amico.html
-- =====================================================================

-- ---------- impostazioni ----------
alter table public.settings
  add column referral_enabled         boolean not null default true,
  add column referral_max_months_year int     not null default 12 check (referral_max_months_year >= 0), -- mesi gratis massimi all'anno per chi presenta
  add column referral_gift_at         int     not null default 3  check (referral_gift_at > 0);          -- al n-esimo amico arriva la targhetta

-- ---------- codice amico e presentatore ----------
alter table public.clients
  add column referral_code text unique check (referral_code ~ '^[A-Z2-9]{6}$'),
  add column referred_by   uuid references public.clients (id) on delete set null,
  add constraint clients_no_self_referral check (referred_by is distinct from id);
create index clients_referred_by_idx on public.clients (referred_by) where referred_by is not null;

-- codice di 6 caratteri senza lettere ambigue (niente O/0, I/1)
create or replace function public.new_referral_code()
returns text
language plpgsql
volatile
set search_path = ''
as $$
declare
  a text := 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  v text;
begin
  loop
    v := '';
    for i in 1..6 loop
      v := v || substr(a, 1 + floor(random() * 32)::int, 1);
    end loop;
    exit when not exists (select 1 from public.clients where referral_code = v);
  end loop;
  return v;
end $$;

create or replace function public.clients_default_referral_code()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.referral_code is null then new.referral_code := public.new_referral_code(); end if;
  return new;
end $$;

create trigger clients_default_referral_code before insert on public.clients
  for each row execute function public.clients_default_referral_code();

-- codici per i clienti già presenti
do $$
declare r record;
begin
  for r in select id from public.clients where referral_code is null loop
    update public.clients set referral_code = public.new_referral_code() where id = r.id;
  end loop;
end $$;

-- ---------- premi ----------
create type public.referral_reward_kind   as enum ('mese_amico', 'mese_presentatore', 'targhetta');
create type public.referral_reward_status as enum ('da_applicare', 'applicato', 'annullato');

create table public.referral_rewards (
  id                     bigint generated always as identity primary key,
  referral_client_id     uuid not null references public.clients (id) on delete cascade, -- l'amico che ha generato il premio
  beneficiary_id         uuid not null references public.clients (id) on delete cascade, -- chi riceve il premio
  kind                   public.referral_reward_kind not null,
  status                 public.referral_reward_status not null default 'da_applicare',
  amount_cents           int  not null default 0 check (amount_cents >= 0),             -- credito dato su Stripe
  stripe_balance_txn_id  text unique,
  note                   text,
  created_at             timestamptz not null default now(),
  applied_at             timestamptz,
  updated_at             timestamptz not null default now(),
  unique (referral_client_id, beneficiary_id, kind)                                      -- un premio di ogni tipo per amico
);
create index referral_rewards_beneficiary_idx on public.referral_rewards (beneficiary_id, created_at desc);
create index referral_rewards_pending_idx on public.referral_rewards (status) where status = 'da_applicare';

create trigger referral_rewards_touch before update on public.referral_rewards
  for each row execute function public.touch_updated_at();

-- data di applicazione gestita in automatico
create or replace function public.referral_rewards_applied_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status = 'applicato' then new.applied_at := coalesce(new.applied_at, now());
  else new.applied_at := null;
  end if;
  return new;
end $$;

create trigger referral_rewards_applied_at before insert or update of status on public.referral_rewards
  for each row execute function public.referral_rewards_applied_at();

-- ---------- regole sul presentatore ----------
-- Si indica solo per un cliente nuovo (al massimo il primo canone pagato), mai sé stessi,
-- solo con un presentatore attivo, e non si cambia dopo che i premi sono stati creati.
create or replace function public.clients_check_referrer()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare r public.clients;
begin
  if tg_op = 'UPDATE' and new.referred_by is not distinct from old.referred_by then return new; end if;
  -- il presentatore è stato cancellato dal gestionale: il collegamento si toglie da solo
  if tg_op = 'UPDATE' and new.referred_by is null
     and not exists (select 1 from public.clients where id = old.referred_by) then return new; end if;

  if tg_op = 'UPDATE' and exists (select 1 from public.referral_rewards where referral_client_id = new.id) then
    raise exception 'i premi per questo amico sono già stati creati: annullali prima di cambiare chi lo ha presentato' using errcode = 'P0001';
  end if;
  if new.referred_by is null then return new; end if;

  if new.referred_by = new.id then
    raise exception 'un cliente non può presentare sé stesso' using errcode = 'P0001';
  end if;
  if new.paid_months_count > 1 then
    raise exception 'il presentatore si indica solo per un cliente nuovo, entro il primo canone pagato' using errcode = 'P0001';
  end if;
  select * into r from public.clients where id = new.referred_by;
  if not found then raise exception 'presentatore non trovato' using errcode = 'P0001'; end if;
  if r.subscription_status = 'scaduto' then
    raise exception '% non ha un abbonamento attivo: non può presentare nuovi clienti', r.business_name using errcode = 'P0001';
  end if;
  if r.referred_by = new.id then
    raise exception '% è stato presentato da questo cliente: non possono presentarsi a vicenda', r.business_name using errcode = 'P0001';
  end if;
  return new;
end $$;

create trigger clients_check_referrer before insert or update of referred_by on public.clients
  for each row execute function public.clients_check_referrer();

-- ---------- creazione dei premi al primo canone dell'amico ----------
create or replace function public.referral_create_rewards(p_friend uuid)
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.settings;
  f public.clients;
  r public.clients;
  v_year int;
  v_friends int;
  n int := 0;
  k int;
begin
  select * into s from public.settings where id = 1;
  if not s.referral_enabled then return 0; end if;
  select * into f from public.clients where id = p_friend;
  if not found or f.referred_by is null or f.paid_months_count < 1 then return 0; end if;
  select * into r from public.clients where id = f.referred_by;
  if not found then return 0; end if;

  -- l'amico: il secondo canone è gratis
  insert into public.referral_rewards (referral_client_id, beneficiary_id, kind, note)
  values (f.id, f.id, 'mese_amico', 'Mese gratis: presentato da ' || r.business_name)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  -- chi presenta: 1 mese gratis, entro il limite annuo
  select count(*) into v_year from public.referral_rewards
   where beneficiary_id = r.id and kind = 'mese_presentatore' and status <> 'annullato'
     and created_at > now() - interval '1 year';
  insert into public.referral_rewards (referral_client_id, beneficiary_id, kind, status, note)
  values (f.id, r.id, 'mese_presentatore',
          case when v_year >= s.referral_max_months_year then 'annullato' else 'da_applicare' end::public.referral_reward_status,
          case when v_year >= s.referral_max_months_year
               then format('Ha presentato %s, ma ha già ricevuto %s mesi gratis negli ultimi 12 mesi (limite raggiunto)', f.business_name, v_year)
               else 'Mese gratis: ha presentato ' || f.business_name end)
  on conflict do nothing;
  get diagnostics k = row_count; n := n + k;

  -- targhetta al n-esimo amico che ha pagato (contano anche quelli oltre il limite dei mesi)
  select count(*) into v_friends from public.referral_rewards where beneficiary_id = r.id and kind = 'mese_presentatore';
  if v_friends = s.referral_gift_at
     and not exists (select 1 from public.referral_rewards where beneficiary_id = r.id and kind = 'targhetta') then
    insert into public.referral_rewards (referral_client_id, beneficiary_id, kind, note)
    values (f.id, r.id, 'targhetta', format('Targhetta recensioni in regalo: %s° amico presentato', v_friends))
    on conflict do nothing;
    get diagnostics k = row_count; n := n + k;
  end if;

  -- traccia nel registro di entrambi
  if n > 0 then
    insert into public.client_notes (client_id, kind, body) values
      (f.id, 'accordo', 'Porta un amico: presentato da ' || r.business_name || '. Il secondo canone è gratis.'),
      (r.id, 'accordo', 'Porta un amico: ha presentato ' || f.business_name || '.');
  end if;
  return n;
end $$;

-- scatta quando l'amico paga il primo canone, o quando il presentatore viene indicato dopo
create or replace function public.clients_referral_rewards()
returns trigger language plpgsql security definer set search_path = '' as $$
begin
  if new.referred_by is not null and new.paid_months_count >= 1
     and (tg_op = 'INSERT' or old.paid_months_count < 1 or old.referred_by is distinct from new.referred_by) then
    perform public.referral_create_rewards(new.id);
  end if;
  return null;
end $$;

create trigger clients_referral_rewards
  after insert or update of paid_months_count, referred_by on public.clients
  for each row execute function public.clients_referral_rewards();

-- ---------- vista della dashboard ----------
-- Ricreata per includere le nuove colonne e i conteggi della promo.
-- Le modifiche incluse ripartono anche da un rinnovo a 0€ (mese gratis): è un normale
-- periodo di abbonamento, anche se non conta come mensilità pagata.
drop view public.client_overview;

create view public.client_overview
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
  coalesce(rw.pending, 0)::int                                             as referral_pending
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
) rw on true;

revoke all on public.client_overview from public, anon;
grant select on public.client_overview to authenticated;

-- ---------- premi da accreditare su Stripe (usate dal webhook, service_role) ----------
-- Restituisce i mesi gratis pronti: cliente collegato a Stripe, abbonamento attivo e
-- ultimo pagamento non fallito. Chi è scaduto perde il premio; chi è in ritardo
-- lo riceve dopo aver regolarizzato. L'importo è la sua tariffa attuale.
create or replace function public.referral_pending_credits()
returns table (id bigint, kind public.referral_reward_kind, beneficiary_id uuid, business_name text,
               stripe_customer_id text, amount_cents int, note text)
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.referral_rewards rr
     set status = 'annullato',
         note = coalesce(rr.note || '. ', '') || 'Annullato: abbonamento cessato prima dell''accredito'
    from public.clients c
   where c.id = rr.beneficiary_id and rr.status = 'da_applicare'
     and rr.kind in ('mese_amico', 'mese_presentatore') and c.subscription_status = 'scaduto';

  return query
  select rr.id, rr.kind, c.id, c.business_name, c.stripe_customer_id,
         round(coalesce(c.monthly_rate, 0) * 100)::int, rr.note
    from public.referral_rewards rr
    join public.clients c on c.id = rr.beneficiary_id
   where rr.status = 'da_applicare'
     and rr.kind in ('mese_amico', 'mese_presentatore')
     and c.stripe_customer_id is not null
     and c.subscription_status = 'attivo'
     and c.last_payment_status is distinct from 'fallito'
     and coalesce(c.monthly_rate, 0) > 0
   order by rr.created_at
   limit 50;
end $$;

-- segna il premio come accreditato su Stripe (dopo la creazione del credito)
create or replace function public.mark_referral_applied(p_id bigint, p_txn text, p_amount_cents int)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
begin
  update public.referral_rewards
     set status = 'applicato', stripe_balance_txn_id = p_txn, amount_cents = coalesce(p_amount_cents, 0)
   where id = p_id and status = 'da_applicare';
  return found;
end $$;

-- ---------- funzione per il gestionale (solo admin) ----------
-- indica (o toglie, con codice vuoto) chi ha presentato un cliente, partendo dal codice amico
create or replace function public.set_client_referrer(p_client_id uuid, p_code text)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_code text := upper(regexp_replace(coalesce(p_code, ''), '[^A-Za-z0-9]', '', 'g'));
  v_ref  public.clients;
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  if v_code = '' then
    update public.clients set referred_by = null where id = p_client_id;
    if not found then raise exception 'cliente non trovato'; end if;
    return null;
  end if;
  select * into v_ref from public.clients where referral_code = v_code;
  if not found then raise exception 'nessun cliente ha il codice amico %', v_code using errcode = 'P0001'; end if;
  update public.clients set referred_by = v_ref.id where id = p_client_id;
  if not found then raise exception 'cliente non trovato'; end if;
  return v_ref.business_name;
end $$;

-- ---------- area clienti: codice e premi ----------
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
alter table public.referral_rewards enable row level security;
create policy "admin vede i premi"      on public.referral_rewards for select to authenticated using (public.is_admin());
create policy "admin aggiorna i premi"  on public.referral_rewards for update to authenticated using (public.is_admin()) with check (public.is_admin());
revoke all on public.referral_rewards from anon;
grant select, update (status, note) on public.referral_rewards to authenticated;

revoke execute on function public.new_referral_code() from public, anon, authenticated;
revoke execute on function public.referral_create_rewards(uuid) from public, anon, authenticated;
revoke execute on function public.referral_pending_credits() from public, anon, authenticated;
revoke execute on function public.mark_referral_applied(bigint, text, int) from public, anon, authenticated;
revoke execute on function public.set_client_referrer(uuid, text) from public, anon;
grant  execute on function public.referral_pending_credits() to service_role;
grant  execute on function public.mark_referral_applied(bigint, text, int) to service_role;
grant  execute on function public.set_client_referrer(uuid, text) to authenticated;
