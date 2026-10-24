import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRecruiter, AuthError } from "@/lib/recruiting/guard";

/**
 * Prospect list + create (recruiting CRM). Duplicate detection on DOT/MC warns
 * (does not hard-block) so a recruiter can still log a known prospect, but sees
 * the existing record. Prospects are separate from Carrier records.
 */
const STAGES = ["NEW_LEAD","CONTACT_ATTEMPTED","CONTACTED","INTERESTED","APPLICATION_SENT","APPLICATION_STARTED","DOCUMENTS_PENDING","UNDER_REVIEW","APPROVED","ACTIVE","NOT_INTERESTED","UNQUALIFIED","DO_NOT_CONTACT"] as const;
const SOURCES = ["DAT","TRUCKSTOP","REFERRAL","COLD_OUTREACH","INBOUND","EVENT","SOCIAL","OTHER"] as const;

export async function GET(request: Request) {
  try { await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const url = new URL(request.url);
  const stage = url.searchParams.get("stage");
  const recruiterId = url.searchParams.get("recruiterId");
  const prospects = await prisma.carrierProspect.findMany({
    where: { ...(stage ? { recruitmentStage: stage as (typeof STAGES)[number] } : {}), ...(recruiterId ? { assignedRecruiterId: recruiterId } : {}) },
    orderBy: { updatedAt: "desc" }, take: 500,
  });
  return NextResponse.json({ prospects });
}

const createSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(40).optional(),
  dotNumber: z.string().max(20).optional(),
  mcNumber: z.string().max(20).optional(),
  equipmentSummary: z.string().max(500).optional(),
  operatingStates: z.string().max(200).optional(),
  leadSource: z.enum(SOURCES).optional(),
  referralSource: z.string().max(200).optional(),
  assignedRecruiterId: z.string().optional(),
});

export async function POST(request: Request) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = createSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const d = parsed.data;

  // Duplicate detection: warn (soft) if a prospect with this DOT/MC exists.
  let duplicate = null;
  if (d.dotNumber || d.mcNumber) {
    duplicate = await prisma.carrierProspect.findFirst({
      where: { OR: [d.dotNumber ? { dotNumber: d.dotNumber } : {}, d.mcNumber ? { mcNumber: d.mcNumber } : {}].filter((o) => Object.keys(o).length) },
      select: { id: true, companyName: true },
    });
  }
  const prospect = await prisma.carrierProspect.create({ data: { ...d, createdById: authed.userId } });
  return NextResponse.json({ prospect, duplicateWarning: duplicate }, { status: 201 });
}

const patchSchema = z.object({
  id: z.string().min(1),
  companyName: z.string().min(1).max(200).optional(),
  contactName: z.string().max(200).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(40).optional(),
  recruitmentStage: z.enum(STAGES).optional(),
  leadSource: z.enum(SOURCES).optional(),
  assignedRecruiterId: z.string().optional(),
  nextFollowUpAt: z.string().datetime().optional(),
  equipmentSummary: z.string().max(500).optional(),
  operatingStates: z.string().max(200).optional(),
});

export async function PATCH(request: Request) {
  let authed;
  try { authed = await requireRecruiter(request); }
  catch (e) { if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status }); throw e; }
  const parsed = patchSchema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const { id, recruitmentStage, nextFollowUpAt, ...rest } = parsed.data;

  const existing = await prisma.carrierProspect.findUnique({ where: { id }, select: { recruitmentStage: true } });
  if (!existing) return NextResponse.json({ error: "Prospect not found." }, { status: 404 });

  const prospect = await prisma.$transaction(async (tx) => {
    const p = await tx.carrierProspect.update({
      where: { id },
      data: { ...rest, ...(recruitmentStage ? { recruitmentStage } : {}), ...(nextFollowUpAt ? { nextFollowUpAt: new Date(nextFollowUpAt) } : {}) },
    });
    // Stage changes are logged to the append-only activity timeline.
    if (recruitmentStage && recruitmentStage !== existing.recruitmentStage) {
      await tx.carrierRecruitingActivity.create({ data: { prospectId: id, activityType: "STAGE_CHANGE", notes: `${existing.recruitmentStage} → ${recruitmentStage}`, performedById: authed.userId } });
    }
    return p;
  });
  return NextResponse.json({ prospect });
}
