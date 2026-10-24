"use client";

import { useEffect, useState, useCallback } from "react";
import { authFetch } from "@/lib/client-auth";

/**
 * Launch Readiness Dashboard — per-market supply/demand/platform/performance
 * metrics from GET /api/admin/markets/readiness, plus the carrier breakdown.
 *
 * Truthfulness rule (mirrors the backend): a metric the backend reports as null
 * is NOT yet tracked. It renders as an explicit "Not tracked" — never zero,
 * never a guess. This keeps the dashboard an honest basis for expansion
 * decisions instead of a vanity board.
 */

type Dashboard = {
  supply: Record<string, number | null>;
  demand: Record<string, number | null>;
  platform: Record<string, number | string | null>;
  performance: Record<string, number | null>;
};

type CarrierBreakdown = Record<string, number | null>;

type ReadinessResponse = {
  marketId: string;
  marketName: string;
  stage: string;
  dashboard: Dashboard;
  carriers?: CarrierBreakdown;
  note?: string;
};

type MarketOption = { id: string; name: string; state: string };

const LABELS: Record<string, string> = {
  approvedMovers: "Approved movers", activeMovers: "Active movers", approvedDrivers: "Approved drivers",
  activeDrivers: "Active drivers", approvedCarriers: "Approved carriers", carriersWithCurrentInsurance: "Carriers with current insurance",
  registeredCustomers: "Registered customers", recurringCustomers: "Recurring customers", signedPropertyPartners: "Signed property partners",
  signedShippers: "Signed shippers", openBookingRequests: "Open booking requests", waitlistCount: "Waitlist",
  stripePaymentSuccessRate: "Stripe success rate", failedPaymentCount: "Failed payments", openProductionDefects: "Open defects",
  documentVerificationBacklog: "Doc verification backlog", migrationStatus: "Migration status", lastSuccessfulDeployment: "Last deploy",
  lastEndToEndTestDate: "Last e2e test", jobsCompleted: "Jobs completed", cancellationRate: "Cancellation rate",
  averageRating: "Average rating", grossBookingValueCents: "Gross booking value", platformRevenueCents: "Platform revenue",
  workerPayoutCents: "Worker payout",
  applications: "Applications", documentsPending: "Documents pending", underReview: "Under review", approved: "Approved",
  active: "Active", suspended: "Suspended", expiredDocuments: "Expired documents", withCurrentInsurance: "With current insurance",
  fmcsaVerified: "FMCSA verified", factored: "Factored", pendingNoaReviews: "Pending NOA reviews",
};

function formatValue(key: string, v: number | string | null): { text: string; muted: boolean } {
  if (v === null || v === undefined) return { text: "Not tracked", muted: true };
  if (typeof v === "string") return { text: v, muted: false };
  if (key.endsWith("Cents")) return { text: `$${(v / 100).toLocaleString(undefined, { minimumFractionDigits: 2 })}`, muted: false };
  if (key.endsWith("Rate")) return { text: `${(v * 100).toFixed(1)}%`, muted: false };
  return { text: v.toLocaleString(), muted: false };
}

function MetricGroup({ title, data }: { title: string; data: Record<string, number | string | null> }) {
  return (
    <section className="rounded-lg border border-slate-200 bg-white p-4">
      <h3 className="mb-3 text-xs font-semibold uppercase tracking-wide text-slate-500">{title}</h3>
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2">
        {Object.entries(data).map(([key, value]) => {
          const { text, muted } = formatValue(key, value);
          return (
            <div key={key} className="flex flex-col">
              <dt className="text-xs text-slate-400">{LABELS[key] ?? key}</dt>
              <dd className={`text-sm font-medium ${muted ? "italic text-slate-300" : "text-slate-900"}`}>{text}</dd>
            </div>
          );
        })}
      </dl>
    </section>
  );
}

export default function LaunchReadinessDashboard() {
  const [markets, setMarkets] = useState<MarketOption[] | null>(null);
  const [marketId, setMarketId] = useState<string | null>(null);
  const [data, setData] = useState<ReadinessResponse | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const res = await authFetch("/api/admin/markets");
        if (!res.ok) { setError(`Could not load markets (${res.status}).`); return; }
        const d = await res.json();
        const opts: MarketOption[] = (d.markets ?? []).map((m: MarketOption) => ({ id: m.id, name: m.name, state: m.state }));
        setMarkets(opts);
        if (opts.length) setMarketId(opts[0].id);
      } catch { setError("Could not reach the markets service."); }
    })();
  }, []);

  const loadReadiness = useCallback(async (id: string) => {
    setError(null); setData(null);
    try {
      const res = await authFetch(`/api/admin/markets/readiness?marketId=${encodeURIComponent(id)}`);
      if (!res.ok) { setError(`Could not load readiness (${res.status}).`); return; }
      setData(await res.json());
    } catch { setError("Could not reach the readiness service."); }
  }, []);

  useEffect(() => { if (marketId) loadReadiness(marketId); }, [marketId, loadReadiness]);

  return (
    <div className="mx-auto max-w-6xl px-6 py-8">
      <header className="mb-6 flex items-end justify-between">
        <div>
          <h1 className="text-2xl font-semibold text-slate-900">Launch Readiness</h1>
          <p className="mt-1 text-sm text-slate-500">Objective metrics for deciding when a market is ready to activate or expand.</p>
        </div>
        {markets && markets.length > 0 && (
          <select value={marketId ?? ""} onChange={(e) => setMarketId(e.target.value)}
            className="rounded-md border border-slate-300 px-3 py-2 text-sm">
            {markets.map((m) => <option key={m.id} value={m.id}>{m.name}, {m.state}</option>)}
          </select>
        )}
      </header>

      {error && <div className="mb-4 rounded-md border border-red-200 bg-red-50 px-4 py-3 text-sm text-red-700">{error}</div>}
      {!data && !error && <p className="text-sm text-slate-400">Loading readiness…</p>}

      {data && (
        <>
          <p className="mb-4 text-sm text-slate-600">
            <span className="font-medium text-slate-900">{data.marketName}</span> — stage {data.stage.replace(/_/g, " ")}
          </p>
          <div className="grid gap-4 md:grid-cols-2">
            <MetricGroup title="Supply" data={data.dashboard.supply} />
            <MetricGroup title="Demand" data={data.dashboard.demand} />
            <MetricGroup title="Platform" data={data.dashboard.platform} />
            <MetricGroup title="Performance" data={data.dashboard.performance} />
            {data.carriers && <MetricGroup title="Carriers" data={data.carriers} />}
          </div>
          {data.note && <p className="mt-4 text-xs italic text-slate-400">{data.note}</p>}
        </>
      )}
    </div>
  );
}
