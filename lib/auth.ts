import bcrypt from "bcryptjs";
import { SignJWT, jwtVerify } from "jose";
import { createHash, randomBytes } from "crypto";
import { prisma } from "@/lib/db";
import type { UserRole } from "@prisma/client";

const SESSION_TTL_MS = 1000 * 60 * 60 * 24 * 14; // 14 days

/** Throws instead of silently falling back to a shared/insecure default. */
function secret() {
  const value = process.env.AUTH_SECRET;
  if (!value || value.length < 32) {
    throw new Error("AUTH_SECRET must be set to at least 32 characters. Refusing to start with an insecure default.");
  }
  return new TextEncoder().encode(value);
}

export async function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}
export async function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

function hashToken(token: string) {
  return createHash("sha256").update(token).digest("hex");
}

/** Issues a signed session JWT and stores its hash server-side so it can be revoked. */
export async function createSession(userId: string, role: UserRole, meta?: { ipAddress?: string; userAgent?: string }) {
  const rawToken = randomBytes(32).toString("hex");
  const expiresAt = new Date(Date.now() + SESSION_TTL_MS);

  await prisma.session.create({
    data: { userId, role, tokenHash: hashToken(rawToken), expiresAt, ...meta },
  });

  const jwt = await new SignJWT({ sub: userId, role, tok: rawToken })
    .setProtectedHeader({ alg: "HS256" })
    .setIssuedAt()
    .setExpirationTime(Math.floor(expiresAt.getTime() / 1000))
    .sign(secret());

  return { jwt, expiresAt };
}

export type AuthedUser = { userId: string; role: UserRole };

/**
 * Verifies the JWT signature, that the underlying session hasn't been
 * revoked/expired server-side, AND that the user's current role/status in the
 * database still permits access — the JWT's `role` claim is only used to look
 * the session up quickly, never trusted on its own, since a suspension or role
 * change after the JWT was issued must take effect immediately.
 */
export async function verifySession(jwt: string): Promise<AuthedUser | null> {
  try {
    const { payload } = await jwtVerify(jwt, secret());
    const userId = payload.sub as string;
    const rawToken = payload.tok as string;
    if (!userId || !rawToken) return null;

    const session = await prisma.session.findUnique({ where: { tokenHash: hashToken(rawToken) } });
    if (!session || session.revokedAt || session.expiresAt < new Date()) return null;

    const user = await prisma.user.findUnique({ where: { id: userId }, select: { id: true, role: true, status: true } });
    if (!user || user.status !== "ACTIVE") return null;

    return { userId: user.id, role: user.role };
  } catch {
    return null;
  }
}

export async function revokeSession(jwt: string) {
  try {
    const { payload } = await jwtVerify(jwt, secret());
    const rawToken = payload.tok as string;
    if (!rawToken) return;
    await prisma.session.updateMany({ where: { tokenHash: hashToken(rawToken) }, data: { revokedAt: new Date() } });
  } catch {
    // Already invalid/expired — nothing to revoke.
  }
}

/** Every mutating API route that isn't public should call this first. */
export async function requireRole(request: Request, allowed: UserRole[]): Promise<AuthedUser> {
  const authHeader = request.headers.get("authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (!jwt) throw new AuthError("UNAUTHENTICATED", 401);

  const user = await verifySession(jwt);
  if (!user) throw new AuthError("UNAUTHENTICATED", 401);
  if (!allowed.includes(user.role)) throw new AuthError("FORBIDDEN", 403);
  return user;
}

export class AuthError extends Error {
  status: number;
  constructor(message: string, status: number) {
    super(message);
    this.status = status;
  }
}
