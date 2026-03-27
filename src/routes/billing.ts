import { Hono } from 'hono';
import Stripe from 'stripe';
import { query } from '../db/pool.js';
import { authMiddleware } from '../middleware/auth.js';

const billing = new Hono();

function getStripe(): Stripe {
  return new Stripe(process.env.STRIPE_SECRET_KEY!);
}

// ---- Authenticated routes ----
const authed = new Hono();
authed.use('*', authMiddleware);

// GET /api/billing/status
authed.get('/status', async (c) => {
  const userId = c.get('userId');
  const result = await query(
    `SELECT s.*, u.tier FROM subscriptions s
     JOIN users u ON u.id = s.user_id
     WHERE s.user_id = $1 AND s.status IN ('active', 'trialing')
     ORDER BY s.created_at DESC LIMIT 1`,
    [userId]
  );

  if (result.rows.length === 0) {
    return c.json({ tier: 'free', subscription: null });
  }

  return c.json({
    tier: result.rows[0].tier,
    subscription: {
      status: result.rows[0].status,
      plan: result.rows[0].plan,
      current_period_end: result.rows[0].current_period_end,
    },
  });
});

// POST /api/billing/checkout — create Stripe checkout session
authed.post('/checkout', async (c) => {
  const userId = c.get('userId');
  const { plan } = await c.req.json();
  const stripe = getStripe();

  const priceId = plan === 'yearly'
    ? process.env.STRIPE_PRICE_PRO_YEARLY
    : process.env.STRIPE_PRICE_PRO_MONTHLY;

  if (!priceId) {
    return c.json({ error: 'Price not configured' }, 500);
  }

  // Get or create Stripe customer
  const userResult = await query('SELECT email, stripe_customer_id FROM users WHERE id = $1', [userId]);
  const user = userResult.rows[0];

  let customerId = user.stripe_customer_id;
  if (!customerId) {
    const customer = await stripe.customers.create({
      email: user.email,
      metadata: { user_id: userId },
    });
    customerId = customer.id;
    await query('UPDATE users SET stripe_customer_id = $1 WHERE id = $2', [customerId, userId]);
  }

  const session = await stripe.checkout.sessions.create({
    customer: customerId,
    mode: 'subscription',
    line_items: [{ price: priceId, quantity: 1 }],
    success_url: `${c.req.header('origin') || 'https://formbuddy.app'}/billing/success?session_id={CHECKOUT_SESSION_ID}`,
    cancel_url: `${c.req.header('origin') || 'https://formbuddy.app'}/billing/cancel`,
    metadata: { user_id: userId },
  });

  return c.json({ checkout_url: session.url });
});

// POST /api/billing/portal — create customer portal session
authed.post('/portal', async (c) => {
  const userId = c.get('userId');
  const stripe = getStripe();

  const userResult = await query('SELECT stripe_customer_id FROM users WHERE id = $1', [userId]);
  const customerId = userResult.rows[0]?.stripe_customer_id;
  if (!customerId) {
    return c.json({ error: 'No billing account found' }, 404);
  }

  const session = await stripe.billingPortal.sessions.create({
    customer: customerId,
    return_url: `${c.req.header('origin') || 'https://formbuddy.app'}/settings`,
  });

  return c.json({ portal_url: session.url });
});

billing.route('/', authed);

// ---- Stripe Webhook (unauthenticated) ----
billing.post('/webhook', async (c) => {
  const stripe = getStripe();
  const signature = c.req.header('stripe-signature');
  if (!signature) return c.json({ error: 'Missing signature' }, 400);

  let event: Stripe.Event;
  try {
    const body = await c.req.text();
    event = stripe.webhooks.constructEvent(body, signature, process.env.STRIPE_WEBHOOK_SECRET!);
  } catch {
    return c.json({ error: 'Invalid webhook signature' }, 400);
  }

  switch (event.type) {
    case 'checkout.session.completed': {
      const session = event.data.object as Stripe.Checkout.Session;
      const userId = session.metadata?.user_id;
      if (!userId) break;

      await query(
        `INSERT INTO subscriptions (user_id, status, plan, stripe_subscription_id, current_period_start, current_period_end)
         VALUES ($1, 'active', 'pro_monthly', $2, NOW(), NOW() + INTERVAL '1 month')
         ON CONFLICT (user_id) DO UPDATE SET status = 'active', stripe_subscription_id = $2`,
        [userId, session.subscription as string]
      );
      await query("UPDATE users SET tier = 'pro' WHERE id = $1", [userId]);
      break;
    }

    case 'customer.subscription.updated': {
      const sub = event.data.object as Stripe.Subscription;
      const status = sub.status === 'active' ? 'active' : sub.status === 'past_due' ? 'past_due' : 'canceled';

      await query(
        `UPDATE subscriptions SET status = $1, current_period_end = $2
         WHERE stripe_subscription_id = $3`,
        [status, new Date(sub.current_period_end * 1000), sub.id]
      );

      if (status === 'canceled') {
        const subResult = await query(
          'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
          [sub.id]
        );
        if (subResult.rows.length > 0) {
          await query("UPDATE users SET tier = 'free' WHERE id = $1", [subResult.rows[0].user_id]);
        }
      }
      break;
    }

    case 'customer.subscription.deleted': {
      const sub = event.data.object as Stripe.Subscription;
      await query(
        "UPDATE subscriptions SET status = 'canceled' WHERE stripe_subscription_id = $1",
        [sub.id]
      );
      const subResult = await query(
        'SELECT user_id FROM subscriptions WHERE stripe_subscription_id = $1',
        [sub.id]
      );
      if (subResult.rows.length > 0) {
        await query("UPDATE users SET tier = 'free' WHERE id = $1", [subResult.rows[0].user_id]);
      }
      break;
    }
  }

  return c.json({ received: true });
});

export default billing;
