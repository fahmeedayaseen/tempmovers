import { NextResponse } from "next/server";
import { z } from "zod";
import { prisma } from "@/lib/db";
import { verifyPassword, createSession } from "@/lib/auth";

const schema = z.object({ email: z.string().email(), password: z.string().min(1) });

export async function POST(request: Request) {
  const parsed = schema.safeParse(await request.json());
  if (!parsed.success) return NextResponse.json({ error: parsed.error.flatten() }, { status: 400 });

  const user = await prisma.user.findUnique({ where: { email: parsed.data.email } });
  // Same generic error whether the email doesn't exist or the password is wrong —
  // never reveal which one it was.
  if (!user || !user.passwordHash || !(await verifyPassword(parsed.data.password, user.passwordHash))) {
    return NextResponse.json({ error: "Invalid email or password." }, { status: 401 });
  }
  if (user.status === "SUSPENDED" || user.status === "REJECTED") {
    return NextResponse.json({ error: "This account is not active." }, { status: 403 });
  }

  const meta = {
    ipAddress: request.headers.get("x-forwarded-for") ?? undefined,
    userAgent: request.headers.get("user-agent") ?? undefined,
  };
  const { jwt, expiresAt } = await createSession(user.id, user.role, meta);
  return NextResponse.json({ user: { id: user.id, email: user.email, role: user.role }, token: jwt, expiresAt });
}
