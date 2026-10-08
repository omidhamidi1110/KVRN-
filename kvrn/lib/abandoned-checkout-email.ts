// lib/abandoned-checkout-email.ts — the single recovery email (pure rendering).
//
// Content rules
//   * concise; saved-bag context only: product name, size, colour, quantity
//   * NO prices (they are re-read on resume), NO address, NO phone, NO order/session ids
//   * one signed link back + an unsubscribe link; no tracking pixel (opens are not tracked)
//   * localized from a small local string table keyed by the stored locale, English fallback.
//     A locale with no strings here is sent in English — never a machine translation.

export interface RecoveryEmailLine {
  name: string
  size?: string | null
  color?: string | null
  quantity: number
}

export interface RecoveryEmailInput {
  locale: string | null | undefined
  lines: RecoveryEmailLine[]
  recoverUrl: string
  unsubscribeUrl: string
  origin: string
}

interface Strings {
  subject: string
  heading: string
  intro: string
  qty: string
  cta: string
  linkNote: string
  reason: string
  unsubscribe: string
  more: string
}

export const RECOVERY_STRINGS: Record<string, Strings> = {
  en: {
    subject: 'Your KVRN bag is saved',
    heading: 'Your bag is saved.',
    intro: 'You started checking out at KVRN. Your items are listed below. Availability and prices are confirmed again when you continue.',
    qty: 'Qty',
    cta: 'Return to your bag',
    linkNote: 'This link is personal and expires automatically.',
    reason: 'You are receiving this one-time reminder because you started a checkout at KVRN.',
    unsubscribe: 'Unsubscribe',
    more: 'and more',
  },
  es: {
    subject: 'Tu bolsa de KVRN está guardada',
    heading: 'Tu bolsa está guardada.',
    intro: 'Empezaste a pagar en KVRN. Tus artículos aparecen abajo. La disponibilidad y los precios se confirman de nuevo al continuar.',
    qty: 'Cant.',
    cta: 'Volver a tu bolsa',
    linkNote: 'Este enlace es personal y caduca automáticamente.',
    reason: 'Recibes este recordatorio único porque iniciaste un pago en KVRN.',
    unsubscribe: 'Cancelar suscripción',
    more: 'y más',
  },
  fr: {
    subject: 'Votre sac KVRN est enregistré',
    heading: 'Votre sac est enregistré.',
    intro: 'Vous avez commencé une commande sur KVRN. Vos articles sont listés ci-dessous. La disponibilité et les prix sont confirmés à nouveau lorsque vous continuez.',
    qty: 'Qté',
    cta: 'Retourner à votre sac',
    linkNote: 'Ce lien est personnel et expire automatiquement.',
    reason: 'Vous recevez ce rappel unique parce que vous avez commencé une commande sur KVRN.',
    unsubscribe: 'Se désinscrire',
    more: 'et plus',
  },
  de: {
    subject: 'Deine KVRN-Tasche ist gespeichert',
    heading: 'Deine Tasche ist gespeichert.',
    intro: 'Du hast bei KVRN mit dem Bezahlen begonnen. Deine Artikel siehst du unten. Verfügbarkeit und Preise werden beim Fortfahren erneut bestätigt.',
    qty: 'Menge',
    cta: 'Zurück zu deiner Tasche',
    linkNote: 'Dieser Link ist persönlich und läuft automatisch ab.',
    reason: 'Du erhältst diese einmalige Erinnerung, weil du bei KVRN einen Bezahlvorgang begonnen hast.',
    unsubscribe: 'Abbestellen',
    more: 'und mehr',
  },
}

export const MAX_EMAIL_LINES = 6

/** 'es-MX' / 'ES' / 'fr_CA' -> 'es' | 'fr'; anything without strings -> 'en'. */
export function resolveEmailLocale(locale: string | null | undefined): string {
  const base = String(locale ?? '').toLowerCase().split(/[-_]/)[0]
  return Object.prototype.hasOwnProperty.call(RECOVERY_STRINGS, base) ? base : 'en'
}

export function escapeHtml(s: unknown): string {
  return String(s ?? '').replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c] as string))
}

const S = {
  body:   'font-family:-apple-system,Helvetica Neue,sans-serif;color:#1A1A1A;background:#FAFAF8;margin:0;padding:0;',
  wrap:   'max-width:560px;margin:0 auto;padding:48px 24px;',
  logo:   'font-size:15px;letter-spacing:0.1em;text-transform:uppercase;font-weight:300;text-decoration:none;color:#1A1A1A;',
  h1:     'font-size:24px;font-weight:300;letter-spacing:-0.02em;margin:40px 0 8px;',
  p:      'font-size:14px;color:#6B6B6B;line-height:1.6;margin:0 0 16px;',
  rule:   'border:none;border-top:1px solid #E8E5E0;margin:28px 0;',
  item:   'font-size:14px;color:#1A1A1A;font-weight:300;margin:0 0 10px;line-height:1.5;',
  meta:   'font-size:12px;color:#9B9B9B;',
  btn:    'display:inline-block;background:#1A1A1A;color:#FFFFFF;text-decoration:none;font-size:13px;letter-spacing:0.04em;padding:14px 28px;',
  footer: 'margin-top:40px;font-size:11px;color:#9B9B9B;line-height:1.6;',
}

function clip(s: string, n: number): string {
  const t = String(s ?? '').replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n - 1) + '…' : t
}

export function recoverySubject(locale: string | null | undefined): string {
  return RECOVERY_STRINGS[resolveEmailLocale(locale)].subject
}

export function renderRecoveryEmail(input: RecoveryEmailInput): { subject: string; html: string; locale: string } {
  const locale = resolveEmailLocale(input.locale)
  const t = RECOVERY_STRINGS[locale]
  const shown = input.lines.slice(0, MAX_EMAIL_LINES)
  const hidden = input.lines.length - shown.length
  const items = shown.map(l => {
    const variant = [l.color, l.size].map(v => clip(String(v ?? ''), 40)).filter(Boolean).join(' / ')
    return `<p style="${S.item}">${escapeHtml(clip(l.name, 80))}`
      + (variant ? `<br><span style="${S.meta}">${escapeHtml(variant)} &middot; ${escapeHtml(t.qty)} ${Number(l.quantity) || 1}</span>`
                 : `<br><span style="${S.meta}">${escapeHtml(t.qty)} ${Number(l.quantity) || 1}</span>`)
      + `</p>`
  }).join('\n    ')
  const more = hidden > 0 ? `<p style="${S.meta}">+ ${hidden} ${escapeHtml(t.more)}</p>` : ''

  const html = `<!DOCTYPE html>
<html lang="${locale}">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <title>${escapeHtml(t.subject)}</title>
</head>
<body style="${S.body}">
  <div style="${S.wrap}">
    <a href="${escapeHtml(input.origin)}" style="${S.logo}">KVRN</a>
    <h1 style="${S.h1}">${escapeHtml(t.heading)}</h1>
    <p style="${S.p}">${escapeHtml(t.intro)}</p>
    <hr style="${S.rule}">
    ${items}
    ${more}
    <hr style="${S.rule}">
    <p style="margin:0 0 16px;"><a href="${escapeHtml(input.recoverUrl)}" style="${S.btn}">${escapeHtml(t.cta)}</a></p>
    <p style="${S.meta}">${escapeHtml(t.linkNote)}</p>
    <p style="${S.footer}">
      ${escapeHtml(t.reason)}<br>
      <a href="${escapeHtml(input.unsubscribeUrl)}" style="color:#9B9B9B;">${escapeHtml(t.unsubscribe)}</a>
      &middot; &copy; KVRN &middot; <a href="${escapeHtml(input.origin)}" style="color:#9B9B9B;">kvrn.shop</a>
    </p>
  </div>
</body>
</html>`
  return { subject: t.subject, html, locale }
}
