const APP_URL = process.env.NEXT_PUBLIC_APP_URL ?? "https://tempmovers.com";

export function baseLayout(bodyHtml: string): string {
  return `
  <div style="font-family:Inter,Helvetica,Arial,sans-serif;background:#f4f7fb;padding:32px 0;">
    <div style="max-width:520px;margin:0 auto;background:white;border-radius:16px;overflow:hidden;border:1px solid #dce4ef;">
      <div style="background:#0d1a2e;padding:20px 28px;">
        <span style="color:white;font-weight:900;font-size:16px;letter-spacing:-.02em;">TempMovers</span>
      </div>
      <div style="padding:28px;color:#112038;font-size:14px;line-height:1.6;">
        ${bodyHtml}
      </div>
      <div style="padding:18px 28px;border-top:1px solid #dce4ef;color:#637089;font-size:12px;">
        TempMovers · <a href="${APP_URL}" style="color:#246bfd;">tempmovers.com</a>
      </div>
    </div>
  </div>`;
}

export function button(href: string, label: string): string {
  return `<p style="margin:20px 0;"><a href="${href}" style="background:#246bfd;color:white;padding:11px 20px;border-radius:8px;text-decoration:none;font-weight:700;font-size:13px;display:inline-block;">${label}</a></p>`;
}

export { APP_URL };
