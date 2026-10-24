import * as Sentry from "@sentry/nextjs";

Sentry.init({
  dsn: process.env.NEXT_PUBLIC_SENTRY_DSN,
  tracesSampleRate: 0.2,
  // Session replay is deliberately off — this app handles payment and
  // identity-document flows; recording user sessions by default would be
  // a privacy decision that needs its own sign-off, not a default.
  environment: process.env.NODE_ENV,
});
