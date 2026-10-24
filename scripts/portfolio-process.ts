/**
 * Phase 5.5B — portfolio image-processing runner (with stale recovery).
 *
 * ⚠️ NEVER EXECUTED HERE. Requires a migrated DB, real object storage, and
 * the sharp native binary, with PORTFOLIO_IMAGE_PROCESSING=on.
 *
 * SCHEDULER WIRING (recommendation 2): this script is the unit of work. It
 * is intentionally idempotent and safe to invoke repeatedly, so it can be
 * driven by ANY recurring executor the team already runs — pick one:
 *   • cron:            * /5 * * * *  cd app && npm run portfolio-process   (every 5 min)
 *   • container CronJob (k8s), ECS scheduled task, or a systemd timer
 *   • a queue worker that calls runProcessingBatch()/runProcessingRecovery() in a loop
 * Do NOT rely on manual execution in production. Wiring to the team's actual
 * mechanism is the remaining infra step; this file deliberately does not
 * assume which one.
 *
 * Each run first RECOVERS stale jobs (workers that died mid-process), then
 * processes a batch of PENDING items.
 *
 * Run manually: npx tsx scripts/portfolio-process.ts
 */
import { runProcessingBatch, runProcessingRecovery } from "@/lib/portfolio/processing-job";
import { imageProcessingEnabled } from "@/lib/portfolio/feature-flags";

async function main() {
  if (!imageProcessingEnabled()) {
    // eslint-disable-next-line no-console
    console.error("PORTFOLIO_IMAGE_PROCESSING is not 'on' — refusing to run.");
    process.exit(2);
  }
  const started = Date.now();
  const recovery = await runProcessingRecovery(new Date());
  const batch = await runProcessingBatch(Number(process.env.PORTFOLIO_PROCESS_LIMIT ?? 20));
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ recovery, batch, ms: Date.now() - started }, null, 2));
  if (batch.failed > 0 || recovery.failed > 0) process.exitCode = 1;
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("portfolio-process failed:", e);
  process.exit(1);
});
