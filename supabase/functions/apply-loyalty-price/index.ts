// Noifla Digital Studio · applica la tariffa ridotta dopo 36 mensilità (Supabase Edge Function, Deno).
//
// La chiama il pulsante «Applica» del gestionale con il login dell'admin.
// Pubblicazione:  supabase functions deploy apply-loyalty-price
//   (qui il controllo del login Supabase resta ATTIVO: senza sessione la richiesta è rifiutata)
// Segreti:        STRIPE_SECRET_KEY (già impostato per il webhook)
//                 STRIPE_PRICE_COMPLETO_RIDOTTO=price_...   (29€ ogni 30 giorni)
//                 STRIPE_PRICE_BASE_RIDOTTO=price_...       (24€ ogni 30 giorni)
//                 ALLOWED_ORIGINS=https://noifla01.github.io (facoltativo, separati da virgola)
//
// Tutte le letture e scritture sul database avvengono con il login dell'admin che chiama:
// valgono le stesse regole RLS del gestionale (un non-admin non vede e non cambia nulla).

import Stripe from 'npm:stripe@17.7.0';
import { createClient } from 'npm:@supabase/supabase-js@2.45.4';
import { applyLoyaltyPrice } from './handler.js';

const stripeKey = Deno.env.get('STRIPE_SECRET_KEY') ?? '';
const stripe = stripeKey ? new Stripe(stripeKey, { httpClient: Stripe.createFetchHttpClient() }) : null;
const priceIds = {
  piano_completo: Deno.env.get('STRIPE_PRICE_COMPLETO_RIDOTTO') ?? '',
  piano_base: Deno.env.get('STRIPE_PRICE_BASE_RIDOTTO') ?? '',
};
const allowed = (Deno.env.get('ALLOWED_ORIGINS') ?? '').split(',').map((s) => s.trim()).filter(Boolean);

function cors(req: Request) {
  const origin = req.headers.get('origin') ?? '';
  return {
    'Access-Control-Allow-Origin': !allowed.length ? '*' : (allowed.includes(origin) ? origin : allowed[0]),
    'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Vary': 'Origin',
  };
}

Deno.serve(async (req) => {
  const headers = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers });
  if (req.method !== 'POST') return Response.json({ error: 'Metodo non consentito' }, { status: 405, headers });

  const auth = req.headers.get('Authorization') ?? '';
  const supabase = createClient(Deno.env.get('SUPABASE_URL') ?? '', Deno.env.get('SUPABASE_ANON_KEY') ?? '', {
    global: { headers: { Authorization: auth } },
    auth: { persistSession: false },
  });

  const { data: isAdmin } = await supabase.rpc('is_admin');
  if (isAdmin !== true) return Response.json({ error: 'Non autorizzato' }, { status: 403, headers });

  let clientId = '';
  try { clientId = (await req.json()).client_id ?? ''; } catch { /* corpo non valido */ }
  if (!/^[0-9a-f-]{36}$/i.test(clientId)) return Response.json({ error: 'client_id mancante' }, { status: 400, headers });

  try {
    const result = await applyLoyaltyPrice(clientId, {
      stripe,
      priceIds,
      getClient: async (id: string) => {
        const { data, error } = await supabase.from('client_overview').select('*').eq('id', id).maybeSingle();
        if (error) throw new Error(error.message);
        return data;
      },
      applyInDb: async (id: string) => {
        const { data, error } = await supabase.rpc('apply_loyalty_rate', { p_client_id: id });
        if (error) throw new Error(error.message);
        return data;
      },
    });
    console.log('apply-loyalty-price', clientId, JSON.stringify(result));
    return Response.json(result, { status: result.ok ? 200 : result.status, headers });
  } catch (err) {
    console.error('apply-loyalty-price', clientId, (err as Error).message);
    return Response.json({ ok: false, error: 'Stripe: ' + (err as Error).message }, { status: 502, headers });
  }
});
