import { describe, it, expect } from "vitest";
import { assembleHealthRow } from "@/lib/integrations/health";

const now = new Date("2026-08-01T00:00:00Z");

describe("assembleHealthRow — states", () => {
  it("disabled provider shows DISABLED and fabricates nothing", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "FREIGHT_BOARD_SYNC_DAT", enabled: false }, now);
    expect(r.state).toBe("DISABLED");
    expect(r.connected).toBe(false);
    expect(r.lastSuccessfulSyncAt).toBeNull();
    expect(r.credentialExpired).toBeNull();
  });
  it("enabled + healthy shows CONNECTED with latency + version", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, health: { ok: true }, latencyMs: 120, apiVersion: "v2" }, now);
    expect(r.state).toBe("CONNECTED");
    expect(r.latencyMs).toBe(120);
    expect(r.apiVersion).toBe("v2");
  });
  it("enabled + unhealthy shows ERROR with the real error", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, health: { ok: false, detail: "HTTP 503" }, latencyMs: 80 }, now);
    expect(r.state).toBe("ERROR");
    expect(r.lastError).toBe("HTTP 503");
    expect(r.connected).toBe(false);
  });
  it("enabled but health not run shows DISCONNECTED", () => {
    expect(assembleHealthRow({ providerKey: "x", featureKey: "k", enabled: true }, now).state).toBe("DISCONNECTED");
  });
});

describe("assembleHealthRow — adapter-reported status wins", () => {
  it("uses tracked sync + error when the adapter reports them", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, health: { ok: true }, status: { connected: true, lastSuccessfulSyncAt: "2026-07-31T23:00:00Z", lastError: "prev timeout", lastErrorAt: "2026-07-30T00:00:00Z" } }, now);
    expect(r.lastSuccessfulSyncAt).toBe("2026-07-31T23:00:00Z");
    expect(r.lastError).toBe("prev timeout");
  });
});

describe("assembleHealthRow — credential expiry", () => {
  it("future date is not expired", () => {
    expect(assembleHealthRow({ providerKey: "x", featureKey: "k", enabled: true, health: { ok: true }, status: { credentialExpiresAt: "2027-01-01T00:00:00Z" } }, now).credentialExpired).toBe(false);
  });
  it("past date is expired", () => {
    expect(assembleHealthRow({ providerKey: "x", featureKey: "k", enabled: true, health: { ok: true }, status: { credentialExpiresAt: "2026-01-01T00:00:00Z" } }, now).credentialExpired).toBe(true);
  });
  it("absent date is unknown (null), never a false positive", () => {
    expect(assembleHealthRow({ providerKey: "x", featureKey: "k", enabled: true, health: { ok: true } }, now).credentialExpired).toBeNull();
  });
});

describe("assembleHealthRow — local configuration (no network, works when disabled)", () => {
  it("disabled provider still shows CONFIGURED + environment from local config", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: false, configuration: { credentialsConfigured: true, environment: "SANDBOX", apiVersion: "v2" } }, now);
    expect(r.state).toBe("DISABLED");
    expect(r.configStatus).toBe("CONFIGURED");
    expect(r.environment).toBe("SANDBOX");
    expect(r.apiVersion).toBe("v2");
    expect(r.connected).toBe(false);
    expect(r.lastSuccessfulSyncAt).toBeNull();
  });
  it("disabled + missing creds shows MISSING_CREDENTIALS", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: false, configuration: { credentialsConfigured: false } }, now);
    expect(r.configStatus).toBe("MISSING_CREDENTIALS");
  });
  it("local config precedes but live status still merges when enabled", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, configuration: { credentialsConfigured: true, environment: "PRODUCTION" }, health: { ok: true }, status: { connected: true, lastSuccessfulSyncAt: "2026-07-31T00:00:00Z" } }, now);
    expect(r.state).toBe("CONNECTED");
    expect(r.environment).toBe("PRODUCTION");
    expect(r.lastSuccessfulSyncAt).toBe("2026-07-31T00:00:00Z");
  });
  it("no config and no status stays UNKNOWN / null", () => {
    const r = assembleHealthRow({ providerKey: "x", featureKey: "k", enabled: false }, now);
    expect(r.configStatus).toBe("UNKNOWN");
    expect(r.environment).toBeNull();
  });
});

describe("assembleHealthRow — diagnostic fields (env, config, codes, failures)", () => {
  it("reports configured + sandbox environment when tracked", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, health: { ok: true }, status: { credentialsConfigured: true, environment: "SANDBOX" } }, now);
    expect(r.configStatus).toBe("CONFIGURED");
    expect(r.environment).toBe("SANDBOX");
  });
  it("maps credentialsConfigured:false to MISSING_CREDENTIALS", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, status: { credentialsConfigured: false } }, now);
    expect(r.configStatus).toBe("MISSING_CREDENTIALS");
  });
  it("passes through response codes and consecutive failure count", () => {
    const r = assembleHealthRow({ providerKey: "DAT", featureKey: "k", enabled: true, health: { ok: false, detail: "HTTP 503" }, status: { lastSuccessCode: 200, lastFailureCode: 503, consecutiveFailures: 3 } }, now);
    expect(r.lastSuccessCode).toBe(200);
    expect(r.lastFailureCode).toBe(503);
    expect(r.consecutiveFailures).toBe(3);
    expect(r.state).toBe("ERROR");
  });
});
