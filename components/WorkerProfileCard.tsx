"use client";

/**
 * Reusable public profile card for a worker — the shared visual
 * building block for Phase 1 (Marketplace Profile System). Consumed
 * directly by the worker directory in this phase, and designed to be
 * reused as-is by Preferred Network Management and Choose Your Helper
 * in later phases, rather than each of those building their own
 * worker-summary rendering.
 *
 * Props match SAFE_WORKER_SELECT exactly — this component should never
 * need a field that route doesn't already return, and any expansion of
 * what's shown here should mean expanding SAFE_WORKER_SELECT first, not
 * fetching something separately.
 */
export type WorkerCardData = {
  id: string;
  displayName: string;
  workerType: string;
  ratingAverage: number;
  ratingCount: number;
  completedJobs: number;
  serviceRadiusMiles: number;
  identityVerification: string;
  acceptingJobs: boolean;
  workerMarkets: { market: { name: string; state: string } }[];
  vehicles: { type: string; hasLiftgate: boolean; hasPalletJack: boolean; capacityDescription: string | null }[];
  // Phase 5 additions — all optional so existing callers (Preferred
  // Network, invite flows) that fetched the pre-Phase-5 shape still
  // type-check and render. Populated wherever SAFE_WORKER_SELECT is now
  // the source (directory, profile, favorites, recommendations).
  bio?: string | null;
  fiveStarReviewCount?: number;
  profilePhotoUrl?: string | null;
  skills?: { skill: { name: string } }[];
  certifications?: { id: string; name: string; issuer: string | null; issuedAt: string | null; expiresAt: string | null; status: string }[];
  languages?: { languageCode: string; proficiency: string }[];
  // Phase 5.5A: approved portfolio preview — optional so callers without
  // portfolio data render unchanged. Only ever holds approved, public-safe
  // media (a signed thumbnail URL + a count); never private keys.
  portfolioPrimaryThumbnailUrl?: string | null;
  portfolioApprovedCount?: number;
};

// Phase 5 derived metrics + availability badge, passed alongside the
// card data (not part of SAFE_WORKER_SELECT — they're computed). Kept as
// a separate optional prop so the card renders fine without them.
export type WorkerCardMetrics = { completionRate: number | null; medianResponseMs: number | null };
export type AvailabilityBadge = "AVAILABLE_NOW" | "AVAILABLE_THIS_WEEK" | "AVAILABLE_LATER" | "NO_UPCOMING";

const AVAILABILITY_BADGE_LABEL: Record<AvailabilityBadge, { label: string; color: string; bg: string }> = {
  AVAILABLE_NOW: { label: "Available now", color: "#1a7f37", bg: "#e6f4ea" },
  AVAILABLE_THIS_WEEK: { label: "Available this week", color: "#1a7f37", bg: "#e6f4ea" },
  AVAILABLE_LATER: { label: "Available later", color: "#8a6d1a", bg: "#fbf3e0" },
  NO_UPCOMING: { label: "No upcoming availability", color: "#637089", bg: "#eef1f5" },
};

const PROFICIENCY_LABEL: Record<string, string> = { BASIC: "basic", CONVERSATIONAL: "conversational", FLUENT: "fluent", NATIVE: "native" };

function formatResponseTime(ms: number | null): string | null {
  if (ms == null) return null;
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `~${mins} min`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `~${hrs} hr${hrs === 1 ? "" : "s"}`;
  const days = Math.round(hrs / 24);
  return `~${days} day${days === 1 ? "" : "s"}`;
}

const WORKER_TYPE_LABEL: Record<string, string> = {
  MOVER: "Mover",
  BOX_TRUCK_DRIVER: "Box truck driver",
  SEMI_DRIVER: "Semi driver",
};

export default function WorkerProfileCard({ worker, action, isPreferred, onViewProfile, metrics, availabilityBadge, isFavorite, onToggleFavorite }: { worker: WorkerCardData; action?: React.ReactNode; isPreferred?: boolean; onViewProfile?: (workerId: string) => void; metrics?: WorkerCardMetrics; availabilityBadge?: AvailabilityBadge; isFavorite?: boolean; onToggleFavorite?: (workerId: string) => void }) {
  const badge = availabilityBadge ? AVAILABILITY_BADGE_LABEL[availabilityBadge] : null;
  const responseLabel = metrics ? formatResponseTime(metrics.medianResponseMs) : null;
  return (
    <article className="panel" style={{ display: "flex", flexDirection: "column", gap: 6 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start" }}>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {worker.profilePhotoUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={worker.profilePhotoUrl} alt="" width={40} height={40} style={{ borderRadius: "50%", objectFit: "cover", flexShrink: 0 }} />
          )}
          <div>
            <strong style={{ fontSize: 15 }}>{worker.displayName}</strong>
            <p style={{ margin: "2px 0 0", color: "#637089", fontSize: 13 }}>{WORKER_TYPE_LABEL[worker.workerType] ?? worker.workerType}</p>
          </div>
        </div>
        <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
          {onToggleFavorite && (
            <button
              className="btn btnSecondary"
              style={{ padding: "2px 8px", fontSize: 13, color: isFavorite ? "#d4a017" : "#637089" }}
              title={isFavorite ? "Remove from favorites" : "Add to favorites"}
              aria-pressed={isFavorite ? true : false}
              onClick={() => onToggleFavorite(worker.id)}
            >{isFavorite ? "★" : "☆"}</button>
          )}
          {isPreferred && <span className="tag" style={{ background: "#eaf0ff", color: "#3355dd" }}>Preferred</span>}
          {worker.identityVerification === "APPROVED" && (
            <span className="tag" style={{ background: "#e6f4ea", color: "#1a7f37" }}>Verified</span>
          )}
        </div>
      </div>

      {badge && (
        <div><span className="tag" style={{ background: badge.bg, color: badge.color }}>{badge.label}</span></div>
      )}

      <div style={{ display: "flex", gap: 14, fontSize: 13, color: "#637089", flexWrap: "wrap" }}>
        <span>{worker.ratingCount > 0 ? `★ ${worker.ratingAverage.toFixed(1)} (${worker.ratingCount})` : "No ratings yet"}</span>
        <span>{worker.completedJobs} completed job{worker.completedJobs === 1 ? "" : "s"}</span>
        <span>{worker.serviceRadiusMiles}-mile radius</span>
        <span style={{ color: worker.acceptingJobs ? "#1a7f37" : "#b3261e" }}>{worker.acceptingJobs ? "Accepting jobs" : "Not currently available"}</span>
      </div>

      {metrics && (metrics.completionRate != null || responseLabel) && (
        <div style={{ display: "flex", gap: 14, fontSize: 13, color: "#637089", flexWrap: "wrap" }}>
          {metrics.completionRate != null && <span><strong>{Math.round(metrics.completionRate * 100)}%</strong> completion</span>}
          {responseLabel && <span><strong>{responseLabel}</strong> median response</span>}
        </div>
      )}

      {worker.bio && <p style={{ margin: 0, fontSize: 13, color: "#3a4453" }}>{worker.bio}</p>}

      {(worker.portfolioPrimaryThumbnailUrl || (worker.portfolioApprovedCount ?? 0) > 0) && (
        <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
          {worker.portfolioPrimaryThumbnailUrl && (
            // eslint-disable-next-line @next/next/no-img-element
            <img src={worker.portfolioPrimaryThumbnailUrl} alt={`${worker.displayName} portfolio sample`} width={48} height={48} style={{ objectFit: "cover", borderRadius: 6, flexShrink: 0 }} />
          )}
          {(worker.portfolioApprovedCount ?? 0) > 0 && (
            <span style={{ fontSize: 13, color: "#637089" }}>{worker.portfolioApprovedCount} approved work photo{worker.portfolioApprovedCount === 1 ? "" : "s"}</span>
          )}
        </div>
      )}

      {worker.skills && worker.skills.length > 0 && (
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>Skills:</strong> {worker.skills.map((s) => s.skill.name).join(" · ")}
        </p>
      )}

      {worker.certifications && worker.certifications.length > 0 && (
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>Certifications:</strong> {worker.certifications.map((c) => `${c.name}${c.status === "VERIFIED" ? " ✓" : ""}`).join(" · ")}
        </p>
      )}

      {worker.languages && worker.languages.length > 0 && (
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>Languages:</strong> {worker.languages.map((l) => `${l.languageCode.toUpperCase()} (${PROFICIENCY_LABEL[l.proficiency] ?? l.proficiency.toLowerCase()})`).join(" · ")}
        </p>
      )}

      {worker.workerMarkets.length > 0 && (
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>Markets:</strong> {worker.workerMarkets.map((m) => `${m.market.name}, ${m.market.state}`).join(" · ")}
        </p>
      )}

      {worker.vehicles.length > 0 && (
        <p style={{ margin: 0, fontSize: 13 }}>
          <strong>Equipment:</strong> {worker.vehicles.map((v) => `${v.type}${v.hasLiftgate ? " · liftgate" : ""}${v.hasPalletJack ? " · pallet jack" : ""}${v.capacityDescription ? ` · ${v.capacityDescription}` : ""}`).join("; ")}
        </p>
      )}

      <div style={{ display: "flex", gap: 8, marginTop: 4, alignItems: "center" }}>
        {onViewProfile && <button className="btn btnSecondary" style={{ padding: "4px 10px", fontSize: 12.5 }} onClick={() => onViewProfile(worker.id)}>View profile</button>}
        {action}
      </div>
    </article>
  );
}
