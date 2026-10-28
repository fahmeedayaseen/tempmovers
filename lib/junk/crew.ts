import type { JunkCrewRole, WorkerType } from "@prisma/client";

// ---------------------------------------------------------------------------
// Junk removal crew rules — VASRUE Digital Media, 28 October 2026.
//
// Carl's junk spec §2 and §7a: a junk crew is a hauler (brings and drives the
// box truck) plus 0–2 helpers (labor only). Two ways into the junk job pool:
//   (a) capability opt-in — an existing mover or box-truck driver switches on
//       WorkerProfile.junkRemovalEnabled and keeps their other work;
//   (b) a junk-only account — JUNK_HAULER or JUNK_HELPER — which sees junk
//       jobs and nothing else.
// Junk workers pay the existing fees mapped by role, never a junk-specific
// plan: a hauler is on Driver Basic with the box-truck screening package, a
// helper on the Mover plan with the mover package.
// ---------------------------------------------------------------------------

export function isJunkOnlyWorkerType(workerType: WorkerType): boolean {
  return workerType === "JUNK_HAULER" || workerType === "JUNK_HELPER";
}

/** The crew seat a worker fills on a junk job, or null if their type can never take one (semi drivers). */
export function junkCrewRoleFor(workerType: WorkerType): JunkCrewRole | null {
  if (workerType === "JUNK_HAULER" || workerType === "BOX_TRUCK_DRIVER") return "HAULER";
  if (workerType === "JUNK_HELPER" || workerType === "MOVER") return "HELPER";
  return null;
}

export function canTakeJunkJobs(worker: { workerType: WorkerType; junkRemovalEnabled: boolean }): boolean {
  if (isJunkOnlyWorkerType(worker.workerType)) return true;
  return junkCrewRoleFor(worker.workerType) !== null && worker.junkRemovalEnabled;
}

/** Moving labor stays mover-only, exactly as before junk existed. */
export function canTakeMovingJobs(workerType: WorkerType): boolean {
  return workerType === "MOVER";
}

/** Which Checkr package a worker type is screened under (spec §7a). */
export function screeningRoleFor(workerType: WorkerType): "MOVER" | "BOX_TRUCK_DRIVER" | "SEMI_DRIVER" {
  if (workerType === "JUNK_HAULER") return "BOX_TRUCK_DRIVER";
  if (workerType === "JUNK_HELPER") return "MOVER";
  return workerType;
}

/** Where a junk crew stands: who is on it, and which seats are still open. */
export function junkSeats(input: { helpersRequired: number; filledRoles: (JunkCrewRole | null)[] }) {
  const haulers = input.filledRoles.filter((r) => r === "HAULER").length;
  const helpers = input.filledRoles.filter((r) => r === "HELPER").length;
  const haulerOpen = haulers < 1;
  const helpersOpen = Math.max(0, input.helpersRequired - helpers);
  return { haulerOpen, helpersOpen, full: !haulerOpen && helpersOpen === 0 };
}

// Assignment statuses that hold a seat on the crew.
export const JUNK_SEAT_HOLDING_STATUSES = ["ACCEPTED", "CHECKED_IN", "CHECKED_OUT", "APPROVED"] as const;
