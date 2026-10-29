import { z } from "zod";
import type { Job, Prisma } from "@prisma/client";
import { prisma } from "@/lib/db";
import { grossUpCents, helperCompCents, helperPayableMinutes } from "@/lib/junk/allocation";
import { JUNK_ALLOCATION_MODEL, type JunkQuotePlan } from "@/lib/junk/full-quote";
import { JUNK_ITEM_CODES, JUNK_ITEMS, type JunkItemCode } from "@/lib/junk/pricing";
import { resolveJunkMarketPricing } from "@/lib/junk/market-pricing";
import { marketCodeForJob } from "@/lib/payments/policy";

// ---------------------------------------------------------------------------
// Change orders — VASRUE Digital Media, 29 October 2026.
//
// Payment spec §3 and §6: extra hours, an extra helper, extra items, or
// disposal over the allowance are priced on the server as a versioned change
// order, shown to the customer with the incremental total and breakdown, and
// collected BEFORE the added work. Junk deltas follow the allocation rules:
// added helper pay is grossed up so the hauler is never docked, and a
// disposal overage adds to the set-aside with no platform cut.
// ---------------------------------------------------------------------------

export class ChangeOrderError extends Error {
  constructor(message: string, readonly status = 400) { super(message); }
}

export const changeOrderRequestSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("EXTRA_HOURS"), hours: z.number().min(0.25).max(12), reason: z.string().trim().min(3).max(500) }),
  z.object({ kind: z.literal("EXTRA_HELPER"), hours: z.number().min(0.25).max(12), reason: z.string().trim().min(3).max(500) }),
  z.object({ kind: z.literal("EXTRA_ITEMS"), items: z.array(z.object({ code: z.enum(JUNK_ITEM_CODES), quantity: z.number().int().min(1).max(20) })).min(1).max(JUNK_ITEM_CODES.length), reason: z.string().trim().min(3).max(500) }),
  z.object({ kind: z.literal("DISPOSAL_OVERAGE"), expectedDisposalCents: z.number().int().min(1).max(1_000_000), reason: z.string().trim().min(3).max(500) }),
  z.object({ kind: z.literal("OTHER"), amountCents: z.number().int().min(100).max(1_000_000), reason: z.string().trim().min(3).max(500) }),
]);
export type ChangeOrderRequest = z.infer<typeof changeOrderRequestSchema>;

export type PricedChangeOrder = {
  deltaCents: number;
  lines: { label: string; cents: number }[];
  plan: { allInDeltaCents: number; disposalDeltaCents: number; helperCompDeltaCents: number; [k: string]: unknown };
};

const quarterHours = (h: number) => Math.round(h * 4) / 4;

async function junkPlan(jobId: string): Promise<JunkQuotePlan> {
  const quote = await prisma.quoteVersion.findFirst({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "desc" } });
  const plan = quote?.plan as unknown as JunkQuotePlan | null;
  if (!plan || plan.model !== JUNK_ALLOCATION_MODEL) throw new ChangeOrderError("This junk job was booked before change orders existed; contact support to adjust it.", 409);
  return plan;
}

/** The disposal allowance funded so far: the quote's set-aside plus paid overage orders. */
export async function fundedDisposalAllowance(jobId: string, plan: JunkQuotePlan): Promise<number> {
  const paid = await prisma.changeOrder.findMany({ where: { entityType: "JOB", entityId: jobId, status: "PAID", kind: "DISPOSAL_OVERAGE" } });
  return plan.disposalCents + paid.reduce((a, c) => a + ((c.plan as { disposalDeltaCents?: number } | null)?.disposalDeltaCents ?? c.deltaCents), 0);
}

export async function priceChangeOrder(job: Pick<Job, "id" | "type" | "marketId" | "moversRequired" | "customerMoverRateCents" | "platformFeePerHourCents">, req: ChangeOrderRequest): Promise<PricedChangeOrder> {
  const isJunk = job.type === "JUNK_REMOVAL";

  if (req.kind === "OTHER") {
    return { deltaCents: req.amountCents, lines: [{ label: req.reason, cents: req.amountCents }], plan: { allInDeltaCents: req.amountCents, disposalDeltaCents: 0, helperCompDeltaCents: 0 } };
  }

  if (!isJunk) {
    if (req.kind !== "EXTRA_HOURS") throw new ChangeOrderError("Only extra hours can be added to this kind of job.");
    const hours = quarterHours(req.hours);
    const labor = Math.round(job.customerMoverRateCents * hours) * job.moversRequired;
    const fee = Math.round(job.platformFeePerHourCents * hours) * job.moversRequired;
    return {
      deltaCents: labor + fee,
      lines: [
        { label: `Extra time: ${hours} hour${hours === 1 ? "" : "s"} × ${job.moversRequired} mover${job.moversRequired === 1 ? "" : "s"}`, cents: labor },
        { label: "Platform fee on the extra time", cents: fee },
      ],
      plan: { allInDeltaCents: labor + fee, disposalDeltaCents: 0, helperCompDeltaCents: 0, extraHours: hours, movers: job.moversRequired, laborCents: labor, feeCents: fee },
    };
  }

  const plan = await junkPlan(job.id);
  const policy = { helperHourlyCents: plan.helperHourlyCents, helperMinimumMinutes: plan.helperMinimumMinutes, helperIncrementMinutes: plan.helperIncrementMinutes };

  if (req.kind === "EXTRA_HOURS") {
    if (plan.helperCount === 0) throw new ChangeOrderError("This job has no helpers; add a helper instead.");
    const minutes = Math.ceil((req.hours * 60) / Math.max(1, plan.helperIncrementMinutes)) * plan.helperIncrementMinutes;
    const helperComp = Math.round((plan.helperHourlyCents * minutes) / 60) * plan.helperCount;
    const delta = grossUpCents(helperComp, plan.platformFeeBps);
    return {
      deltaCents: delta,
      lines: [{ label: `Extra helper time: ${minutes / 60} hour${minutes === 60 ? "" : "s"} × ${plan.helperCount} helper${plan.helperCount === 1 ? "" : "s"}`, cents: delta }],
      plan: { allInDeltaCents: delta, disposalDeltaCents: 0, helperCompDeltaCents: helperComp, extraHelperMinutes: minutes, helpers: plan.helperCount },
    };
  }

  if (req.kind === "EXTRA_HELPER") {
    if (plan.helperCount >= 2) throw new ChangeOrderError("This job already has two helpers.");
    const payable = helperPayableMinutes(Math.round(req.hours * 60), policy);
    const helperComp = helperCompCents(payable, policy);
    const delta = grossUpCents(helperComp, plan.platformFeeBps);
    return {
      deltaCents: delta,
      lines: [{ label: `Another helper: ${payable / 60} hour${payable === 60 ? "" : "s"}`, cents: delta }],
      plan: { allInDeltaCents: delta, disposalDeltaCents: 0, helperCompDeltaCents: helperComp, addHelper: true, helperPayableMinutes: payable },
    };
  }

  if (req.kind === "EXTRA_ITEMS") {
    const marketCode = await marketCodeForJob(job);
    const pricing = await resolveJunkMarketPricing(marketCode ?? "US-DEFAULT");
    const lines = req.items.map((i) => ({ label: `${JUNK_ITEMS[i.code as JunkItemCode].label}${i.quantity > 1 ? ` × ${i.quantity}` : ""}`, cents: pricing.table.itemsCents[i.code as JunkItemCode] * i.quantity }));
    const delta = lines.reduce((a, l) => a + l.cents, 0);
    return { deltaCents: delta, lines, plan: { allInDeltaCents: delta, disposalDeltaCents: 0, helperCompDeltaCents: 0, items: req.items } };
  }

  // DISPOSAL_OVERAGE: collected before the dump, no platform cut (spec §6).
  const allowance = await fundedDisposalAllowance(job.id, plan);
  const delta = req.expectedDisposalCents - allowance;
  if (delta <= 0) throw new ChangeOrderError(`The disposal allowance already covers that (allowance ${(allowance / 100).toFixed(2)}).`);
  return {
    deltaCents: delta,
    lines: [{ label: `Disposal over the estimate (expected ${(req.expectedDisposalCents / 100).toFixed(2)}, allowance ${(allowance / 100).toFixed(2)})`, cents: delta }],
    plan: { allInDeltaCents: delta, disposalDeltaCents: delta, helperCompDeltaCents: 0, expectedDisposalCents: req.expectedDisposalCents, allowanceBeforeCents: allowance },
  };
}

export async function nextChangeOrderVersion(jobId: string, client: Prisma.TransactionClient | typeof prisma = prisma) {
  const last = await client.changeOrder.findFirst({ where: { entityType: "JOB", entityId: jobId }, orderBy: { version: "desc" }, select: { version: true } });
  return (last?.version ?? 0) + 1;
}

export function changeOrderConsentText(deltaCents: number) {
  return `I approve this change and agree to pay $${(deltaCents / 100).toFixed(2)} now. The added work starts only after this payment goes through.`;
}
