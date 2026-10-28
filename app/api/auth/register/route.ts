import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { hashPassword, createSession } from "@/lib/auth";

// Bump these when Terms/Privacy actually change — UserConsent keeps a
// permanent record of which version each user accepted, not just that
// they accepted something at some point.
const TERMS_VERSION = "2026-01-01";
const PRIVACY_VERSION = "2026-01-01";

const schema = z.object({
  email: z.string().email(),
  password: z.string().min(10, "Password must be at least 10 characters."),
  firstName: z.string().min(1),
  lastName: z.string().min(1),
  role: z.enum(["CUSTOMER", "MOVER", "DRIVER"]),
  // Junk removal — VASRUE Digital Media, 28 Oct 2026: JUNK_HELPER (mover role) and JUNK_HAULER (driver role) are junk-only accounts.
  workerType: z.enum(["MOVER", "BOX_TRUCK_DRIVER", "SEMI_DRIVER", "JUNK_HAULER", "JUNK_HELPER"]).optional(),
  // Required for movers/drivers — seeds their primary market and territory.
  // Not required for customers (their market is resolved from their
  // delivery address at booking time instead — see POST /api/jobs).
  homeZip: z.string().regex(/^\d{5}(?:-\d{4})?$/, "Enter a valid ZIP code.").optional(),
  acceptedTerms: z.literal(true, { errorMap: () => ({ message: "You must accept the Terms and Privacy Policy." }) }),
  marketingConsent: z.boolean().optional(),
});

/** Rejects nonsensical role/workerType pairs server-side instead of silently
 *  defaulting — a DRIVER role account with workerType MOVER (or vice versa)
 *  would confuse every downstream equipment/plan-eligibility check. */
function resolveWorkerType(role: "CUSTOMER" | "MOVER" | "DRIVER", requested?: "MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER" | "JUNK_HAULER" | "JUNK_HELPER") {
  if (role === "CUSTOMER") return null;
  if (role === "MOVER") return requested === "JUNK_HELPER" ? ("JUNK_HELPER" as const) : ("MOVER" as const);
  if (requested !== "BOX_TRUCK_DRIVER" && requested !== "SEMI_DRIVER" && requested !== "JUNK_HAULER") return null;
  return requested;
}

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });
  const input = parsed.data;
  const email = input.email.toLowerCase().trim();

  if (input.role !== "CUSTOMER" && !input.homeZip) {
    return NextResponse.json({ error: "Home ZIP is required to create a mover or driver account." }, { status: 400 });
  }
  const workerType = resolveWorkerType(input.role, input.workerType);
  if (input.role === "DRIVER" && !workerType) {
    return NextResponse.json({ error: "A valid vehicle type is required for driver accounts." }, { status: 400 });
  }

  const existing = await prisma.user.findUnique({ where: { email } });
  if (existing) return NextResponse.json({ error: "An account with that email already exists." }, { status: 409 });

  // Only a market that's actually recruiting workers can seed a new
  // account's territory — a market that merely has this ZIP on file for
  // planning purposes (e.g. still PIPELINE stage) doesn't count. Rejecting
  // here rather than silently allowing a worker to register into nowhere
  // avoids a signup that can never complete the territory onboarding step.
  const market = input.role !== "CUSTOMER"
    ? await prisma.launchMarket.findFirst({ where: { zipCodes: { has: input.homeZip! }, workerRecruitingEnabled: true } })
    : null;
  if (input.role !== "CUSTOMER" && !market) {
    return NextResponse.json({ error: "TempMovers is not currently recruiting workers in this ZIP code." }, { status: 409 });
  }

  const passwordHash = await hashPassword(input.password);

  const user = await prisma.$transaction(async (tx) => {
    const created = await tx.user.create({
      data: {
        email, passwordHash, firstName: input.firstName, lastName: input.lastName,
        role: input.role,
        // ACTIVE, not PENDING: User.status is the account-security state
        // (suspended/closed), never the onboarding-progress state — that's
        // WorkerProfile.onboardingStatus/operationalStatus below. Setting
        // this to PENDING made every freshly-issued registration token
        // immediately fail verifySession()'s ACTIVE-only check, since
        // nothing ever transitions a User out of PENDING — the returned
        // session was unusable from the moment it was issued.
        status: "ACTIVE",
        termsAcceptedAt: new Date(),
        marketingConsent: input.marketingConsent ?? false,
        ...(input.role === "CUSTOMER" && { customerProfile: { create: { type: "INDIVIDUAL" } } }),
        ...(workerType && {
          workerProfile: {
            create: {
              workerType, homeZip: input.homeZip, primaryMarketId: market?.id,
              // Deliberately restricted starting state: able to sign in and
              // build a profile, not able to touch loads/payouts. This is
              // WorkerProfile's job, not User.status's.
              onboardingStatus: "INCOMPLETE",
              overallVerificationStatus: "PENDING",
              operationalStatus: "PENDING",
              acceptingJobs: false,
            },
          },
        }),
      },
      include: { workerProfile: true },
    });

    // Same transaction as the user/profile creation — a WorkerMarket row
    // created outside the transaction could succeed independently of the
    // user creation and leave an inconsistent state if either step failed.
    if (created.workerProfile && market) {
      await tx.workerMarket.create({
        data: { workerId: created.workerProfile.id, marketId: market.id, active: true, acceptingJobs: false, serviceRadiusMiles: 30 },
      });
    }

    const requestMeta = {
      ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
      userAgent: request.headers.get("user-agent") ?? undefined,
    };
    await tx.userConsent.createMany({
      data: [
        { userId: created.id, type: "TERMS_OF_SERVICE", version: TERMS_VERSION, ...requestMeta },
        { userId: created.id, type: "PRIVACY_POLICY", version: PRIVACY_VERSION, ...requestMeta },
        ...(input.marketingConsent ? [{ userId: created.id, type: "MARKETING" as const, version: TERMS_VERSION, ...requestMeta }] : []),
      ],
    });

    return created;
  });

  const { jwt, expiresAt } = await createSession(user.id, user.role);
  const nextStep = user.role === "DRIVER" ? "/onboarding/driver" : user.role === "MOVER" ? "/onboarding/mover" : "/dashboard";
  return NextResponse.json({
    user: { id: user.id, email: user.email, role: user.role },
    token: jwt,
    expiresAt,
    nextStep,
  }, { status: 201 });
}
