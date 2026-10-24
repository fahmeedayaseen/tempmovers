import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { requireRole, AuthError } from "@/lib/auth";

/**
 * A genuinely foundational gap found while checking the client portal's
 * job-posting flow: POST /api/jobs requires an existing `addressId` —
 * it has never accepted raw address text — but nothing anywhere in
 * this codebase, backend or frontend, ever created an Address record
 * for a customer. This meant job creation could never succeed for any
 * customer through any path, independent of the separately-known
 * Stripe Elements gap. This is that missing piece.
 *
 * Deliberately does NOT geocode here — POST /api/jobs already geocodes
 * lazily itself if an address lacks coordinates (see geocodeAddress
 * usage there), so this stays a simple, fast save rather than
 * duplicating that logic or making address creation depend on the
 * geocoding provider being configured.
 */
const schema = z.object({
  label: z.string().max(100).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(100),
  state: z.string().length(2),
  postalCode: z.string().regex(/^\d{5}(?:-\d{4})?$/, "Enter a valid ZIP code."),
});

export async function POST(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customerProfile) return NextResponse.json({ error: "No customer profile for this account." }, { status: 403 });

  const address = await prisma.address.create({
    data: {
      customerId: customerProfile.id,
      label: parsed.data.label,
      line1: parsed.data.line1,
      line2: parsed.data.line2,
      city: parsed.data.city,
      state: parsed.data.state.toUpperCase(),
      postalCode: parsed.data.postalCode,
    },
  });

  return NextResponse.json({ address });
}

export async function GET(request: Request) {
  let authed;
  try {
    authed = await requireRole(request, ["CUSTOMER", "ADMIN"]);
  } catch (e) {
    if (e instanceof AuthError) return NextResponse.json({ error: e.message }, { status: e.status });
    throw e;
  }

  const customerProfile = await prisma.customerProfile.findUnique({ where: { userId: authed.userId } });
  if (!customerProfile) return NextResponse.json({ error: "No customer profile for this account." }, { status: 403 });

  const addresses = await prisma.address.findMany({
    where: { customerId: customerProfile.id },
    orderBy: { id: "desc" },
  });

  return NextResponse.json({ addresses });
}
