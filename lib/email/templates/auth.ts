import { baseLayout, button, APP_URL } from "./base";

export function emailVerificationTemplate({ name, verifyUrl }: { name: string; verifyUrl: string }) {
  return {
    subject: "Verify your TempMovers email",
    html: baseLayout(`<h1 style="font-size:18px;">Verify your email</h1><p>Hi ${name},</p><p>Confirm this is your email address to finish setting up your TempMovers account.</p>${button(verifyUrl, "Verify email")}<p style="color:#637089;font-size:12px;">If you didn't create a TempMovers account, you can ignore this email.</p>`),
    text: `Verify your TempMovers email: ${verifyUrl}`,
  };
}

export function passwordResetTemplate({ name, resetUrl }: { name: string; resetUrl: string }) {
  return {
    subject: "Reset your TempMovers password",
    html: baseLayout(`<h1 style="font-size:18px;">Reset your password</h1><p>Hi ${name},</p><p>We received a request to reset your password. This link expires in 60 minutes.</p>${button(resetUrl, "Reset password")}<p style="color:#637089;font-size:12px;">If you didn't request this, you can safely ignore this email — your password won't change.</p>`),
    text: `Reset your TempMovers password: ${resetUrl}`,
  };
}

export function adminEscalationTemplate({ subject, detail, entityUrl }: { subject: string; detail: string; entityUrl?: string }) {
  return {
    subject: `[Action needed] ${subject}`,
    html: baseLayout(`<h1 style="font-size:18px;">${subject}</h1><p>${detail}</p>${entityUrl ? button(entityUrl, "Review in admin") : ""}`),
    text: `${subject}\n\n${detail}${entityUrl ? `\n\n${entityUrl}` : ""}`,
  };
}
