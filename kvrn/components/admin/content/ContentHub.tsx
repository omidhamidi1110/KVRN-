'use client'
// /admin/content — one place to edit the storefront's text: policies, size guides, reusable blocks,
// FAQ, pages, About & Contact, announcement bar, navigation, footer, collections and site SEO.
//
// The open tab and item live in the URL (?tab=policies&id=terms) so a link or a reload lands in
// the same place. Nothing edited here is public until it is published (collections and SEO apply on save).

import { useCallback, useEffect, useState } from 'react'
import { AdminPageHeader, AdminTabs, AdminNotice } from '@/components/admin/ui/AdminUI'
import { SINGLETON, type Kind } from './api'
import { ListPanel } from './ListPanel'
import { EntityEditor } from './EntityEditor'
import { CollectionsPanel } from './CollectionsPanel'
import { SeoPanel } from './SeoPanel'
import { LanguagesPanel } from './LanguagesPanel'
import { PolicyAuditPanel } from './PolicyAuditPanel'
import { MessagingPoliciesCard } from './MessagingPoliciesCard'

export type HubTab =
  | 'policies' | 'size-guides' | 'size-guide-page' | 'blocks' | 'faq' | 'pages' | 'about-contact'
  | 'announcement' | 'navigation' | 'footer' | 'collections' | 'seo' | 'languages'

export const HUB_TABS: Array<{ id: HubTab; label: string }> = [
  { id: 'policies', label: 'Policies' },
  { id: 'size-guides', label: 'Size guides' },
  { id: 'size-guide-page', label: 'Size guide page' },
  { id: 'blocks', label: 'Content blocks' },
  { id: 'faq', label: 'FAQ' },
  { id: 'pages', label: 'Pages' },
  { id: 'about-contact', label: 'About & Contact' },
  { id: 'announcement', label: 'Announcement' },
  { id: 'navigation', label: 'Navigation' },
  { id: 'footer', label: 'Footer' },
  { id: 'collections', label: 'Collections' },
  { id: 'seo', label: 'Site SEO' },
  { id: 'languages', label: 'Languages & currency' },
]

const LIST_KIND: Partial<Record<HubTab, Kind>> = { policies: 'policies', 'size-guides': 'size-guides', blocks: 'blocks', pages: 'pages' }
const SINGLE_KIND: Partial<Record<HubTab, Kind>> = {
  'size-guide-page': 'support-pages', faq: 'faq', announcement: 'announcement', navigation: 'navigation', footer: 'footer',
}
const DESCRIPTION: Record<HubTab, string> = {
  policies: 'Terms, Privacy, Shipping & Returns, Cookies and any other legal page.',
  'size-guides': 'Reusable size charts. Assign one to each product from the product editor.',
  'size-guide-page': 'The text on the Size Guide page: how to measure, fit notes.',
  blocks: 'Pieces of content you can reuse inside policies and pages.',
  faq: 'Questions and answers on the Help page.',
  pages: 'Extra pages such as Care or Sustainability.',
  'about-contact': 'The text on the About and Contact pages.',
  announcement: 'The bar at the very top of every page.',
  navigation: 'The links in the header and the mobile menu.',
  footer: 'The footer columns, links and social profiles.',
  collections: 'Product groupings with their own pages.',
  seo: 'Search and sharing defaults for the whole site.',
  languages: 'Which languages and display currencies the storefront offers, and what customers are charged in.',
}

function readUrl(): { tab: HubTab; id: string | null } {
  if (typeof window === 'undefined') return { tab: 'policies', id: null }
  const p = new URLSearchParams(window.location.search)
  const t = p.get('tab') as HubTab | null
  const id = p.get('id')
  return { tab: HUB_TABS.some(x => x.id === t) ? t! : 'policies', id: id && /^[A-Za-z0-9_-]{1,64}$/.test(id) ? id : null }
}

export function ContentHub() {
  const [tab, setTab] = useState<HubTab>('policies')
  const [id, setId] = useState<string | null>(null)
  const [ready, setReady] = useState(false)
  const [refresh, setRefresh] = useState(0)

  useEffect(() => { const u = readUrl(); setTab(u.tab); setId(u.id); setReady(true) }, [])
  useEffect(() => {
    const h = () => { const u = readUrl(); setTab(u.tab); setId(u.id) }
    window.addEventListener('popstate', h); return () => window.removeEventListener('popstate', h)
  }, [])

  const go = useCallback((t: HubTab, nextId: string | null, push = true) => {
    setTab(t); setId(nextId)
    const p = new URLSearchParams({ tab: t }); if (nextId) p.set('id', nextId)
    const url = `${window.location.pathname}?${p}`
    if (push) window.history.pushState(null, '', url); else window.history.replaceState(null, '', url)
  }, [])

  const bump = () => setRefresh(n => n + 1)
  if (!ready) return null

  const listKind = LIST_KIND[tab]
  const singleKind = SINGLE_KIND[tab]

  return (
    <div>
      <AdminPageHeader title="Site content" description="Edit the storefront’s text without code." eyebrow="Content" />
      <AdminTabs<HubTab> ariaLabel="Content sections" value={tab} onChange={t => go(t, null)} tabs={HUB_TABS} />
      <p className="-mt-2 mb-4 text-[12px] text-[#6B6B66]">{DESCRIPTION[tab]}</p>

      {(tab === 'policies' || tab === 'faq') && !id && <PolicyAuditPanel />}
      {tab === 'policies' && !id && <MessagingPoliciesCard onOpen={nid => go('policies', nid)} />}

      {listKind && (id
        ? <EntityEditor key={`${listKind}:${id}`} kind={listKind} id={id} onClose={() => { go(tab, null); bump() }}
            onCreated={nid => go(tab, nid, false)} onChanged={bump} />
        : <ListPanel kind={listKind} onOpen={nid => go(tab, nid)} refreshKey={refresh} />)}

      {singleKind && <EntityEditor key={singleKind} kind={singleKind} id={SINGLETON[singleKind]!} onCreated={() => {}} />}

      {tab === 'about-contact' && (
        <div className="space-y-4">
          <SubTabs value={id === 'contact' ? 'contact' : 'about'} onChange={v => go(tab, v === 'about' ? null : v, false)} />
          {id === 'contact'
            ? <EntityEditor key="contact" kind="contact" id="main" onCreated={() => {}} />
            : <EntityEditor key="about" kind="about" id="main" onCreated={() => {}} />}
        </div>
      )}

      {tab === 'collections' && <CollectionsPanel key="collections" initialId={id} onOpenChange={nid => go('collections', nid)} />}
      {tab === 'seo' && <SeoPanel />}
      {tab === 'languages' && <LanguagesPanel />}

      {tab === 'navigation' && (
        <AdminNotice tone="info" className="mt-4">The header and footer must keep links to Shop and Contact. The footer must also keep Shipping & Returns, Privacy, Terms and Cookies. Publishing is blocked if one is missing.</AdminNotice>
      )}
    </div>
  )
}

function SubTabs({ value, onChange }: { value: 'about' | 'contact'; onChange: (v: 'about' | 'contact') => void }) {
  return <AdminTabs<'about' | 'contact'> ariaLabel="About or Contact" value={value} onChange={onChange} tabs={[{ id: 'about', label: 'About page' }, { id: 'contact', label: 'Contact page' }]} />
}
