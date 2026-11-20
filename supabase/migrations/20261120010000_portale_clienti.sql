-- =====================================================================
-- Noifla Digital Studio · gestionale (passo 3: area clienti con link personale)
-- Da eseguire dopo 20261120000000_gestionale.sql.
--
-- Il cliente non ha account: apre ticket.html?t=<token>. La pagina chiama queste
-- due funzioni con la chiave anon; le funzioni cercano il cliente tramite l'hash del
-- token (256 bit casuali, non indovinabili) e restituiscono SOLO i suoi dati.
-- Le tabelle restano chiuse agli anonimi: niente select diretti.
-- =====================================================================

-- cliente associato al token, o errore generico
create or replace function public.portal_client_id(p_token text)
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  if p_token is null or p_token !~ '^[0-9a-f]{64}$' then
    raise exception 'link non valido' using errcode = '28000';
  end if;
  select id into v_id from public.clients
   where ticket_token_hash = encode(sha256(convert_to(p_token, 'UTF8')), 'hex');
  if v_id is null then
    raise exception 'link non valido' using errcode = '28000';
  end if;
  return v_id;
end $$;

-- dati mostrati al cliente: attività, piano, modifiche del mese e storico ticket
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

-- nuovo ticket dal cliente
-- p_kind: 'modifica' | 'nuova_funzionalita' | 'assistenza'
-- Una "modifica" chiesta da un cliente Base diventa extra (modifiche a pagamento, 20€/ora).
create or replace function public.client_portal_create_ticket(p_token text, p_kind text, p_title text, p_description text)
returns json
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_id     uuid := public.portal_client_id(p_token);
  v_client public.clients;
  v_title  text := trim(coalesce(p_title, ''));
  v_desc   text := nullif(trim(coalesce(p_description, '')), '');
  v_cat    public.ticket_category;
  v_recent int;
begin
  select * into v_client from public.clients where id = v_id;
  if v_client.subscription_status = 'scaduto' then
    raise exception 'abbonamento non attivo: contattaci direttamente' using errcode = 'P0001';
  end if;
  if length(v_title) < 3 or length(v_title) > 120 then
    raise exception 'il titolo deve avere tra 3 e 120 caratteri' using errcode = '22023';
  end if;
  if v_desc is not null and length(v_desc) > 4000 then
    raise exception 'la descrizione può avere al massimo 4000 caratteri' using errcode = '22023';
  end if;

  -- freno contro invii ripetuti: massimo 5 richieste nelle ultime 24 ore
  select count(*) into v_recent from public.tickets
   where client_id = v_id and source = 'cliente' and created_at > now() - interval '24 hours';
  if v_recent >= 5 then
    raise exception 'hai già inviato 5 richieste nelle ultime 24 ore: scrivici su WhatsApp se è urgente' using errcode = 'P0001';
  end if;

  v_cat := case p_kind
    when 'modifica' then case v_client.plan when 'piano_completo' then 'modifica_inclusa' else 'extra_preventivo' end
    when 'nuova_funzionalita' then 'extra_preventivo'
    when 'assistenza' then 'bug_assistenza'
  end::public.ticket_category;
  if v_cat is null then raise exception 'tipo di richiesta non valido' using errcode = '22023'; end if;

  insert into public.tickets (client_id, title, description, category, source)
  values (v_id, v_title, v_desc, v_cat, 'cliente');

  return public.client_portal(p_token);
end $$;

-- solo queste due funzioni sono richiamabili senza login
revoke execute on function public.portal_client_id(text) from public, anon, authenticated;
revoke execute on function public.client_portal(text) from public;
revoke execute on function public.client_portal_create_ticket(text, text, text, text) from public;
grant  execute on function public.client_portal(text) to anon, authenticated;
grant  execute on function public.client_portal_create_ticket(text, text, text, text) to anon, authenticated;
