-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 6: modifiche azzerate dal pagamento)
-- Da eseguire dopo 20261120030000_avvisi_36_mesi.sql.
--
-- Prima: le 3 modifiche incluse si contavano nel mese solare.
-- Ora:   si contano dall'ultimo pagamento registrato (una mensilità conteggiata).
--        Ogni rinnovo pagato azzera il contatore; finché il rinnovo non è pagato
--        il contatore non riparte.
--        Clienti senza pagamenti Stripe (es. siti regalati): resta il mese solare.
-- =====================================================================

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
  case when p.paid_at is null then 'mese' else 'pagamento' end             as changes_period_kind
from public.clients c
cross join s
-- inizio del periodo: ultimo pagamento conteggiato come mensilità, altrimenti il mese solare
left join lateral (
  select lp.paid_at, coalesce(lp.paid_at, (select ts from month_start)) as since
    from (select max(coalesce(py.paid_at, py.created_at)) as paid_at
            from public.payments py
           where py.client_id = c.id and py.counted and py.status = 'pagato') lp
) p on true
left join lateral (
  select
    count(*) filter (where tk.category = 'modifica_inclusa'
                       and tk.status <> 'rifiutato_extra'
                       and tk.created_at >= p.since)                     as changes_used,
    count(*) filter (where tk.status in ('aperto', 'in_lavorazione'))     as open_tickets
  from public.tickets tk
  where tk.client_id = c.id
) t on true;

revoke all on public.client_overview from public, anon;
grant select on public.client_overview to authenticated;

-- l'area clienti mostra anche da quando si contano le modifiche
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
  where o.id = v_id;
  return v;
end $$;
-- i permessi di client_portal restano quelli già dati (create or replace non li cambia)
