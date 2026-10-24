/**
 * Phase 5.5B — portfolio cleanup runner.
 *
 * ⚠️ NEVER EXECUTED IN THIS ENVIRONMENT. Requires a migrated database and
 * a real object-storage bucket. This stands in for a scheduler the
 * codebase does not yet have; wire it to a real cron/queue in 5.5B infra
 * work. Treat as "should work given the code," not "verified working."
 *
 * Run: npx tsx scripts/portfolio-cleanup.ts
 * Env: DATABASE_URL (migrated), AWS_S3_BUCKET / AWS_REGION configured.
 */
import { runPortfolioCleanup } from "@/lib/portfolio/cleanup-job";

async function main() {
  const started = Date.now();
  const outcome = await runPortfolioCleanup(new Date());
  // eslint-disable-next-line no-console
  console.log(JSON.stringify({ ...outcome, ms: Date.now() - started }, null, 2));
  if (outcome.failed > 0) process.exitCode = 1; // non-zero so a scheduler can alert
}

main().catch((e) => {
  // eslint-disable-next-line no-console
  console.error("portfolio-cleanup failed:", e);
  process.exit(1);
});
