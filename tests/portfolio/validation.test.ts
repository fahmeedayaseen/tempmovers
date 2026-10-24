import { describe, it, expect } from "vitest";
import {
  isAllowedMime, extensionForMime, signatureMatchesMime, validatePresign, validateBatchSize, validateDimensions,
  PORTFOLIO_MAX_BYTES, PORTFOLIO_MAX_BATCH, PORTFOLIO_MAX_ACTIVE,
} from "@/lib/portfolio/validation";

describe("mime allow-list", () => {
  it("accepts jpeg/png/webp", () => {
    expect(isAllowedMime("image/jpeg")).toBe(true);
    expect(isAllowedMime("image/png")).toBe(true);
    expect(isAllowedMime("image/webp")).toBe(true);
  });
  it("rejects everything else", () => {
    for (const m of ["image/gif", "image/heic", "image/tiff", "image/svg+xml", "application/pdf", "text/html"]) {
      expect(isAllowedMime(m)).toBe(false);
    }
  });
  it("maps mime to extension", () => {
    expect(extensionForMime("image/jpeg")).toBe("jpg");
    expect(extensionForMime("image/png")).toBe("png");
    expect(extensionForMime("image/webp")).toBe("webp");
  });
});

describe("signatureMatchesMime (5.5B logic, tested now)", () => {
  it("matches a JPEG magic header", () => {
    expect(signatureMatchesMime(new Uint8Array([0xff, 0xd8, 0xff, 0x00]), "image/jpeg")).toBe(true);
  });
  it("matches a PNG magic header", () => {
    expect(signatureMatchesMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), "image/png")).toBe(true);
  });
  it("matches a WEBP RIFF/WEBP header", () => {
    const webp = new Uint8Array([0x52, 0x49, 0x46, 0x46, 0, 0, 0, 0, 0x57, 0x45, 0x42, 0x50]);
    expect(signatureMatchesMime(webp, "image/webp")).toBe(true);
  });
  it("rejects a mismatched header (png bytes declared as jpeg)", () => {
    expect(signatureMatchesMime(new Uint8Array([0x89, 0x50, 0x4e, 0x47]), "image/jpeg")).toBe(false);
  });
  it("rejects an SVG/text payload renamed as an image", () => {
    const svg = new TextEncoder().encode("<svg xmlns=");
    expect(signatureMatchesMime(svg, "image/png")).toBe(false);
    expect(signatureMatchesMime(svg, "image/jpeg")).toBe(false);
  });
  it("rejects truncated data too short to contain a signature", () => {
    expect(signatureMatchesMime(new Uint8Array([0xff]), "image/jpeg")).toBe(false);
  });
});

describe("validatePresign", () => {
  it("accepts a valid image within limits and count", () => {
    const r = validatePresign({ mimeType: "image/png", contentLength: 1000, currentActiveCount: 0 });
    expect(r.ok).toBe(true);
  });
  it("rejects a disallowed type", () => {
    expect(validatePresign({ mimeType: "application/pdf", contentLength: 10, currentActiveCount: 0 }).ok).toBe(false);
  });
  it("rejects empty and oversized files", () => {
    expect(validatePresign({ mimeType: "image/png", contentLength: 0, currentActiveCount: 0 }).ok).toBe(false);
    expect(validatePresign({ mimeType: "image/png", contentLength: PORTFOLIO_MAX_BYTES + 1, currentActiveCount: 0 }).ok).toBe(false);
  });
  it("rejects when the portfolio is already full", () => {
    expect(validatePresign({ mimeType: "image/png", contentLength: 10, currentActiveCount: PORTFOLIO_MAX_ACTIVE }).ok).toBe(false);
  });
});

describe("validateBatchSize", () => {
  it("accepts 1..max", () => {
    expect(validateBatchSize(1).ok).toBe(true);
    expect(validateBatchSize(PORTFOLIO_MAX_BATCH).ok).toBe(true);
  });
  it("rejects 0 and over-max", () => {
    expect(validateBatchSize(0).ok).toBe(false);
    expect(validateBatchSize(PORTFOLIO_MAX_BATCH + 1).ok).toBe(false);
  });
});

describe("validateDimensions", () => {
  it("tolerates unknown dimensions", () => {
    expect(validateDimensions(null, null).ok).toBe(true);
  });
  it("accepts sane dimensions", () => {
    expect(validateDimensions(1920, 1080).ok).toBe(true);
  });
  it("rejects zero/negative and absurd (bomb) dimensions", () => {
    expect(validateDimensions(0, 100).ok).toBe(false);
    expect(validateDimensions(100, 999999).ok).toBe(false);
  });
});
