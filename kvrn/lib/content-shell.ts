// lib/content-shell.ts — types + pure resolution helpers for the global shell
// (navigation, footer, announcement bar). Shared by the server loader and the client
// components. PURE: no DB, no React, no server-only imports.
//
// The shell data object is built on the server and handed to the client components as props;
// the CLIENT picks the visitor's locale (the storefront locale lives in localStorage).
// Label resolution order for a locale:
//   1. a PUBLISHED translation written in Admin            (tr[locale]["link.<id>.label"])
//   2. the storefront dictionary key a seeded link keeps    (only while its English label is unchanged)
//   3. the English label                                    (never presented as translated)

import type { NavigationSnapshot, FooterSnapshot, AnnouncementSnapshot, NavLink, I18nKey } from './content-schemas'
import { isAnnouncementActive } from './content-schemas'

export type TrMap = Record<string, Record<string, string>>   // locale → field → value

export interface ShellData {
  navigation: NavigationSnapshot | null
  footer: FooterSnapshot | null
  announcement: (AnnouncementSnapshot & { id: string }) | null
  tr: { navigation: TrMap; footer: TrMap; announcement: TrMap }
}

export const EMPTY_TR = { navigation: {}, footer: {}, announcement: {} }

type Dict = Partial<Record<I18nKey, string>> | Record<string, string> | undefined

function fromDict(key: I18nKey | undefined, enLabel: string | undefined, label: string, dict: Dict): string | null {
  if (!key || !dict || enLabel === undefined || label !== enLabel) return null
  const v = (dict as Record<string, string>)[key]
  return typeof v === 'string' && v ? v : null
}

export function resolveLinkLabel(link: Pick<NavLink, 'id' | 'label' | 'i18nKey' | 'i18nEn'>, locale: string, tr: TrMap | undefined, dict?: Dict): string {
  if (locale !== 'en') {
    const t = tr?.[locale]?.[`link.${link.id}.label`]
    if (t) return t
    const d = fromDict(link.i18nKey, link.i18nEn, link.label, dict)
    if (d) return d
  }
  return link.label
}

export function resolveGroupHeading(g: { id: string; heading: string; i18nKey?: I18nKey; i18nEn?: string }, locale: string, tr: TrMap | undefined, dict?: Dict): string {
  if (locale !== 'en') {
    const t = tr?.[locale]?.[`group.${g.id}`]
    if (t) return t
    const d = fromDict(g.i18nKey, g.i18nEn, g.heading, dict)
    if (d) return d
  }
  return g.heading
}

export function resolveText(field: string, source: string, locale: string, tr: TrMap | undefined): string {
  if (locale === 'en') return source
  return tr?.[locale]?.[field] || source
}

/** `© {year} {holder}. {suffix}` — the suffix defaults to the storefront's translated "All rights reserved." */
export function copyrightLine(f: Pick<FooterSnapshot, 'copyrightHolder' | 'copyrightSuffix'>, year: number, locale: string, tr: TrMap | undefined, dict?: Dict): string {
  const suffix = f.copyrightSuffix
    ? resolveText('copyrightSuffix', f.copyrightSuffix, locale, tr)
    : ((dict as Record<string, string> | undefined)?.allRightsReserved ?? 'All rights reserved.')
  return `© ${year} ${f.copyrightHolder}. ${suffix}`
}

/** Messages to rotate right now (empty ⇒ show the quiet empty strip). */
export function activeAnnouncementMessages(a: ShellData['announcement'], locale: string, tr: TrMap | undefined, now: Date): Array<{ id: string; text: string; href?: string }> {
  if (!a || !isAnnouncementActive(a, now)) return []
  return a.messages.map(m => ({ id: m.id, href: m.href, text: resolveText(`msg.${m.id}.text`, m.text, locale, tr) }))
}
