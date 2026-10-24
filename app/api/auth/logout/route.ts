import { NextResponse } from "next/server";
import { revokeSession } from "@/lib/auth";

export async function POST(request: Request) {
  const authHeader = request.headers.get("authorization");
  const jwt = authHeader?.startsWith("Bearer ") ? authHeader.slice(7) : null;
  if (jwt) await revokeSession(jwt);
  return NextResponse.json({ ok: true });
}
