-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 5: avvisi email per i 36 mesi)
-- Da eseguire dopo 20261120020000_stripe.sql.
--
-- Dopo ogni pagamento ricevuto, il webhook Stripe chiede quali clienti sono entrati
-- in una nuova fase ("in arrivo" dalla 34ª mensilità, "da applicare" dalla 36ª) e non
-- sono ancora stati segnalati; manda una email all'admin e li segna come segnalati.
-- Ogni fase viene segnalata una volta sola per cliente.
-- =====================================================================

alter table public.clients add column loyalty_notified text
  check (loyalty_notified in ('in_arrivo', 'da_applicare'));

create or replace function public.loyalty_pending_notifications()
returns table (id uuid, business_name text, plan public.plan_type, paid_months_count int,
               months_to_loyalty int, monthly_rate numeric, loyalty_rate numeric, loyalty_state text)
language sql
stable
security definer
set search_path = ''
as $$
  select o.id, o.business_name, o.plan, o.paid_months_count, o.months_to_loyalty,
         o.monthly_rate, o.loyalty_rate, o.loyalty_state
    from public.client_overview o
    join public.clients c on c.id = o.id   -- la vista non include le colonne aggiunte dopo
   where o.loyalty_state in ('in_arrivo', 'da_applicare')
     and o.loyalty_state is distinct from c.loyalty_notified
     and o.subscription_status <> 'scaduto'
   order by o.paid_months_count desc;
$$;

-- segna come segnalata la fase attuale dei clienti indicati (dopo l'invio riuscito dell'email)
create or replace function public.mark_loyalty_notified(p_ids uuid[])
returns int
language plpgsql
security definer
set search_path = ''
as $$
declare n int;
begin
  update public.clients c
     set loyalty_notified = o.loyalty_state
    from public.client_overview o
   where o.id = c.id and c.id = any (p_ids) and o.loyalty_state in ('in_arrivo', 'da_applicare');
  get diagnostics n = row_count;
  return n;
end $$;

revoke execute on function public.loyalty_pending_notifications() from public, anon, authenticated;
revoke execute on function public.mark_loyalty_notified(uuid[]) from public, anon, authenticated;
grant  execute on function public.loyalty_pending_notifications() to service_role;
grant  execute on function public.mark_loyalty_notified(uuid[]) to service_role;
