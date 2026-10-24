/**
 * Real implementation against Checkr's documented API
 * (https://docs.checkr.com/) — not a stub. Untested against the live
 * endpoint in this environment (no network access here).
 *
 * The hosted invitation flow requires a real Checkr Candidate ID created
 * (or reused) BEFORE the invitation — the previous version posted
 * candidate_email directly to /v1/invitations, which doesn't follow
 * Checkr's documented Candidate -> Invitation sequence. Email is enough to
 * create the Candidate; Checkr's hosted intake collects sensitive PII
 * (SSN, DOB, etc.) directly from the applicant — TempMovers never touches it.
 */

export class CheckrNotConfiguredError extends Error {
  constructor() {
    super("CHECKR_API_KEY is not configured.");
  }
}

export type CheckrCandidate = {
  id: string;
  object: "candidate";
  email: string;
  custom_id?: string | null;
};

export type CheckrInvitation = {
  id: string;
  object: "invitation";
  candidate_id: string;
  report_id: string | null;
  invitation_url?: string | null;
  status: string;
  expires_at?: string | null;
};

type WorkLocation = {
  city?: string;
  state: string;
  country: "US";
};

function getApiKey(): string {
  const key = process.env.CHECKR_API_KEY;
  if (!key) throw new CheckrNotConfiguredError();
  return key;
}

async function checkrRequest<T>(path: string, init: RequestInit, idempotencyKey?: string): Promise<T> {
  const apiKey = getApiKey();
  const response = await fetch(`https://api.checkr.com/v1${path}`, {
    ...init,
    headers: {
      Authorization: `Basic ${Buffer.from(`${apiKey}:`).toString("base64")}`,
      "Content-Type": "application/json",
      Accept: "application/json",
      ...(idempotencyKey ? { "Idempotency-Key": idempotencyKey } : {}),
      ...(init.headers ?? {}),
    },
  });

  const text = await response.text();
  let payload: unknown = null;
  try {
    payload = text ? JSON.parse(text) : null;
  } catch {
    payload = text;
  }

  if (!response.ok) {
    const message = typeof payload === "object" && payload && "error" in payload
      ? String((payload as { error?: string }).error)
      : `Checkr request failed (${response.status}).`;
    throw new Error(message);
  }

  return payload as T;
}

/** Creates a Checkr Candidate — the first step of the hosted flow. custom_id
 *  is set to our own workerId, which is what lets reconciliation work even
 *  before any Checkr-side ID exists on our side yet. */
export async function createCheckrCandidate(input: { email: string; workerId: string }): Promise<CheckrCandidate> {
  return checkrRequest<CheckrCandidate>("/candidates", {
    method: "POST",
    body: JSON.stringify({ email: input.email, custom_id: input.workerId }),
  }, `candidate-${input.workerId}`);
}

/** Creates a Checkr Invitation for an existing candidate_id — never call this
 *  with a bare email; the candidate must exist first (see createCheckrCandidate
 *  and lib/screening/start-checkr.ts, which creates-or-reuses one). */
export async function createCheckrInvitation(input: {
  candidateId: string; packageSlug: string; workLocation: WorkLocation; screeningChargeId: string;
}): Promise<CheckrInvitation> {
  const node = process.env.CHECKR_NODE_CUSTOM_ID?.trim();
  const body: Record<string, unknown> = {
    candidate_id: input.candidateId,
    package: input.packageSlug,
    work_locations: [input.workLocation],
  };
  if (node) body.node = node;

  return checkrRequest<CheckrInvitation>("/invitations", {
    method: "POST",
    body: JSON.stringify(body),
  }, `invitation-${input.screeningChargeId}`);
}
