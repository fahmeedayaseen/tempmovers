import { describe, it, expect } from "vitest";
import { analyzeImageMeta, thumbnailTarget, MAX_PIXELS, MAX_DIMENSION, MAX_PIXELS_PER_BYTE, THUMBNAIL_MAX_EDGE } from "@/lib/portfolio/image-analysis";

describe("analyzeImageMeta", () => {
  const good = { width: 1920, height: 1080, byteSize: 500_000, format: "jpeg" };

  it("accepts a normal photo", () => {
    expect(analyzeImageMeta(good).ok).toBe(true);
  });
  it("rejects unreadable dimensions", () => {
    expect(analyzeImageMeta({ ...good, width: NaN }).ok).toBe(false);
  });
  it("rejects zero/negative dimensions", () => {
    expect(analyzeImageMeta({ ...good, width: 0 }).ok).toBe(false);
  });
  it("rejects an over-long side", () => {
    expect(analyzeImageMeta({ ...good, width: MAX_DIMENSION + 1, height: 10 }).ok).toBe(false);
  });
  it("rejects an over-megapixel image within side limits", () => {
    // 8000 x 6000 = 48MP > MAX_PIXELS (40MP), both sides under MAX_DIMENSION
    const r = analyzeImageMeta({ ...good, width: 8000, height: 6000, byteSize: 8_000_000 });
    expect(r.ok).toBe(false);
  });
  it("flags a decompression bomb (huge pixels, tiny bytes)", () => {
    // 5000x5000 = 25MP from a 1KB file => 25000 pixels/byte >> MAX_PIXELS_PER_BYTE
    const r = analyzeImageMeta({ width: 5000, height: 5000, byteSize: 1000, format: "png" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reason).toMatch(/decompression/i);
  });
  it("does not flag a normal-ratio image as a bomb", () => {
    // 25MP from a 2MB file => 12.5 pixels/byte, well under the gate
    expect(analyzeImageMeta({ width: 5000, height: 5000, byteSize: 2_000_000, format: "png" }).ok).toBe(true);
  });
  it("the bomb gate boundary is MAX_PIXELS_PER_BYTE", () => {
    // Construct a square within dimension+MP limits whose pixels/byte sits
    // just at the limit: pick byteSize so pixels/byteSize == MAX_PIXELS_PER_BYTE.
    const width = 3000, height = 3000; // 9MP, both sides < MAX_DIMENSION, < MAX_PIXELS
    const pixels = width * height;
    const byteSize = pixels / MAX_PIXELS_PER_BYTE; // exactly at the limit
    // exactly at limit is allowed (> is the reject condition)
    expect(analyzeImageMeta({ width, height, byteSize, format: "png" }).ok).toBe(true);
    // one byte fewer tips it over
    expect(analyzeImageMeta({ width, height, byteSize: byteSize - 1, format: "png" }).ok).toBe(false);
  });
});

describe("thumbnailTarget", () => {
  it("never upscales a small image", () => {
    expect(thumbnailTarget(100, 80)).toEqual({ width: 100, height: 80 });
  });
  it("scales a large landscape image to fit the max edge", () => {
    const t = thumbnailTarget(4000, 3000);
    expect(Math.max(t.width, t.height)).toBe(THUMBNAIL_MAX_EDGE);
    expect(t.width).toBe(400);
    expect(t.height).toBe(300);
  });
  it("scales a large portrait image to fit the max edge", () => {
    const t = thumbnailTarget(1000, 2000);
    expect(Math.max(t.width, t.height)).toBe(THUMBNAIL_MAX_EDGE);
    expect(t.height).toBe(400);
    expect(t.width).toBe(200);
  });
  it("preserves aspect ratio within rounding", () => {
    const t = thumbnailTarget(1920, 1080);
    expect(Math.abs(t.width / t.height - 1920 / 1080)).toBeLessThan(0.02);
  });
});

// Sanity: the module's public constants are the ones the tests assume.
describe("constants", () => {
  it("MAX_PIXELS is 40MP", () => expect(MAX_PIXELS).toBe(40_000_000));
});
