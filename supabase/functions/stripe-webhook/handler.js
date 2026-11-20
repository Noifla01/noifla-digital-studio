// Traduce un evento Stripe (già verificato) in una chiamata alle funzioni del database.
// File separato e senza dipendenze, così si può provare anche fuori da Supabase.
// Gestisce sia il formato classico delle fatture (invoice.subscription) sia quello
// delle versioni API più recenti (invoice.parent.subscription_details.subscription).

const idOf = (v) => (v && typeof v === 'object' ? v.id : v) ?? null;
const isoOf = (s) => (s ? new Date(s * 1000).toISOString() : null);

export async function handleStripeEvent(event, rpc) {
  const o = event.data.object;
  switch (event.type) {
    case 'invoice.paid':
    case 'invoice.payment_failed': {
      const paid = event.type === 'invoice.paid';
      const line = o.lines && o.lines.data && o.lines.data[0];
      const subscription =
        idOf(o.subscription) ??
        idOf(o.parent && o.parent.subscription_details && o.parent.subscription_details.subscription) ??
        null;
      return rpc('stripe_apply_invoice', {
        p_event_id: event.id,
        p_event_type: event.type,
        p_invoice_id: o.id,
        p_customer: idOf(o.customer),
        p_subscription: subscription,
        p_billing_reason: o.billing_reason ?? null,
        p_paid: paid,
        p_amount_cents: paid ? (o.amount_paid ?? 0) : (o.amount_due ?? 0),
        p_currency: o.currency ?? 'eur',
        p_paid_at: isoOf(o.status_transitions && o.status_transitions.paid_at),
        p_period_start: isoOf((line && line.period && line.period.start) ?? o.period_start),
        p_period_end: isoOf((line && line.period && line.period.end) ?? o.period_end),
      });
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      const item = o.items && o.items.data && o.items.data[0];
      return rpc('stripe_apply_subscription', {
        p_event_id: event.id,
        p_event_type: event.type,
        p_customer: idOf(o.customer),
        p_subscription: o.id,
        p_status: o.status ?? null,
        p_unit_amount_cents: (item && item.price && item.price.unit_amount) ?? null,
      });
    }
    default:
      return 'ignorato: evento non gestito';
  }
}
