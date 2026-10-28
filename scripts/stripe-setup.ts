/**
 * Stripe sandbox setup — creates the five worker-subscription products and the
 * webhook endpoint this codebase expects, then writes the resulting IDs into
 * .env.local.
 *
 * VASRUE Digital Media — Clinton Douglas IV. Contract #2942026-1353.
 *
 * WHY THIS IS A SCRIPT AND NOT DASHBOARD CLICKING
 * The five prices must match lib/pricing.ts exactly — the handoff is explicit
 * that subscription amounts have to agree with PricingRule, and a mistyped
 * price in a dashboard form is silent until someone is billed the wrong
 * amount. So this script IMPORTS the constants rather than restating them.
 * There is one source of truth and it is the code. Likewise the webhook's 25
 * events are the exact set app/api/stripe/webhook/route.ts switches on; adding
 * them by hand in a checkbox list is how you end up one event short.
 *
 * SAFETY
 *  - Refuses to run against anything but a TEST-mode key. A live key aborts
 *    immediately, before a single API call.
 *  - Idempotent. Prices are keyed by lookup_key, so re-running finds the
 *    existing price instead of creating a duplicate.
 *  - Never prints a secret. Values are written to .env.local (gitignored at
 *    .gitignore:51) and reported by name only.
 *
 * Run with:
 *   npx tsx scripts/stripe-setup.ts            # create/verify everything
 *   npx tsx scripts/stripe-setup.ts --dry-run  # show the plan, touch nothing
 *
 * The webhook URL must be publicly reachable. For local work, do not point it
 * at localhost — use `stripe listen --forward-to localhost:3000/api/stripe/webhook`,
 * which prints its own signing secret for the duration of the session.
 */

import fs from "node:fs";
import path from "node:path";
import Stripe from "stripe";

import {
  MOVER_MONTHLY_SUBSCRIPTION_CENTS,
  DRIVER_BASIC_MONTHLY_CENTS,
  OWNER_OPERATOR_PRO_MONTHLY_CENTS,
  FLEET_MONTHLY_CENTS,
  ADDITIONAL_FLEET_VEHICLE_MONTHLY_CENTS,
  FLEET_INCLUDED_VEHICLES,
} from "../lib/pricing";

const ROOT = path.resolve(__dirname, "..");
const ENV_LOCAL = path.join(ROOT, ".env.local");
const DRY_RUN = process.argv.includes("--dry-run");

/** The exact event set app/api/stripe/webhook/route.ts handles. 25 of them. */
const WEBHOOK_EVENTS = [
  "account.updated",
  "charge.dispute.closed",
  "charge.dispute.created",
  "charge.refunded",
  "checkout.session.completed",
  "checkout.session.expired",
  "customer.subscription.created",
  "customer.subscription.deleted",
  "customer.subscription.paused",
  "customer.subscription.resumed",
  "customer.subscription.updated",
  "invoice.paid",
  "invoice.payment_failed",
  "invoice.voided",
  "payment_intent.amount_capturable_updated",
  "payment_intent.canceled",
  "payment_intent.payment_failed",
  "payment_intent.processing",
  "payment_intent.succeeded",
  "payout.failed",
  "payout.paid",
  "refund.created",
  "refund.updated",
  "transfer.created",
  "transfer.reversed",
] as const;

type PlanSpec = {
  /** Stable key so re-runs find the existing price instead of duplicating it. */
  lookupKey: string;
  productName: string;
  description: string;
  amountCents: number;
  /** The variable the application reads this price ID from. */
  envVar: string;
};

const PLANS: PlanSpec[] = [
  {
    lookupKey: "tempmovers_mover_monthly",
    productName: "TempMovers — Mover",
    description: "Monthly subscription for movers. Waived until the first completed paid job.",
    amountCents: MOVER_MONTHLY_SUBSCRIPTION_CENTS,
    envVar: "STRIPE_MOVER_SUBSCRIPTION_PRICE_ID",
  },
  {
    lookupKey: "tempmovers_driver_basic_monthly",
    productName: "TempMovers — Driver Basic",
    description: "Monthly subscription for box-truck drivers.",
    amountCents: DRIVER_BASIC_MONTHLY_CENTS,
    envVar: "STRIPE_DRIVER_BASIC_PRICE_ID",
  },
  {
    lookupKey: "tempmovers_owner_operator_pro_monthly",
    productName: "TempMovers — Owner Operator Pro",
    description: "Monthly subscription for owner-operators running their own box truck or semi.",
    amountCents: OWNER_OPERATOR_PRO_MONTHLY_CENTS,
    envVar: "STRIPE_OWNER_OPERATOR_PRO_PRICE_ID",
  },
  {
    lookupKey: "tempmovers_fleet_monthly",
    productName: "TempMovers — Fleet",
    description: `Monthly fleet subscription. Includes ${FLEET_INCLUDED_VEHICLES} vehicles.`,
    amountCents: FLEET_MONTHLY_CENTS,
    envVar: "STRIPE_FLEET_PRICE_ID",
  },
  {
    lookupKey: "tempmovers_fleet_extra_vehicle_monthly",
    productName: "TempMovers — Fleet additional vehicle",
    description: `Per-vehicle monthly add-on, charged beyond the ${FLEET_INCLUDED_VEHICLES} included in Fleet.`,
    amountCents: ADDITIONAL_FLEET_VEHICLE_MONTHLY_CENTS,
    envVar: "STRIPE_FLEET_EXTRA_VEHICLE_PRICE_ID",
  },
];

const money = (cents: number) => `$${(cents / 100).toFixed(2)}`;

// ---------------------------------------------------------------- env handling

/** Minimal .env reader — the repo has no dotenv dependency and tsx does not
 *  auto-load env files, so parse what we need rather than adding a package. */
function readEnvFile(file: string): Record<string, string> {
  if (!fs.existsSync(file)) return {};
  const out: Record<string, string> = {};
  for (const raw of fs.readFileSync(file, "utf8").split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#") || !line.includes("=")) continue;
    const [k, ...rest] = line.split("=");
    out[k.trim()] = rest.join("=").trim().replace(/^["']|["']$/g, "");
  }
  return out;
}

/** Upsert keys into .env.local, preserving comments, order and unrelated keys. */
function writeEnvLocal(updates: Record<string, string>) {
  const existing = fs.existsSync(ENV_LOCAL) ? fs.readFileSync(ENV_LOCAL, "utf8") : "";
  const lines = existing ? existing.split(/\r?\n/) : [];
  const remaining = { ...updates };

  const patched = lines.map((raw) => {
    const m = raw.match(/^\s*([A-Z0-9_]+)\s*=/);
    if (!m) return raw;
    const key = m[1];
    if (!(key in remaining)) return raw;
    const value = remaining[key];
    delete remaining[key];
    return `${key}="${value}"`;
  });

  const added = Object.entries(remaining).map(([k, v]) => `${k}="${v}"`);
  if (added.length) {
    if (patched.length && patched[patched.length - 1].trim() !== "") patched.push("");
    patched.push("# Added by scripts/stripe-setup.ts — VASRUE Digital Media");
    patched.push(...added);
  }

  fs.writeFileSync(ENV_LOCAL, patched.join("\n").replace(/\n{3,}$/, "\n\n"), "utf8");
}

// ---------------------------------------------------------------- guards

function resolveSecretKey(): string {
  const env = { ...readEnvFile(path.join(ROOT, ".env")), ...readEnvFile(ENV_LOCAL), ...process.env };
  const key = (env.STRIPE_SECRET_KEY ?? "").trim();

  if (!key) {
    console.error(
      [
        "STRIPE_SECRET_KEY is not set.",
        "",
        "Put the TEST-mode secret key in .env.local and run this again:",
        `  ${ENV_LOCAL}`,
        '  STRIPE_SECRET_KEY="sk_test_..."',
        "",
        "In Stripe: make sure the Test mode toggle is ON, then",
        "Developers -> API keys -> Secret key -> Reveal.",
        "That file is gitignored, so the key cannot be committed.",
      ].join("\n"),
    );
    process.exit(1);
  }

  // Hard stop on anything that is not test mode. This script creates products
  // and a webhook; doing that against a live account is not recoverable by
  // simply deleting rows, and nobody should be one typo away from it.
  const isTest = key.startsWith("sk_test_") || key.startsWith("rk_test_");
  if (!isTest) {
    console.error(
      [
        "REFUSING TO RUN: that key is not a test-mode key.",
        "",
        `  key prefix: ${key.slice(0, 8)}...`,
        "",
        "This script only ever runs against Stripe test mode. Live keys belong",
        "to the account owner and nothing here should touch them.",
      ].join("\n"),
    );
    process.exit(1);
  }

  return key;
}

function resolveWebhookUrl(): string | null {
  const env = { ...readEnvFile(path.join(ROOT, ".env")), ...readEnvFile(ENV_LOCAL), ...process.env };
  const explicit = (env.STRIPE_WEBHOOK_URL ?? "").trim();
  const base = (env.NEXT_PUBLIC_APP_URL ?? "").trim().replace(/\/+$/, "");
  const url = explicit || (base ? `${base}/api/stripe/webhook` : "");

  if (!url) return null;
  if (/localhost|127\.0\.0\.1|\[::1\]/.test(url)) {
    console.log("");
    console.log("SKIPPING the webhook endpoint — the URL points at localhost.");
    console.log("  Stripe delivers webhooks over the public internet, so a localhost");
    console.log("  endpoint would never receive anything. For local testing run:");
    console.log("    stripe listen --forward-to localhost:3000/api/stripe/webhook");
    console.log("  which prints its own signing secret for that session.");
    console.log("  For a deployed environment, set STRIPE_WEBHOOK_URL and re-run.");
    return null;
  }
  return url;
}

// ---------------------------------------------------------------- work

async function ensurePlan(stripe: Stripe, plan: PlanSpec): Promise<string> {
  const found = await stripe.prices.list({ lookup_keys: [plan.lookupKey], expand: ["data.product"], limit: 1 });
  const existing = found.data[0];

  if (existing) {
    const matches = existing.unit_amount === plan.amountCents
      && existing.currency === "usd"
      && existing.recurring?.interval === "month";
    const label = matches ? "exists, matches code" : "EXISTS BUT DOES NOT MATCH lib/pricing.ts";
    console.log(`  ${plan.productName.padEnd(42)} ${money(plan.amountCents).padStart(8)}  ${label}`);
    if (!matches) {
      console.log(`      on Stripe: ${money(existing.unit_amount ?? 0)} ${existing.currency} / ${existing.recurring?.interval ?? "one-off"}`);
      console.log("      Prices are immutable in Stripe. Archive it and pick a new lookup_key.");
    }
    return existing.id;
  }

  if (DRY_RUN) {
    console.log(`  ${plan.productName.padEnd(42)} ${money(plan.amountCents).padStart(8)}  would create`);
    return "price_DRY_RUN";
  }

  const product = await stripe.products.create({
    name: plan.productName,
    description: plan.description,
    metadata: { platform: "tempmovers", managed_by: "vasrue-digital-media", contract: "2942026-1353" },
  });

  const price = await stripe.prices.create({
    product: product.id,
    unit_amount: plan.amountCents,
    currency: "usd",
    recurring: { interval: "month" },
    lookup_key: plan.lookupKey,
    metadata: { platform: "tempmovers", source: "lib/pricing.ts" },
  });

  console.log(`  ${plan.productName.padEnd(42)} ${money(plan.amountCents).padStart(8)}  created`);
  return price.id;
}

async function ensureWebhook(stripe: Stripe, url: string): Promise<{ id: string; secret?: string }> {
  const existing = (await stripe.webhookEndpoints.list({ limit: 100 })).data.find((e) => e.url === url);

  if (existing) {
    const current = new Set(existing.enabled_events as string[]);
    const missing = WEBHOOK_EVENTS.filter((e) => !current.has(e));
    if (missing.length === 0) {
      console.log(`  endpoint exists with all ${WEBHOOK_EVENTS.length} events — nothing to do`);
    } else if (DRY_RUN) {
      console.log(`  endpoint exists, would add ${missing.length} missing event(s)`);
    } else {
      await stripe.webhookEndpoints.update(existing.id, { enabled_events: [...WEBHOOK_EVENTS] });
      console.log(`  endpoint existed, added ${missing.length} missing event(s)`);
    }
    // Stripe reveals a signing secret only at creation. An endpoint we did not
    // create in this run cannot hand it back, so say so rather than writing a
    // blank over a value that might already be correct.
    console.log("  NOTE: the signing secret is only shown when an endpoint is created.");
    console.log("        If STRIPE_WEBHOOK_SECRET is not already set, roll it in the");
    console.log("        dashboard (endpoint -> Signing secret -> Roll) and paste it in.");
    return { id: existing.id };
  }

  if (DRY_RUN) {
    console.log(`  would create endpoint at ${url} with ${WEBHOOK_EVENTS.length} events`);
    return { id: "we_DRY_RUN" };
  }

  const created = await stripe.webhookEndpoints.create({
    url,
    enabled_events: [...WEBHOOK_EVENTS],
    description: "TempMovers platform webhook — VASRUE Digital Media, contract #2942026-1353",
  });
  console.log(`  created endpoint with ${WEBHOOK_EVENTS.length} events`);
  return { id: created.id, secret: created.secret ?? undefined };
}

async function main() {
  const key = resolveSecretKey();
  const stripe = new Stripe(key, { apiVersion: "2025-08-27.basil" });

  const account = await stripe.accounts.retrieve();
  console.log(`Stripe account: ${account.id}${account.business_profile?.name ? ` (${account.business_profile.name})` : ""}`);
  console.log(`Mode: TEST${DRY_RUN ? "  ·  DRY RUN — nothing will be written" : ""}`);

  // Connect must be enabled by the account owner; we can only report on it.
  const connectReady = Boolean((account as unknown as { controller?: unknown }).controller) || account.details_submitted;
  console.log(`Charges enabled: ${account.charges_enabled ? "yes" : "no"}   Payouts enabled: ${account.payouts_enabled ? "yes" : "no"}`);
  if (!account.payouts_enabled) {
    console.log("  ^ payouts are blocked until Stripe's business verification clears. Expected at this stage.");
  }
  void connectReady;

  console.log("");
  console.log("Subscription products (amounts imported from lib/pricing.ts)");
  const updates: Record<string, string> = {};
  for (const plan of PLANS) {
    updates[plan.envVar] = await ensurePlan(stripe, plan);
  }

  console.log("");
  console.log("Webhook endpoint");
  const url = resolveWebhookUrl();
  let webhookSecretWritten = false;
  if (url) {
    const hook = await ensureWebhook(stripe, url);
    if (hook.secret) {
      updates.STRIPE_WEBHOOK_SECRET = hook.secret;
      webhookSecretWritten = true;
    }
  }

  if (DRY_RUN) {
    console.log("");
    console.log("Dry run complete. Nothing was created and .env.local was not touched.");
    return;
  }

  writeEnvLocal(updates);

  console.log("");
  console.log(`Wrote ${Object.keys(updates).length} value(s) to .env.local:`);
  for (const k of Object.keys(updates)) {
    console.log(`  ${k}${k === "STRIPE_WEBHOOK_SECRET" ? "   (secret — not printed)" : `  = ${updates[k]}`}`);
  }
  if (!webhookSecretWritten && url) {
    console.log("");
    console.log("STRIPE_WEBHOOK_SECRET was NOT written — see the note above.");
  }

  console.log("");
  console.log("Still required from the account owner:");
  console.log("  1. Enable Connect and set the account type to Express (not Standard, not Custom).");
  console.log("  2. Complete Stripe's business verification — it has a waiting period and");
  console.log("     blocks all payouts until it clears.");
}

main().catch((e) => {
  console.error("");
  console.error("FAILED:", e instanceof Error ? e.message : e);
  process.exit(1);
});
