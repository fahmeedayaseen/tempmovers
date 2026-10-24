/**
 * Pure invitation-template token substitution — deliberately in its own
 * file with ZERO db/prisma/notification imports, so it's importable from
 * tests without instantiating PrismaClient (which can't be generated in
 * this sandbox). Same reasoning that put post-load-schema.ts in its own
 * file. lib/loads/invite-driver.ts re-exports renderInvitationTemplate
 * from here so existing importers don't need to change.
 */
export type RenderedTemplate = { subject: string; body: string };

const TOKEN_PATTERN = /\{(driverName|loadTitle|pickupDate|expiresAt)\}/g;

/**
 * Substitutes the fixed, documented token set into a template's raw
 * subject/body. Unknown `{tokens}` are left as-is rather than silently
 * stripped — better a customer notices a literal `{typo}` in a preview
 * than have it vanish invisibly.
 */
export function renderInvitationTemplate(
  raw: { subject: string; body: string },
  tokens: { driverName: string; loadTitle: string; pickupDate: Date; expiresAt: Date }
): RenderedTemplate {
  const values: Record<string, string> = {
    driverName: tokens.driverName,
    loadTitle: tokens.loadTitle,
    pickupDate: tokens.pickupDate.toLocaleString(),
    expiresAt: tokens.expiresAt.toLocaleString(),
  };
  const substitute = (text: string) => text.replace(TOKEN_PATTERN, (_, key: string) => values[key] ?? `{${key}}`);
  return { subject: substitute(raw.subject), body: substitute(raw.body) };
}
