/**
 * The canonical "safe to show a business/customer" field list for a
 * worker — matching the same pattern as SANITIZED_JOB_SELECT and
 * SANITIZED_LOAD_SELECT: one shared select used everywhere a worker's
 * profile is exposed outside admin contexts, so a future field
 * addition to WorkerProfile can't accidentally leak through one route
 * but not another.
 *
 * Deliberately excludes: home address/coordinates, exact ZIP, SSN/tax
 * fields, background-check details, banking/Stripe identifiers,
 * phone/email (contact info stays private until a worker is actually
 * assigned, mirroring the exact same principle SANITIZED_LOAD_SELECT
 * already enforces for a load's shipper), and internal compliance/
 * operational-status detail (PENDING/RESTRICTED/SUSPENDED are not a
 * business's concern) beyond the simple verified flag already here.
 * "Eligibility" itself is enforced by callers filtering to
 * operationalStatus: "ACTIVE" (see the worker directory route) rather
 * than exposed as a raw status string here. acceptingJobs is included
 * specifically for "availability" — a worker-controlled boolean, safe
 * to show directly, distinct from and simpler than exposing their
 * actual compliance status.
 */
export const SAFE_WORKER_SELECT = {
  id: true,
  displayName: true,
  workerType: true,
  bio: true,
  ratingAverage: true,
  ratingCount: true,
  fiveStarReviewCount: true,
  completedJobs: true,
  serviceRadiusMiles: true,
  identityVerification: true,
  acceptingJobs: true,
  // Phase 5: DISPLAY-only. Populating this safely from user uploads is
  // Phase 5.5's whole job — Phase 5 shows an already-set photo but adds
  // no upload path. Safe to expose: it's a URL the worker set, not PII.
  profilePhotoUrl: true,
  workerMarkets: { select: { market: { select: { name: true, state: true } } } },
  vehicles: { select: { type: true, hasLiftgate: true, hasPalletJack: true, capacityDescription: true } },
  // Phase 5 additions — all worker-controlled, non-PII, safe to show a
  // business. Skills reuse the pre-existing WorkerSkill/Skill relation
  // (previously unused by any business-facing read).
  skills: { select: { skill: { select: { name: true } } } },
  certifications: { select: { id: true, name: true, issuer: true, issuedAt: true, expiresAt: true, status: true } },
  languages: { select: { languageCode: true, proficiency: true } },
} as const;
