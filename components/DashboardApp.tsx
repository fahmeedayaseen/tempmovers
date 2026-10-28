"use client";

import { Fragment, useEffect, useMemo, useRef, useState } from "react";
import { calculateBoxTruckLoadQuote, calculateJobQuote, calculateSemiLoadQuote } from "@/lib/pricing";
import { authFetch, getAuthToken, NotSignedInError } from "@/lib/client-auth";
import LoadBoard from "./LoadBoard";
import StripePaymentForm from "./StripePaymentForm";
import TipForm from "./TipForm";
import WorkerProfileCard, { type WorkerCardData } from "./WorkerProfileCard";
// Junk removal — VASRUE Digital Media, 28 Oct 2026: the worker-side junk board.
import JunkJobBoard from "./junk/JunkJobBoard";

type View = "marketplace" | "customer" | "partner" | "mover" | "driver" | "launch" | "admin";

const movers = [
  { name: "Marcus Reed", initials: "MR", rating: 4.98, jobs: 214, tags: ["Loading", "Heavy items", "Assembly"] },
  { name: "DeAndre Wilson", initials: "DW", rating: 4.94, jobs: 167, tags: ["Apartments", "Packing", "Furniture"] },
  { name: "Luis Martinez", initials: "LM", rating: 4.91, jobs: 139, tags: ["Office moves", "Unloading", "Bilingual"] },
];

/**
 * Starts a real Stripe Checkout subscription for the signed-in worker and
 * redirects the browser to it. Shared by the mover and driver panels since
 * both call the same backend route with a different plan.
 *
 * Requires a signed-in session — surfaces NotSignedInError plainly rather
 * than failing silently if the token is missing or expired.
 */
async function startSubscriptionCheckout(plan: "MOVER" | "DRIVER_BASIC" | "OWNER_OPERATOR_PRO" | "FLEET") {
  const res = await authFetch("/api/stripe/worker-subscription", {
    method: "POST",
    body: JSON.stringify({ plan }),
  });
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Subscription request failed (${res.status}).`);
  }
  const data: { status: string; url?: string; message?: string } = await res.json();
  if (data.status === "WAIVED_UNTIL_FIRST_COMPLETED_JOB") {
    return { waived: true, message: data.message ?? "Waived until your first completed job." };
  }
  if (data.url) {
    window.location.href = data.url;
    return { waived: false };
  }
  throw new Error("No checkout URL returned.");
}

/** Real self-service path for an existing subscriber — payment method
 *  updates, invoices, cancellation, plan changes — none of which the
 *  Checkout flow above can do once a subscription already exists.
 *  Returns null (not throwing) specifically for the "no billing profile
 *  yet" case, so the caller can fall back to starting Checkout instead —
 *  every other failure still throws normally. */
async function openBillingPortal(): Promise<{ opened: boolean }> {
  const res = await authFetch("/api/stripe/billing-portal", { method: "POST" });
  if (res.status === 409) return { opened: false };
  if (!res.ok) {
    const body = await res.json().catch(() => ({}));
    throw new Error(body.error ?? `Billing portal request failed (${res.status}).`);
  }
  const data: { url: string } = await res.json();
  window.location.href = data.url;
  return { opened: true };
}

type AdminSubscriptionStats = {
  totals: { active: number; waived: number; pastDue: number; total: number; estimatedMonthlyRevenueCents: number };
  byPlan: Record<string, number>;
  workers: { id: string; name: string; role: string; status: string; plan: string | null; renewsAt: string | null; waived: boolean; completedJobs: number }[];
};

const ROLE_DEFAULT_VIEW: Record<string, View> = {
  CUSTOMER: "customer",
  MOVER: "mover",
  DRIVER: "driver",
  ADMIN: "admin",
};

export default function DashboardApp({ initialRole, initialService }: { initialRole?: "CUSTOMER" | "MOVER" | "DRIVER" | "ADMIN"; initialService?: "moving-labor" | "box-truck-delivery" | "freight" }) {
  // Mock admin metrics (gross booking volume, platform fees, and the
  // aspirational multi-market table) must never appear in production as if
  // they were live figures. Gated behind an explicit flag rather than
  // shown unconditionally — see README for how to set this for a demo.
  const DEMO_MODE = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
  const [view, setView] = useState<View>(initialRole ? ROLE_DEFAULT_VIEW[initialRole] : "marketplace");
  const [moversNeeded, setMoversNeeded] = useState(2);
  const [hours, setHours] = useState(3);
  // Service tier, not a customer-editable hourly rate — the platform
  // controls the actual wage server-side (see lib/pricing-rules.ts). This
  // tier only maps to a representative rate for this local preview
  // calculator; it is never sent anywhere, and no dollar-per-hour figure
  // is ever shown as something the customer picks.
  const [serviceTier, setServiceTier] = useState<"STANDARD" | "LEAD" | "SPECIALTY">("STANDARD");
  const TIER_PREVIEW_RATE_CENTS: Record<typeof serviceTier, number> = { STANDARD: 3200, LEAD: 3600, SPECIALTY: 4200 };
  const [urgent, setUrgent] = useState(false);
  const [urgentFeeMode, setUrgentFeeMode] = useState<"HOURLY_FEE" | "PERCENT_PREMIUM">("HOURLY_FEE");
  // Previously entirely uncontrolled (address, project type, description)
  // or missing altogether (startsAt) — the form could never have
  // actually submitted anything even if a submit handler existed.
  const [jobType, setJobType] = useState<"RESIDENTIAL_MOVE" | "COMMERCIAL_MOVE" | "LOADING" | "UNLOADING" | "LABOR_ONLY" | "FURNITURE_DELIVERY" | "STORAGE_MOVE">("RESIDENTIAL_MOVE");
  const [jobDescription, setJobDescription] = useState("");
  const [jobStartsAt, setJobStartsAt] = useState("");
  const [addressLine1, setAddressLine1] = useState("");
  const [addressCity, setAddressCity] = useState("");
  const [addressState, setAddressState] = useState("");
  const [addressZip, setAddressZip] = useState("");
  const [postJobBusy, setPostJobBusy] = useState(false);
  const [postJobMessage, setPostJobMessage] = useState<string | null>(null);
  const [postedJobId, setPostedJobId] = useState<string | null>(null);
  const [postedJobAmountCents, setPostedJobAmountCents] = useState<number>(0);

  async function handlePostJob() {
    setPostJobBusy(true);
    setPostJobMessage(null);
    try {
      const addressRes = await authFetch("/api/addresses", {
        method: "POST",
        body: JSON.stringify({ line1: addressLine1, city: addressCity, state: addressState, postalCode: addressZip }),
      });
      const addressData = await addressRes.json().catch(() => ({}));
      if (!addressRes.ok) throw new Error(typeof addressData.error === "string" ? addressData.error : "Could not save that address.");

      const jobRes = await authFetch("/api/jobs", {
        method: "POST",
        body: JSON.stringify({
          addressId: addressData.address.id,
          title: `${jobType.replaceAll("_", " ")} — ${addressCity}`,
          description: jobDescription || undefined,
          type: jobType,
          startsAt: jobStartsAt ? new Date(jobStartsAt).toISOString() : undefined,
          estimatedHours: hours,
          movers: moversNeeded,
          urgent,
        }),
      });
      const jobData = await jobRes.json().catch(() => ({}));
      if (!jobRes.ok) throw new Error(typeof jobData.error === "string" ? jobData.error : "Could not post that job.");

      setPostedJobId(jobData.job?.id ?? null);
      setPostedJobAmountCents(jobData.job?.estimatedTotalCents ?? 0);
      setPostJobMessage(`Job posted — estimated total ${money(jobData.job?.estimatedTotalCents ?? 0)}. Authorize payment below to confirm the booking.`);
    } catch (e) {
      setPostJobMessage(e instanceof NotSignedInError ? "Sign in to post a job." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setPostJobBusy(false);
    }
  }

  // Freight load posting — POST /api/loads previously had zero frontend
  // caller at all, not even a disabled placeholder. Its schema
  // (lib/loads/post-load-schema.ts) is architecturally different from
  // job posting: raw address fields (originCity/originState/originZip,
  // exactPickupAddress as free text), never a saved addressId — freight
  // loads were never designed around the Address model the way moving
  // jobs are, so /api/addresses genuinely doesn't apply here.
  type FreightServiceType = "OWNER_OPERATOR_BOX_TRUCK" | "OWNER_OPERATOR_SEMI" | "CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY";
  const [freightServiceType, setFreightServiceType] = useState<FreightServiceType>("OWNER_OPERATOR_BOX_TRUCK");
  const [freightTitle, setFreightTitle] = useState("");
  const [originCity, setOriginCity] = useState("");
  const [originState, setOriginState] = useState("");
  const [originZip, setOriginZip] = useState("");
  const [destinationCity, setDestinationCity] = useState("");
  const [destinationState, setDestinationState] = useState("");
  const [pickupDate, setPickupDate] = useState("");
  const [estimatedHoursOrMiles, setEstimatedHoursOrMiles] = useState("");
  const [stopCount, setStopCount] = useState(0);
  const [liftgateRequired, setLiftgateRequired] = useState(false);
  const [cdlRequired, setCdlRequired] = useState(false);
  const [isLocalRoute, setIsLocalRoute] = useState(false);
  const [exactPickupAddress, setExactPickupAddress] = useState("");
  const [exactDeliveryAddress, setExactDeliveryAddress] = useState("");
  const [shipperContactName, setShipperContactName] = useState("");
  const [shipperContactPhone, setShipperContactPhone] = useState("");
  const [commodityDescription, setCommodityDescription] = useState("");
  // Pricing fields — only the one matching the selected service type is
  // ever sent, matching the backend's discriminated union exactly (an
  // hourly rate can never be submitted alongside a flat payout).
  const [driverPayoutCents, setDriverPayoutCents] = useState("");
  const [routeGrossCents, setRouteGrossCents] = useState("");
  const [driverHourlyRateCents, setDriverHourlyRateCents] = useState("");
  const [freightEstimatedHours, setFreightEstimatedHours] = useState("");
  const [freightBusy, setFreightBusy] = useState(false);
  const [freightMessage, setFreightMessage] = useState<string | null>(null);
  const [postedLoadId, setPostedLoadId] = useState<string | null>(null);
  const [postedLoadAmountCents, setPostedLoadAmountCents] = useState<number>(0);

  async function handlePostFreightLoad() {
    setFreightBusy(true);
    setFreightMessage(null);
    try {
      const base = {
        title: freightTitle,
        originCity, originState: originState.toUpperCase(), originZip: originZip || undefined,
        destinationCity, destinationState: destinationState.toUpperCase(),
        pickupDate: pickupDate ? new Date(pickupDate).toISOString() : undefined,
        estimatedHoursOrMiles,
        stopCount, liftgateRequired, cdlRequired, isLocalRoute,
        exactPickupAddress: exactPickupAddress || undefined,
        exactDeliveryAddress: exactDeliveryAddress || undefined,
        shipperContactName: shipperContactName || undefined,
        shipperContactPhone: shipperContactPhone || undefined,
        commodityDescription: commodityDescription || undefined,
      };
      let body: Record<string, unknown>;
      if (freightServiceType === "OWNER_OPERATOR_BOX_TRUCK") {
        body = { ...base, serviceType: freightServiceType, equipmentType: "BOX_TRUCK", driverPayoutCents: Math.round(Number(driverPayoutCents) * 100) };
      } else if (freightServiceType === "OWNER_OPERATOR_SEMI") {
        body = { ...base, serviceType: freightServiceType, equipmentType: "SEMI_TRACTOR", routeGrossCents: Math.round(Number(routeGrossCents) * 100) };
      } else {
        body = { ...base, serviceType: freightServiceType, equipmentType: "BOX_TRUCK", driverHourlyRateCents: Math.round(Number(driverHourlyRateCents) * 100), estimatedHours: Number(freightEstimatedHours) };
      }

      const res = await authFetch("/api/loads", { method: "POST", body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : JSON.stringify(data.error ?? `Load posting failed (${res.status}).`));

      setPostedLoadId(data.load?.id ?? null);
      setPostedLoadAmountCents(data.totalCents ?? 0);
      setFreightMessage(`Load posted — total ${money(data.totalCents ?? 0)}. Authorize payment below to confirm the booking.`);
    } catch (e) {
      setFreightMessage(e instanceof NotSignedInError ? "Sign in to post a freight load." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setFreightBusy(false);
    }
  }

  // Customer's own jobs and loads — previously there was no way for a
  // customer to see their own past jobs/loads at all after posting them,
  // which is also what a "leave a tip" flow needs: somewhere to trigger
  // it from for something completed in a past session, not just the
  // just-posted success state.
  type MyJobRow = { id: string; title: string; status: string; paymentStatus: string; estimatedTotalCents: number };
  type MyLoadRow = { id: string; title: string; status: string; paymentStatus: string; grossCarrierCents: number; platformFeeCents: number };
  const [myJobs, setMyJobs] = useState<MyJobRow[] | null>(null);
  const [myLoads, setMyLoads] = useState<MyLoadRow[] | null>(null);
  const [myJobsLoadsError, setMyJobsLoadsError] = useState<string | null>(null);
  const [tippingEntity, setTippingEntity] = useState<{ type: "job" | "load"; id: string } | null>(null);
  type SentInvitationRow = { id: string; status: string; expiresAt: string | null; respondedAt: string | null; createdAt: string; worker: { id: string; displayName: string } };
  const [trackingEntity, setTrackingEntity] = useState<{ type: "job" | "load"; id: string } | null>(null);
  const [sentInvitations, setSentInvitations] = useState<SentInvitationRow[] | null>(null);
  const [sentInvitationsError, setSentInvitationsError] = useState<string | null>(null);

  async function handleToggleTrackInvitations(type: "job" | "load", id: string) {
    if (trackingEntity?.type === type && trackingEntity?.id === id) {
      setTrackingEntity(null);
      setSentInvitations(null);
      return;
    }
    setTrackingEntity({ type, id });
    setSentInvitations(null);
    setSentInvitationsError(null);
    try {
      const path = type === "job" ? `/api/jobs/${id}/invitations` : `/api/loads/${id}/invitations`;
      const res = await authFetch(path);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Failed to load invitations (${res.status}).`);
      setSentInvitations(data.invitations);
    } catch (e) {
      setSentInvitationsError(e instanceof NotSignedInError ? "Sign in to view invitations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function loadMyJobsAndLoads() {
    setMyJobsLoadsError(null);
    try {
      const [jobsRes, loadsRes] = await Promise.all([authFetch("/api/jobs"), authFetch("/api/loads/mine")]);
      if (!jobsRes.ok || !loadsRes.ok) throw new Error("Failed to load your jobs and loads.");
      const jobsData: { jobs: MyJobRow[] } = await jobsRes.json();
      const loadsData: { loads: MyLoadRow[] } = await loadsRes.json();
      setMyJobs(jobsData.jobs);
      setMyLoads(loadsData.loads);
    } catch (e) {
      setMyJobsLoadsError(e instanceof NotSignedInError ? "Sign in to view your jobs and loads." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "customer") return;
    loadMyJobsAndLoads();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  // Approve Hours — the gap a review found: the backend approval route
  // already existed and worked correctly, but nothing in the frontend
  // ever called it, so a checked-out assignment had no path to
  // approval, and a job had no path to COMPLETED, at all.
  type AssignmentRow = {
    id: string; status: string; scheduledHours: string; actualHours: string | null;
    checkInAt: string | null; checkOutAt: string | null; customerApprovedAt: string | null;
    worker: { id: string; displayName: string };
  };
  const [expandedApprovalJobId, setExpandedApprovalJobId] = useState<string | null>(null);
  const [jobAssignments, setJobAssignments] = useState<AssignmentRow[] | null>(null);
  const [assignmentsError, setAssignmentsError] = useState<string | null>(null);
  const [assignmentActionBusyId, setAssignmentActionBusyId] = useState<string | null>(null);
  const [assignmentActionMessage, setAssignmentActionMessage] = useState<string | null>(null);
  const [disputingAssignmentId, setDisputingAssignmentId] = useState<string | null>(null);
  const [disputeReason, setDisputeReason] = useState("");

  async function loadJobAssignments(jobId: string) {
    setAssignmentsError(null);
    setJobAssignments(null);
    try {
      const res = await authFetch(`/api/jobs/${jobId}/assignments`);
      if (!res.ok) throw new Error(`Failed to load workers for this job (${res.status}).`);
      const data: { assignments: AssignmentRow[] } = await res.json();
      setJobAssignments(data.assignments);
    } catch (e) {
      setAssignmentsError(e instanceof NotSignedInError ? "Sign in to view this job's workers." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  function toggleApprovalExpansion(jobId: string) {
    if (expandedApprovalJobId === jobId) {
      setExpandedApprovalJobId(null);
      setJobAssignments(null);
    } else {
      setExpandedApprovalJobId(jobId);
      loadJobAssignments(jobId);
    }
  }

  async function handleApproveAssignment(assignmentId: string) {
    setAssignmentActionBusyId(assignmentId);
    setAssignmentActionMessage(null);
    try {
      const res = await authFetch(`/api/assignments/${assignmentId}/approve`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Approval failed (${res.status}).`);
      setAssignmentActionMessage(data.jobCompleted ? "Hours approved — this was the last worker, so the job is now complete." : "Hours approved.");
      if (expandedApprovalJobId) await loadJobAssignments(expandedApprovalJobId);
      await loadMyJobsAndLoads();
    } catch (e) {
      setAssignmentActionMessage(e instanceof NotSignedInError ? "Sign in to approve hours." : e instanceof Error ? e.message : "Approval failed.");
    } finally {
      setAssignmentActionBusyId(null);
    }
  }

  async function handleDisputeAssignment(assignmentId: string) {
    if (!disputeReason.trim()) return;
    setAssignmentActionBusyId(assignmentId);
    setAssignmentActionMessage(null);
    try {
      const res = await authFetch(`/api/assignments/${assignmentId}/dispute`, { method: "POST", body: JSON.stringify({ reason: disputeReason.trim() }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Dispute failed (${res.status}).`);
      setAssignmentActionMessage("Dispute submitted — our team will review these hours before anything is approved or billed.");
      setDisputingAssignmentId(null);
      setDisputeReason("");
      if (expandedApprovalJobId) await loadJobAssignments(expandedApprovalJobId);
    } catch (e) {
      setAssignmentActionMessage(e instanceof NotSignedInError ? "Sign in to dispute hours." : e instanceof Error ? e.message : "Dispute failed.");
    } finally {
      setAssignmentActionBusyId(null);
    }
  }

  // Preserves the service intent selected on the marketing homepage
  // (moving-labor / box-truck-delivery / freight) through registration
  // and into the customer dashboard — previously every service button
  // on the homepage produced the identical generic intent, so a
  // customer who specifically clicked "Post a Freight Load" landed on
  // the same view as one who clicked "Book Moving Labor," with no
  // indication which form to scroll to.
  const jobPostingPanelRef = useRef<HTMLElement>(null);
  const freightPostingPanelRef = useRef<HTMLElement>(null);
  useEffect(() => {
    if (view !== "customer" || !initialService) return;
    if (initialService === "moving-labor") {
      jobPostingPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    } else {
      // Both box-truck-delivery and freight land on the freight panel —
      // box-truck-delivery additionally pre-selects the matching
      // service-type branch, since that mapping is unambiguous (a
      // customer asking for box truck delivery wants the owner-operator
      // flat-rate branch, not the driver-only hourly one). "freight"
      // alone is left at the form's own default rather than guessing
      // between the semi and driver-only branches.
      if (initialService === "box-truck-delivery") setFreightServiceType("OWNER_OPERATOR_BOX_TRUCK");
      freightPostingPanelRef.current?.scrollIntoView({ behavior: "smooth", block: "start" });
    }
    // Intentionally only on the initial arrival at the customer view —
    // this is a one-time landing behavior, not something that should
    // re-fire and yank the page around on every subsequent view change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  const [driverMode, setDriverMode] = useState<"BOX_TRUCK" | "SEMI">("BOX_TRUCK");
  const [boxTruckPayout, setBoxTruckPayout] = useState(400);
  const [boxTruckAccessorials, setBoxTruckAccessorials] = useState(0);
  const [semiGross, setSemiGross] = useState(2000);
  const [driverPlan, setDriverPlan] = useState<"DRIVER_BASIC" | "OWNER_OPERATOR_PRO" | "FLEET">("DRIVER_BASIC");

  const [subscriptionBusy, setSubscriptionBusy] = useState(false);
  const [subscriptionMessage, setSubscriptionMessage] = useState<string | null>(null);

  async function handleManageSubscription(plan: "MOVER" | "DRIVER_BASIC" | "OWNER_OPERATOR_PRO" | "FLEET") {
    setSubscriptionBusy(true);
    setSubscriptionMessage(null);
    try {
      const portalResult = await openBillingPortal();
      if (portalResult.opened) return; // already navigating to Stripe's portal
      // No billing profile yet — this is a brand-new subscriber, so fall
      // back to starting Checkout, same as before.
      const result = await startSubscriptionCheckout(plan);
      if (result.waived) setSubscriptionMessage(result.message ?? "Waived until your first completed job.");
      // Otherwise the browser is already navigating away to Stripe Checkout.
    } catch (e) {
      setSubscriptionMessage(e instanceof NotSignedInError ? "Sign in to manage your subscription." : e instanceof Error ? e.message : "Something went wrong.");
    } finally {
      setSubscriptionBusy(false);
    }
  }

  const [adminStats, setAdminStats] = useState<AdminSubscriptionStats | null>(null);
  const [adminStatsError, setAdminStatsError] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "admin") return;
    let cancelled = false;
    authFetch("/api/admin/subscriptions")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load subscriptions (${res.status}).`);
        return res.json();
      })
      .then((data) => { if (!cancelled) setAdminStats(data); })
      .catch((e) => { if (!cancelled) setAdminStatsError(e instanceof NotSignedInError ? "Sign in as an admin to view live subscription data." : e.message); });
    return () => { cancelled = true; };
  }, [view]);

  // Worker payout history — previously no worker could see their own
  // payout status in-app at all, despite the full lifecycle (including
  // the PAID_OUT bank-arrival confirmation added in the P1-08 fix)
  // being real and tracked correctly in the database.
  type PayoutHistoryRow = {
    id: string; type: "payout" | "settlement"; grossEarningsCents: number; adjustmentsCents: number;
    netPayoutCents: number; status: string; scheduledAt?: string | null; paidAt: string | null;
    paidOutAt: string | null; failureReason: string | null; reversedAt: string | null; createdAt: string;
  };
  const [payoutHistory, setPayoutHistory] = useState<{ payouts: PayoutHistoryRow[]; settlements: PayoutHistoryRow[] } | null>(null);
  const [payoutHistoryError, setPayoutHistoryError] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "mover" && view !== "driver") return;
    let cancelled = false;
    authFetch("/api/payouts/my")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load payout history (${res.status}).`);
        return res.json();
      })
      .then((data) => { if (!cancelled) setPayoutHistory(data); })
      .catch((e) => { if (!cancelled) setPayoutHistoryError(e instanceof NotSignedInError ? "Sign in to view your payout history." : e.message); });
    return () => { cancelled = true; };
  }, [view]);

  // Driver's assigned loads with full details — the gap found while
  // verifying the full freight path: POST .../request already correctly
  // returns full details (exact addresses, shipper contact, access
  // code) at the moment of assignment, but that was the only time it
  // was ever shown. GET /api/driver/loads always applies the sanitized
  // selector and only lists OPEN/OFFER_RECEIVED loads anyway. This is
  // what lets a driver come back later and still see the address they
  // need to actually complete the delivery.
  type AssignedLoadRow = {
    id: string; title: string; status: string; originCity: string; originState: string;
    destinationCity: string; destinationState: string; equipmentType: string; pickupDate: string;
    estimatedHoursOrMiles: string; stopCount: number; liftgateRequired: boolean; cdlRequired: boolean;
    isLocalRoute: boolean; grossCarrierCents: number;
    exactPickupAddress: string | null; exactDeliveryAddress: string | null;
    shipperContactName: string | null; shipperContactPhone: string | null;
    accessCode: string | null; commodityDescription: string | null;
  };
  const [assignedLoads, setAssignedLoads] = useState<AssignedLoadRow[] | null>(null);
  const [assignedLoadsError, setAssignedLoadsError] = useState<string | null>(null);
  const [expandedLoadId, setExpandedLoadId] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "driver") return;
    let cancelled = false;
    authFetch("/api/driver/assigned-loads")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load your assigned loads (${res.status}).`);
        return res.json();
      })
      .then((data) => { if (!cancelled) setAssignedLoads(data.loads); })
      .catch((e) => { if (!cancelled) setAssignedLoadsError(e instanceof NotSignedInError ? "Sign in to view your assigned loads." : e.message); });
    return () => { cancelled = true; };
  }, [view]);

  // Worker tip history — fires for both mover and driver views, mirroring
  // the payout-history fetch pattern.
  type TipAllocationRow = {
    id: string; amountCents: number; status: string; paidAt: string | null; paidOutAt: string | null;
    failureReason: string | null; createdAt: string; entityTitle: string; tipTotalCents: number;
  };
  const [tipAllocations, setTipAllocations] = useState<TipAllocationRow[] | null>(null);
  const [tipAllocationsError, setTipAllocationsError] = useState<string | null>(null);
  useEffect(() => {
    if (view !== "mover" && view !== "driver") return;
    let cancelled = false;
    authFetch("/api/tips/my")
      .then(async (res) => {
        if (!res.ok) throw new Error(`Failed to load your tip history (${res.status}).`);
        return res.json();
      })
      .then((data) => { if (!cancelled) setTipAllocations(data.allocations); })
      .catch((e) => { if (!cancelled) setTipAllocationsError(e instanceof NotSignedInError ? "Sign in to view your tip history." : e.message); });
    return () => { cancelled = true; };
  }, [view]);

  // Worker invitation inboxes — Phase 3 (Choose Your Helper). The
  // backend for both (job invite/accept/decline, load invite/accept/
  // decline) has existed since an earlier round; this is the first
  // frontend for any of it.
  type JobInvitationRow = {
    id: string; expiresAt: string | null; createdAt: string; agreedEarningsCents: number; scheduledHours: string;
    job: { id: string; title: string; type: string; startsAt: string; market: { name: string; state: string } | null };
  };
  type LoadInvitationRow = {
    id: string; expiresAt: string | null; createdAt: string;
    carrierRoute: { id: string; title: string; originCity: string; originState: string; destinationCity: string; destinationState: string; pickupDate: string; equipmentType: string; grossCarrierCents: number };
  };
  const [jobInvitations, setJobInvitations] = useState<JobInvitationRow[] | null>(null);
  const [jobInvitationsError, setJobInvitationsError] = useState<string | null>(null);
  const [loadInvitations, setLoadInvitations] = useState<LoadInvitationRow[] | null>(null);
  const [loadInvitationsError, setLoadInvitationsError] = useState<string | null>(null);
  const [invitationActionBusyId, setInvitationActionBusyId] = useState<string | null>(null);
  const [invitationActionMessage, setInvitationActionMessage] = useState<string | null>(null);

  async function loadJobInvitations() {
    setJobInvitationsError(null);
    try {
      const res = await authFetch("/api/worker/invitations");
      if (!res.ok) throw new Error(`Failed to load invitations (${res.status}).`);
      const data = await res.json();
      setJobInvitations(data.invitations);
    } catch (e) {
      setJobInvitationsError(e instanceof NotSignedInError ? "Sign in to view your invitations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "mover") return;
    loadJobInvitations();
  }, [view]);

  async function loadLoadInvitations() {
    setLoadInvitationsError(null);
    try {
      const res = await authFetch("/api/driver/load-invitations");
      if (!res.ok) throw new Error(`Failed to load invitations (${res.status}).`);
      const data = await res.json();
      setLoadInvitations(data.invitations);
    } catch (e) {
      setLoadInvitationsError(e instanceof NotSignedInError ? "Sign in to view your invitations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "driver") return;
    loadLoadInvitations();
  }, [view]);

  async function handleJobInvitationAction(invitationId: string, action: "accept" | "decline") {
    setInvitationActionBusyId(invitationId);
    setInvitationActionMessage(null);
    try {
      const res = await authFetch(`/api/assignments/${invitationId}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not ${action} invitation (${res.status}).`);
      setInvitationActionMessage(action === "accept" ? "Invitation accepted — you're on the job." : "Invitation declined.");
      await loadJobInvitations();
    } catch (e) {
      setInvitationActionMessage(e instanceof NotSignedInError ? "Sign in to respond to invitations." : e instanceof Error ? e.message : `Could not ${action} invitation.`);
    } finally {
      setInvitationActionBusyId(null);
    }
  }

  async function handleLoadInvitationAction(invitationId: string, action: "accept" | "decline") {
    setInvitationActionBusyId(invitationId);
    setInvitationActionMessage(null);
    try {
      const res = await authFetch(`/api/load-invitations/${invitationId}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not ${action} invitation (${res.status}).`);
      setInvitationActionMessage(action === "accept" ? "Invitation accepted — the load is yours." : "Invitation declined.");
      await loadLoadInvitations();
    } catch (e) {
      setInvitationActionMessage(e instanceof NotSignedInError ? "Sign in to respond to invitations." : e instanceof Error ? e.message : `Could not ${action} invitation.`);
    } finally {
      setInvitationActionBusyId(null);
    }
  }

  // Admin capture triggers — GET /api/admin/captures (new lookup) +
  // the existing, already-correct POST capture-payment routes for jobs
  // and freight loads, neither of which had any UI caller before this.
  type CaptureReadyItem = { id: string; title: string; customerName: string | null; type: "job" | "load" } & (
    | { ready: true; amountCents: number; estimatedTotalCents?: number }
    | { ready: false; reason: string; estimatedTotalCents: number }
  );
  const [captureItems, setCaptureItems] = useState<{ jobs: CaptureReadyItem[]; loads: CaptureReadyItem[] } | null>(null);
  const [captureError, setCaptureError] = useState<string | null>(null);
  const [captureBusyId, setCaptureBusyId] = useState<string | null>(null);
  const [captureMessage, setCaptureMessage] = useState<string | null>(null);

  async function loadCaptureReadyItems() {
    setCaptureError(null);
    try {
      const res = await authFetch("/api/admin/captures");
      if (!res.ok) throw new Error(`Failed to load capture-ready items (${res.status}).`);
      setCaptureItems(await res.json());
    } catch (e) {
      setCaptureError(e instanceof NotSignedInError ? "Sign in as an admin to view capture-ready items." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "admin") return;
    loadCaptureReadyItems();
  }, [view]);

  async function handleCapture(item: CaptureReadyItem) {
    if (!item.ready) return;
    setCaptureBusyId(item.id);
    setCaptureMessage(null);
    try {
      const path = item.type === "job" ? `/api/jobs/${item.id}/capture-payment` : `/api/loads/${item.id}/capture-payment`;
      const res = await authFetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Capture failed (${res.status}).`);
      setCaptureMessage(`Captured ${item.title}.`);
      await loadCaptureReadyItems();
    } catch (e) {
      setCaptureMessage(e instanceof NotSignedInError ? "Sign in as an admin to capture payments." : e instanceof Error ? e.message : "Capture failed.");
    } finally {
      setCaptureBusyId(null);
    }
  }

  // Admin payout trigger — GET /api/admin/payouts-ready (new lookup) +
  // the existing, already-correct payout/settlement pay routes, neither
  // of which had a UI caller before this.
  type PayoutReadyItem = {
    id: string; type: "payout" | "settlement"; workerName: string; amountCents: number;
    status: string; failureReason: string | null; connectReady: boolean; loadsSettled?: number;
  };
  const [payoutsReady, setPayoutsReady] = useState<{ payouts: PayoutReadyItem[]; settlements: PayoutReadyItem[] } | null>(null);
  const [payoutsReadyError, setPayoutsReadyError] = useState<string | null>(null);
  const [payoutTriggerBusyId, setPayoutTriggerBusyId] = useState<string | null>(null);
  const [payoutTriggerMessage, setPayoutTriggerMessage] = useState<string | null>(null);

  async function loadPayoutsReady() {
    setPayoutsReadyError(null);
    try {
      const res = await authFetch("/api/admin/payouts-ready");
      if (!res.ok) throw new Error(`Failed to load payouts (${res.status}).`);
      setPayoutsReady(await res.json());
    } catch (e) {
      setPayoutsReadyError(e instanceof NotSignedInError ? "Sign in as an admin to view pending payouts." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "admin") return;
    loadPayoutsReady();
  }, [view]);

  async function handleTriggerPayout(item: PayoutReadyItem) {
    if (!item.connectReady) return;
    setPayoutTriggerBusyId(item.id);
    setPayoutTriggerMessage(null);
    try {
      const path = item.type === "payout" ? `/api/payouts/${item.id}/pay` : `/api/settlements/${item.id}/pay`;
      const res = await authFetch(path, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Payout failed (${res.status}).`);
      // "transferred: true" means submitted to Stripe, not that the money
      // has arrived — bank arrival is a separate, later confirmation
      // (PAID_OUT) that only the payout.paid webhook can report. Saying
      // "Paid" here would misrepresent the exact same TRANSFERRED-vs-
      // PAID_OUT distinction this whole payment system was built to keep
      // straight.
      if (data.fullyOffset) {
        setPayoutTriggerMessage(`${item.workerName}'s payout was fully offset by an outstanding balance — nothing was transferred.`);
      } else {
        setPayoutTriggerMessage(`Transfer initiated for ${item.workerName} — ${money(item.amountCents)}. Final payout status will update after Stripe confirms processing.`);
      }
      await loadPayoutsReady();
    } catch (e) {
      setPayoutTriggerMessage(e instanceof NotSignedInError ? "Sign in as an admin to trigger payouts." : e instanceof Error ? e.message : "Payout failed.");
    } finally {
      setPayoutTriggerBusyId(null);
    }
  }

  // Admin tip reporting — GET /api/admin/tips (new) + the existing,
  // already-correct POST /api/admin/tip-allocations/[id]/pay route.
  type TipAllocationReportRow = {
    id: string; amountCents: number; status: string; paidAt: string | null; paidOutAt: string | null; failureReason: string | null;
    worker: { id: string; displayName: string; stripePayoutsEnabled: boolean };
  };
  type TipReportRow = {
    id: string; amountCents: number; status: string; failureReason: string | null; createdAt: string; succeededAt: string | null;
    entityTitle: string; entityType: "job" | "load"; customerName: string; allocations: TipAllocationReportRow[];
  };
  const [adminTips, setAdminTips] = useState<TipReportRow[] | null>(null);
  const [adminTipsError, setAdminTipsError] = useState<string | null>(null);
  const [tipAllocationBusyId, setTipAllocationBusyId] = useState<string | null>(null);
  const [tipAllocationMessage, setTipAllocationMessage] = useState<string | null>(null);

  async function loadAdminTips() {
    setAdminTipsError(null);
    try {
      const res = await authFetch("/api/admin/tips");
      if (!res.ok) throw new Error(`Failed to load tips (${res.status}).`);
      const data: { tips: TipReportRow[] } = await res.json();
      setAdminTips(data.tips);
    } catch (e) {
      setAdminTipsError(e instanceof NotSignedInError ? "Sign in as an admin to view tips." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "admin") return;
    loadAdminTips();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function handlePayTipAllocation(allocation: TipAllocationReportRow) {
    setTipAllocationBusyId(allocation.id);
    setTipAllocationMessage(null);
    try {
      const res = await authFetch(`/api/admin/tip-allocations/${allocation.id}/pay`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Tip payout failed (${res.status}).`);
      // Same TRANSFERRED-vs-PAID_OUT distinction preserved here as
      // everywhere else this system moves money to a worker.
      setTipAllocationMessage(`Transfer initiated for ${allocation.worker.displayName} — ${money(allocation.amountCents)}. Final status will update after Stripe confirms processing.`);
      await loadAdminTips();
    } catch (e) {
      setTipAllocationMessage(e instanceof NotSignedInError ? "Sign in as an admin to pay tips." : e instanceof Error ? e.message : "Tip payout failed.");
    } finally {
      setTipAllocationBusyId(null);
    }
  }

  async function handleRetryTipAllocation(tipId: string) {
    setTipAllocationBusyId(tipId);
    setTipAllocationMessage(null);
    try {
      const res = await authFetch(`/api/admin/tips/${tipId}/retry-allocation`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Retry failed (${res.status}).`);
      setTipAllocationMessage("Tip allocation retried successfully — workers have been notified.");
      await loadAdminTips();
    } catch (e) {
      setTipAllocationMessage(e instanceof NotSignedInError ? "Sign in as an admin to retry tip allocation." : e instanceof Error ? e.message : "Retry failed.");
    } finally {
      setTipAllocationBusyId(null);
    }
  }

  // Admin partner billing/invoicing — GET /api/admin/partners (new
  // lookup, same missing-search pattern as everything above),
  // GET /api/partners/[id]/billing (already existed, P2-01-hardened),
  // GET /api/partners/[id]/invoices (new — listing existing invoices,
  // the generate route alone couldn't show invoice history), and
  // POST /api/partners/[id]/invoices (already existed, P0-04).
  type PartnerSearchResult = { id: string; displayName: string; type: string; monthlyInvoicing: boolean; active: boolean; _count: { invoices: number } };
  type PartnerInvoiceRow = {
    id: string; periodStart: string; periodEnd: string; status: string; subtotalCents: number; platformFeeCents: number; totalCents: number;
    stripeInvoiceId: string | null; dueDate: string | null; finalizedAt: string | null; paidAt: string | null; voidedAt: string | null; lineCount: number;
  };
  const [partnerQuery, setPartnerQuery] = useState("");
  const [partnerResults, setPartnerResults] = useState<PartnerSearchResult[] | null>(null);
  const [partnerSearchBusy, setPartnerSearchBusy] = useState(false);
  const [partnerSearchError, setPartnerSearchError] = useState<string | null>(null);
  const [selectedPartner, setSelectedPartner] = useState<PartnerSearchResult | null>(null);
  const [partnerInvoices, setPartnerInvoices] = useState<PartnerInvoiceRow[] | null>(null);
  const [partnerInvoicesError, setPartnerInvoicesError] = useState<string | null>(null);
  const [billingReport, setBillingReport] = useState<{ subtotalCents: number; platformFeeCents: number; totalCents: number; period: { from: string; to: string }; lineItems: unknown[] } | null>(null);
  const [billingReportError, setBillingReportError] = useState<string | null>(null);
  const [invoicePeriodStart, setInvoicePeriodStart] = useState("");
  const [invoicePeriodEnd, setInvoicePeriodEnd] = useState("");
  const [invoiceGenerateBusy, setInvoiceGenerateBusy] = useState(false);
  const [invoiceMessage, setInvoiceMessage] = useState<string | null>(null);

  async function handlePartnerSearch() {
    if (!partnerQuery.trim()) return;
    setPartnerSearchBusy(true);
    setPartnerSearchError(null);
    setPartnerResults(null);
    try {
      const res = await authFetch(`/api/admin/partners?query=${encodeURIComponent(partnerQuery.trim())}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Search failed (${res.status}).`);
      }
      const data: { results: PartnerSearchResult[] } = await res.json();
      setPartnerResults(data.results);
    } catch (e) {
      setPartnerSearchError(e instanceof NotSignedInError ? "Sign in as an admin to search partners." : e instanceof Error ? e.message : "Search failed.");
    } finally {
      setPartnerSearchBusy(false);
    }
  }

  async function loadPartnerInvoicesAndReport(partnerId: string) {
    setPartnerInvoicesError(null);
    setBillingReportError(null);
    try {
      const res = await authFetch(`/api/partners/${partnerId}/invoices`);
      if (!res.ok) throw new Error(`Failed to load invoices (${res.status}).`);
      const data: { invoices: PartnerInvoiceRow[] } = await res.json();
      setPartnerInvoices(data.invoices);
    } catch (e) {
      setPartnerInvoicesError(e instanceof NotSignedInError ? "Sign in as an admin to view invoices." : e instanceof Error ? e.message : "Failed to load invoices.");
    }
    try {
      const res = await authFetch(`/api/partners/${partnerId}/billing`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Failed to load billing report (${res.status}).`);
      }
      setBillingReport(await res.json());
    } catch (e) {
      setBillingReportError(e instanceof NotSignedInError ? "Sign in as an admin to view the billing report." : e instanceof Error ? e.message : "Failed to load report.");
    }
  }

  function handleSelectPartner(p: PartnerSearchResult) {
    setSelectedPartner(p);
    setPartnerInvoices(null);
    setBillingReport(null);
    setInvoiceMessage(null);
    loadPartnerInvoicesAndReport(p.id);
  }

  async function handleGenerateInvoice() {
    if (!selectedPartner || !invoicePeriodStart || !invoicePeriodEnd) return;
    setInvoiceGenerateBusy(true);
    setInvoiceMessage(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/invoices`, {
        method: "POST",
        body: JSON.stringify({
          periodStart: new Date(`${invoicePeriodStart}T00:00:00.000Z`).toISOString(),
          periodEnd: toExclusiveEndDate(invoicePeriodEnd),
        }),
      });
      const data = await res.json().catch(() => ({}));
      // A 502 with an invoice present means Stripe invoice creation/
      // finalization failed, but the local draft invoice and its line
      // snapshots were already committed — this is NOT the same as
      // total failure, and treating it as one would hide from the
      // admin that a real draft now exists and needs follow-up.
      if (res.status === 502 && data.invoice) {
        setInvoiceMessage(`Invoice saved locally as DRAFT, but Stripe invoice delivery failed: ${typeof data.error === "string" ? data.error : "unknown error"}. Follow up manually — see the invoice history below.`);
        await loadPartnerInvoicesAndReport(selectedPartner.id);
        return;
      }
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Invoice generation failed (${res.status}).`);
      setInvoiceMessage(data.warning ? `Invoice created as DRAFT: ${data.warning}` : `Invoice ${data.invoice?.status ?? "created"} — ${money(data.invoice?.totalCents ?? 0)}.`);
      await loadPartnerInvoicesAndReport(selectedPartner.id);
    } catch (e) {
      setInvoiceMessage(e instanceof NotSignedInError ? "Sign in as an admin to generate invoices." : e instanceof Error ? e.message : "Invoice generation failed.");
    } finally {
      setInvoiceGenerateBusy(false);
    }
  }

  // Worker directory search — Phase 1 (Marketplace Profile System) of
  // the marketplace roadmap. Reuses selectedPartner from the partner
  // billing panel above, since worker-directory search is scoped to a
  // partner org the same way preferred-network management (Phase 2)
  // and invitations (Phase 3) will be.
  const [directoryQuery, setDirectoryQuery] = useState("");
  const [directoryWorkerType, setDirectoryWorkerType] = useState<"" | "MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER">("");
  // Phase 5 advanced filters/sort/pagination.
  type EnrichedWorker = WorkerCardData & { metrics?: { completionRate: number | null; medianResponseMs: number | null }; availabilityBadge?: "AVAILABLE_NOW" | "AVAILABLE_THIS_WEEK" | "AVAILABLE_LATER" | "NO_UPCOMING" };
  const [directorySkill, setDirectorySkill] = useState("");
  const [directoryLanguage, setDirectoryLanguage] = useState("");
  const [directoryMinRating, setDirectoryMinRating] = useState<"" | "3" | "4" | "4.5">("");
  const [directoryVerifiedOnly, setDirectoryVerifiedOnly] = useState(false);
  const [directoryAcceptingOnly, setDirectoryAcceptingOnly] = useState(false);
  const [directorySort, setDirectorySort] = useState<"" | "rating" | "completedJobs">("");
  const [directoryPage, setDirectoryPage] = useState(1);
  const [directoryPagination, setDirectoryPagination] = useState<{ page: number; pageSize: number; total: number; totalPages: number } | null>(null);
  const [directoryResults, setDirectoryResults] = useState<EnrichedWorker[] | null>(null);
  const [directoryBusy, setDirectoryBusy] = useState(false);
  const [directoryError, setDirectoryError] = useState<string | null>(null);

  // Phase 5 favorites — a Set of favorited workerIds for quick lookup by
  // the card's star toggle, plus the favorites list itself.
  const [favoriteWorkerIds, setFavoriteWorkerIds] = useState<Set<string>>(new Set());
  const [favorites, setFavorites] = useState<EnrichedWorker[] | null>(null);
  const [recentlyHired, setRecentlyHired] = useState<EnrichedWorker[] | null>(null);
  const [recommendations, setRecommendations] = useState<{ worker: EnrichedWorker; reason: string }[] | null>(null);
  const [savedSearches, setSavedSearches] = useState<{ id: string; name: string; params: Record<string, unknown> }[] | null>(null);
  const [discoveryError, setDiscoveryError] = useState<string | null>(null);
  const [saveSearchName, setSaveSearchName] = useState("");

  function buildDirectoryParams(page: number): URLSearchParams {
    const params = new URLSearchParams();
    if (directoryQuery.trim()) params.set("query", directoryQuery.trim());
    if (directoryWorkerType) params.set("workerType", directoryWorkerType);
    if (directorySkill.trim()) params.set("skill", directorySkill.trim());
    if (directoryLanguage.trim()) params.set("languageCode", directoryLanguage.trim().toLowerCase());
    if (directoryMinRating) params.set("minRating", directoryMinRating);
    if (directoryVerifiedOnly) params.set("verifiedOnly", "true");
    if (directoryAcceptingOnly) params.set("acceptingJobsOnly", "true");
    if (directorySort) params.set("sort", directorySort);
    params.set("page", String(page));
    return params;
  }

  async function handleSearchDirectory(page = 1) {
    if (!selectedPartner) return;
    setDirectoryBusy(true);
    setDirectoryError(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/worker-directory?${buildDirectoryParams(page).toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Search failed (${res.status}).`);
      setDirectoryResults(data.workers);
      setDirectoryPagination(data.pagination ?? null);
      setDirectoryPage(page);
    } catch (e) {
      setDirectoryError(e instanceof NotSignedInError ? "Sign in as an admin to search the worker directory." : e instanceof Error ? e.message : "Search failed.");
    } finally {
      setDirectoryBusy(false);
    }
  }

  async function loadFavorites() {
    setDiscoveryError(null);
    try {
      const res = await authFetch("/api/favorites");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load favorites.");
      const workers = (data.favorites as { worker: EnrichedWorker }[]).map(f => f.worker);
      setFavorites(workers);
      setFavoriteWorkerIds(new Set(workers.map(w => w.id)));
    } catch (e) {
      setDiscoveryError(e instanceof NotSignedInError ? "Sign in to view favorites." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleToggleFavorite(workerId: string) {
    const isFav = favoriteWorkerIds.has(workerId);
    // optimistic update
    setFavoriteWorkerIds(prev => { const next = new Set(prev); if (isFav) next.delete(workerId); else next.add(workerId); return next; });
    try {
      const res = isFav
        ? await authFetch(`/api/favorites/${workerId}`, { method: "DELETE" })
        : await authFetch("/api/favorites", { method: "POST", body: JSON.stringify({ workerId }) });
      if (!res.ok) throw new Error();
      if (favorites) loadFavorites();
    } catch {
      // revert on failure
      setFavoriteWorkerIds(prev => { const next = new Set(prev); if (isFav) next.add(workerId); else next.delete(workerId); return next; });
      setDiscoveryError("Could not update favorite.");
    }
  }

  async function loadRecentlyHired() {
    setDiscoveryError(null);
    try {
      const res = await authFetch("/api/workers/recently-hired");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load recently hired.");
      setRecentlyHired((data.recentlyHired as { worker: EnrichedWorker }[]).map(r => r.worker));
    } catch (e) {
      setDiscoveryError(e instanceof NotSignedInError ? "Sign in to view recently hired." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function loadRecommendations() {
    if (!selectedPartner) return;
    setDiscoveryError(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/recommended-workers`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load recommendations.");
      setRecommendations((data.recommendations as { worker: EnrichedWorker; reason: string }[]).map(r => ({ worker: r.worker, reason: r.reason })));
    } catch (e) {
      setDiscoveryError(e instanceof NotSignedInError ? "Sign in to view recommendations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function loadSavedSearches() {
    setDiscoveryError(null);
    try {
      const res = await authFetch("/api/saved-searches");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load saved searches.");
      setSavedSearches(data.savedSearches);
    } catch (e) {
      setDiscoveryError(e instanceof NotSignedInError ? "Sign in to view saved searches." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleSaveSearch() {
    if (!saveSearchName.trim()) return;
    setDiscoveryError(null);
    try {
      // Persist the current filter set (params minus pagination).
      const params = buildDirectoryParams(1);
      params.delete("page");
      const paramObj: Record<string, unknown> = {};
      for (const [k, v] of params.entries()) {
        if (k === "minRating") paramObj[k] = Number(v);
        else if (k === "verifiedOnly" || k === "acceptingJobsOnly") paramObj[k] = v === "true";
        else paramObj[k] = v;
      }
      const res = await authFetch("/api/saved-searches", { method: "POST", body: JSON.stringify({ name: saveSearchName.trim(), params: paramObj }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not save search.");
      setSaveSearchName("");
      loadSavedSearches();
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : "Could not save search.");
    }
  }

  async function handleApplySavedSearch(searchId: string) {
    if (!selectedPartner) return;
    setDiscoveryError(null);
    try {
      const res = await authFetch(`/api/saved-searches/${searchId}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : (data.stale ? "This saved search is no longer valid." : "Could not apply search."));
      // Replay against the directory using the returned querystring.
      setDirectoryBusy(true);
      const dres = await authFetch(`/api/partners/${selectedPartner.id}/worker-directory?${data.queryString}&page=1`);
      const ddata = await dres.json().catch(() => ({}));
      if (!dres.ok) throw new Error(typeof ddata.error === "string" ? ddata.error : "Replay failed.");
      setDirectoryResults(ddata.workers);
      setDirectoryPagination(ddata.pagination ?? null);
      setDirectoryPage(1);
    } catch (e) {
      setDiscoveryError(e instanceof Error ? e.message : "Could not apply search.");
    } finally {
      setDirectoryBusy(false);
    }
  }

  async function handleDeleteSavedSearch(searchId: string) {
    try {
      const res = await authFetch(`/api/saved-searches/${searchId}`, { method: "DELETE" });
      if (!res.ok) throw new Error();
      loadSavedSearches();
    } catch {
      setDiscoveryError("Could not delete saved search.");
    }
  }

  // Preferred Network Management — Phase 2 of the marketplace roadmap.
  // Wires the existing PreferredWorker CRUD backend (built prior round)
  // to a real UI for the first time.
  type PreferredWorkerRow = { id: string; priority: number; createdAt: string; worker: WorkerCardData };
  const [preferredWorkers, setPreferredWorkers] = useState<PreferredWorkerRow[] | null>(null);
  const [preferredNetworkFilterQuery, setPreferredNetworkFilterQuery] = useState("");
  const [preferredNetworkFilterType, setPreferredNetworkFilterType] = useState<"" | "MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER">("");
  const [preferredWorkersError, setPreferredWorkersError] = useState<string | null>(null);
  const [preferredNetworkBusyId, setPreferredNetworkBusyId] = useState<string | null>(null);
  const [preferredNetworkMessage, setPreferredNetworkMessage] = useState<string | null>(null);

  // Worker profile viewer — "open worker public profile," using the
  // Phase 1 GET /api/workers/[workerId]/profile endpoint, which had no
  // frontend caller until now.
  const [viewingWorkerProfile, setViewingWorkerProfile] = useState<{ worker: WorkerCardData; reviews: { rating: number; comment: string | null; tags: string[]; createdAt: string }[]; metrics?: { completionRate: number | null; medianResponseMs: number | null }; availabilityBadge?: "AVAILABLE_NOW" | "AVAILABLE_THIS_WEEK" | "AVAILABLE_LATER" | "NO_UPCOMING" } | null>(null);
  const [viewingWorkerProfileError, setViewingWorkerProfileError] = useState<string | null>(null);
  // Phase 5.5A: approved public gallery for the profile modal.
  type PublicMedia = { id: string; title: string | null; description: string | null; width: number | null; height: number | null; isPrimary: boolean; deliveryUrl: string | null; thumbnailUrl: string | null; category: { id: string; name: string; slug: string } | null };
  const [profileGallery, setProfileGallery] = useState<PublicMedia[] | null>(null);

  async function handleViewWorkerProfile(workerId: string) {
    setViewingWorkerProfile(null);
    setViewingWorkerProfileError(null);
    setProfileGallery(null);
    try {
      const res = await authFetch(`/api/workers/${workerId}/profile`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Failed to load profile (${res.status}).`);
      setViewingWorkerProfile(data);
      // Load the approved public gallery separately (public endpoint).
      try {
        const gres = await authFetch(`/api/workers/${workerId}/portfolio`);
        const gdata = await gres.json().catch(() => ({}));
        if (gres.ok) setProfileGallery(gdata.media);
      } catch { /* gallery is best-effort */ }
    } catch (e) {
      setViewingWorkerProfileError(e instanceof NotSignedInError ? "Sign in to view worker profiles." : e instanceof Error ? e.message : "Failed to load profile.");
    }
  }

  async function loadPreferredWorkers() {
    if (!selectedPartner) return;
    setPreferredWorkersError(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/preferred-workers`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Failed to load preferred network (${res.status}).`);
      setPreferredWorkers(data.preferredWorkers);
    } catch (e) {
      setPreferredWorkersError(e instanceof NotSignedInError ? "Sign in as an admin to view the preferred network." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "admin" || !selectedPartner) return;
    loadPreferredWorkers();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view, selectedPartner?.id]);

  async function handleAddPreferredWorker(workerId: string) {
    if (!selectedPartner) return;
    setPreferredNetworkBusyId(workerId);
    setPreferredNetworkMessage(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/preferred-workers`, { method: "POST", body: JSON.stringify({ workerId }) });
      const data = await res.json().catch(() => ({}));
      if (res.status === 409 && data.code === "DUPLICATE_PREFERRED_WORKER") {
        setPreferredNetworkMessage("This worker is already in your preferred network.");
        return;
      }
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not add worker (${res.status}).`);
      setPreferredNetworkMessage("Worker added to your preferred network.");
      await loadPreferredWorkers();
    } catch (e) {
      setPreferredNetworkMessage(e instanceof NotSignedInError ? "Sign in as an admin to manage the preferred network." : e instanceof Error ? e.message : "Could not add worker.");
    } finally {
      setPreferredNetworkBusyId(null);
    }
  }

  async function handleRemovePreferredWorker(workerId: string) {
    if (!selectedPartner) return;
    setPreferredNetworkBusyId(workerId);
    setPreferredNetworkMessage(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/preferred-workers/${workerId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not remove worker (${res.status}).`);
      setPreferredNetworkMessage("Worker removed from your preferred network. This only affects future opportunities — nothing about their past assignments changes.");
      await loadPreferredWorkers();
    } catch (e) {
      setPreferredNetworkMessage(e instanceof NotSignedInError ? "Sign in as an admin to manage the preferred network." : e instanceof Error ? e.message : "Could not remove worker.");
    } finally {
      setPreferredNetworkBusyId(null);
    }
  }

  async function handleChangePreferredPriority(workerId: string, priority: number) {
    if (!selectedPartner) return;
    setPreferredNetworkBusyId(workerId);
    setPreferredNetworkMessage(null);
    try {
      const res = await authFetch(`/api/partners/${selectedPartner.id}/preferred-workers/${workerId}`, { method: "PATCH", body: JSON.stringify({ priority }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not update priority (${res.status}).`);
      await loadPreferredWorkers();
    } catch (e) {
      setPreferredNetworkMessage(e instanceof NotSignedInError ? "Sign in as an admin to manage the preferred network." : e instanceof Error ? e.message : "Could not update priority.");
    } finally {
      setPreferredNetworkBusyId(null);
    }
  }

  // Invite action + target picker — Phase 3's core deliverable. Fetches
  // the customer's own open jobs (for movers) or open loads (for
  // drivers), lets them pick one, and sends a real invitation. Final
  // eligibility (market, capacity, assignment status) is authoritative
  // on the backend — this picker shows a reasonable candidate list, not
  // a duplicate of that validation.
  type InviteTargetJob = { id: string; title: string; status: string; startsAt: string; moversRequired: number };
  type InviteTargetLoad = { id: string; title: string; status: string; pickupDate: string; equipmentType: string };
  const [invitingWorker, setInvitingWorker] = useState<WorkerCardData | null>(null);
  const [inviteTargetJobs, setInviteTargetJobs] = useState<InviteTargetJob[] | null>(null);
  const [inviteTargetLoads, setInviteTargetLoads] = useState<InviteTargetLoad[] | null>(null);
  const [inviteTargetsError, setInviteTargetsError] = useState<string | null>(null);
  const [inviteBusy, setInviteBusy] = useState(false);
  const [inviteMessage, setInviteMessage] = useState<string | null>(null);
  // Which saved template (if any) to apply when sending a driver
  // invitation. Only used for freight loads — the mover/job invite
  // path has no template concept in Phase 4. "" means "default
  // message." Shared by both the single-invite modal and the bulk
  // invite panel so the customer picks a template once.
  const [inviteTemplateId, setInviteTemplateId] = useState<string>("");

  // Invitation templates (Phase 4) — reusable subject/body pairs.
  type InvitationTemplate = { id: string; name: string; subject: string; body: string; updatedAt: string };
  const [invitationTemplates, setInvitationTemplates] = useState<InvitationTemplate[] | null>(null);
  const [templatesError, setTemplatesError] = useState<string | null>(null);
  const [templateBusy, setTemplateBusy] = useState(false);
  const [templateMessage, setTemplateMessage] = useState<string | null>(null);
  const [templateDraftName, setTemplateDraftName] = useState("");
  const [templateDraftSubject, setTemplateDraftSubject] = useState("");
  const [templateDraftBody, setTemplateDraftBody] = useState("");
  const [editingTemplateId, setEditingTemplateId] = useState<string | null>(null);

  // Bulk freight invitations (Phase 4) — invite several drivers to one
  // load at once. Selection is a set of workerIds picked from the
  // preferred-network roster; the target load is chosen in the panel.
  const [bulkSelectedWorkerIds, setBulkSelectedWorkerIds] = useState<string[]>([]);
  const [bulkTargetLoads, setBulkTargetLoads] = useState<InviteTargetLoad[] | null>(null);
  const [bulkInviteBusy, setBulkInviteBusy] = useState(false);
  const [bulkInviteResults, setBulkInviteResults] = useState<{ workerId: string; ok: boolean; error?: string }[] | null>(null);
  const [bulkInviteMessage, setBulkInviteMessage] = useState<string | null>(null);

  async function loadInvitationTemplates() {
    setTemplatesError(null);
    try {
      const res = await authFetch("/api/invitation-templates");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Failed to load templates (${res.status}).`);
      setInvitationTemplates(data.templates);
    } catch (e) {
      setTemplatesError(e instanceof NotSignedInError ? "Sign in to manage invitation templates." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  function beginEditTemplate(t: InvitationTemplate) {
    setEditingTemplateId(t.id);
    setTemplateDraftName(t.name);
    setTemplateDraftSubject(t.subject);
    setTemplateDraftBody(t.body);
    setTemplateMessage(null);
  }

  function resetTemplateDraft() {
    setEditingTemplateId(null);
    setTemplateDraftName("");
    setTemplateDraftSubject("");
    setTemplateDraftBody("");
  }

  async function handleSaveTemplate() {
    setTemplateBusy(true);
    setTemplateMessage(null);
    try {
      const payload = { name: templateDraftName, subject: templateDraftSubject, body: templateDraftBody };
      const res = editingTemplateId
        ? await authFetch(`/api/invitation-templates/${editingTemplateId}`, { method: "PATCH", body: JSON.stringify(payload) })
        : await authFetch("/api/invitation-templates", { method: "POST", body: JSON.stringify(payload) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not save template (${res.status}).`);
      setTemplateMessage(editingTemplateId ? "Template updated." : "Template created.");
      resetTemplateDraft();
      await loadInvitationTemplates();
    } catch (e) {
      setTemplateMessage(e instanceof NotSignedInError ? "Sign in to manage templates." : e instanceof Error ? e.message : "Could not save template.");
    } finally {
      setTemplateBusy(false);
    }
  }

  async function handleDeleteTemplate(templateId: string) {
    setTemplateBusy(true);
    setTemplateMessage(null);
    try {
      const res = await authFetch(`/api/invitation-templates/${templateId}`, { method: "DELETE" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not delete template (${res.status}).`);
      if (editingTemplateId === templateId) resetTemplateDraft();
      if (inviteTemplateId === templateId) setInviteTemplateId("");
      setTemplateMessage("Template deleted.");
      await loadInvitationTemplates();
    } catch (e) {
      setTemplateMessage(e instanceof NotSignedInError ? "Sign in to manage templates." : e instanceof Error ? e.message : "Could not delete template.");
    } finally {
      setTemplateBusy(false);
    }
  }

  function toggleBulkWorker(workerId: string) {
    setBulkSelectedWorkerIds(prev => prev.includes(workerId) ? prev.filter(id => id !== workerId) : [...prev, workerId]);
  }

  async function handleOpenBulkInvite() {
    setBulkInviteResults(null);
    setBulkInviteMessage(null);
    setBulkTargetLoads(null);
    try {
      const res = await authFetch("/api/loads/mine");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load your loads.");
      setBulkTargetLoads((data.loads as InviteTargetLoad[]).filter(l => ["OPEN", "OFFER_RECEIVED"].includes(l.status)));
    } catch (e) {
      setBulkInviteMessage(e instanceof NotSignedInError ? "Sign in to send invitations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleSendBulkInvite(loadId: string) {
    if (bulkSelectedWorkerIds.length === 0) return;
    setBulkInviteBusy(true);
    setBulkInviteMessage(null);
    setBulkInviteResults(null);
    try {
      const res = await authFetch(`/api/loads/${loadId}/invitations/bulk`, {
        method: "POST",
        body: JSON.stringify({ workerIds: bulkSelectedWorkerIds, templateId: inviteTemplateId || undefined }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not send invitations (${res.status}).`);
      setBulkInviteResults(data.results.map((r: { workerId: string; ok: boolean; error?: string }) => ({ workerId: r.workerId, ok: r.ok, error: r.error })));
      setBulkInviteMessage(`${data.sentCount} sent, ${data.failedCount} not sent.`);
    } catch (e) {
      setBulkInviteMessage(e instanceof NotSignedInError ? "Sign in to send invitations." : e instanceof Error ? e.message : "Could not send invitations.");
    } finally {
      setBulkInviteBusy(false);
    }
  }

  async function handleOpenInvite(worker: WorkerCardData) {
    setInvitingWorker(worker);
    setInviteMessage(null);
    setInviteTargetsError(null);
    setInviteTargetJobs(null);
    setInviteTargetLoads(null);
    // Templates only apply to freight (driver) invitations — no need to
    // fetch them for a mover/job invite, and the dropdown isn't shown there.
    if (worker.workerType !== "MOVER" && !invitationTemplates) loadInvitationTemplates();
    try {
      if (worker.workerType === "MOVER") {
        const res = await authFetch("/api/jobs");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load your jobs.");
        setInviteTargetJobs((data.jobs as InviteTargetJob[]).filter(j => ["POSTED", "MATCHING", "PARTIALLY_FILLED"].includes(j.status)));
      } else {
        const res = await authFetch("/api/loads/mine");
        const data = await res.json().catch(() => ({}));
        if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load your loads.");
        setInviteTargetLoads((data.loads as InviteTargetLoad[]).filter(l => ["OPEN", "OFFER_RECEIVED"].includes(l.status)));
      }
    } catch (e) {
      setInviteTargetsError(e instanceof NotSignedInError ? "Sign in to send invitations." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleSendJobInvite(jobId: string) {
    if (!invitingWorker) return;
    setInviteBusy(true);
    setInviteMessage(null);
    try {
      const res = await authFetch(`/api/jobs/${jobId}/invite`, { method: "POST", body: JSON.stringify({ workerId: invitingWorker.id }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not send invitation (${res.status}).`);
      setInviteMessage(`Invitation sent to ${invitingWorker.displayName}.`);
      setInvitingWorker(null);
    } catch (e) {
      setInviteMessage(e instanceof NotSignedInError ? "Sign in to send invitations." : e instanceof Error ? e.message : "Could not send invitation.");
    } finally {
      setInviteBusy(false);
    }
  }

  async function handleSendLoadInvite(loadId: string) {
    if (!invitingWorker) return;
    setInviteBusy(true);
    setInviteMessage(null);
    try {
      const res = await authFetch(`/api/loads/${loadId}/invitations`, { method: "POST", body: JSON.stringify({ workerId: invitingWorker.id, templateId: inviteTemplateId || undefined }) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not send invitation (${res.status}).`);
      setInviteMessage(`Invitation sent to ${invitingWorker.displayName}.`);
      setInvitingWorker(null);
    } catch (e) {
      setInviteMessage(e instanceof NotSignedInError ? "Sign in to send invitations." : e instanceof Error ? e.message : "Could not send invitation.");
    } finally {
      setInviteBusy(false);
    }
  }

  // Freight settlement operations — GET/POST /api/settlements (list +
  // generate, both new — generation's transaction logic already existed
  // and was correct, but there was no way to see or trigger it from the
  // UI) and the existing approve/pay routes. Same missing-lookup shape
  // as every other admin panel this engagement.
  type DriverSearchResult = { id: string; displayName: string; workerType: string; operationalStatus: string; stripePayoutsEnabled: boolean; user: { email: string } };
  type SettlementRow = {
    id: string; periodStart: string; periodEnd: string; loadsSettled: number; grossCents: number;
    adjustmentsCents: number; netCents: number; status: string; approvedAt: string | null; paidAt: string | null;
    paidOutAt: string | null; failureReason: string | null; reversedAt: string | null; createdAt: string;
    worker: { id: string; displayName: string; stripePayoutsEnabled: boolean };
  };
  const [driverQuery, setDriverQuery] = useState("");
  const [driverResults, setDriverResults] = useState<DriverSearchResult[] | null>(null);
  const [driverSearchBusy, setDriverSearchBusy] = useState(false);
  const [driverSearchError, setDriverSearchError] = useState<string | null>(null);
  const [selectedDriver, setSelectedDriver] = useState<DriverSearchResult | null>(null);
  const [settlementPeriodStart, setSettlementPeriodStart] = useState("");
  const [settlementPeriodEnd, setSettlementPeriodEnd] = useState("");
  const [settlementGenerateBusy, setSettlementGenerateBusy] = useState(false);
  const [settlementMessage, setSettlementMessage] = useState<string | null>(null);
  const [settlements, setSettlements] = useState<SettlementRow[] | null>(null);
  const [settlementsError, setSettlementsError] = useState<string | null>(null);
  const [settlementStatusFilter, setSettlementStatusFilter] = useState("");
  const [settlementActionBusyId, setSettlementActionBusyId] = useState<string | null>(null);

  async function loadSettlements() {
    setSettlementsError(null);
    try {
      const params = new URLSearchParams();
      if (settlementStatusFilter) params.set("status", settlementStatusFilter);
      const res = await authFetch(`/api/settlements?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load settlements (${res.status}).`);
      const data: { settlements: SettlementRow[] } = await res.json();
      setSettlements(data.settlements);
    } catch (e) {
      setSettlementsError(e instanceof NotSignedInError ? "Sign in as an admin to view settlements." : e instanceof Error ? e.message : "Failed to load.");
    }
  }
  useEffect(() => {
    if (view !== "admin") return;
    loadSettlements();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  async function handleDriverSearch() {
    if (!driverQuery.trim()) return;
    setDriverSearchBusy(true);
    setDriverSearchError(null);
    setDriverResults(null);
    try {
      const res = await authFetch(`/api/admin/drivers?query=${encodeURIComponent(driverQuery.trim())}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Search failed (${res.status}).`);
      }
      const data: { drivers: DriverSearchResult[] } = await res.json();
      setDriverResults(data.drivers);
    } catch (e) {
      setDriverSearchError(e instanceof NotSignedInError ? "Sign in as an admin to search drivers." : e instanceof Error ? e.message : "Search failed.");
    } finally {
      setDriverSearchBusy(false);
    }
  }

  // The <input type="date"> value is naturally inclusive from an admin's
  // perspective ("through Jan 31" means all of Jan 31 counts) but the
  // backend's eligibility filter (deliveredAt: { gte: periodStart, lt:
  // periodEnd }) treats periodEnd as an exclusive boundary. Sending the
  // selected date's own midnight as periodEnd would silently exclude
  // everything delivered on that date. This converts the UI's inclusive
  // end date into the exclusive boundary the backend actually expects —
  // the backend's gte/lt rule itself stays unchanged, since adjacent
  // settlement periods correctly not overlapping is the right database
  // pattern; the fix belongs at the UI boundary, not the query.
  function toExclusiveEndDate(dateValue: string): string {
    const [year, month, day] = dateValue.split("-").map(Number);
    return new Date(Date.UTC(year, month - 1, day + 1)).toISOString();
  }

  async function handleGenerateSettlement() {
    if (!selectedDriver || !settlementPeriodStart || !settlementPeriodEnd) return;
    setSettlementGenerateBusy(true);
    setSettlementMessage(null);
    try {
      const res = await authFetch("/api/settlements", {
        method: "POST",
        body: JSON.stringify({
          workerId: selectedDriver.id,
          periodStart: new Date(`${settlementPeriodStart}T00:00:00.000Z`).toISOString(),
          periodEnd: toExclusiveEndDate(settlementPeriodEnd),
        }),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Settlement generation failed (${res.status}).`);
      setSettlementMessage(`Settlement generated — ${data.settlement.loadsSettled} loads, net ${money(data.settlement.netCents)}.`);
      setSelectedDriver(null);
      setDriverResults(null);
      setDriverQuery("");
      await loadSettlements();
    } catch (e) {
      setSettlementMessage(e instanceof NotSignedInError ? "Sign in as an admin to generate settlements." : e instanceof Error ? e.message : "Settlement generation failed.");
    } finally {
      setSettlementGenerateBusy(false);
    }
  }

  async function handleSettlementAction(settlement: SettlementRow, action: "approve" | "pay") {
    setSettlementActionBusyId(settlement.id);
    setSettlementMessage(null);
    try {
      const res = await authFetch(`/api/settlements/${settlement.id}/${action}`, { method: "POST" });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Action failed (${res.status}).`);
      if (action === "approve") {
        setSettlementMessage(`Settlement approved and scheduled for payout.`);
      } else if (data.reconciled) {
        setSettlementMessage(`Settlement reconciled — a matching Stripe transfer was found for a stuck PROCESSING settlement. Status: TRANSFERRED.`);
      } else {
        setSettlementMessage(`Transfer initiated — ${money(settlement.netCents)}. Final status will update after Stripe confirms processing.`);
      }
      await loadSettlements();
    } catch (e) {
      setSettlementMessage(e instanceof NotSignedInError ? "Sign in as an admin to manage settlements." : e instanceof Error ? e.message : "Action failed.");
    } finally {
      setSettlementActionBusyId(null);
    }
  }

  // Admin audit log viewer — GET /api/admin/audit-logs already existed
  // (built earlier in this project) and every action across this whole
  // payment audit correctly writes to it, but nothing in the frontend
  // ever called it: a real, correctly-populated audit trail with no way
  // for an admin to see it. Also fixes the endpoint's own pagination gap
  // (a flat 200-row ceiling, no way to see anything beyond it) with real
  // cursor pagination.
  type AuditLogRow = {
    id: string; action: string; entityType: string; entityId: string | null; details: unknown; createdAt: string;
    actor: { id: string; email: string; role: string } | null;
  };
  const [auditFilterAction, setAuditFilterAction] = useState("");
  const [auditFilterEntityType, setAuditFilterEntityType] = useState("");
  const [auditFilterEntityId, setAuditFilterEntityId] = useState("");
  const [auditLogs, setAuditLogs] = useState<AuditLogRow[]>([]);
  const [auditCursor, setAuditCursor] = useState<string | null>(null);
  const [auditHasMore, setAuditHasMore] = useState(false);
  const [auditLoading, setAuditLoading] = useState(false);
  const [auditError, setAuditError] = useState<string | null>(null);
  const [expandedAuditId, setExpandedAuditId] = useState<string | null>(null);

  async function loadAuditLogs(opts: { reset: boolean; entityId?: string }) {
    setAuditLoading(true);
    setAuditError(null);
    try {
      const params = new URLSearchParams();
      if (auditFilterAction.trim()) params.set("action", auditFilterAction.trim());
      if (auditFilterEntityType.trim()) params.set("entityType", auditFilterEntityType.trim());
      const entityIdFilter = opts.entityId ?? auditFilterEntityId.trim();
      if (entityIdFilter) params.set("entityId", entityIdFilter);
      if (!opts.reset && auditCursor) params.set("cursor", auditCursor);
      const res = await authFetch(`/api/admin/audit-logs?${params.toString()}`);
      if (!res.ok) throw new Error(`Failed to load audit logs (${res.status}).`);
      const data: { logs: AuditLogRow[]; nextCursor: string | null; hasMore: boolean } = await res.json();
      setAuditLogs((prev) => (opts.reset ? data.logs : [...prev, ...data.logs]));
      setAuditCursor(data.nextCursor);
      setAuditHasMore(data.hasMore);
    } catch (e) {
      setAuditError(e instanceof NotSignedInError ? "Sign in as an admin to view the audit log." : e instanceof Error ? e.message : "Failed to load.");
    } finally {
      setAuditLoading(false);
    }
  }

  useEffect(() => {
    if (view !== "admin") return;
    loadAuditLogs({ reset: true });
    // Intentionally only on view change — filter changes are applied via
    // the explicit "Apply filters" button below, not on every keystroke.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view]);

  /** Jumps the audit panel to a specific entity — used by "View audit
   *  trail" links on other admin panels (refunds, captures, payouts,
   *  invoices) so an admin doesn't have to manually copy an ID over. */
  function viewAuditTrailFor(entityId: string) {
    setAuditFilterEntityId(entityId);
    setAuditFilterAction("");
    setAuditFilterEntityType("");
    loadAuditLogs({ reset: true, entityId });
  }

  // Admin refund tool — wires up POST /api/admin/payment-transactions/[id]/refund
  // (built during P1-05) and GET /api/admin/payment-transactions (the lookup
  // endpoint this UI needed and didn't have), which previously had no UI
  // caller anywhere despite the backend logic being real and complete.
  type RefundSearchResult = {
    id: string; title: string; customerName: string | null; type: "job" | "load";
    amountReceivedCents: number; refundedAmountCents: number; refundableRemainingCents: number;
    currency: string; createdAt: string;
  };
  const [refundQuery, setRefundQuery] = useState("");
  const [refundResults, setRefundResults] = useState<RefundSearchResult[] | null>(null);
  const [refundSearchBusy, setRefundSearchBusy] = useState(false);
  const [refundSearchError, setRefundSearchError] = useState<string | null>(null);
  const [selectedTransaction, setSelectedTransaction] = useState<RefundSearchResult | null>(null);
  const [refundAmountInput, setRefundAmountInput] = useState("");
  const [refundFull, setRefundFull] = useState(true);
  const [refundReason, setRefundReason] = useState("");
  const [refundBusy, setRefundBusy] = useState(false);
  const [refundMessage, setRefundMessage] = useState<string | null>(null);

  async function handleRefundSearch() {
    if (!refundQuery.trim()) return;
    setRefundSearchBusy(true);
    setRefundSearchError(null);
    setRefundResults(null);
    try {
      const res = await authFetch(`/api/admin/payment-transactions?query=${encodeURIComponent(refundQuery.trim())}`);
      if (!res.ok) {
        const body = await res.json().catch(() => ({}));
        throw new Error(body.error ?? `Search failed (${res.status}).`);
      }
      const data: { results: RefundSearchResult[] } = await res.json();
      setRefundResults(data.results);
    } catch (e) {
      setRefundSearchError(e instanceof NotSignedInError ? "Sign in as an admin to search transactions." : e instanceof Error ? e.message : "Search failed.");
    } finally {
      setRefundSearchBusy(false);
    }
  }

  async function handleRefundSubmit() {
    if (!selectedTransaction || !refundReason.trim()) return;
    setRefundBusy(true);
    setRefundMessage(null);
    try {
      const body: { fullRefund: boolean; reason: string; amountCents?: number } = {
        fullRefund: refundFull, reason: refundReason.trim(),
      };
      if (!refundFull) {
        const cents = Math.round(Number(refundAmountInput) * 100);
        if (!Number.isFinite(cents) || cents <= 0) {
          setRefundMessage("Enter a valid refund amount.");
          setRefundBusy(false);
          return;
        }
        body.amountCents = cents;
      }
      const res = await authFetch(`/api/admin/payment-transactions/${selectedTransaction.id}/refund`, {
        method: "POST", body: JSON.stringify(body),
      });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data.error ? (typeof data.error === "string" ? data.error : JSON.stringify(data.error)) : `Refund failed (${res.status}).`);
      setRefundMessage(`Refund ${data.status === "SUCCEEDED" ? "succeeded" : "submitted"} — ${money(data.amountCents)}. Remaining refundable balance: ${money(data.refundableRemainingCents)}.`);
      setSelectedTransaction(null);
      setRefundReason("");
      setRefundAmountInput("");
      setRefundResults(null);
      setRefundQuery("");
    } catch (e) {
      setRefundMessage(e instanceof NotSignedInError ? "Sign in as an admin to issue refunds." : e instanceof Error ? e.message : "Refund failed.");
    } finally {
      setRefundBusy(false);
    }
  }

  // ===== Phase 5.5A — Portfolio media (worker + admin) =====
  type OwnerMedia = { id: string; title: string | null; description: string | null; width: number | null; height: number | null; isPrimary: boolean; displayOrder: number; status: string; rejectionReason: string | null; mimeType: string; fileSize: number; category: { id: string; name: string; slug: string } | null };
  const [ownerMedia, setOwnerMedia] = useState<OwnerMedia[] | null>(null);
  const [portfolioError, setPortfolioError] = useState<string | null>(null);
  const [portfolioMessage, setPortfolioMessage] = useState<string | null>(null);
  const [portfolioUploadBusy, setPortfolioUploadBusy] = useState(false);
  const [portfolioUploadProgress, setPortfolioUploadProgress] = useState<string | null>(null);

  const PORTFOLIO_STATUS_BADGE: Record<string, { label: string; bg: string; color: string }> = {
    DRAFT: { label: "Draft", bg: "#eef1f5", color: "#637089" },
    UPLOADING: { label: "Uploading", bg: "#fbf3e0", color: "#8a6d1a" },
    PENDING: { label: "Pending review", bg: "#fbf3e0", color: "#8a6d1a" },
    APPROVED: { label: "Approved", bg: "#e6f4ea", color: "#1a7f37" },
    REJECTED: { label: "Rejected", bg: "#fde8e8", color: "#b3261e" },
    REMOVED: { label: "Removed", bg: "#fde8e8", color: "#b3261e" },
  };

  async function loadOwnerPortfolio() {
    setPortfolioError(null);
    try {
      const res = await authFetch("/api/me/portfolio");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load portfolio.");
      setOwnerMedia(data.media);
    } catch (e) {
      setPortfolioError(e instanceof NotSignedInError ? "Sign in as a worker to manage your portfolio." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  // Full upload flow: presign -> PUT to storage -> finalize. Reuses the
  // existing presign->upload->finalize lifecycle; the browser measures
  // dimensions client-side and passes them to finalize (stored, not
  // security-gated in 5.5A).
  async function handlePortfolioUpload(file: File) {
    setPortfolioUploadBusy(true);
    setPortfolioMessage(null);
    setPortfolioError(null);
    try {
      setPortfolioUploadProgress("Requesting upload…");
      const presignRes = await authFetch("/api/me/portfolio", { method: "POST", body: JSON.stringify({ mimeType: file.type, contentLength: file.size, title: file.name.replace(/\.[^.]+$/, "").slice(0, 120) }) });
      const presign = await presignRes.json().catch(() => ({}));
      if (!presignRes.ok) throw new Error(typeof presign.error === "string" ? presign.error : "Could not start upload.");

      setPortfolioUploadProgress("Uploading image…");
      const put = await fetch(presign.uploadUrl, { method: "PUT", headers: { "Content-Type": file.type }, body: file });
      if (!put.ok) throw new Error("Upload to storage failed.");

      // Measure dimensions client-side (best-effort).
      let width: number | undefined, height: number | undefined;
      try {
        const dims = await new Promise<{ w: number; h: number }>((resolve, reject) => {
          const img = new Image();
          img.onload = () => resolve({ w: img.naturalWidth, h: img.naturalHeight });
          img.onerror = () => reject(new Error("decode"));
          img.src = URL.createObjectURL(file);
        });
        width = dims.w; height = dims.h;
      } catch { /* dimensions optional */ }

      setPortfolioUploadProgress("Submitting for review…");
      const finalizeRes = await authFetch(`/api/me/portfolio/${presign.mediaId}/finalize`, { method: "POST", body: JSON.stringify({ width, height }) });
      const finalize = await finalizeRes.json().catch(() => ({}));
      if (!finalizeRes.ok) throw new Error(typeof finalize.error === "string" ? finalize.error : "Could not submit for review.");

      setPortfolioMessage("Uploaded — your image is now pending review.");
      await loadOwnerPortfolio();
    } catch (e) {
      setPortfolioError(e instanceof NotSignedInError ? "Sign in to upload." : e instanceof Error ? e.message : "Upload failed.");
    } finally {
      setPortfolioUploadBusy(false);
      setPortfolioUploadProgress(null);
    }
  }

  async function handlePortfolioEdit(mediaId: string, patch: Record<string, unknown>) {
    setPortfolioMessage(null);
    try {
      const res = await authFetch(`/api/me/portfolio/${mediaId}`, { method: "PATCH", body: JSON.stringify(patch) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Could not update.");
      await loadOwnerPortfolio();
    } catch (e) {
      setPortfolioError(e instanceof Error ? e.message : "Could not update.");
    }
  }

  async function handlePortfolioDelete(mediaId: string) {
    setPortfolioMessage(null);
    try {
      const res = await authFetch(`/api/me/portfolio/${mediaId}`, { method: "DELETE" });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(typeof d.error === "string" ? d.error : "Could not delete."); }
      await loadOwnerPortfolio();
    } catch (e) {
      setPortfolioError(e instanceof Error ? e.message : "Could not delete.");
    }
  }

  function renderPortfolioManager() {
    return (
      <section className="panel">
        <div className="panelHead"><div><p className="eyebrow">PORTFOLIO MEDIA — PHASE 5.5A</p><h3>My work portfolio</h3></div>
          <button className="btn btnSecondary" onClick={loadOwnerPortfolio}>Refresh</button>
        </div>
        <p className="footerNote" style={{marginTop:0}}>Upload photos of completed work. Every image is reviewed before it appears on your public profile. JPEG, PNG, or WEBP up to 10&nbsp;MB.</p>
        <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap",marginBottom:12}}>
          <label className="btn btnPrimary" style={{cursor: portfolioUploadBusy ? "default" : "pointer", opacity: portfolioUploadBusy ? 0.6 : 1}}>
            {portfolioUploadBusy ? "Uploading…" : "Upload an image"}
            <input type="file" accept="image/jpeg,image/png,image/webp" style={{display:"none"}} disabled={portfolioUploadBusy}
              onChange={e => { const f = e.target.files?.[0]; if (f) handlePortfolioUpload(f); e.currentTarget.value = ""; }} />
          </label>
          {portfolioUploadProgress && <span className="footerNote" style={{margin:0}}>{portfolioUploadProgress}</span>}
        </div>
        {portfolioError && <p className="footerNote" style={{color:"#b3261e"}}>{portfolioError}</p>}
        {portfolioMessage && <p className="footerNote">{portfolioMessage}</p>}
        {ownerMedia === null && !portfolioError && <button className="btn btnSecondary" onClick={loadOwnerPortfolio}>Load my portfolio</button>}
        {ownerMedia && ownerMedia.length === 0 && <p className="footerNote">No portfolio items yet.</p>}
        {ownerMedia && ownerMedia.length > 0 && (
          <table className="table"><thead><tr><th>Title</th><th>Status</th><th>Primary</th><th>Order</th><th></th></tr></thead>
            <tbody>
              {ownerMedia.map(m => {
                const badge = PORTFOLIO_STATUS_BADGE[m.status] ?? { label: m.status, bg: "#eef1f5", color: "#637089" };
                return (
                  <tr key={m.id}>
                    <td>
                      <input defaultValue={m.title ?? ""} placeholder="Untitled" style={{width:"100%",maxWidth:220}} onBlur={e => { if (e.target.value !== (m.title ?? "")) handlePortfolioEdit(m.id, { title: e.target.value || null }); }} />
                      {m.status === "REJECTED" && m.rejectionReason && <small style={{display:"block",color:"#b3261e",marginTop:4}}>Reason: {m.rejectionReason}</small>}
                    </td>
                    <td><span className="tag" style={{background:badge.bg,color:badge.color}}>{badge.label}</span></td>
                    <td>
                      {m.status === "APPROVED"
                        ? <input type="radio" name="primaryMedia" checked={m.isPrimary} onChange={() => handlePortfolioEdit(m.id, { isPrimary: true })} title="Set as primary" />
                        : <span className="footerNote" style={{margin:0}}>—</span>}
                    </td>
                    <td><input type="number" min={0} defaultValue={m.displayOrder} style={{width:56}} onBlur={e => { const v = Number(e.target.value); if (v !== m.displayOrder) handlePortfolioEdit(m.id, { displayOrder: v }); }} /></td>
                    <td><button className="btn btnSecondary" onClick={() => handlePortfolioDelete(m.id)}>Delete</button></td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  // ===== Admin moderation + reports UI =====
  type AdminMedia = { id: string; title: string | null; description: string | null; status: string; mimeType: string; fileSize: number; width: number | null; height: number | null; submittedAt: string | null; createdAt: string; rejectionReason: string | null; moderationNote: string | null; previewUrl: string | null; worker: { id: string; displayName: string; workerType: string }; category: { id: string; name: string } | null; _count: { reports: number } };
  type AdminReport = { id: string; reason: string; details: string | null; status: string; createdAt: string; reviewedAt: string | null; resolutionNote: string | null; reporterUserId: string; media: { id: string; title: string | null; status: string; worker: { id: string; displayName: string } } };
  const [modQueue, setModQueue] = useState<AdminMedia[] | null>(null);
  const [modFilter, setModFilter] = useState<"PENDING" | "APPROVED" | "REJECTED" | "REMOVED" | "REPORTED">("PENDING");
  const [modError, setModError] = useState<string | null>(null);
  const [modBusyId, setModBusyId] = useState<string | null>(null);
  const [reportQueue, setReportQueue] = useState<AdminReport[] | null>(null);

  async function loadModQueue() {
    setModError(null);
    try {
      const params = new URLSearchParams();
      if (modFilter === "REPORTED") params.set("reported", "true");
      else params.set("status", modFilter);
      const res = await authFetch(`/api/admin/portfolio?${params.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load moderation queue.");
      setModQueue(data.media);
    } catch (e) {
      setModError(e instanceof NotSignedInError ? "Sign in as an admin." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleModAction(mediaId: string, action: "approve" | "reject" | "remove" | "restore") {
    setModBusyId(mediaId);
    setModError(null);
    try {
      let body: Record<string, unknown> = {};
      if (action === "reject") {
        const reason = window.prompt("Rejection reason (shown to the worker):");
        if (!reason) { setModBusyId(null); return; }
        body = { reason };
      }
      const res = await authFetch(`/api/admin/portfolio/${mediaId}/${action}`, { method: "POST", body: JSON.stringify(body) });
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : `Could not ${action}.`);
      await loadModQueue();
    } catch (e) {
      setModError(e instanceof Error ? e.message : `Could not ${action}.`);
    } finally {
      setModBusyId(null);
    }
  }

  async function loadReportQueue() {
    setModError(null);
    try {
      const res = await authFetch("/api/admin/portfolio/reports?status=OPEN");
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(typeof data.error === "string" ? data.error : "Failed to load reports.");
      setReportQueue(data.reports);
    } catch (e) {
      setModError(e instanceof NotSignedInError ? "Sign in as an admin." : e instanceof Error ? e.message : "Failed to load.");
    }
  }

  async function handleReportResolution(reportId: string, outcome: "resolve" | "dismiss") {
    try {
      const note = window.prompt(`${outcome === "resolve" ? "Resolution" : "Dismissal"} note (optional):`) ?? undefined;
      const res = await authFetch(`/api/admin/portfolio/reports/${reportId}/${outcome}`, { method: "POST", body: JSON.stringify(note ? { resolutionNote: note } : {}) });
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw new Error(typeof d.error === "string" ? d.error : "Could not update report."); }
      await loadReportQueue();
    } catch (e) {
      setModError(e instanceof Error ? e.message : "Could not update report.");
    }
  }

  function renderPortfolioModerationPanel() {
    return (
      <section className="panel">
        <div className="panelHead"><div><p className="eyebrow">PORTFOLIO MODERATION — PHASE 5.5A</p><h3>Media review queue</h3></div></div>
        <div style={{display:"flex",gap:6,flexWrap:"wrap",marginBottom:10}}>
          {(["PENDING","APPROVED","REJECTED","REMOVED","REPORTED"] as const).map(s => (
            <button key={s} className={modFilter === s ? "btn btnPrimary" : "btn btnSecondary"} style={{padding:"4px 10px",fontSize:12.5}} onClick={() => { setModFilter(s); }}>{s.charAt(0) + s.slice(1).toLowerCase()}</button>
          ))}
          <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12.5}} onClick={loadModQueue}>Load queue</button>
        </div>
        {modError && <p className="footerNote" style={{color:"#b3261e"}}>{modError}</p>}
        {modQueue === null && !modError && <p className="footerNote">Choose a filter and load the queue.</p>}
        {modQueue && modQueue.length === 0 && <p className="footerNote">Nothing in this queue.</p>}
        {modQueue && modQueue.length > 0 && (
          <table className="table"><thead><tr><th>Preview</th><th>Worker</th><th>Title</th><th>Submitted</th><th>Reports</th><th>Actions</th></tr></thead>
            <tbody>
              {modQueue.map(m => (
                <tr key={m.id}>
                  <td>{m.previewUrl
                    // eslint-disable-next-line @next/next/no-img-element
                    ? <img src={m.previewUrl} alt={m.title ?? "portfolio image"} width={64} height={64} style={{objectFit:"cover",borderRadius:6}} />
                    : <span className="footerNote" style={{margin:0}}>No preview</span>}</td>
                  <td>{m.worker.displayName}<small style={{display:"block",color:"#637089"}}>{m.worker.workerType}</small></td>
                  <td>{m.title ?? <em style={{color:"#637089"}}>Untitled</em>}{m.rejectionReason && <small style={{display:"block",color:"#b3261e"}}>Reason: {m.rejectionReason}</small>}</td>
                  <td>{m.submittedAt ? new Date(m.submittedAt).toLocaleDateString() : "—"}</td>
                  <td>{m._count.reports > 0 ? <span className="tag" style={{background:"#fde8e8",color:"#b3261e"}}>{m._count.reports}</span> : "—"}</td>
                  <td>
                    {m.status === "PENDING" && <>
                      <button className="btn btnPrimary" style={{marginRight:4,padding:"3px 8px",fontSize:12}} disabled={modBusyId === m.id} onClick={() => handleModAction(m.id, "approve")}>Approve</button>
                      <button className="btn btnSecondary" style={{padding:"3px 8px",fontSize:12}} disabled={modBusyId === m.id} onClick={() => handleModAction(m.id, "reject")}>Reject</button>
                    </>}
                    {m.status === "APPROVED" && <button className="btn btnSecondary" style={{padding:"3px 8px",fontSize:12}} disabled={modBusyId === m.id} onClick={() => handleModAction(m.id, "remove")}>Remove</button>}
                    {m.status === "REMOVED" && <button className="btn btnSecondary" style={{padding:"3px 8px",fontSize:12}} disabled={modBusyId === m.id} onClick={() => handleModAction(m.id, "restore")}>Restore</button>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
        <div style={{marginTop:16}}>
          <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
            <h4 style={{margin:"0 0 6px",fontSize:13,color:"#637089"}}>OPEN REPORTS</h4>
            <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12.5}} onClick={loadReportQueue}>Load reports</button>
          </div>
          {reportQueue && reportQueue.length === 0 && <p className="footerNote">No open reports.</p>}
          {reportQueue && reportQueue.length > 0 && (
            <table className="table"><thead><tr><th>Media</th><th>Worker</th><th>Reason</th><th>Details</th><th></th></tr></thead>
              <tbody>
                {reportQueue.map(r => (
                  <tr key={r.id}>
                    <td>{r.media.title ?? "Untitled"}<small style={{display:"block",color:"#637089"}}>{r.media.status}</small></td>
                    <td>{r.media.worker.displayName}</td>
                    <td>{r.reason}</td>
                    <td style={{maxWidth:220}}>{r.details ?? "—"}</td>
                    <td>
                      <button className="btn btnPrimary" style={{marginRight:4,padding:"3px 8px",fontSize:12}} onClick={() => handleReportResolution(r.id, "resolve")}>Resolve</button>
                      <button className="btn btnSecondary" style={{padding:"3px 8px",fontSize:12}} onClick={() => handleReportResolution(r.id, "dismiss")}>Dismiss</button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      </section>
    );
  }

  function renderPayoutHistoryPanel() {
    const rows = payoutHistory ? [...payoutHistory.payouts, ...payoutHistory.settlements].sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime()) : [];
    return (
      <section className="panel">
        <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>Payout history</h3></div></div>
        {payoutHistoryError && <p className="footerNote">{payoutHistoryError}</p>}
        {!payoutHistory && !payoutHistoryError && <p className="footerNote">Loading…</p>}
        {payoutHistory && rows.length === 0 && <p className="footerNote">No payouts yet.</p>}
        {payoutHistory && rows.length > 0 && (
          <table className="table"><thead><tr><th>Type</th><th>Gross</th><th>Adjustments</th><th>Net</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.id}>
                  <td>{r.type === "settlement" ? "Freight settlement" : "Job payout"}</td>
                  <td>{money(r.grossEarningsCents)}</td>
                  <td>{r.adjustmentsCents !== 0 ? money(r.adjustmentsCents) : "—"}</td>
                  <td>{money(r.netPayoutCents)}</td>
                  <td>
                    {r.status}
                    {r.status === "TRANSFERRED" && <small style={{display:"block",color:"#637089"}}>Sent to Stripe payout balance — bank arrival depends on Stripe's schedule</small>}
                    {r.status === "PAID_OUT" && <small style={{display:"block",color:"#637089"}}>Deposited to your bank</small>}
                    {r.status === "FAILED" && r.failureReason && <small style={{display:"block",color:"#b3261e"}}>{r.failureReason}</small>}
                  </td>
                  <td>{new Date(r.paidOutAt ?? r.paidAt ?? r.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  function renderTipHistoryPanel() {
    return (
      <section className="panel">
        <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>Tip history</h3></div></div>
        {tipAllocationsError && <p className="footerNote">{tipAllocationsError}</p>}
        {!tipAllocations && !tipAllocationsError && <p className="footerNote">Loading…</p>}
        {tipAllocations && tipAllocations.length === 0 && <p className="footerNote">No tips yet.</p>}
        {tipAllocations && tipAllocations.length > 0 && (
          <table className="table"><thead><tr><th>For</th><th>Amount</th><th>Status</th><th>Date</th></tr></thead>
            <tbody>
              {tipAllocations.map(t => (
                <tr key={t.id}>
                  <td>{t.entityTitle}</td>
                  <td>{money(t.amountCents)}</td>
                  <td>
                    {t.status}
                    {t.status === "TRANSFERRED" && <small style={{display:"block",color:"#637089"}}>Sent to Stripe payout balance</small>}
                    {t.status === "PAID_OUT" && <small style={{display:"block",color:"#637089"}}>Deposited to your bank</small>}
                    {t.status === "FAILED" && t.failureReason && <small style={{display:"block",color:"#b3261e"}}>{t.failureReason}</small>}
                  </td>
                  <td>{new Date(t.paidOutAt ?? t.paidAt ?? t.createdAt).toLocaleDateString()}</td>
                </tr>
              ))}
            </tbody>
          </table>
        )}
      </section>
    );
  }

  const quote = useMemo(
    () => calculateJobQuote({
      moverHourlyRateCents: TIER_PREVIEW_RATE_CENTS[serviceTier],
      movers: moversNeeded,
      estimatedHours: hours,
      urgent,
      urgentFeeMode,
      urgentPremiumPercent: 20,
      includeBookingProtection: true,
    }),
    [serviceTier, moversNeeded, hours, urgent, urgentFeeMode],
  );

  const driverQuote = useMemo(
    () => driverMode === "BOX_TRUCK"
      ? calculateBoxTruckLoadQuote({ driverPayoutCents: boxTruckPayout * 100, accessorialsCents: boxTruckAccessorials * 100 })
      : calculateSemiLoadQuote(semiGross * 100),
    [driverMode, boxTruckPayout, boxTruckAccessorials, semiGross],
  );

  const money = (cents: number) =>
    new Intl.NumberFormat("en-US", { style: "currency", currency: "USD" }).format(cents / 100);

  const title: Record<View, string> = {
    marketplace: "Book qualified movers and drivers",
    customer: "Customer dashboard",
    partner: "Business partner portal",
    mover: "Mover dashboard",
    driver: "Commercial driver portal",
    launch: "Indianapolis launch center",
    admin: "Admin operations",
  };

  return (
    <div className="shell">
      <aside className="sidebar">
        <div className="brand">
          <div className="brandMark">TM</div>
          <div className="brandText"><strong>TempMovers</strong><small>Hourly labor marketplace</small></div>
        </div>
        <div className="nav">
          {[
            ["marketplace","Find workers","⌂"],
            ...(initialRole === "CUSTOMER" || initialRole === "ADMIN" || !initialRole ? [["customer","Customer","▣"], ["partner","Partners","▦"]] as const : []),
            ...(initialRole === "MOVER" || initialRole === "ADMIN" || !initialRole ? [["mover","Mover","◉"]] as const : []),
            ...(initialRole === "DRIVER" || initialRole === "ADMIN" || !initialRole ? [["driver","Driver","▤"]] as const : []),
            ["launch","Launch","◎"],
            ...(initialRole === "ADMIN" ? [["admin","Admin","◆"]] as const : []),
          ].map(([key,label,icon]) => (
            <button key={key} className={view === key ? "active" : ""} onClick={() => setView(key as View)}>
              {icon} <span>{label}</span>
            </button>
          ))}
        </div>
        <div className="sidebarCard">
          <strong>Platform rules</strong>
          <p>$5 scheduled or $7 urgent per mover-hour, $9.95 booking protection, three-hour minimum, two-mover minimum, and mover membership waived until the first completed job.</p>
        </div>
      </aside>

      <main className="main">
        <header className="topbar">
          <div><p className="eyebrow">TEMPMOVERS.COM</p><h1>{title[view]}</h1></div>
          <div className="actions"><button className="btn btnSecondary" onClick={() => setView("driver")}>Driver portal</button><button className="btn btnPrimary" onClick={() => setView("customer")}>Post a job</button></div>
        </header>

        {view === "marketplace" && (
          <>
            <section className="hero">
              <div><span className="pill">Nationwide geo-targeted workforce</span><h2>Qualified moving labor and commercial drivers, exactly where you need them.</h2><p>Homeowners and businesses can book pre-registered movers by the hour, while logistics customers can connect with verified box-truck and semi drivers.</p></div>
              <div className="heroStat"><span>Marketplace requirements</span><strong>2 movers × 3 hours</strong><small>Minimum moving-job booking</small></div>
            </section>
            <section className="search">
              <div className="field"><label>Service location</label><input defaultValue="Indianapolis, IN 46204" /></div>
              <div className="field"><label>Workers needed</label><input type="number" min={2} value={moversNeeded} onChange={e => setMoversNeeded(Number(e.target.value))} /></div>
              <div className="field"><label>Estimated hours</label><input type="number" min={3} value={hours} onChange={e => setHours(Number(e.target.value))} /></div>
              <div className="field"><label>Service tier</label><select value={serviceTier} onChange={e => setServiceTier(e.target.value as typeof serviceTier)}><option value="STANDARD">Standard moving labor</option><option value="LEAD">Lead mover</option><option value="SPECIALTY">Specialty handling</option></select></div>
              <button className="btn btnPrimary" onClick={() => setView("customer")}>Build job</button>
            </section>
            <div className="dashboardGrid">
              <section>
                <div className="panelHead"><div><p className="eyebrow">QUALIFIED NEARBY MOVERS</p><h3>Top matches</h3></div><span className="status good">Background checked</span></div>
                <div className="list">{movers.map(m => <article className="workerCard" key={m.name}><div className="avatar">{m.initials}</div><div><strong>{m.name} ✓</strong><p>★ {m.rating} · {m.jobs} completed jobs</p><div className="tags">{m.tags.map(t => <span className="tag" key={t}>{t}</span>)}</div></div><div className="price"><small>Available for your dates</small><button className="btn btnPrimary" onClick={() => setView("customer")}>Select</button></div></article>)}</div>
              </section>
              <aside className="panel">
                <p className="eyebrow">LIVE ESTIMATE</p><h3>Pricing breakdown</h3>
                <div className="quote">
                  <div className="quoteRow"><span>{quote.movers} movers × {quote.billableHours} hours</span><strong>{money(quote.laborCents)}</strong></div>
                  <div className="quoteRow"><span>TempMovers fee ({money(quote.platformFeePerManHourCents)}/man-hour)</span><strong>{money(quote.platformFeeCents)}</strong></div>
                  {quote.urgentPremiumCents > 0 && <div className="quoteRow"><span>Urgent-booking premium</span><strong>{money(quote.urgentPremiumCents)}</strong></div>}
                  <div className="quoteRow"><span>Booking protection</span><strong>{money(quote.bookingProtectionFeeCents)}</strong></div>
                  <div className="quoteRow total"><span>Estimated total</span><strong>{money(quote.totalCents)}</strong></div>
                </div>
                <label style={{display:"flex",gap:8,alignItems:"center",marginTop:14,fontSize:13}}><input type="checkbox" checked={urgent} onChange={e => setUrgent(e.target.checked)} /> Urgent / same-day request</label>
                {urgent && <div className="field" style={{marginTop:12}}><label>Urgent pricing method</label><select value={urgentFeeMode} onChange={e => setUrgentFeeMode(e.target.value as "HOURLY_FEE" | "PERCENT_PREMIUM")}><option value="HOURLY_FEE">$7 per man-hour</option><option value="PERCENT_PREMIUM">20% urgent premium</option></select></div>}
                <p className="footerNote" style={{marginTop:14}}>Scheduled jobs use $5 per approved man-hour. Same-day jobs default to $7 per approved man-hour. A $9.95 booking-protection fee supports payment handling, customer service, fraud prevention, and replacement assistance. Tips pass 100% to movers.</p>
              </aside>
            </div>
          </>
        )}

        {view === "customer" && (
          <>
            {/* Junk removal — VASRUE Digital Media, 28 Oct 2026: junk has its own booking flow at /book/junk. */}
            <div className="banner"><strong>Junk removal:</strong> furniture, appliances and full cleanouts at one all-in price, disposal included. <a href="/book/junk">Book junk removal</a></div>
            <div className="banner"><strong>Booking guardrail:</strong> moving projects require at least two movers and a three-hour minimum. Scheduled work uses a $5 per man-hour platform fee; urgent work defaults to $7 per man-hour. Each booking also includes $9.95 booking protection.</div>
            <div className="grid4">
              <article className="metric"><span>Upcoming jobs</span><strong>2</strong><small>Next: Tuesday at 10:00 AM</small></article>
              <article className="metric"><span>Minimum crew</span><strong>2</strong><small>Applied to every moving project</small></article>
              <article className="metric"><span>Minimum booking</span><strong>3 hrs</strong><small>Per mover</small></article>
              <article className="metric"><span>Payment method</span><strong>Stripe</strong><small>Authorization before confirmation</small></article>
            </div>
            <div className="dashboardGrid">
              <section className="panel" ref={jobPostingPanelRef}>
                <div className="panelHead"><div><p className="eyebrow">POST A JOB</p><h3>Project requirements</h3></div><span className="status info">Draft</span></div>
                <div className="grid4" style={{gridTemplateColumns:"1fr 1fr"}}>
                  <div className="field"><label>Customer type</label><select><option>Homeowner / renter</option><option>Business</option><option>Property manager</option><option>Moving company overflow</option></select></div>
                  <div className="field"><label>Project type</label><select value={jobType} onChange={e => setJobType(e.target.value as typeof jobType)}><option value="RESIDENTIAL_MOVE">Residential move</option><option value="COMMERCIAL_MOVE">Commercial move</option><option value="LOADING">Loading</option><option value="UNLOADING">Unloading</option><option value="LABOR_ONLY">Labor only</option><option value="FURNITURE_DELIVERY">Furniture delivery</option><option value="STORAGE_MOVE">Storage move</option></select></div>
                  <div className="field"><label>Movers required</label><input type="number" min={2} value={moversNeeded} onChange={e => setMoversNeeded(Math.max(2, Number(e.target.value)))} /></div>
                  <div className="field"><label>Estimated hours</label><input type="number" min={3} value={hours} onChange={e => setHours(Math.max(3, Number(e.target.value)))} /></div>
                  <div className="field"><label>Date &amp; time</label><input type="datetime-local" value={jobStartsAt} onChange={e => setJobStartsAt(e.target.value)} /></div>
                  <div className="field"><label>Street address</label><input value={addressLine1} onChange={e => setAddressLine1(e.target.value)} placeholder="123 Main St" /></div>
                  <div className="field"><label>City</label><input value={addressCity} onChange={e => setAddressCity(e.target.value)} placeholder="Indianapolis" /></div>
                  <div className="field"><label>State</label><input value={addressState} onChange={e => setAddressState(e.target.value.toUpperCase())} maxLength={2} placeholder="IN" /></div>
                  <div className="field"><label>ZIP</label><input value={addressZip} onChange={e => setAddressZip(e.target.value)} placeholder="46204" /></div>
                  <div className="field" style={{gridColumn:"1/-1"}}><label>Project details</label><textarea value={jobDescription} onChange={e => setJobDescription(e.target.value)} placeholder="Stairs, oversized items, elevators, parking, tools, loading dock, and special instructions." /></div>
                </div>
                <button className="btn btnPrimary" onClick={handlePostJob} disabled={postJobBusy || !addressLine1 || !addressCity || !addressState || !addressZip || !jobStartsAt}>{postJobBusy ? "Posting…" : "Post job"}</button>
                {postJobMessage && <p className="footerNote" style={{marginTop:8}}>{postJobMessage}</p>}
                {postedJobId && (
                  <>
                    <p style={{color:"#637089",fontSize:12,marginTop:6}}>Job <code>{postedJobId}</code> was created for real.</p>
                    <StripePaymentForm entityType="job" entityId={postedJobId} amountCents={postedJobAmountCents} />
                  </>
                )}
              </section>
              <aside className="panel"><p className="eyebrow">STRIPE PAYMENT FLOW</p><h3>Protected checkout</h3><ol className="footerNote"><li>Authorize the estimated job total.</li><li>Workers check in with GPS plus customer PIN.</li><li>Final approved hours are captured.</li><li>Stripe Connect transfers worker earnings.</li><li>TempMovers retains $5 per scheduled man-hour or $7 per urgent man-hour.</li><li>The $9.95 booking-protection fee is retained by TempMovers.</li></ol></aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel" ref={freightPostingPanelRef}>
                <div className="panelHead"><div><p className="eyebrow">POST A FREIGHT LOAD</p><h3>Box truck, semi, or driver-only</h3></div><span className="status info">Draft</span></div>
                <div className="grid4" style={{gridTemplateColumns:"1fr 1fr"}}>
                  <div className="field" style={{gridColumn:"1/-1"}}><label>Service type</label>
                    <select value={freightServiceType} onChange={e => setFreightServiceType(e.target.value as FreightServiceType)}>
                      <option value="OWNER_OPERATOR_BOX_TRUCK">Owner-operator box truck (flat rate)</option>
                      <option value="OWNER_OPERATOR_SEMI">Owner-operator semi (flat rate)</option>
                      <option value="CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY">Driver only, your truck (hourly)</option>
                    </select>
                  </div>
                  <div className="field" style={{gridColumn:"1/-1"}}><label>Load title</label><input value={freightTitle} onChange={e => setFreightTitle(e.target.value)} placeholder="e.g. Pallet delivery, Indy to Columbus" /></div>
                  <div className="field"><label>Origin city</label><input value={originCity} onChange={e => setOriginCity(e.target.value)} placeholder="Indianapolis" /></div>
                  <div className="field"><label>Origin state</label><input value={originState} onChange={e => setOriginState(e.target.value.toUpperCase())} maxLength={2} placeholder="IN" /></div>
                  <div className="field"><label>Origin ZIP (optional)</label><input value={originZip} onChange={e => setOriginZip(e.target.value)} placeholder="46204" /></div>
                  <div className="field"><label>Destination city</label><input value={destinationCity} onChange={e => setDestinationCity(e.target.value)} placeholder="Columbus" /></div>
                  <div className="field"><label>Destination state</label><input value={destinationState} onChange={e => setDestinationState(e.target.value.toUpperCase())} maxLength={2} placeholder="OH" /></div>
                  <div className="field"><label>Pickup date &amp; time</label><input type="datetime-local" value={pickupDate} onChange={e => setPickupDate(e.target.value)} /></div>
                  <div className="field"><label>Estimated hours or miles</label><input value={estimatedHoursOrMiles} onChange={e => setEstimatedHoursOrMiles(e.target.value)} placeholder="e.g. 4 hours or 210 miles" /></div>
                  <div className="field"><label>Stops</label><input type="number" min={0} value={stopCount} onChange={e => setStopCount(Math.max(0, Number(e.target.value)))} /></div>

                  {freightServiceType === "OWNER_OPERATOR_BOX_TRUCK" && (
                    <div className="field"><label>Driver payout ($, flat)</label><input type="number" min="0.01" step="0.01" value={driverPayoutCents} onChange={e => setDriverPayoutCents(e.target.value)} /></div>
                  )}
                  {freightServiceType === "OWNER_OPERATOR_SEMI" && (
                    <div className="field"><label>Route gross ($, flat)</label><input type="number" min="0.01" step="0.01" value={routeGrossCents} onChange={e => setRouteGrossCents(e.target.value)} /></div>
                  )}
                  {freightServiceType === "CUSTOMER_SUPPLIED_TRUCK_DRIVER_ONLY" && (
                    <>
                      <div className="field"><label>Driver hourly rate ($)</label><input type="number" min="0.01" step="0.01" value={driverHourlyRateCents} onChange={e => setDriverHourlyRateCents(e.target.value)} /></div>
                      <div className="field"><label>Estimated hours</label><input type="number" min="0.5" step="0.5" value={freightEstimatedHours} onChange={e => setFreightEstimatedHours(e.target.value)} /></div>
                    </>
                  )}

                  <div className="field" style={{display:"flex",alignItems:"center",gap:8}}><label style={{margin:0}}><input type="checkbox" checked={liftgateRequired} onChange={e => setLiftgateRequired(e.target.checked)} /> Liftgate required</label></div>
                  <div className="field" style={{display:"flex",alignItems:"center",gap:8}}><label style={{margin:0}}><input type="checkbox" checked={cdlRequired} onChange={e => setCdlRequired(e.target.checked)} /> CDL required</label></div>
                  <div className="field" style={{display:"flex",alignItems:"center",gap:8}}><label style={{margin:0}}><input type="checkbox" checked={isLocalRoute} onChange={e => setIsLocalRoute(e.target.checked)} /> Local route</label></div>

                  <div className="field" style={{gridColumn:"1/-1"}}><label>Exact pickup address (private — never shown pre-assignment)</label><input value={exactPickupAddress} onChange={e => setExactPickupAddress(e.target.value)} placeholder="123 Warehouse Dr, Indianapolis, IN 46204" /></div>
                  <div className="field" style={{gridColumn:"1/-1"}}><label>Exact delivery address (private — never shown pre-assignment)</label><input value={exactDeliveryAddress} onChange={e => setExactDeliveryAddress(e.target.value)} placeholder="456 Dock St, Columbus, OH 43004" /></div>
                  <div className="field"><label>Shipper contact name (private)</label><input value={shipperContactName} onChange={e => setShipperContactName(e.target.value)} /></div>
                  <div className="field"><label>Shipper contact phone (private)</label><input value={shipperContactPhone} onChange={e => setShipperContactPhone(e.target.value)} /></div>
                  <div className="field" style={{gridColumn:"1/-1"}}><label>Commodity description (private)</label><textarea value={commodityDescription} onChange={e => setCommodityDescription(e.target.value)} placeholder="Not shown to drivers before they're assigned to this load." /></div>
                </div>
                <button className="btn btnPrimary" onClick={handlePostFreightLoad} disabled={freightBusy || !freightTitle || !originCity || !originState || !destinationCity || !destinationState || !pickupDate || !estimatedHoursOrMiles}>{freightBusy ? "Posting…" : "Post freight load"}</button>
                {freightMessage && <p className="footerNote" style={{marginTop:8}}>{freightMessage}</p>}
                {postedLoadId && (
                  <>
                    <p style={{color:"#637089",fontSize:12,marginTop:6}}>Load <code>{postedLoadId}</code> was created for real — it will appear on the sanitized driver load board immediately.</p>
                    <StripePaymentForm entityType="load" entityId={postedLoadId} amountCents={postedLoadAmountCents} />
                  </>
                )}
              </section>
              <aside className="panel"><p className="eyebrow">DRIVER VIEW</p><h3>What drivers see before assignment</h3><p className="footerNote">City/state (not exact address), equipment type, pickup date, estimated hours/miles, stop count, liftgate/CDL flags, and the payout amount. Exact addresses, shipper contact info, commodity description, and access codes stay hidden until a driver is actually assigned to this specific load.</p></aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>My jobs &amp; loads</h3></div></div>
                {myJobsLoadsError && <p className="footerNote">{myJobsLoadsError}</p>}
                {!myJobs && !myJobsLoadsError && <p className="footerNote">Loading…</p>}
                {myJobs && myLoads && myJobs.length === 0 && myLoads.length === 0 && <p className="footerNote">Nothing posted yet.</p>}
                {myJobs && myLoads && (myJobs.length > 0 || myLoads.length > 0) && (
                  <table className="table"><thead><tr><th>Title</th><th>Status</th><th>Amount</th><th></th></tr></thead>
                    <tbody>
                      {[...myJobs.map(j => ({ ...j, kind: "job" as const, amountCents: j.estimatedTotalCents })), ...myLoads.map(l => ({ ...l, kind: "load" as const, amountCents: l.grossCarrierCents + l.platformFeeCents }))].map(item => {
                        const eligible = item.kind === "job"
                          ? item.status === "COMPLETED" && item.paymentStatus === "CAPTURED"
                          : ["DELIVERED", "POD_UPLOADED", "SETTLED"].includes(item.status) && item.paymentStatus === "CAPTURED";
                        const isTipping = tippingEntity?.type === item.kind && tippingEntity?.id === item.id;
                        const isApproving = item.kind === "job" && expandedApprovalJobId === item.id;
                        const isTracking = trackingEntity?.type === item.kind && trackingEntity?.id === item.id;
                        return (
                          <Fragment key={`${item.kind}-${item.id}`}>
                            <tr>
                              <td>{item.title} <small style={{color:"#637089"}}>({item.kind})</small></td>
                              <td>{item.status}</td>
                              <td>{money(item.amountCents)}</td>
                              <td>
                                {item.kind === "job" && item.status !== "COMPLETED" && item.status !== "CANCELED" && <button className="btn btnPrimary" style={{marginRight:6}} onClick={() => toggleApprovalExpansion(item.id)}>{isApproving ? "Hide" : "Approve hours"}</button>}
                                <button className="btn btnSecondary" style={{marginRight:6}} onClick={() => handleToggleTrackInvitations(item.kind, item.id)}>{isTracking ? "Hide invitations" : "Track invitations"}</button>
                                {eligible && <button className="btn btnSecondary" onClick={() => setTippingEntity(isTipping ? null : { type: item.kind, id: item.id })}>{isTipping ? "Hide" : "Leave a tip"}</button>}
                              </td>
                            </tr>
                            {isTracking && (
                              <tr><td colSpan={4}>
                                <div className="panel" style={{background:"#f7f9fc"}}>
                                  {sentInvitationsError && <p className="footerNote">{sentInvitationsError}</p>}
                                  {!sentInvitations && !sentInvitationsError && <p className="footerNote">Loading…</p>}
                                  {sentInvitations && sentInvitations.length === 0 && <p className="footerNote">No invitations sent for this {item.kind} yet.</p>}
                                  {sentInvitations && sentInvitations.length > 0 && (
                                    <table className="table"><thead><tr><th>Worker</th><th>Status</th><th>Sent</th><th>Expires</th><th>Responded</th></tr></thead>
                                      <tbody>
                                        {sentInvitations.map(inv => (
                                          <tr key={inv.id}>
                                            <td>{inv.worker.displayName}</td>
                                            <td>{inv.status}</td>
                                            <td>{new Date(inv.createdAt).toLocaleDateString()}</td>
                                            <td>{inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : "—"}</td>
                                            <td>{inv.respondedAt ? new Date(inv.respondedAt).toLocaleString() : "—"}</td>
                                          </tr>
                                        ))}
                                      </tbody>
                                    </table>
                                  )}
                                </div>
                              </td></tr>
                            )}
                            {isApproving && (
                              <tr><td colSpan={4}>
                                <div className="panel" style={{background:"#f7f9fc"}}>
                                  {assignmentsError && <p className="footerNote">{assignmentsError}</p>}
                                  {!jobAssignments && !assignmentsError && <p className="footerNote">Loading…</p>}
                                  {jobAssignments && jobAssignments.length === 0 && <p className="footerNote">No workers have checked out yet — nothing to approve.</p>}
                                  {jobAssignments && jobAssignments.map(a => (
                                    <div key={a.id} style={{borderBottom:"1px solid #e3e8f0",padding:"10px 0"}}>
                                      <p style={{margin:0}}><strong>{a.worker.displayName}</strong> — scheduled {a.scheduledHours}h, actual {a.actualHours ?? "—"}h</p>
                                      {a.status === "APPROVED" && <p className="footerNote" style={{margin:"4px 0 0",color:"#1a7f37"}}>Approved</p>}
                                      {a.status === "CHECKED_OUT" && (
                                        <>
                                          <div style={{display:"flex",gap:8,marginTop:8}}>
                                            <button className="btn btnPrimary" disabled={assignmentActionBusyId === a.id} onClick={() => handleApproveAssignment(a.id)}>{assignmentActionBusyId === a.id ? "Approving…" : "Approve"}</button>
                                            <button className="btn btnSecondary" disabled={assignmentActionBusyId === a.id} onClick={() => setDisputingAssignmentId(disputingAssignmentId === a.id ? null : a.id)}>Dispute</button>
                                          </div>
                                          {disputingAssignmentId === a.id && (
                                            <div style={{marginTop:8}}>
                                              <textarea value={disputeReason} onChange={e => setDisputeReason(e.target.value)} placeholder="What's wrong with these hours?" />
                                              <button className="btn btnPrimary" style={{marginTop:6}} disabled={!disputeReason.trim() || assignmentActionBusyId === a.id} onClick={() => handleDisputeAssignment(a.id)}>{assignmentActionBusyId === a.id ? "Submitting…" : "Submit dispute"}</button>
                                            </div>
                                          )}
                                        </>
                                      )}
                                    </div>
                                  ))}
                                  {assignmentActionMessage && <p className="footerNote" style={{marginTop:10}}>{assignmentActionMessage}</p>}
                                </div>
                              </td></tr>
                            )}
                            {isTipping && (
                              <tr><td colSpan={4}><TipForm entityType={item.kind} entityId={item.id} onSuccess={loadMyJobsAndLoads} /></td></tr>
                            )}
                          </Fragment>
                        );
                      })}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
          </>
        )}

        {view === "mover" && (
          <>
            <div className="grid4">
              <article className="metric"><span>Membership</span><strong>Waived</strong><small>$19.95 begins after first completed job</small></article>
              <article className="metric"><span>This week</span><strong>$576</strong><small>18 approved hours (illustrative)</small></article>
              <article className="metric"><span>Available jobs</span><strong>14</strong><small>Within 30-mile territory (illustrative)</small></article>
              <article className="metric"><span>Next payout</span><strong>{payoutHistory && payoutHistory.payouts[0] ? money(payoutHistory.payouts[0].netPayoutCents) : "$448"}</strong><small>{payoutHistory && payoutHistory.payouts[0] ? payoutHistory.payouts[0].status : "Scheduled Friday (illustrative)"}</small></article>
            </div>
            <div className="dashboardGrid">
              <section className="panel"><div className="panelHead"><div><p className="eyebrow">GEO-TARGETED JOB FEED</p><h3>Available moving projects</h3></div><span className="status good">Accepting jobs</span></div>
                {[["Load a 2-bedroom apartment","Downtown Indianapolis · 6.2 miles · 3 hours","$96 mover earnings"],["Unload storage container","Carmel · 11.4 miles · 4 hours","$128 mover earnings"],["Office furniture relocation","Fishers · 13.1 miles · 5 hours","$160 mover earnings"]].map(j => <div className="jobRow" key={j[0]}><div className="avatar">J</div><div><strong>{j[0]}</strong><p>{j[1]} (illustrative)</p></div><div className="price"><strong>{j[2]}</strong><button className="btn btnPrimary" disabled title="Illustrative job feed — not connected to real listings yet.">Accept</button></div></div>)}
              </section>
              <aside className="panel"><p className="eyebrow">MOVER ACCOUNT</p><h3>Subscription and territory</h3><div className="banner"><strong>Founding benefit:</strong> no mover subscription charge until the first paid job is completed. After that, membership is $19.95/month.</div><div className="field"><label>Home ZIP</label><input defaultValue="46220" /></div><div className="field"><label>Travel radius</label><select><option>15 miles</option><option>30 miles</option><option>50 miles</option><option>Entire state</option></select></div><div className="field"><label>Pay</label><p style={{margin:"6px 0 0",fontSize:14,lineHeight:1.6}}>Your current TempMovers pay tier: <strong>Standard Mover</strong><br />Platform-assigned payout: <strong>$32.00/hour</strong></p><button className="btn btnSecondary" style={{marginTop:8,padding:"6px 12px",fontSize:12.5}} type="button">Request a tier review</button></div><button className="btn btnSecondary" style={{width:"100%"}} disabled={subscriptionBusy} onClick={() => handleManageSubscription("MOVER")}>{subscriptionBusy ? "Redirecting to Stripe…" : "Manage $19.95 subscription"}</button>{subscriptionMessage && <p className="footerNote" style={{marginTop:10}}>{subscriptionMessage}</p>}</aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderPayoutHistoryPanel()}
            </div>
            <div style={{marginTop:20}}>
              <JunkJobBoard />
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">CHOOSE YOUR HELPER — PHASE 3</p><h3>Job invitations</h3></div></div>
                {jobInvitationsError && <p className="footerNote">{jobInvitationsError}</p>}
                {!jobInvitations && !jobInvitationsError && <p className="footerNote">Loading...</p>}
                {jobInvitations && jobInvitations.length === 0 && <p className="footerNote">No pending invitations.</p>}
                {jobInvitations && jobInvitations.length > 0 && (
                  <table className="table"><thead><tr><th>Job</th><th>Market</th><th>Starts</th><th>Rate</th><th>Expires</th><th></th></tr></thead>
                    <tbody>
                      {jobInvitations.map(inv => (
                        <tr key={inv.id}>
                          <td>{inv.job.title}</td>
                          <td>{inv.job.market ? `${inv.job.market.name}, ${inv.job.market.state}` : "-"}</td>
                          <td>{new Date(inv.job.startsAt).toLocaleString()}</td>
                          <td>{money(inv.agreedEarningsCents)}/hr</td>
                          <td>{inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : "-"}</td>
                          <td>
                            <button className="btn btnPrimary" style={{marginRight:6}} disabled={invitationActionBusyId === inv.id} onClick={() => handleJobInvitationAction(inv.id, "accept")}>Accept</button>
                            <button className="btn btnSecondary" disabled={invitationActionBusyId === inv.id} onClick={() => handleJobInvitationAction(inv.id, "decline")}>Decline</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {invitationActionMessage && <p className="footerNote" style={{marginTop:10}}>{invitationActionMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderPortfolioManager()}
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderTipHistoryPanel()}
            </div>
          </>
        )}

        {view === "driver" && (
          <>
            <div className="tabs"><button className="active">Driver dashboard</button><button disabled title="Not yet built">Vehicles</button><button disabled title="Not yet built">Routes</button><button disabled title="Not yet built">Documents</button><button disabled title="Settlement generation/approval isn't triggerable from the UI yet — but your settlement payout history is now visible below.">Settlements</button><button disabled title="Not yet built">Membership</button></div>
            <div className="banner"><strong>Driver pricing:</strong> Driver Basic is $29.95/month, Owner-Operator Pro is $59.95/month, and Fleet is $149/month for up to five vehicles. Box-truck and semi owner-operators receive a guaranteed flat payout per load. TempMovers adds its configured marketplace fee to the customer or shipper total. Approved detention and accessorial charges are calculated separately.</div>
            <div className="grid4">
              <article className="metric"><span>Driver status</span><strong>Verified</strong><small>CDL and identity approved</small></article>
              <article className="metric"><span>Active vehicle</span><strong>26-ft box</strong><small>Liftgate · 10,000-lb payload</small></article>
              <article className="metric"><span>Open routes</span><strong>7</strong><small>Within preferred territory</small></article>
              <article className="metric"><span>Weekly gross</span><strong>$2,220</strong><small>Before operating expenses</small></article>
            </div>
            <div style={{marginTop:20}}>
              <JunkJobBoard />
            </div>
            <div className="dashboardGrid">
              <LoadBoard authToken={getAuthToken() ?? undefined} />
              <aside className="panel"><p className="eyebrow">DRIVER PRICING CALCULATOR</p><h3>Customer-side fee</h3>
                <div className="tabs"><button className={driverMode === "BOX_TRUCK" ? "active" : ""} onClick={() => setDriverMode("BOX_TRUCK")}>Box truck</button><button className={driverMode === "SEMI" ? "active" : ""} onClick={() => setDriverMode("SEMI")}>Semi</button></div>
                {driverMode === "BOX_TRUCK" ? <><div className="field"><label>Guaranteed owner-operator payout</label><input type="number" value={boxTruckPayout} onChange={e => setBoxTruckPayout(Number(e.target.value))} /></div><div className="field"><label>Accessorial charges</label><input type="number" value={boxTruckAccessorials} onChange={e => setBoxTruckAccessorials(Number(e.target.value))} /></div></> : <div className="field"><label>Carrier gross for load</label><input type="number" value={semiGross} onChange={e => setSemiGross(Number(e.target.value))} /></div>}
                <div className="quote"><div className="quoteRow"><span>Driver/carrier keeps</span><strong>{money("driverPayoutCents" in driverQuote ? driverQuote.driverPayoutCents : driverQuote.routeGrossCents)}</strong></div><div className="quoteRow"><span>TempMovers fee</span><strong>{money(driverQuote.platformFeeCents)}</strong></div><div className="quoteRow total"><span>Customer total</span><strong>{money(driverQuote.totalCents)}</strong></div></div>
                <p className="footerNote" style={{marginTop:12}}>The advertised driver or carrier amount is not reduced. The service fee is added to the customer or shipper total.</p>
              </aside>
              <aside className="panel"><p className="eyebrow">DRIVER ACCOUNT</p><h3>Membership</h3>
                <div className="field"><label>Plan</label>
                  <select value={driverPlan} onChange={e => setDriverPlan(e.target.value as typeof driverPlan)}>
                    <option value="DRIVER_BASIC">Driver Basic — $29.95/mo (box truck)</option>
                    <option value="OWNER_OPERATOR_PRO">Owner-Operator Pro — $59.95/mo (semi-eligible)</option>
                    <option value="FLEET">Fleet — $149/mo (up to 5 vehicles)</option>
                  </select>
                </div>
                <p className="footerNote">New drivers receive a waiver through their first completed load, same as movers.</p>
                <button className="btn btnSecondary" style={{width:"100%"}} disabled={subscriptionBusy} onClick={() => handleManageSubscription(driverPlan)}>{subscriptionBusy ? "Redirecting to Stripe…" : "Manage subscription"}</button>
                {subscriptionMessage && <p className="footerNote" style={{marginTop:10}}>{subscriptionMessage}</p>}
              </aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>My assigned loads</h3></div></div>
                {assignedLoadsError && <p className="footerNote">{assignedLoadsError}</p>}
                {!assignedLoads && !assignedLoadsError && <p className="footerNote">Loading…</p>}
                {assignedLoads && assignedLoads.length === 0 && <p className="footerNote">No loads currently assigned to you.</p>}
                {assignedLoads && assignedLoads.length > 0 && (
                  <table className="table"><thead><tr><th>Load</th><th>Route</th><th>Pickup</th><th>Payout</th><th></th></tr></thead>
                    <tbody>
                      {assignedLoads.map(l => (
                        <Fragment key={l.id}>
                          <tr>
                            <td>{l.title} <small style={{color:"#637089"}}>({l.status})</small></td>
                            <td>{l.originCity}, {l.originState} → {l.destinationCity}, {l.destinationState}</td>
                            <td>{new Date(l.pickupDate).toLocaleString()}</td>
                            <td>{money(l.grossCarrierCents)}</td>
                            <td><button className="btn btnSecondary" onClick={() => setExpandedLoadId(expandedLoadId === l.id ? null : l.id)}>{expandedLoadId === l.id ? "Hide details" : "Full details"}</button></td>
                          </tr>
                          {expandedLoadId === l.id && (
                            <tr><td colSpan={5}>
                              <div style={{background:"#f7f9fc",padding:12,borderRadius:6,fontSize:13,lineHeight:1.7}}>
                                <p><strong>Pickup address:</strong> {l.exactPickupAddress ?? "—"}</p>
                                <p><strong>Delivery address:</strong> {l.exactDeliveryAddress ?? "—"}</p>
                                <p><strong>Shipper contact:</strong> {l.shipperContactName ?? "—"} {l.shipperContactPhone ? `· ${l.shipperContactPhone}` : ""}</p>
                                {l.accessCode && <p><strong>Access code:</strong> {l.accessCode}</p>}
                                {l.commodityDescription && <p><strong>Commodity:</strong> {l.commodityDescription}</p>}
                                <p><strong>Equipment:</strong> {l.equipmentType} · <strong>Est.:</strong> {l.estimatedHoursOrMiles} · <strong>Stops:</strong> {l.stopCount}{l.liftgateRequired ? " · Liftgate" : ""}{l.cdlRequired ? " · CDL" : ""}{l.isLocalRoute ? " · Local route" : ""}</p>
                              </div>
                            </td></tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderPayoutHistoryPanel()}
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">CHOOSE YOUR HELPER — PHASE 3</p><h3>Load invitations</h3></div></div>
                {loadInvitationsError && <p className="footerNote">{loadInvitationsError}</p>}
                {!loadInvitations && !loadInvitationsError && <p className="footerNote">Loading...</p>}
                {loadInvitations && loadInvitations.length === 0 && <p className="footerNote">No pending invitations.</p>}
                {loadInvitations && loadInvitations.length > 0 && (
                  <table className="table"><thead><tr><th>Load</th><th>Route</th><th>Pickup</th><th>Payout</th><th>Expires</th><th></th></tr></thead>
                    <tbody>
                      {loadInvitations.map(inv => (
                        <tr key={inv.id}>
                          <td>{inv.carrierRoute.title}</td>
                          <td>{inv.carrierRoute.originCity}, {inv.carrierRoute.originState} to {inv.carrierRoute.destinationCity}, {inv.carrierRoute.destinationState}</td>
                          <td>{new Date(inv.carrierRoute.pickupDate).toLocaleString()}</td>
                          <td>{money(inv.carrierRoute.grossCarrierCents)}</td>
                          <td>{inv.expiresAt ? new Date(inv.expiresAt).toLocaleString() : "-"}</td>
                          <td>
                            <button className="btn btnPrimary" style={{marginRight:6}} disabled={invitationActionBusyId === inv.id} onClick={() => handleLoadInvitationAction(inv.id, "accept")}>Accept</button>
                            <button className="btn btnSecondary" disabled={invitationActionBusyId === inv.id} onClick={() => handleLoadInvitationAction(inv.id, "decline")}>Decline</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {invitationActionMessage && <p className="footerNote" style={{marginTop:10}}>{invitationActionMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderTipHistoryPanel()}
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderPortfolioManager()}
            </div>
          </>
        )}


        {view === "partner" && (
          <>
            <div className="grid4">
              <article className="metric"><span>Partner type</span><strong>Property manager</strong><small>Free business account</small></article>
              <article className="metric"><span>Active properties</span><strong>18</strong><small>Multiple-location management</small></article>
              <article className="metric"><span>Preferred movers</span><strong>12</strong><small>Private approved roster</small></article>
              <article className="metric"><span>Monthly spend</span><strong>$6,840</strong><small>Consolidated invoicing</small></article>
            </div>
            <div className="dashboardGrid">
              <section className="panel"><div className="panelHead"><div><p className="eyebrow">PARTNER OPERATIONS</p><h3>Recurring and overflow requests</h3></div><button className="btn btnPrimary" disabled title="Not yet built">Post partner job</button></div>
                {["Emergency unit cleanout — 2 movers","Moving-company overflow — 6 movers","Furniture delivery assistance — 2 movers"].map((j,i)=><div className="jobRow" key={j}><div className="avatar">P</div><div><strong>{j}</strong><p>{i===0?"Carmel property · same-day":"Private customer details · preferred network first"}</p></div><span className="status good">{i===1?"Partially filled":"Confirmed"}</span></div>)}
              </section>
              <aside className="panel"><p className="eyebrow">PARTNER FEATURES</p><h3>Included tools</h3><div className="tags"><span className="tag">Monthly invoices</span><span className="tag">Before/after photos</span><span className="tag">Authorization limits</span><span className="tag">Preferred crews</span><span className="tag">Referral QR code</span><span className="tag">Confidential jobs</span></div><p className="footerNote" style={{marginTop:16}}>Referral commissions are earned only after a referred customer completes and pays for a qualifying job.</p></aside>
            </div>
          </>
        )}

        {view === "launch" && (
          <>
            <div className="banner"><strong>Indianapolis controlled launch:</strong> expansion remains locked until fill rate, acceptance time, no-show rate, and repeat-customer targets are achieved.</div>
            <div className="grid4">
              <article className="metric"><span>Signed pilot partners</span><strong>5 / 5</strong><small>Initial goal achieved</small></article>
              <article className="metric"><span>Forecasted jobs</span><strong>24</strong><small>Target: 20–30</small></article>
              <article className="metric"><span>Active movers</span><strong>30</strong><small>Indianapolis territory</small></article>
              <article className="metric"><span>Fill rate</span><strong>91.4%</strong><small>Target: at least 90%</small></article>
            </div>
            <div className="dashboardGrid">
              <section className="panel"><div className="panelHead"><div><p className="eyebrow">90-DAY PIPELINE</p><h3>Demand-account targets</h3></div><span className="status info">Controlled launch</span></div><table className="table"><thead><tr><th>Segment</th><th>Target</th><th>Contacted</th><th>Pilots</th></tr></thead><tbody><tr><td>Property managers</td><td>25</td><td>19</td><td>2</td></tr><tr><td>Apartment communities</td><td>20</td><td>14</td><td>1</td></tr><tr><td>Moving companies</td><td>15</td><td>11</td><td>1</td></tr><tr><td>Retailers</td><td>20</td><td>9</td><td>1</td></tr><tr><td>Local shippers</td><td>20</td><td>8</td><td>0</td></tr></tbody></table></section>
              <aside className="panel"><p className="eyebrow">ONE-TIME INCENTIVES</p><h3>Controlled bonus budget</h3><div className="split"><div><span>Customer first booking credit</span><strong>$25</strong></div><div><span>Mover first job bonus</span><strong>$25</strong></div><div><span>3 five-star jobs bonus</span><strong>$25</strong></div><div><span>Mover referral bonus</span><strong>$50</strong></div><div><span>Driver referral bonus</span><strong>$75</strong></div><div><span>Partner referral credit</span><strong>$25</strong></div></div><p className="footerNote">The customer credit and the mover bonus are separate programs, even though both key off a first completed job. Bonuses are one-time, admin-approved, tied to paid jobs, non-stackable unless authorized, and must remain below the platform revenue generated by the qualifying activity.</p></aside>
            </div>
          </>
        )}

        {view === "admin" && (
          <>
            <div className="grid4">
              <article className="metric"><span>Gross booking volume</span><strong>{DEMO_MODE ? "$218,640" : "—"}</strong><small>{DEMO_MODE ? "Current month (demo data)" : "No live data available yet"}</small></article>
              <article className="metric"><span>Man-hour platform fees</span><strong>{DEMO_MODE ? "$34,860" : "—"}</strong><small>{DEMO_MODE ? "$5 scheduled / $7 urgent (demo data)" : "No live data available yet"}</small></article>
              <article className="metric"><span>Active subscriptions</span><strong>{adminStats ? adminStats.totals.active : adminStatsError ? "—" : "…"}</strong><small>{adminStats ? `Est. ${money(adminStats.totals.estimatedMonthlyRevenueCents)}/mo` : adminStatsError ?? "Loading live data…"}</small></article>
              <article className="metric"><span>Waived (first-job)</span><strong>{adminStats ? adminStats.totals.waived : adminStatsError ? "—" : "…"}</strong><small>{adminStats ? `${adminStats.totals.pastDue} past due` : "Loading live data…"}</small></article>
            </div>
            <div className="dashboardGrid">
              <section className="panel"><div className="panelHead"><div><p className="eyebrow">MARKET OPERATIONS</p><h3>Territory performance</h3></div><span className="status good">91.4% fill rate</span></div>
                <table className="table"><thead><tr><th>Market</th><th>Status</th><th>Movers</th><th>Drivers</th><th>Open jobs</th><th>Revenue</th></tr></thead><tbody><tr><td>Indianapolis</td><td>Active launch market</td><td colSpan={4} style={{color:"#637089",fontStyle:"italic"}}>{DEMO_MODE ? "186 movers · 42 drivers · 24 open jobs · $18,420 (demo data)" : "No live market-stats endpoint wired yet"}</td></tr>{DEMO_MODE ? <><tr><td>Chicago</td><td>Future market (demo data)</td><td>312</td><td>87</td><td>51</td><td>$31,805</td></tr><tr><td>Columbus</td><td>Future market (demo data)</td><td>144</td><td>33</td><td>19</td><td>$14,290</td></tr><tr><td>Nashville</td><td>Future market (demo data)</td><td>98</td><td>28</td><td>17</td><td>$11,610</td></tr></> : <tr><td colSpan={6} style={{color:"#637089",fontStyle:"italic"}}>No live data available yet for additional markets.</td></tr>}</tbody></table>
              </section>
              <aside className="panel"><p className="eyebrow">PRICING CONTROLS</p><h3>Marketplace rules</h3><div className="split"><div><span>Scheduled man-hour</span><strong>$5</strong></div><div><span>Urgent man-hour</span><strong>$7</strong></div><div><span>Booking protection</span><strong>$9.95</strong></div><div><span>Mover membership</span><strong>$19.95</strong></div><div><span>First-job waiver</span><strong>Enabled</strong></div><div><span>Driver Basic</span><strong>$29.95</strong></div><div><span>Owner-Operator Pro</span><strong>$59.95</strong></div><div><span>Fleet / 5 vehicles</span><strong>$149</strong></div><div><span>Extra fleet vehicle</span><strong>$15</strong></div><div><span>Box-truck fee</span><strong>$5/hr</strong></div><div><span>Semi fee</span><strong>5% / $150 cap</strong></div></div><button className="btn btnSecondary" style={{width:"100%"}} disabled title="Not yet built — pricing values shown here are read from constants, not an editable admin control">Manage market rules</button></aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel"><div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>Worker subscriptions</h3></div>{adminStats && <span className="status good">{adminStats.totals.total} workers</span>}</div>
                {adminStatsError && <p className="footerNote">{adminStatsError}</p>}
                {!adminStats && !adminStatsError && <p className="footerNote">Loading…</p>}
                {adminStats && adminStats.workers.length === 0 && <p className="footerNote">No worker profiles yet.</p>}
                {adminStats && adminStats.workers.length > 0 && (
                  <table className="table"><thead><tr><th>Worker</th><th>Role</th><th>Plan</th><th>Status</th><th>Renews</th></tr></thead>
                    <tbody>
                      {adminStats.workers.map(w => (
                        <tr key={w.id}>
                          <td>{w.name}</td><td>{w.role}</td><td>{w.plan ?? "—"}</td>
                          <td>{w.waived ? "Waived" : w.status}</td>
                          <td>{w.renewsAt ? new Date(w.renewsAt).toLocaleDateString() : "—"}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
              </section>
              <aside className="panel"><p className="eyebrow">BY PLAN</p><h3>Active subscription mix</h3>
                {adminStats ? (
                  <div className="split">
                    {Object.entries(adminStats.byPlan).length === 0 && <p className="footerNote">No active subscriptions yet.</p>}
                    {Object.entries(adminStats.byPlan).map(([plan, count]) => (
                      <div key={plan}><span>{plan.replaceAll("_", " ")}</span><strong>{count}</strong></div>
                    ))}
                  </div>
                ) : <p className="footerNote">{adminStatsError ?? "Loading…"}</p>}
              </aside>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE ACTION</p><h3>Capture-ready payments</h3></div></div>
                {captureError && <p className="footerNote">{captureError}</p>}
                {!captureItems && !captureError && <p className="footerNote">Loading…</p>}
                {captureItems && captureItems.jobs.length === 0 && captureItems.loads.length === 0 && <p className="footerNote">Nothing is currently authorized and waiting on capture.</p>}
                {captureItems && (captureItems.jobs.length > 0 || captureItems.loads.length > 0) && (
                  <table className="table"><thead><tr><th>Title</th><th>Customer</th><th>Amount</th><th></th></tr></thead>
                    <tbody>
                      {[...captureItems.jobs, ...captureItems.loads].map(item => (
                        <tr key={item.id}>
                          <td>{item.title} <small style={{color:"#637089"}}>({item.type})</small></td>
                          <td>{item.customerName ?? "—"}</td>
                          <td>
                            {item.ready ? money(item.amountCents) : (
                              <>
                                <span style={{color:"#637089"}}>Authorized estimate: {money(item.estimatedTotalCents)}</span>
                                <small style={{display:"block",color:"#b3261e"}}>{item.reason}</small>
                              </>
                            )}
                          </td>
                          <td><button className="btn btnPrimary" disabled={!item.ready || captureBusyId === item.id} title={item.ready ? undefined : "Final hours must be customer-approved before this can be captured."} onClick={() => handleCapture(item)}>{captureBusyId === item.id ? "Capturing…" : "Capture"}</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {captureMessage && <p className="footerNote" style={{marginTop:10}}>{captureMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE ACTION</p><h3>Pending worker payouts</h3></div></div>
                {payoutsReadyError && <p className="footerNote">{payoutsReadyError}</p>}
                {!payoutsReady && !payoutsReadyError && <p className="footerNote">Loading…</p>}
                {payoutsReady && payoutsReady.payouts.length === 0 && payoutsReady.settlements.length === 0 && <p className="footerNote">Nothing is currently scheduled or awaiting payout retry.</p>}
                {payoutsReady && (payoutsReady.payouts.length > 0 || payoutsReady.settlements.length > 0) && (
                  <table className="table"><thead><tr><th>Worker</th><th>Type</th><th>Amount</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {[...payoutsReady.payouts, ...payoutsReady.settlements].map(item => (
                        <tr key={item.id}>
                          <td>{item.workerName}</td>
                          <td>{item.type === "settlement" ? `Freight settlement (${item.loadsSettled ?? 0} loads)` : "Job payout"}</td>
                          <td>{money(item.amountCents)}</td>
                          <td>
                            {item.status}
                            {item.status === "FAILED" && item.failureReason && <small style={{display:"block",color:"#b3261e"}}>{item.failureReason}</small>}
                            {!item.connectReady && <small style={{display:"block",color:"#b3261e"}}>Worker hasn't completed Stripe Connect onboarding</small>}
                          </td>
                          <td>
                            <button className="btn btnPrimary" disabled={!item.connectReady || payoutTriggerBusyId === item.id} title={item.connectReady ? undefined : "Worker hasn't completed Stripe Connect onboarding."} onClick={() => handleTriggerPayout(item)}>{payoutTriggerBusyId === item.id ? "Paying…" : item.status === "FAILED" ? "Retry" : "Pay"}</button>
                            <button className="btn btnSecondary" style={{marginLeft:6}} onClick={() => viewAuditTrailFor(item.id)}>Audit trail</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {payoutTriggerMessage && <p className="footerNote" style={{marginTop:10}}>{payoutTriggerMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>Tip reporting</h3></div></div>
                {adminTipsError && <p className="footerNote">{adminTipsError}</p>}
                {!adminTips && !adminTipsError && <p className="footerNote">Loading…</p>}
                {adminTips && adminTips.length === 0 && <p className="footerNote">No tips yet.</p>}
                {adminTips && adminTips.length > 0 && (
                  <table className="table"><thead><tr><th>For</th><th>Customer</th><th>Tip total</th><th>Status</th><th>Worker</th><th>Share</th><th></th></tr></thead>
                    <tbody>
                      {adminTips.map(tip => (
                        <Fragment key={tip.id}>
                          {tip.allocations.length === 0 ? (
                            <tr>
                              <td>{tip.entityTitle} <small style={{color:"#637089"}}>({tip.entityType})</small></td>
                              <td>{tip.customerName}</td>
                              <td>{money(tip.amountCents)}</td>
                              <td>
                                {tip.status}
                                {(tip.status === "FAILED" || tip.status === "PAID_UNALLOCATED") && tip.failureReason && <small style={{display:"block",color:"#b3261e"}}>{tip.failureReason}</small>}
                              </td>
                              <td colSpan={2} style={{color:"#637089"}}>No allocations yet</td>
                              <td>{tip.status === "PAID_UNALLOCATED" && <button className="btn btnPrimary" disabled={tipAllocationBusyId === tip.id} onClick={() => handleRetryTipAllocation(tip.id)}>{tipAllocationBusyId === tip.id ? "Retrying…" : "Retry allocation"}</button>}</td>
                            </tr>
                          ) : tip.allocations.map((a, i) => (
                            <tr key={a.id}>
                              {i === 0 && <td rowSpan={tip.allocations.length}>{tip.entityTitle} <small style={{color:"#637089"}}>({tip.entityType})</small></td>}
                              {i === 0 && <td rowSpan={tip.allocations.length}>{tip.customerName}</td>}
                              {i === 0 && <td rowSpan={tip.allocations.length}>{money(tip.amountCents)}</td>}
                              {i === 0 && <td rowSpan={tip.allocations.length}>{tip.status}</td>}
                              <td>{a.worker.displayName}</td>
                              <td>
                                {money(a.amountCents)} — {a.status}
                                {a.status === "TRANSFERRED" && <small style={{display:"block",color:"#637089"}}>Sent to Stripe balance</small>}
                                {a.status === "PAID_OUT" && <small style={{display:"block",color:"#637089"}}>Deposited to bank</small>}
                                {a.status === "FAILED" && a.failureReason && <small style={{display:"block",color:"#b3261e"}}>{a.failureReason}</small>}
                              </td>
                              <td>
                                {(a.status === "PENDING" || a.status === "FAILED") && (
                                  <button className="btn btnPrimary" disabled={!a.worker.stripePayoutsEnabled || tipAllocationBusyId === a.id} title={a.worker.stripePayoutsEnabled ? undefined : "Worker hasn't completed Stripe Connect onboarding."} onClick={() => handlePayTipAllocation(a)}>{tipAllocationBusyId === a.id ? "Paying…" : a.status === "FAILED" ? "Retry" : "Pay"}</button>
                                )}
                              </td>
                            </tr>
                          ))}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
                {tipAllocationMessage && <p className="footerNote" style={{marginTop:10}}>{tipAllocationMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE ACTION</p><h3>Partner billing &amp; invoicing</h3></div></div>
                <div className="field" style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <label>Search by partner name or referral code</label>
                    <input value={partnerQuery} onChange={e => setPartnerQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handlePartnerSearch(); }} placeholder="e.g. Acme Property Management" />
                  </div>
                  <button className="btn btnPrimary" onClick={handlePartnerSearch} disabled={partnerSearchBusy || !partnerQuery.trim()}>{partnerSearchBusy ? "Searching…" : "Search"}</button>
                </div>
                {partnerSearchError && <p className="footerNote">{partnerSearchError}</p>}
                {partnerResults && partnerResults.length === 0 && <p className="footerNote">No matching partners found.</p>}
                {partnerResults && partnerResults.length > 0 && (
                  <table className="table"><thead><tr><th>Partner</th><th>Type</th><th>Monthly invoicing</th><th>Invoices</th><th></th></tr></thead>
                    <tbody>
                      {partnerResults.map(p => (
                        <tr key={p.id}>
                          <td>{p.displayName}{!p.active && <small style={{display:"block",color:"#b3261e"}}>Inactive</small>}</td>
                          <td>{p.type}</td>
                          <td>{p.monthlyInvoicing ? "Yes" : "No"}</td>
                          <td>{p._count.invoices}</td>
                          <td><button className="btn btnSecondary" onClick={() => handleSelectPartner(p)}>View</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}

                {selectedPartner && (
                  <div className="panel" style={{marginTop:14,background:"#f7f9fc"}}>
                    <p><strong>{selectedPartner.displayName}</strong> {!selectedPartner.monthlyInvoicing && <small style={{color:"#b3261e"}}>— not on monthly invoicing; generation will be rejected</small>}</p>

                    <h4 style={{marginTop:14,marginBottom:6,fontSize:13,color:"#637089"}}>BILLING REPORT PREVIEW (current month)</h4>
                    {billingReportError && <p className="footerNote">{billingReportError}</p>}
                    {!billingReport && !billingReportError && <p className="footerNote">Loading…</p>}
                    {billingReport && (
                      <p className="footerNote">
                        {new Date(billingReport.period.from).toLocaleDateString()} – {new Date(billingReport.period.to).toLocaleDateString()}:{" "}
                        {billingReport.lineItems.length} loads, subtotal {money(billingReport.subtotalCents)}, platform fee {money(billingReport.platformFeeCents)}, total <strong>{money(billingReport.totalCents)}</strong>
                      </p>
                    )}

                    <h4 style={{marginTop:14,marginBottom:6,fontSize:13,color:"#637089"}}>INVOICE HISTORY</h4>
                    {partnerInvoicesError && <p className="footerNote">{partnerInvoicesError}</p>}
                    {partnerInvoices && partnerInvoices.length === 0 && <p className="footerNote">No invoices generated yet.</p>}
                    {partnerInvoices && partnerInvoices.length > 0 && (
                      <table className="table"><thead><tr><th>Period</th><th>Status</th><th>Total</th><th>Loads</th><th>Stripe invoice</th><th>Due</th></tr></thead>
                        <tbody>
                          {partnerInvoices.map(inv => (
                            <tr key={inv.id}>
                              <td>{new Date(inv.periodStart).toLocaleDateString()} – {new Date(inv.periodEnd).toLocaleDateString()}</td>
                              <td>{inv.status}</td>
                              <td>{money(inv.totalCents)}</td>
                              <td>{inv.lineCount}</td>
                              <td>{inv.stripeInvoiceId ?? "—"}</td>
                              <td>{inv.dueDate ? new Date(inv.dueDate).toLocaleDateString() : "—"}</td>
                            </tr>
                          ))}
                        </tbody>
                      </table>
                    )}

                    <h4 style={{marginTop:14,marginBottom:6,fontSize:13,color:"#637089"}}>GENERATE NEW INVOICE</h4>
                    <div className="formRow">
                      <div className="field"><label>Period start</label><input type="date" value={invoicePeriodStart} onChange={e => setInvoicePeriodStart(e.target.value)} /></div>
                      <div className="field"><label>Period end</label><input type="date" value={invoicePeriodEnd} onChange={e => setInvoicePeriodEnd(e.target.value)} /></div>
                    </div>
                    <button className="btn btnPrimary" onClick={handleGenerateInvoice} disabled={invoiceGenerateBusy || !invoicePeriodStart || !invoicePeriodEnd}>{invoiceGenerateBusy ? "Generating…" : "Generate invoice"}</button>
                    {invoiceMessage && <p className="footerNote" style={{marginTop:10}}>{invoiceMessage}</p>}
                  </div>
                )}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">MARKETPLACE PROFILES &amp; DISCOVERY — PHASE 5</p><h3>Worker directory</h3></div></div>
                {!selectedPartner && <p className="footerNote">Select a partner above (Partner billing &amp; invoicing) to search its worker directory.</p>}
                {selectedPartner && (
                  <>
                    <div className="formRow">
                      <div className="field"><label>Search by name</label><input value={directoryQuery} onChange={e => setDirectoryQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleSearchDirectory(1); }} placeholder="e.g. Jordan Lee" /></div>
                      <div className="field"><label>Worker type</label>
                        <select value={directoryWorkerType} onChange={e => setDirectoryWorkerType(e.target.value as typeof directoryWorkerType)}>
                          <option value="">Any</option>
                          <option value="MOVER">Mover</option>
                          <option value="BOX_TRUCK_DRIVER">Box truck driver</option>
                          <option value="SEMI_DRIVER">Semi driver</option>
                        </select>
                      </div>
                    </div>
                    <div className="formRow">
                      <div className="field"><label>Skill</label><input value={directorySkill} onChange={e => setDirectorySkill(e.target.value)} placeholder="e.g. piano moving" /></div>
                      <div className="field"><label>Language (2-letter code)</label><input value={directoryLanguage} onChange={e => setDirectoryLanguage(e.target.value)} maxLength={2} placeholder="es" /></div>
                      <div className="field"><label>Minimum rating</label>
                        <select value={directoryMinRating} onChange={e => setDirectoryMinRating(e.target.value as typeof directoryMinRating)}>
                          <option value="">Any</option>
                          <option value="3">3.0+</option>
                          <option value="4">4.0+</option>
                          <option value="4.5">4.5+</option>
                        </select>
                      </div>
                      <div className="field"><label>Sort by</label>
                        <select value={directorySort} onChange={e => setDirectorySort(e.target.value as typeof directorySort)}>
                          <option value="">Default (rating)</option>
                          <option value="rating">Rating</option>
                          <option value="completedJobs">Completed jobs</option>
                        </select>
                      </div>
                    </div>
                    <div style={{display:"flex",gap:16,alignItems:"center",marginBottom:10,flexWrap:"wrap"}}>
                      <label style={{fontSize:13,display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" checked={directoryVerifiedOnly} onChange={e => setDirectoryVerifiedOnly(e.target.checked)} /> Verified only</label>
                      <label style={{fontSize:13,display:"flex",gap:6,alignItems:"center"}}><input type="checkbox" checked={directoryAcceptingOnly} onChange={e => setDirectoryAcceptingOnly(e.target.checked)} /> Accepting jobs only</label>
                    </div>
                    <div style={{display:"flex",gap:8,alignItems:"center",flexWrap:"wrap"}}>
                      <button className="btn btnPrimary" onClick={() => handleSearchDirectory(1)} disabled={directoryBusy}>{directoryBusy ? "Searching…" : "Search directory"}</button>
                      <input value={saveSearchName} onChange={e => setSaveSearchName(e.target.value)} placeholder="Name this search…" style={{maxWidth:180}} />
                      <button className="btn btnSecondary" onClick={handleSaveSearch} disabled={!saveSearchName.trim()}>Save search</button>
                    </div>
                    {savedSearches === null ? (
                      <button className="btn btnSecondary" style={{marginTop:8}} onClick={loadSavedSearches}>Load saved searches</button>
                    ) : savedSearches.length > 0 && (
                      <div style={{marginTop:8,display:"flex",gap:6,flexWrap:"wrap"}}>
                        {savedSearches.map(s => (
                          <span key={s.id} className="tag" style={{background:"#eef1f5",display:"inline-flex",gap:6,alignItems:"center"}}>
                            <button className="btnLink" style={{border:"none",background:"none",cursor:"pointer",font:"inherit",color:"#3355dd"}} onClick={() => handleApplySavedSearch(s.id)}>{s.name}</button>
                            <button style={{border:"none",background:"none",cursor:"pointer",color:"#b3261e"}} title="Delete" onClick={() => handleDeleteSavedSearch(s.id)}>×</button>
                          </span>
                        ))}
                      </div>
                    )}
                    {directoryError && <p className="footerNote">{directoryError}</p>}
                    {directoryResults && directoryResults.length === 0 && <p className="footerNote">No active workers match this search.</p>}
                    {directoryResults && directoryResults.length > 0 && (
                      <>
                      <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12,marginTop:12}}>
                        {directoryResults.map(w => {
                          const alreadyPreferred = preferredWorkers?.some(pw => pw.worker.id === w.id);
                          return (
                            <WorkerProfileCard
                              key={w.id}
                              worker={w}
                              metrics={w.metrics}
                              availabilityBadge={w.availabilityBadge}
                              isPreferred={alreadyPreferred}
                              isFavorite={favoriteWorkerIds.has(w.id)}
                              onToggleFavorite={handleToggleFavorite}
                              onViewProfile={handleViewWorkerProfile}
                              action={
                                <>
                                  <button className="btn btnSecondary" disabled={alreadyPreferred || preferredNetworkBusyId === w.id} onClick={() => handleAddPreferredWorker(w.id)}>
                                    {alreadyPreferred ? "Already preferred" : preferredNetworkBusyId === w.id ? "Adding…" : "Add to preferred network"}
                                  </button>
                                  <button className="btn btnPrimary" style={{marginLeft:6}} onClick={() => handleOpenInvite(w)}>Invite</button>
                                </>
                              }
                            />
                          );
                        })}
                      </div>
                      {directoryPagination && directoryPagination.totalPages > 1 && (
                        <div style={{display:"flex",gap:10,alignItems:"center",justifyContent:"center",marginTop:14}}>
                          <button className="btn btnSecondary" disabled={directoryPage <= 1 || directoryBusy} onClick={() => handleSearchDirectory(directoryPage - 1)}>Previous</button>
                          <span style={{fontSize:13,color:"#637089"}}>Page {directoryPagination.page} of {directoryPagination.totalPages} ({directoryPagination.total} workers)</span>
                          <button className="btn btnSecondary" disabled={directoryPage >= directoryPagination.totalPages || directoryBusy} onClick={() => handleSearchDirectory(directoryPage + 1)}>Next</button>
                        </div>
                      )}
                      </>
                    )}
                  </>
                )}
              </section>
            </div>

            {/* Phase 5 discovery panels — favorites, recently hired, recommendations. All reuse WorkerProfileCard. */}
            {selectedPartner && (
              <div className="dashboardGrid" style={{marginTop:20}}>
                <section className="panel">
                  <div className="panelHead"><div><p className="eyebrow">DISCOVERY — PHASE 5</p><h3>Favorites, recently hired &amp; recommendations</h3></div></div>
                  {discoveryError && <p className="footerNote" style={{color:"#b3261e"}}>{discoveryError}</p>}
                  <div style={{display:"flex",gap:8,flexWrap:"wrap",marginBottom:12}}>
                    <button className="btn btnSecondary" onClick={loadFavorites}>Load favorites</button>
                    <button className="btn btnSecondary" onClick={loadRecentlyHired}>Load recently hired</button>
                    <button className="btn btnSecondary" onClick={loadRecommendations}>Load recommendations</button>
                  </div>

                  {favorites && (
                    <>
                      <h4 style={{margin:"6px 0",fontSize:13,color:"#637089"}}>FAVORITES</h4>
                      {favorites.length === 0 ? <p className="footerNote">No favorites yet — tap the ☆ on any worker.</p> : (
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12}}>
                          {favorites.map(w => (
                            <WorkerProfileCard key={w.id} worker={w} metrics={w.metrics} availabilityBadge={w.availabilityBadge} isFavorite={favoriteWorkerIds.has(w.id)} onToggleFavorite={handleToggleFavorite} onViewProfile={handleViewWorkerProfile}
                              action={<button className="btn btnPrimary" onClick={() => handleOpenInvite(w)}>Invite</button>} />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {recentlyHired && (
                    <>
                      <h4 style={{margin:"14px 0 6px",fontSize:13,color:"#637089"}}>RECENTLY HIRED</h4>
                      {recentlyHired.length === 0 ? <p className="footerNote">No hiring history yet.</p> : (
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12}}>
                          {recentlyHired.map(w => (
                            <WorkerProfileCard key={w.id} worker={w} metrics={w.metrics} availabilityBadge={w.availabilityBadge} isFavorite={favoriteWorkerIds.has(w.id)} onToggleFavorite={handleToggleFavorite} onViewProfile={handleViewWorkerProfile}
                              action={<button className="btn btnPrimary" onClick={() => handleOpenInvite(w)}>Invite again</button>} />
                          ))}
                        </div>
                      )}
                    </>
                  )}

                  {recommendations && (
                    <>
                      <h4 style={{margin:"14px 0 6px",fontSize:13,color:"#637089"}}>RECOMMENDED</h4>
                      {recommendations.length === 0 ? <p className="footerNote">No recommendations available yet.</p> : (
                        <div style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(280px, 1fr))",gap:12}}>
                          {recommendations.map(({ worker: w, reason }) => (
                            <div key={w.id} style={{display:"flex",flexDirection:"column",gap:4}}>
                              <WorkerProfileCard worker={w} metrics={w.metrics} availabilityBadge={w.availabilityBadge} isFavorite={favoriteWorkerIds.has(w.id)} onToggleFavorite={handleToggleFavorite} onViewProfile={handleViewWorkerProfile}
                                action={<button className="btn btnPrimary" onClick={() => handleOpenInvite(w)}>Invite</button>} />
                              <p className="footerNote" style={{margin:0,fontStyle:"italic"}}>Why: {reason}</p>
                            </div>
                          ))}
                        </div>
                      )}
                    </>
                  )}
                </section>
              </div>
            )}
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">PREFERRED NETWORK — PHASE 2</p><h3>My preferred network</h3></div></div>
                {!selectedPartner && <p className="footerNote">Select a partner above to manage its preferred network.</p>}
                {selectedPartner && (
                  <>
                    {preferredWorkersError && <p className="footerNote">{preferredWorkersError}</p>}
                    {!preferredWorkers && !preferredWorkersError && <p className="footerNote">Loading…</p>}
                    {preferredWorkers && preferredWorkers.length > 0 && (
                      <div className="formRow">
                        <div className="field"><label>Filter by name</label><input value={preferredNetworkFilterQuery} onChange={e => setPreferredNetworkFilterQuery(e.target.value)} placeholder="e.g. Jordan Lee" /></div>
                        <div className="field"><label>Type</label>
                          <select value={preferredNetworkFilterType} onChange={e => setPreferredNetworkFilterType(e.target.value as typeof preferredNetworkFilterType)}>
                            <option value="">Any</option>
                            <option value="MOVER">Mover</option>
                            <option value="BOX_TRUCK_DRIVER">Box truck driver</option>
                            <option value="SEMI_DRIVER">Semi driver</option>
                          </select>
                        </div>
                      </div>
                    )}
                    {preferredWorkers && preferredWorkers.length === 0 && <p className="footerNote">No preferred workers yet — add some from the directory above.</p>}
                    {preferredWorkers && preferredWorkers.length > 0 && (() => {
                      const filtered = preferredWorkers.filter(pw =>
                        (!preferredNetworkFilterQuery.trim() || pw.worker.displayName.toLowerCase().includes(preferredNetworkFilterQuery.trim().toLowerCase())) &&
                        (!preferredNetworkFilterType || pw.worker.workerType === preferredNetworkFilterType)
                      );
                      if (filtered.length === 0) return <p className="footerNote">No preferred workers match this filter.</p>;
                      const isDriver = (t: string) => t === "BOX_TRUCK_DRIVER" || t === "SEMI_DRIVER";
                      return (
                        <table className="table"><thead><tr><th></th><th>Worker</th><th>Type</th><th>Availability</th><th>Priority</th><th>Added</th><th></th></tr></thead>
                          <tbody>
                            {filtered.map(pw => (
                              <tr key={pw.id}>
                                <td>{isDriver(pw.worker.workerType) && (
                                  <input type="checkbox" checked={bulkSelectedWorkerIds.includes(pw.worker.id)} onChange={() => toggleBulkWorker(pw.worker.id)} title="Select for bulk freight invitation" />
                                )}</td>
                                <td>{pw.worker.displayName}</td>
                                <td>{pw.worker.workerType}</td>
                                <td style={{color: pw.worker.acceptingJobs ? "#1a7f37" : "#b3261e"}}>{pw.worker.acceptingJobs ? "Accepting jobs" : "Not available"}</td>
                                <td><input type="number" min={1} max={100} value={pw.priority} style={{width:60}} onChange={e => handleChangePreferredPriority(pw.worker.id, Number(e.target.value))} disabled={preferredNetworkBusyId === pw.worker.id} /></td>
                                <td>{new Date(pw.createdAt).toLocaleDateString()}</td>
                                <td>
                                  <button className="btn btnSecondary" style={{marginRight:6}} onClick={() => handleViewWorkerProfile(pw.worker.id)}>View profile</button>
                                  <button className="btn btnPrimary" style={{marginRight:6}} onClick={() => handleOpenInvite(pw.worker)}>Invite</button>
                                  <button className="btn btnSecondary" disabled={preferredNetworkBusyId === pw.worker.id} onClick={() => handleRemovePreferredWorker(pw.worker.id)}>{preferredNetworkBusyId === pw.worker.id ? "Removing…" : "Remove"}</button>
                                </td>
                              </tr>
                            ))}
                          </tbody>
                        </table>
                      );
                    })()}
                    {/* Bulk freight invitations — Phase 4. Checkbox-select drivers above, then pick a load. */}
                    {bulkSelectedWorkerIds.length > 0 && (
                      <div className="panel" style={{marginTop:12,background:"#eef3fb"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"center"}}>
                          <strong style={{fontSize:14}}>{bulkSelectedWorkerIds.length} driver{bulkSelectedWorkerIds.length === 1 ? "" : "s"} selected for bulk invite</strong>
                          <div>
                            <button className="btn btnPrimary" style={{marginRight:6}} onClick={handleOpenBulkInvite}>Choose a load…</button>
                            <button className="btn btnSecondary" onClick={() => { setBulkSelectedWorkerIds([]); setBulkTargetLoads(null); setBulkInviteResults(null); setBulkInviteMessage(null); }}>Clear</button>
                          </div>
                        </div>
                        <div className="field" style={{marginTop:10,marginBottom:0}}>
                          <label>Message template (optional)</label>
                          <select value={inviteTemplateId} onChange={e => setInviteTemplateId(e.target.value)} onFocus={() => { if (!invitationTemplates) loadInvitationTemplates(); }}>
                            <option value="">Default invitation message</option>
                            {(invitationTemplates ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                          </select>
                        </div>
                        {bulkTargetLoads && bulkTargetLoads.length === 0 && <p className="footerNote">You have no open loads to invite these drivers to.</p>}
                        {bulkTargetLoads && bulkTargetLoads.length > 0 && (
                          <table className="table" style={{marginTop:10}}><thead><tr><th>Load</th><th>Status</th><th>Pickup</th><th>Equipment</th><th></th></tr></thead>
                            <tbody>
                              {bulkTargetLoads.map(l => (
                                <tr key={l.id}>
                                  <td>{l.title}</td>
                                  <td>{l.status}</td>
                                  <td>{new Date(l.pickupDate).toLocaleString()}</td>
                                  <td>{l.equipmentType}</td>
                                  <td><button className="btn btnPrimary" disabled={bulkInviteBusy} onClick={() => handleSendBulkInvite(l.id)}>{bulkInviteBusy ? "Sending…" : `Invite ${bulkSelectedWorkerIds.length}`}</button></td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                        {bulkInviteMessage && <p className="footerNote" style={{marginTop:8}}>{bulkInviteMessage}</p>}
                        {bulkInviteResults && bulkInviteResults.some(r => !r.ok) && (
                          <div style={{marginTop:6}}>
                            {bulkInviteResults.filter(r => !r.ok).map(r => {
                              const w = preferredWorkers?.find(pw => pw.worker.id === r.workerId)?.worker;
                              return <p key={r.workerId} className="footerNote" style={{color:"#b3261e",margin:"2px 0"}}>{w?.displayName ?? r.workerId}: {r.error}</p>;
                            })}
                          </div>
                        )}
                      </div>
                    )}
                    {preferredNetworkMessage && <p className="footerNote" style={{marginTop:10}}>{preferredNetworkMessage}</p>}
                    {viewingWorkerProfileError && <p className="footerNote" style={{color:"#b3261e"}}>{viewingWorkerProfileError}</p>}
                    {viewingWorkerProfile && (
                      <div className="panel" style={{marginTop:14,background:"#f7f9fc"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                          <h4 style={{margin:0}}>Worker profile</h4>
                          <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12.5}} onClick={() => setViewingWorkerProfile(null)}>Close</button>
                        </div>
                        <WorkerProfileCard worker={viewingWorkerProfile.worker} metrics={viewingWorkerProfile.metrics} availabilityBadge={viewingWorkerProfile.availabilityBadge} isFavorite={favoriteWorkerIds.has(viewingWorkerProfile.worker.id)} onToggleFavorite={handleToggleFavorite} isPreferred={preferredWorkers?.some(pw => pw.worker.id === viewingWorkerProfile.worker.id)} />
                        {profileGallery && profileGallery.length > 0 && (
                          <>
                            <h4 style={{marginBottom:6,marginTop:14,fontSize:13,color:"#637089"}}>WORK PORTFOLIO</h4>
                            <ul role="list" aria-label="Approved work photos" style={{display:"grid",gridTemplateColumns:"repeat(auto-fill, minmax(120px, 1fr))",gap:8,listStyle:"none",padding:0,margin:0}}>
                              {profileGallery.map(g => (
                                <li key={g.id} style={{margin:0}}>
                                  {(g.thumbnailUrl || g.deliveryUrl) ? (
                                    // eslint-disable-next-line @next/next/no-img-element
                                    <img src={g.thumbnailUrl ?? g.deliveryUrl ?? ""} alt={g.title ? `${g.title}${g.category ? ` (${g.category.name})` : ""}` : `Work photo by ${viewingWorkerProfile.worker.displayName}`} loading="lazy" style={{width:"100%",aspectRatio:"1 / 1",objectFit:"cover",borderRadius:6,border: g.isPrimary ? "2px solid #3355dd" : "1px solid #e3e8f0"}} />
                                  ) : (
                                    <div style={{width:"100%",aspectRatio:"1 / 1",borderRadius:6,background:"#eef1f5",display:"flex",alignItems:"center",justifyContent:"center",fontSize:11,color:"#637089"}} aria-label={g.title ?? "Work photo"}>Image unavailable</div>
                                  )}
                                </li>
                              ))}
                            </ul>
                          </>
                        )}
                        <h4 style={{marginBottom:6,marginTop:14,fontSize:13,color:"#637089"}}>RECENT REVIEWS</h4>
                        {viewingWorkerProfile.reviews.length === 0 && <p className="footerNote">No published reviews yet.</p>}
                        {viewingWorkerProfile.reviews.map((r, i) => (
                          <div key={i} style={{borderBottom:"1px solid #e3e8f0",padding:"8px 0",fontSize:13}}>
                            <strong>★ {r.rating}</strong>{r.comment && <p style={{margin:"4px 0 0"}}>{r.comment}</p>}
                          </div>
                        ))}
                      </div>
                    )}
                    {invitingWorker && (
                      <div className="panel" style={{marginTop:14,background:"#f7f9fc"}}>
                        <div style={{display:"flex",justifyContent:"space-between",alignItems:"flex-start"}}>
                          <h4 style={{margin:0}}>Invite {invitingWorker.displayName}</h4>
                          <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12.5}} onClick={() => setInvitingWorker(null)}>Close</button>
                        </div>
                        {inviteTargetsError && <p className="footerNote">{inviteTargetsError}</p>}
                        {invitingWorker.workerType === "MOVER" && (
                          <>
                            {!inviteTargetJobs && !inviteTargetsError && <p className="footerNote">Loading your open jobs…</p>}
                            {inviteTargetJobs && inviteTargetJobs.length === 0 && <p className="footerNote">You have no open jobs to invite this worker to.</p>}
                            {inviteTargetJobs && inviteTargetJobs.length > 0 && (
                              <table className="table"><thead><tr><th>Job</th><th>Status</th><th>Starts</th><th>Crew size</th><th></th></tr></thead>
                                <tbody>
                                  {inviteTargetJobs.map(j => (
                                    <tr key={j.id}>
                                      <td>{j.title}</td>
                                      <td>{j.status}</td>
                                      <td>{new Date(j.startsAt).toLocaleString()}</td>
                                      <td>{j.moversRequired}</td>
                                      <td><button className="btn btnPrimary" disabled={inviteBusy} onClick={() => handleSendJobInvite(j.id)}>{inviteBusy ? "Sending…" : "Send invite"}</button></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </>
                        )}
                        {invitingWorker.workerType !== "MOVER" && (
                          <>
                            <div className="field" style={{marginBottom:8}}>
                              <label>Message template (optional)</label>
                              <select value={inviteTemplateId} onChange={e => setInviteTemplateId(e.target.value)}>
                                <option value="">Default invitation message</option>
                                {(invitationTemplates ?? []).map(t => <option key={t.id} value={t.id}>{t.name}</option>)}
                              </select>
                            </div>
                            {!inviteTargetLoads && !inviteTargetsError && <p className="footerNote">Loading your open loads…</p>}
                            {inviteTargetLoads && inviteTargetLoads.length === 0 && <p className="footerNote">You have no open loads to invite this driver to.</p>}
                            {inviteTargetLoads && inviteTargetLoads.length > 0 && (
                              <table className="table"><thead><tr><th>Load</th><th>Status</th><th>Pickup</th><th>Equipment</th><th></th></tr></thead>
                                <tbody>
                                  {inviteTargetLoads.map(l => (
                                    <tr key={l.id}>
                                      <td>{l.title}</td>
                                      <td>{l.status}</td>
                                      <td>{new Date(l.pickupDate).toLocaleString()}</td>
                                      <td>{l.equipmentType}</td>
                                      <td><button className="btn btnPrimary" disabled={inviteBusy} onClick={() => handleSendLoadInvite(l.id)}>{inviteBusy ? "Sending…" : "Send invite"}</button></td>
                                    </tr>
                                  ))}
                                </tbody>
                              </table>
                            )}
                          </>
                        )}
                      </div>
                    )}
                    {inviteMessage && <p className="footerNote" style={{marginTop:10}}>{inviteMessage}</p>}
                  </>
                )}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">FREIGHT INVITATIONS — PHASE 4</p><h3>Invitation message templates</h3></div>
                  <button className="btn btnSecondary" onClick={loadInvitationTemplates}>Refresh</button>
                </div>
                <p className="footerNote" style={{marginTop:0}}>
                  Reusable messages for freight-load invitations. Tokens <code>{"{driverName}"}</code>, <code>{"{loadTitle}"}</code>, <code>{"{pickupDate}"}</code>, and <code>{"{expiresAt}"}</code> are filled in automatically when the invitation is sent.
                </p>
                {templatesError && <p className="footerNote" style={{color:"#b3261e"}}>{templatesError}</p>}
                {!invitationTemplates && !templatesError && <button className="btn btnPrimary" onClick={loadInvitationTemplates}>Load my templates</button>}
                {invitationTemplates && invitationTemplates.length === 0 && <p className="footerNote">No templates yet — create one below.</p>}
                {invitationTemplates && invitationTemplates.length > 0 && (
                  <table className="table"><thead><tr><th>Name</th><th>Subject</th><th>Updated</th><th></th></tr></thead>
                    <tbody>
                      {invitationTemplates.map(t => (
                        <tr key={t.id}>
                          <td>{t.name}</td>
                          <td>{t.subject}</td>
                          <td>{new Date(t.updatedAt).toLocaleDateString()}</td>
                          <td>
                            <button className="btn btnSecondary" style={{marginRight:6}} disabled={templateBusy} onClick={() => beginEditTemplate(t)}>Edit</button>
                            <button className="btn btnSecondary" disabled={templateBusy} onClick={() => handleDeleteTemplate(t.id)}>Delete</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                <h4 style={{marginTop:14,marginBottom:6,fontSize:13,color:"#637089"}}>{editingTemplateId ? "EDIT TEMPLATE" : "NEW TEMPLATE"}</h4>
                <div className="field"><label>Name</label><input value={templateDraftName} onChange={e => setTemplateDraftName(e.target.value)} placeholder="e.g. Preferred carrier — urgent" /></div>
                <div className="field"><label>Subject</label><input value={templateDraftSubject} onChange={e => setTemplateDraftSubject(e.target.value)} placeholder="You're invited: {loadTitle}" /></div>
                <div className="field"><label>Body</label><textarea value={templateDraftBody} onChange={e => setTemplateDraftBody(e.target.value)} rows={4} placeholder={"Hi {driverName}, we'd like you on {loadTitle} (pickup {pickupDate}). This invitation expires {expiresAt}."} /></div>
                <div>
                  <button className="btn btnPrimary" style={{marginRight:6}} disabled={templateBusy || !templateDraftName.trim() || !templateDraftSubject.trim() || !templateDraftBody.trim()} onClick={handleSaveTemplate}>{templateBusy ? "Saving…" : editingTemplateId ? "Update template" : "Create template"}</button>
                  {editingTemplateId && <button className="btn btnSecondary" disabled={templateBusy} onClick={resetTemplateDraft}>Cancel edit</button>}
                </div>
                {templateMessage && <p className="footerNote" style={{marginTop:10}}>{templateMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE ACTION</p><h3>Freight settlement operations</h3></div></div>

                <h4 style={{marginTop:0,marginBottom:6,fontSize:13,color:"#637089"}}>GENERATE A NEW SETTLEMENT</h4>
                <div className="field" style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <label>Search driver by name or email</label>
                    <input value={driverQuery} onChange={e => setDriverQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleDriverSearch(); }} placeholder="e.g. Jordan Lee" />
                  </div>
                  <button className="btn btnPrimary" onClick={handleDriverSearch} disabled={driverSearchBusy || !driverQuery.trim()}>{driverSearchBusy ? "Searching…" : "Search"}</button>
                </div>
                {driverSearchError && <p className="footerNote">{driverSearchError}</p>}
                {driverResults && driverResults.length === 0 && <p className="footerNote">No matching drivers found.</p>}
                {driverResults && driverResults.length > 0 && (
                  <table className="table"><thead><tr><th>Driver</th><th>Type</th><th>Status</th><th>Connect</th><th></th></tr></thead>
                    <tbody>
                      {driverResults.map(d => (
                        <tr key={d.id}>
                          <td>{d.displayName} <small style={{color:"#637089"}}>({d.user.email})</small></td>
                          <td>{d.workerType}</td>
                          <td>{d.operationalStatus}</td>
                          <td>{d.stripePayoutsEnabled ? "Ready" : "Not onboarded"}</td>
                          <td><button className="btn btnSecondary" onClick={() => { setSelectedDriver(d); setSettlementMessage(null); }}>Select</button></td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {selectedDriver && (
                  <div className="panel" style={{marginTop:14,background:"#f7f9fc"}}>
                    <p><strong>Generating for:</strong> {selectedDriver.displayName}</p>
                    <div className="formRow">
                      <div className="field"><label>Period start</label><input type="date" value={settlementPeriodStart} onChange={e => setSettlementPeriodStart(e.target.value)} /></div>
                      <div className="field"><label>Period end</label><input type="date" value={settlementPeriodEnd} onChange={e => setSettlementPeriodEnd(e.target.value)} /></div>
                    </div>
                    <button className="btn btnPrimary" onClick={handleGenerateSettlement} disabled={settlementGenerateBusy || !settlementPeriodStart || !settlementPeriodEnd}>{settlementGenerateBusy ? "Generating…" : "Generate settlement"}</button>
                    <button className="btn btnSecondary" style={{marginLeft:8}} onClick={() => setSelectedDriver(null)} disabled={settlementGenerateBusy}>Cancel</button>
                  </div>
                )}

                <h4 style={{marginTop:18,marginBottom:6,fontSize:13,color:"#637089"}}>EXISTING SETTLEMENTS</h4>
                <div className="field" style={{maxWidth:240}}>
                  <label>Filter by status</label>
                  <select value={settlementStatusFilter} onChange={e => { setSettlementStatusFilter(e.target.value); }}>
                    <option value="">All statuses</option>
                    <option value="PENDING">Pending</option>
                    <option value="SCHEDULED">Scheduled</option>
                    <option value="PROCESSING">Processing</option>
                    <option value="TRANSFERRED">Transferred</option>
                    <option value="PAID_OUT">Paid out</option>
                    <option value="FAILED">Failed</option>
                    <option value="HELD">Held</option>
                    <option value="REVERSED">Reversed</option>
                  </select>
                </div>
                <button className="btn btnSecondary" onClick={loadSettlements}>Refresh</button>
                {settlementsError && <p className="footerNote">{settlementsError}</p>}
                {settlements && settlements.length === 0 && <p className="footerNote">No settlements match this filter.</p>}
                {settlements && settlements.length > 0 && (
                  <table className="table"><thead><tr><th>Driver</th><th>Period</th><th>Loads</th><th>Net</th><th>Status</th><th></th></tr></thead>
                    <tbody>
                      {settlements.map(s => (
                        <tr key={s.id}>
                          <td>{s.worker.displayName}</td>
                          <td>{new Date(s.periodStart).toLocaleDateString()} – {new Date(s.periodEnd).toLocaleDateString()}</td>
                          <td>{s.loadsSettled}</td>
                          <td>{money(s.netCents)}</td>
                          <td>
                            {s.status}
                            {s.status === "TRANSFERRED" && <small style={{display:"block",color:"#637089"}}>Sent to Stripe payout balance</small>}
                            {s.status === "PAID_OUT" && <small style={{display:"block",color:"#637089"}}>Deposited to bank</small>}
                            {s.status === "FAILED" && s.failureReason && <small style={{display:"block",color:"#b3261e"}}>{s.failureReason}</small>}
                          </td>
                          <td>
                            {s.status === "PENDING" && <button className="btn btnSecondary" disabled={settlementActionBusyId === s.id} onClick={() => handleSettlementAction(s, "approve")}>{settlementActionBusyId === s.id ? "Approving…" : "Approve"}</button>}
                            {(s.status === "SCHEDULED" || s.status === "FAILED" || s.status === "PROCESSING") && <button className="btn btnPrimary" disabled={!s.worker.stripePayoutsEnabled || settlementActionBusyId === s.id} title={s.worker.stripePayoutsEnabled ? undefined : "Driver hasn't completed Stripe Connect onboarding."} onClick={() => handleSettlementAction(s, "pay")}>{settlementActionBusyId === s.id ? "Paying…" : s.status === "FAILED" ? "Retry" : "Pay"}</button>}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {settlementMessage && <p className="footerNote" style={{marginTop:10}}>{settlementMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE DATA</p><h3>Audit log</h3></div></div>
                <div className="formRow">
                  <div className="field"><label>Action</label><input value={auditFilterAction} onChange={e => setAuditFilterAction(e.target.value)} placeholder="e.g. REFUND_SUCCEEDED" /></div>
                  <div className="field"><label>Entity type</label><input value={auditFilterEntityType} onChange={e => setAuditFilterEntityType(e.target.value)} placeholder="e.g. PaymentRefund" /></div>
                  <div className="field"><label>Entity ID</label><input value={auditFilterEntityId} onChange={e => setAuditFilterEntityId(e.target.value)} placeholder="e.g. a job or refund ID" /></div>
                </div>
                <button className="btn btnSecondary" onClick={() => loadAuditLogs({ reset: true })} disabled={auditLoading}>{auditLoading && auditLogs.length === 0 ? "Loading…" : "Apply filters"}</button>
                {auditError && <p className="footerNote">{auditError}</p>}
                {!auditLoading && auditLogs.length === 0 && !auditError && <p className="footerNote">No matching audit entries.</p>}
                {auditLogs.length > 0 && (
                  <table className="table"><thead><tr><th>When</th><th>Actor</th><th>Action</th><th>Entity</th><th></th></tr></thead>
                    <tbody>
                      {auditLogs.map(log => (
                        <Fragment key={log.id}>
                          <tr>
                            <td>{new Date(log.createdAt).toLocaleString()}</td>
                            <td>{log.actor ? `${log.actor.email} (${log.actor.role})` : <em style={{color:"#637089"}}>System / webhook</em>}</td>
                            <td>{log.action}</td>
                            <td>{log.entityType}{log.entityId && <><br /><small style={{color:"#637089"}}>{log.entityId}</small></>}</td>
                            <td>
                              {log.details != null && <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12}} onClick={() => setExpandedAuditId(expandedAuditId === log.id ? null : log.id)}>{expandedAuditId === log.id ? "Hide" : "Details"}</button>}
                              {log.entityId && <button className="btn btnSecondary" style={{padding:"4px 10px",fontSize:12,marginLeft:6}} onClick={() => viewAuditTrailFor(log.entityId!)}>Filter to this</button>}
                            </td>
                          </tr>
                          {expandedAuditId === log.id && log.details != null && (
                            <tr><td colSpan={5}><pre style={{whiteSpace:"pre-wrap",fontSize:12,background:"#f7f9fc",padding:10,borderRadius:6,margin:0}}>{JSON.stringify(log.details, null, 2)}</pre></td></tr>
                          )}
                        </Fragment>
                      ))}
                    </tbody>
                  </table>
                )}
                {auditHasMore && (
                  <button className="btn btnSecondary" style={{marginTop:10}} onClick={() => loadAuditLogs({ reset: false })} disabled={auditLoading}>{auditLoading ? "Loading…" : "Load more"}</button>
                )}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              <section className="panel">
                <div className="panelHead"><div><p className="eyebrow">LIVE ACTION</p><h3>Issue a refund</h3></div></div>
                <div className="field" style={{display:"flex",gap:8,alignItems:"flex-end"}}>
                  <div style={{flex:1}}>
                    <label>Search by job/load title, customer name, or ID</label>
                    <input value={refundQuery} onChange={e => setRefundQuery(e.target.value)} onKeyDown={e => { if (e.key === "Enter") handleRefundSearch(); }} placeholder="e.g. Jordan Lee, or a job ID" />
                  </div>
                  <button className="btn btnPrimary" onClick={handleRefundSearch} disabled={refundSearchBusy || !refundQuery.trim()}>{refundSearchBusy ? "Searching…" : "Search"}</button>
                </div>
                {refundSearchError && <p className="footerNote">{refundSearchError}</p>}
                {refundResults && refundResults.length === 0 && <p className="footerNote">No matching payment transactions found.</p>}
                {refundResults && refundResults.length > 0 && (
                  <table className="table"><thead><tr><th>Title</th><th>Customer</th><th>Received</th><th>Refunded</th><th>Refundable</th><th></th></tr></thead>
                    <tbody>
                      {refundResults.map(r => (
                        <tr key={r.id}>
                          <td>{r.title} <small style={{color:"#637089"}}>({r.type})</small></td>
                          <td>{r.customerName ?? "—"}</td>
                          <td>{money(r.amountReceivedCents)}</td>
                          <td>{money(r.refundedAmountCents)}</td>
                          <td>{money(r.refundableRemainingCents)}</td>
                          <td>
                            <button className="btn btnSecondary" disabled={r.refundableRemainingCents <= 0} onClick={() => { setSelectedTransaction(r); setRefundFull(true); setRefundAmountInput(""); setRefundMessage(null); }}>Refund</button>
                            <button className="btn btnSecondary" style={{marginLeft:6}} onClick={() => viewAuditTrailFor(r.id)}>Audit trail</button>
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                )}
                {selectedTransaction && (
                  <div className="panel" style={{marginTop:14,background:"#f7f9fc"}}>
                    <p><strong>Refunding:</strong> {selectedTransaction.title} — refundable balance {money(selectedTransaction.refundableRemainingCents)}</p>
                    <div className="field">
                      <label><input type="radio" checked={refundFull} onChange={() => setRefundFull(true)} /> Full remaining balance</label>
                      <label style={{marginLeft:16}}><input type="radio" checked={!refundFull} onChange={() => setRefundFull(false)} /> Partial amount ($)</label>
                      {!refundFull && <input style={{marginTop:6}} type="number" min="0.01" step="0.01" value={refundAmountInput} onChange={e => setRefundAmountInput(e.target.value)} placeholder="0.00" />}
                    </div>
                    <div className="field"><label>Reason (required)</label><textarea value={refundReason} onChange={e => setRefundReason(e.target.value)} placeholder="Customer-approved service adjustment, duplicate charge, etc." /></div>
                    <div style={{display:"flex",gap:8}}>
                      <button className="btn btnPrimary" onClick={handleRefundSubmit} disabled={refundBusy || !refundReason.trim()}>{refundBusy ? "Processing…" : "Submit refund"}</button>
                      <button className="btn btnSecondary" onClick={() => { setSelectedTransaction(null); setRefundMessage(null); }} disabled={refundBusy}>Cancel</button>
                    </div>
                  </div>
                )}
                {refundMessage && <p className="footerNote" style={{marginTop:10}}>{refundMessage}</p>}
              </section>
            </div>
            <div className="dashboardGrid" style={{marginTop:20}}>
              {renderPortfolioModerationPanel()}
            </div>
          </>
        )}
      </main>
    </div>
  );
}
