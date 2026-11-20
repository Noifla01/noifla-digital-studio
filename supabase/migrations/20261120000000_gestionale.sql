-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 1: schema del database)
-- Da eseguire una volta nell'editor SQL di Supabase (o con `supabase db push`).
--
-- Contiene: clienti, registro note, ticket, pagamenti Stripe, eventi Stripe,
-- impostazioni, vista riepilogo per la dashboard e permessi (RLS).
-- Solo gli utenti presenti nella tabella `admins` leggono e scrivono.
-- I clienti non hanno accesso diretto: i ticket arrivano tramite una funzione
-- lato server (passo 3) che verifica il loro link personale.
-- =====================================================================

-- ---------- tipi ----------
create type public.plan_type as enum ('piano_base', 'piano_completo');
create type public.subscription_status as enum ('attivo', 'in_rinnovo', 'scaduto');
create type public.payment_state as enum ('pagato', 'fallito', 'in_attesa');
create type public.ticket_category as enum ('modifica_inclusa', 'extra_preventivo', 'bug_assistenza');
create type public.ticket_status as enum ('aperto', 'in_lavorazione', 'completato', 'rifiutato_extra');
create type public.note_kind as enum ('intervista', 'accordo', 'specifica', 'altro');

-- ---------- impostazioni (una sola riga) ----------
create table public.settings (
  id                     smallint primary key default 1 check (id = 1),
  loyalty_months         int     not null default 36 check (loyalty_months > 0),       -- mensilità dopo cui la tariffa scende
  loyalty_warning_from   int     not null default 34 check (loyalty_warning_from > 0), -- da quale mensilità mostrare l'avviso
  monthly_change_quota   int     not null default 3  check (monthly_change_quota >= 0),-- modifiche incluse nel Completo
  rate_completo          numeric(8,2) not null default 49,
  rate_base              numeric(8,2) not null default 29,
  loyalty_rate_completo  numeric(8,2) not null default 29,
  loyalty_rate_base      numeric(8,2) not null default 24,
  timezone               text    not null default 'Europe/Rome'
);
insert into public.settings (id) values (1);

-- ---------- amministratori ----------
create table public.admins (
  user_id    uuid primary key references auth.users (id) on delete cascade,
  created_at timestamptz not null default now()
);

-- vero se chi chiama è un amministratore (usata dalle regole RLS)
create or replace function public.is_admin()
returns boolean
language sql
stable
security definer
set search_path = ''
as $$
  select exists (select 1 from public.admins a where a.user_id = auth.uid());
$$;

-- ---------- clienti ----------
create table public.clients (
  id                       uuid primary key default gen_random_uuid(),
  business_name            text not null check (length(trim(business_name)) > 0),
  contact_name             text,
  email                    text,
  phone                    text,
  site_url                 text,
  contract_start_date      date,                                  -- inizio contratto / primo pagamento
  paid_months_count        int  not null default 0 check (paid_months_count >= 0),
  subscription_status      public.subscription_status not null default 'attivo',
  plan                     public.plan_type not null default 'piano_completo',
  monthly_rate             numeric(8,2) check (monthly_rate >= 0), -- tariffa attuale; se vuota prende quella del piano
  loyalty_rate_applied_at  timestamptz,                            -- quando è stata applicata la tariffa dopo 36 mesi
  last_payment_status      public.payment_state,
  last_payment_at          timestamptz,
  stripe_customer_id       text unique,
  stripe_subscription_id   text unique,
  ticket_token_hash        text unique,                            -- sha256 del link ticket: il link in chiaro non si salva
  ticket_token_created_at  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now()
);
create index clients_status_idx on public.clients (subscription_status);

-- ---------- registro note (intervista iniziale, accordi, specifiche) ----------
create table public.client_notes (
  id          bigint generated always as identity primary key,
  client_id   uuid not null references public.clients (id) on delete cascade,
  kind        public.note_kind not null default 'accordo',
  body        text not null check (length(trim(body)) > 0),
  created_at  timestamptz not null default now(),
  created_by  uuid default auth.uid()
);
create index client_notes_client_idx on public.client_notes (client_id, created_at desc);

-- ---------- ticket ----------
create table public.tickets (
  id           bigint generated always as identity primary key,
  client_id    uuid not null references public.clients (id) on delete cascade,
  title        text not null check (length(trim(title)) > 0),
  description  text,
  category     public.ticket_category not null default 'modifica_inclusa',
  status       public.ticket_status   not null default 'aperto',
  source       text not null default 'admin' check (source in ('admin', 'cliente')),
  admin_notes  text,
  created_at   timestamptz not null default now(),
  closed_at    timestamptz,
  updated_at   timestamptz not null default now()
);
create index tickets_client_idx on public.tickets (client_id, created_at desc);
create index tickets_status_idx on public.tickets (status);

-- ---------- pagamenti (una riga per fattura Stripe) ----------
create table public.payments (
  id                 bigint generated always as identity primary key,
  client_id          uuid references public.clients (id) on delete set null,
  stripe_invoice_id  text not null unique,
  amount_cents       int  not null default 0,
  currency           text not null default 'eur',
  status             public.payment_state not null,
  period_start       timestamptz,
  period_end         timestamptz,
  paid_at            timestamptz,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now()
);
create index payments_client_idx on public.payments (client_id, created_at desc);

-- ---------- eventi Stripe già elaborati (Stripe può inviare due volte lo stesso evento) ----------
create table public.stripe_events (
  id           text primary key,      -- evt_...
  type         text not null,
  received_at  timestamptz not null default now()
);

-- =====================================================================
-- TRIGGER
-- =====================================================================
create or replace function public.touch_updated_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  new.updated_at := now();
  return new;
end $$;

create trigger clients_touch  before update on public.clients  for each row execute function public.touch_updated_at();
create trigger tickets_touch  before update on public.tickets  for each row execute function public.touch_updated_at();
create trigger payments_touch before update on public.payments for each row execute function public.touch_updated_at();

-- tariffa di partenza in base al piano, se non indicata
create or replace function public.clients_default_rate()
returns trigger language plpgsql set search_path = '' as $$
declare s public.settings;
begin
  if new.monthly_rate is null then
    select * into s from public.settings where id = 1;
    new.monthly_rate := case new.plan when 'piano_completo' then s.rate_completo else s.rate_base end;
  end if;
  return new;
end $$;

create trigger clients_default_rate before insert on public.clients
  for each row execute function public.clients_default_rate();

-- data di chiusura del ticket gestita in automatico
create or replace function public.tickets_closed_at()
returns trigger language plpgsql set search_path = '' as $$
begin
  if new.status in ('completato', 'rifiutato_extra') then
    if tg_op = 'INSERT' or old.status is distinct from new.status then
      new.closed_at := coalesce(new.closed_at, now());
    end if;
  else
    new.closed_at := null;
  end if;
  return new;
end $$;

create trigger tickets_closed_at before insert or update of status on public.tickets
  for each row execute function public.tickets_closed_at();

-- =====================================================================
-- VISTA PER LA DASHBOARD
-- Mese solare corrente calcolato nel fuso orario delle impostazioni (Europe/Rome).
-- Le modifiche contate sono i ticket "modifica inclusa" aperti nel mese, esclusi i rifiutati.
-- =====================================================================
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
  end                                                                      as loyalty_state
from public.clients c
cross join s
left join lateral (
  select
    count(*) filter (where tk.category = 'modifica_inclusa'
                       and tk.status <> 'rifiutato_extra'
                       and tk.created_at >= (select ts from month_start)) as changes_used,
    count(*) filter (where tk.status in ('aperto', 'in_lavorazione'))     as open_tickets
  from public.tickets tk
  where tk.client_id = c.id
) t on true;

-- =====================================================================
-- FUNZIONI RICHIAMABILI DALLA DASHBOARD (solo admin)
-- =====================================================================

-- crea (o rigenera) il link ticket del cliente; restituisce il token in chiaro una sola volta
create or replace function public.rotate_ticket_token(p_client_id uuid)
returns text
language plpgsql
security definer
set search_path = ''
as $$
declare v_token text;
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  v_token := replace(gen_random_uuid()::text, '-', '') || replace(gen_random_uuid()::text, '-', '');
  update public.clients
     set ticket_token_hash = encode(sha256(convert_to(v_token, 'UTF8')), 'hex'),
         ticket_token_created_at = now()
   where id = p_client_id;
  if not found then raise exception 'cliente non trovato'; end if;
  return v_token;
end $$;

-- registra la tariffa ridotta dopo le 36 mensilità e la annota nel registro del cliente
-- (l'aggiornamento su Stripe arriva al passo 5, con una funzione lato server)
create or replace function public.apply_loyalty_rate(p_client_id uuid)
returns numeric
language plpgsql
security definer
set search_path = ''
as $$
declare
  s public.settings;
  c public.clients;
  v_new numeric(8,2);
begin
  if not public.is_admin() then raise exception 'non autorizzato' using errcode = '42501'; end if;
  select * into s from public.settings where id = 1;
  select * into c from public.clients where id = p_client_id for update;
  if not found then raise exception 'cliente non trovato'; end if;
  if c.loyalty_rate_applied_at is not null then raise exception 'tariffa già applicata il %', c.loyalty_rate_applied_at; end if;
  if c.paid_months_count < s.loyalty_months then
    raise exception 'il cliente ha pagato % mensilità su %: la tariffa ridotta si applica dopo la %ª',
      c.paid_months_count, s.loyalty_months, s.loyalty_months;
  end if;
  v_new := case c.plan when 'piano_completo' then s.loyalty_rate_completo else s.loyalty_rate_base end;
  update public.clients set monthly_rate = v_new, loyalty_rate_applied_at = now() where id = p_client_id;
  insert into public.client_notes (client_id, kind, body)
  values (p_client_id, 'accordo',
          format('Tariffa ridotta da %s€ a %s€ dopo %s mensilità pagate.', c.monthly_rate, v_new, c.paid_months_count));
  return v_new;
end $$;

-- =====================================================================
-- PERMESSI
-- RLS attiva ovunque; nessuna regola per gli utenti anonimi.
-- Le funzioni lato server (webhook Stripe, ticket dei clienti) usano la chiave
-- service_role, che non passa da queste regole.
-- =====================================================================
alter table public.settings      enable row level security;
alter table public.admins        enable row level security;
alter table public.clients       enable row level security;
alter table public.client_notes  enable row level security;
alter table public.tickets       enable row level security;
alter table public.payments      enable row level security;
alter table public.stripe_events enable row level security;

create policy "admin legge le impostazioni"  on public.settings      for select to authenticated using (public.is_admin());
create policy "admin modifica le impostazioni" on public.settings    for update to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin vede gli admin"         on public.admins        for select to authenticated using (public.is_admin());
create policy "admin gestisce i clienti"     on public.clients       for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin gestisce le note"       on public.client_notes  for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin gestisce i ticket"      on public.tickets       for all    to authenticated using (public.is_admin()) with check (public.is_admin());
create policy "admin vede i pagamenti"       on public.payments      for select to authenticated using (public.is_admin());
create policy "admin vede gli eventi stripe" on public.stripe_events for select to authenticated using (public.is_admin());

-- gli utenti anonimi non toccano nulla
revoke all on public.settings, public.admins, public.clients, public.client_notes,
              public.tickets, public.payments, public.stripe_events, public.client_overview from anon;
grant select on public.client_overview to authenticated;

revoke execute on function public.rotate_ticket_token(uuid) from public, anon;
revoke execute on function public.apply_loyalty_rate(uuid)  from public, anon;
grant  execute on function public.rotate_ticket_token(uuid) to authenticated;
grant  execute on function public.apply_loyalty_rate(uuid)  to authenticated;
grant  execute on function public.is_admin() to authenticated;
