import { describe, expect, it } from "vitest";
import { canTakeJunkJobs, canTakeMovingJobs, junkCrewRoleFor, junkSeats, screeningRoleFor } from "@/lib/junk/crew";
import { isKeyUnder, junkBookingPhotoPrefix, junkProofPrefix } from "@/lib/junk/storage-keys";

// Junk removal — VASRUE Digital Media, 28 October 2026. Both worker paths from
// Carl's junk spec §2, the fee mapping from §7a, and the seat cap that keeps a
// junk crew to one hauler plus the helpers the booking called for.

describe("who can take junk jobs", () => {
  it("lets junk-only accounts in by type, and existing workers only once opted in", () => {
    expect(canTakeJunkJobs({ workerType: "JUNK_HAULER", junkRemovalEnabled: false })).toBe(true);
    expect(canTakeJunkJobs({ workerType: "JUNK_HELPER", junkRemovalEnabled: false })).toBe(true);
    expect(canTakeJunkJobs({ workerType: "MOVER", junkRemovalEnabled: false })).toBe(false);
    expect(canTakeJunkJobs({ workerType: "MOVER", junkRemovalEnabled: true })).toBe(true);
    expect(canTakeJunkJobs({ workerType: "BOX_TRUCK_DRIVER", junkRemovalEnabled: true })).toBe(true);
    expect(canTakeJunkJobs({ workerType: "SEMI_DRIVER", junkRemovalEnabled: true })).toBe(false);
  });

  it("keeps moving work mover-only, so junk-only helpers never see it", () => {
    expect(canTakeMovingJobs("MOVER")).toBe(true);
    expect(canTakeMovingJobs("JUNK_HELPER")).toBe(false);
  });

  it("seats truck owners as haulers and labor as helpers", () => {
    expect(junkCrewRoleFor("BOX_TRUCK_DRIVER")).toBe("HAULER");
    expect(junkCrewRoleFor("JUNK_HAULER")).toBe("HAULER");
    expect(junkCrewRoleFor("MOVER")).toBe("HELPER");
    expect(junkCrewRoleFor("JUNK_HELPER")).toBe("HELPER");
    expect(junkCrewRoleFor("SEMI_DRIVER")).toBeNull();
  });

  it("screens junk workers under the existing packages, never a junk-specific one", () => {
    expect(screeningRoleFor("JUNK_HAULER")).toBe("BOX_TRUCK_DRIVER");
    expect(screeningRoleFor("JUNK_HELPER")).toBe("MOVER");
    expect(screeningRoleFor("MOVER")).toBe("MOVER");
  });
});

describe("junk crew seats", () => {
  it("is full only with a hauler and every helper the booking asked for", () => {
    expect(junkSeats({ helpersRequired: 1, filledRoles: [] })).toEqual({ haulerOpen: true, helpersOpen: 1, full: false });
    expect(junkSeats({ helpersRequired: 1, filledRoles: ["HELPER"] })).toEqual({ haulerOpen: true, helpersOpen: 0, full: false });
    expect(junkSeats({ helpersRequired: 1, filledRoles: ["HELPER", "HAULER"] }).full).toBe(true);
    expect(junkSeats({ helpersRequired: 0, filledRoles: ["HAULER"] }).full).toBe(true);
  });
});

describe("junk upload keys", () => {
  it("accepts only keys issued under the right customer or job", () => {
    const id = "123e4567-e89b-12d3-a456-426614174000";
    expect(isKeyUnder(`${junkBookingPhotoPrefix("cust1")}${id}.jpg`, junkBookingPhotoPrefix("cust1"))).toBe(true);
    expect(isKeyUnder(`${junkBookingPhotoPrefix("cust2")}${id}.jpg`, junkBookingPhotoPrefix("cust1"))).toBe(false);
    expect(isKeyUnder(`${junkProofPrefix("job1", "BEFORE")}../../x.jpg`, junkProofPrefix("job1", "BEFORE"))).toBe(false);
    expect(isKeyUnder(`${junkProofPrefix("job1", "DUMP_RECEIPT")}${id}.pdf`, junkProofPrefix("job1", "DUMP_RECEIPT"))).toBe(true);
  });
});
