-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 7: email per ogni nuova richiesta del cliente)
-- Da eseguire dopo 20261121000000_modifiche_dal_pagamento.sql.
--
-- Quando il cliente invia una richiesta dall'area clienti, la pagina avvisa la
-- funzione lato server `ticket-notify`, che legge qui le richieste non ancora
-- segnalate, invia un'email all'admin (Resend) e le segna come segnalate.
-- Una richiesta rimasta indietro (email non partita) viene ritentata al
-- prossimo invio di un qualsiasi cliente.
-- =====================================================================

alter table public.tickets add column notified_at timestamptz;

-- le richieste già presenti non generano email
update public.tickets set notified_at = now() where source = 'cliente';

create index tickets_to_notify_idx on public.tickets (created_at) where source = 'cliente' and notified_at is null;

-- richieste dei clienti ancora da segnalare (le più vecchie prima, al massimo 20 per volta)
create or replace function public.ticket_pending_notifications()
returns table (id bigint, business_name text, contact_name text, phone text, plan public.plan_type,
               category public.ticket_category, title text, description text, created_at timestamptz,
               changes_used int, changes_quota int)
language sql
stable
security definer
set search_path = ''
as $$
  select t.id, o.business_name, o.contact_name, o.phone, o.plan,
         t.category, t.title, t.description, t.created_at,
         o.changes_used_this_month, o.changes_quota
    from public.tickets t
    join public.client_overview o on o.id = t.client_id
   where t.source = 'cliente' and t.notified_at is null
   order by t.created_at
   limit 20;
$$;

create or replace function public.mark_tickets_notified(p_ids bigint[])
returns void
language sql
security definer
set search_path = ''
as $$
  update public.tickets set notified_at = now() where id = any (p_ids) and notified_at is null;
$$;

-- solo la funzione lato server (service_role) legge e segna gli avvisi
revoke execute on function public.ticket_pending_notifications() from public, anon, authenticated;
revoke execute on function public.mark_tickets_notified(bigint[]) from public, anon, authenticated;
grant  execute on function public.ticket_pending_notifications() to service_role;
grant  execute on function public.mark_tickets_notified(bigint[]) to service_role;
grant  execute on function public.portal_client_id(text) to service_role;
