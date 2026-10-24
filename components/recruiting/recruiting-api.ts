"use client";

import { authFetch } from "@/lib/client-auth";

/** Carrier Recruiting CRM API client. */

export const STAGES = ["NEW_LEAD","CONTACT_ATTEMPTED","CONTACTED","INTERESTED","APPLICATION_SENT","APPLICATION_STARTED","DOCUMENTS_PENDING","UNDER_REVIEW","APPROVED","ACTIVE","NOT_INTERESTED","UNQUALIFIED","DO_NOT_CONTACT"] as const;
export type Stage = (typeof STAGES)[number];
export const LEAD_SOURCES = ["DAT","TRUCKSTOP","REFERRAL","COLD_OUTREACH","INBOUND","EVENT","SOCIAL","OTHER"] as const;
export type LeadSource = (typeof LEAD_SOURCES)[number];

export type Prospect = {
  id: string; companyName: string; contactName: string | null; contactEmail: string | null; contactPhone: string | null;
  dotNumber: string | null; mcNumber: string | null; equipmentSummary: string | null; operatingStates: string | null;
  recruitmentStage: Stage; leadSource: LeadSource; referralSource: string | null;
  assignedRecruiterId: string | null; convertedCarrierId: string | null; lastContactAt: string | null; nextFollowUpAt: string | null;
};
export type Activity = { id: string; activityType: string; notes: string | null; performedById: string; occurredAt: string };
export type Task = { id: string; title: string; dueAt: string | null; prospectId: string | null; completedAt: string | null };
export type Dashboard = { goal: number; activeCarriers: number; progressPercent: number; convertedProspects: number; pipeline: Record<string, number>; followUpsOverdue: number; tasksDueThisWeek: number };

export async function listProspects(stage?: string): Promise<Prospect[]> {
  const res = await authFetch(stage ? `/api/recruiting/prospects?stage=${stage}` : "/api/recruiting/prospects");
  if (!res.ok) throw new Error(`Could not load prospects (${res.status}).`);
  return (await res.json()).prospects ?? [];
}
export async function createProspect(input: Partial<Prospect> & { companyName: string }): Promise<{ prospect: Prospect; duplicateWarning: { id: string; companyName: string } | null }> {
  const res = await authFetch("/api/recruiting/prospects", { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not create prospect (${res.status}).`);
  return res.json();
}
export async function updateProspect(input: { id: string } & Partial<Prospect>): Promise<Prospect> {
  const res = await authFetch("/api/recruiting/prospects", { method: "PATCH", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not update prospect (${res.status}).`);
  return (await res.json()).prospect;
}
export async function getProspect(id: string): Promise<Prospect & { activities: Activity[]; tasks: Task[] }> {
  const res = await authFetch(`/api/recruiting/prospects/${id}`);
  if (!res.ok) throw new Error(`Could not load prospect (${res.status}).`);
  return (await res.json()).prospect;
}
export async function logActivity(id: string, input: { activityType: "NOTE" | "CALL" | "EMAIL" | "SMS"; notes?: string; nextFollowUpAt?: string }): Promise<void> {
  const res = await authFetch(`/api/recruiting/prospects/${id}`, { method: "POST", body: JSON.stringify(input) });
  if (!res.ok) throw new Error(`Could not log activity (${res.status}).`);
}
export async function lookupFmcsa(id: string): Promise<{ state: string; checkedAt: string }> {
  const res = await authFetch(`/api/recruiting/prospects/${id}/fmcsa`);
  if (!res.ok) throw new Error(`FMCSA lookup failed (${res.status}).`);
  return res.json();
}
export async function inviteProspect(id: string): Promise<void> {
  const res = await authFetch(`/api/recruiting/prospects/${id}/invite`, { method: "POST" });
  if (res.status === 428) throw new Error("This prospect needs a contact email before you can invite them.");
  if (!res.ok) throw new Error(`Invite failed (${res.status}).`);
}
export async function getDashboard(): Promise<Dashboard> {
  const res = await authFetch("/api/recruiting/dashboard");
  if (!res.ok) throw new Error(`Could not load dashboard (${res.status}).`);
  return res.json();
}
