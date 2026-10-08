'use client'
// One form per content kind. Each receives the working snapshot and reports the whole next
// snapshot; the editor shell owns autosave, publishing, versions and translations.

import { useMemo, useState, type ReactNode } from 'react'
import { AdminCard, AdminSectionHeader, AdminNotice, AdminButton, adminInputClass } from '@/components/admin/ui/AdminUI'
import { TextInput, Toggle, Select, ListEditor, MediaField, SeoForm, cx } from './ui'
import { RichTextEditor, type BlockChoice } from './RichTextEditor'
import { newId, type Kind } from './api'
import { slugify } from '@/lib/content-urls'
import { policyPath, LEGACY_POLICY_PATHS, BLOCK_CATEGORIES, REQUIRED_NAV_PATHS, REQUIRED_FOOTER_PATHS } from '@/lib/content-schemas'
import type {
  PolicySnapshot, SizeGuideSnapshot, ContentBlockSnapshot, FaqSnapshot, PageSnapshot, AboutSnapshot, ContactSnapshot,
  SupportPageSnapshot, AnnouncementSnapshot, AnnouncementMessage, NavigationSnapshot, FooterSnapshot, NavLink,
} from '@/lib/content-schemas'
import type { RichText } from '@/lib/content-richtext'

export interface FormProps<T> { value: T; onChange: (v: T) => void; blockChoices?: BlockChoice[]; entityId?: string; isNew?: boolean }

const emptyRich = (): RichText => ({ v: 1, blocks: [] })
const Section = ({ title, description, children }: { title: string; description?: string; children: ReactNode }) => (
  <AdminCard className="space-y-3"><AdminSectionHeader title={title} description={description} />{children}</AdminCard>
)

// ── templates for "New" ───────────────────────────────────────────────────────

export const NEW_SNAPSHOT: Partial<Record<Kind, () => any>> = {
  policies: (): PolicySnapshot => ({ slug: '', title: '', style: 'legal', body: emptyRich(), seo: {} }),
  pages: (): PageSnapshot => ({ slug: '', title: '', body: emptyRich(), navEligible: false, seo: {} }),
  blocks: (): ContentBlockSnapshot => ({ name: '', category: 'care', content: emptyRich() }),
  'size-guides': (): SizeGuideSnapshot => ({
    name: '', garment: '', unit: 'cm', rowHeader: 'Size', columns: [{ id: 'c1', label: 'Length' }],
    rows: [{ id: 'r1', label: 'S', values: { c1: '' } }], notes: [], fit: emptyRich(), showOnGuidePage: false, order: 10,
  }),
}

// ── policies ──────────────────────────────────────────────────────────────────

export function PolicyForm({ value: v, onChange, blockChoices, entityId, isNew }: FormProps<PolicySnapshot>) {
  const set = (p: Partial<PolicySnapshot>) => onChange({ ...v, ...p })
  const legacy = entityId ? LEGACY_POLICY_PATHS[entityId] : undefined
  const path = v.slug ? policyPath(entityId ?? 'new', v.slug) : '/legal/…'
  return (
    <div className="space-y-4">
      <Section title="Page" description="Where it lives and what it is called.">
        <TextInput label="Title" value={v.title} onChange={t => set({ title: t, ...(isNew && !v.slug ? { slug: slugify(t) } : {}) })} max={140} />
        <TextInput label="Web address (slug)" value={v.slug} onChange={s => set({ slug: s.toLowerCase() })} max={80}
          hint={`Public address: ${path}`}
          info={<>Changing the address of a live policy creates a permanent redirect from the old address, so existing links keep working.{legacy ? ` ${legacy.path} is a required address for this policy; keep the slug "${legacy.slug}" to stay there.` : ''}</>} />
        {legacy && v.slug !== legacy.slug && <AdminNotice tone="warning">This policy normally lives at {legacy.path}. Changing the slug moves it to /legal/{v.slug || '…'} (with a redirect).</AdminNotice>}
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Banner title" value={v.heroTitle ?? ''} onChange={t => set({ heroTitle: t || undefined })} max={140} hint="The dark banner at the top. Blank = the title." />
          <TextInput label="Breadcrumb label" value={v.heroBreadcrumb ?? ''} onChange={t => set({ heroBreadcrumb: t || undefined })} max={80} hint="Blank = the title." />
        </div>
        <div className="grid gap-3 sm:grid-cols-3">
          <TextInput label="Last updated date" type="date" value={v.effectiveDate ?? ''} onChange={d => set({ effectiveDate: d || null })} hint="Shown on the page. Update it when the terms change." />
          <TextInput label="Date label" value={v.lastUpdatedLabel ?? ''} onChange={t => set({ lastUpdatedLabel: t || undefined })} max={60} hint="Blank = “Last updated”." />
          <Select label="Layout" value={v.style} onChange={s => set({ style: s })} options={[{ value: 'legal', label: 'Legal (narrow, with title)' }, { value: 'support', label: 'Support (wider sections)' }]} />
        </div>
      </Section>
      <Section title="Content">
        <RichTextEditor value={v.body} onChange={body => set({ body })} blockChoices={blockChoices} allowCookieControls={entityId === 'cookies' || v.body.blocks.some(b => b.t === 'embed')} variant={v.style === 'support' ? 'support' : 'legal'} label="Policy text" />
      </Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
    </div>
  )
}

// ── pages ─────────────────────────────────────────────────────────────────────

export function PageForm({ value: v, onChange, blockChoices, isNew }: FormProps<PageSnapshot>) {
  const set = (p: Partial<PageSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Page">
        <TextInput label="Title" value={v.title} onChange={t => set({ title: t, ...(isNew && !v.slug ? { slug: slugify(t) } : {}) })} max={140} />
        <TextInput label="Web address (slug)" value={v.slug} onChange={s => set({ slug: s.toLowerCase() })} max={80} hint={`Public address: /pages/${v.slug || '…'}`}
          info="Renaming a live page keeps the old address working through a permanent redirect." />
        <TextInput label="Subtitle" value={v.subtitle ?? ''} onChange={t => set({ subtitle: t || undefined })} max={240} multiline rows={2} />
        <Toggle label="Can be added to navigation and the footer" checked={v.navEligible} onChange={navEligible => set({ navEligible })} hint="Only marks it as available; add the link under Navigation or Footer." />
      </Section>
      <Section title="Content"><RichTextEditor value={v.body} onChange={body => set({ body })} blockChoices={blockChoices} /></Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
    </div>
  )
}

// ── reusable block ────────────────────────────────────────────────────────────

export function BlockForm({ value: v, onChange }: FormProps<ContentBlockSnapshot>) {
  const set = (p: Partial<ContentBlockSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Block" description="Reusable text you can place on several pages. Edit it once and every page that uses it updates.">
        <TextInput label="Name" value={v.name} onChange={name => set({ name })} max={100} hint="Only you see this name." />
        <Select label="Category" value={v.category} onChange={category => set({ category })} options={BLOCK_CATEGORIES.map(c => ({ value: c, label: c.replace('-', ' ') }))} />
      </Section>
      <Section title="Content"><RichTextEditor value={v.content} onChange={content => set({ content })} compact label="Block text" variant="support" /></Section>
    </div>
  )
}

// ── size guide ────────────────────────────────────────────────────────────────

export function SizeGuideForm({ value: v, onChange }: FormProps<SizeGuideSnapshot>) {
  const set = (p: Partial<SizeGuideSnapshot>) => onChange({ ...v, ...p })
  const setCell = (ri: number, cid: string, val: string) => set({ rows: v.rows.map((r, i) => (i === ri ? { ...r, values: { ...r.values, [cid]: val } } : r)) })
  return (
    <div className="space-y-4">
      <Section title="Guide">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Name" value={v.name} onChange={name => set({ name })} max={100} hint="Shown as the table heading." />
          <TextInput label="Garment" value={v.garment} onChange={garment => set({ garment })} max={60} />
          <Select label="Measurements entered in" value={v.unit} onChange={unit => set({ unit })} options={[{ value: 'cm', label: 'Centimetres' }, { value: 'in', label: 'Inches' }]} hint="Shoppers can switch between cm and inches; numbers convert automatically." />
          <TextInput label="First column heading" value={v.rowHeader} onChange={rowHeader => set({ rowHeader })} max={40} />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Shop link label" value={v.shopLink?.label ?? ''} onChange={label => set({ shopLink: label || v.shopLink?.href ? { label, href: v.shopLink?.href ?? '' } : undefined })} max={80} />
          <TextInput label="Shop link address" value={v.shopLink?.href ?? ''} onChange={href => set({ shopLink: v.shopLink?.label || href ? { label: v.shopLink?.label ?? '', href } : undefined })} placeholder="/shop?type=hoodies" />
        </div>
        <div className="grid gap-3 sm:grid-cols-2">
          <Toggle label="Show on the public Size Guide page" checked={v.showOnGuidePage} onChange={showOnGuidePage => set({ showOnGuidePage })} hint="Off keeps it available to products only." />
          <TextInput label="Order on the page" type="number" value={String(v.order)} onChange={o => set({ order: Math.max(0, Math.min(9999, Math.trunc(Number(o)) || 0)) })} />
        </div>
      </Section>
      <Section title="Measurements" description="Columns are measurements; rows are sizes.">
        <ListEditor items={v.columns} onChange={columns => set({ columns, rows: v.rows.map(r => ({ ...r, values: Object.fromEntries(columns.map(c => [c.id, r.values[c.id] ?? ''])) })) })}
          makeNew={() => ({ id: newId('c'), label: '' })} addLabel="Add column" max={10} itemLabel={(_, i) => `Column ${i + 1}`}
          render={(c, up) => <TextInput label="Column heading" value={c.label} onChange={label => up({ label })} max={60} />} />
        <div className="overflow-x-auto">
          <table className="w-full min-w-[480px] border-collapse text-[12px]">
            <thead><tr><th className="p-1 text-left text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A85]">{v.rowHeader || 'Size'}</th>
              {v.columns.map(c => <th key={c.id} className="p-1 text-left text-[10px] font-medium uppercase tracking-[0.08em] text-[#8A8A85]">{c.label || '—'} ({v.unit})</th>)}<th /></tr></thead>
            <tbody>
              {v.rows.map((r, ri) => (
                <tr key={r.id}>
                  <td className="p-1"><input aria-label={`Size ${ri + 1} name`} value={r.label} maxLength={30} onChange={e => set({ rows: v.rows.map((x, i) => (i === ri ? { ...x, label: e.target.value } : x)) })} className={adminInputClass} /></td>
                  {v.columns.map(c => <td key={c.id} className="p-1"><input aria-label={`${r.label || 'Row ' + (ri + 1)} ${c.label}`} inputMode="decimal" value={r.values[c.id] ?? ''} maxLength={30} onChange={e => setCell(ri, c.id, e.target.value)} className={adminInputClass} /></td>)}
                  <td className="p-1"><AdminButton size="sm" variant="ghost" aria-label={`Remove size ${r.label}`} onClick={() => set({ rows: v.rows.filter((_, i) => i !== ri) })}>Remove</AdminButton></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <AdminButton size="sm" disabled={v.rows.length >= 40} onClick={() => set({ rows: [...v.rows, { id: newId('r'), label: '', values: Object.fromEntries(v.columns.map(c => [c.id, ''])) }] })}>Add size</AdminButton>
      </Section>
      <Section title="Notes & fit advice">
        <TextInput label="Measuring notes" multiline rows={3} value={v.notes.join('\n')} onChange={t => set({ notes: t.split('\n').filter(l => l.trim()) })} hint="One note per line, shown under the table." />
        <RichTextEditor value={v.fit} onChange={fit => set({ fit })} compact label="Fit advice (optional)" variant="support" />
        <MediaField label="Diagram (optional)" assetId={v.imageAssetId} onChange={imageAssetId => set({ imageAssetId })} />
        {v.imageAssetId && <TextInput label="Diagram description (alt text)" value={v.imageAlt ?? ''} onChange={imageAlt => set({ imageAlt: imageAlt || undefined })} max={200} />}
      </Section>
    </div>
  )
}

// ── FAQ ───────────────────────────────────────────────────────────────────────

export function FaqForm({ value: v, onChange, blockChoices }: FormProps<FaqSnapshot>) {
  const set = (p: Partial<FaqSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Page"><TextInput label="Page title" value={v.heroTitle} onChange={heroTitle => set({ heroTitle })} max={100} /></Section>
      <Section title="Questions" description="Categories and questions show in this order. Inactive ones are hidden from shoppers but kept here.">
        <ListEditor items={v.categories} onChange={categories => set({ categories })} addLabel="Add category" max={20}
          makeNew={() => ({ id: newId('cat'), heading: '', active: true, items: [] })} itemLabel={(c, i) => c.heading || `Category ${i + 1}`}
          render={(c, upC) => (
            <div className="space-y-3">
              <div className="grid items-end gap-3 sm:grid-cols-[1fr_auto]">
                <TextInput label="Category heading" value={c.heading} onChange={heading => upC({ heading })} max={80} />
                <Toggle label="Active" checked={c.active} onChange={active => upC({ active })} />
              </div>
              <ListEditor items={c.items} onChange={items => upC({ items })} addLabel="Add question" max={60}
                makeNew={() => ({ id: newId('q'), question: '', answer: emptyRich(), active: true })} itemLabel={(q, i) => q.question || `Question ${i + 1}`}
                render={(q, upQ) => (
                  <div className="space-y-2">
                    <TextInput label="Question" value={q.question} onChange={question => upQ({ question })} max={200} />
                    <RichTextEditor value={q.answer} onChange={answer => upQ({ answer })} compact label="Answer" variant="faq" />
                    <Toggle label="Active" checked={q.active} onChange={active => upQ({ active })} />
                  </div>
                )} />
            </div>
          )} />
      </Section>
      <Section title="Footer of the page">
        <TextInput label="Heading" value={v.footerTitle} onChange={footerTitle => set({ footerTitle })} max={100} />
        <RichTextEditor value={v.footerBody} onChange={footerBody => set({ footerBody })} compact label="Text" variant="faq" />
      </Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
      {blockChoices && null}
    </div>
  )
}

// ── About / Contact / Size guide page text ────────────────────────────────────

export function AboutForm({ value: v, onChange }: FormProps<AboutSnapshot>) {
  const set = (p: Partial<AboutSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Header"><TextInput label="Page title" value={v.heroTitle} onChange={heroTitle => set({ heroTitle })} max={100} /></Section>
      <Section title="The brand">
        <TextInput label="Eyebrow" value={v.brandEyebrow} onChange={brandEyebrow => set({ brandEyebrow })} max={60} />
        <TextInput label="Lead sentence" value={v.lead} onChange={lead => set({ lead })} max={400} multiline rows={2} />
        <ListEditor items={v.brandParagraphs.map(text => ({ text }))} onChange={xs => set({ brandParagraphs: xs.map(x => x.text) })} makeNew={() => ({ text: '' })} addLabel="Add paragraph" max={8}
          itemLabel={(_, i) => `Paragraph ${i + 1}`} render={(p, up) => <TextInput label="Paragraph" value={p.text} onChange={text => up({ text })} multiline rows={3} max={800} />} />
        <MediaField label="Image (optional)" assetId={v.imageAssetId} onChange={imageAssetId => set({ imageAssetId })} />
        {v.imageAssetId && <TextInput label="Image description (alt text)" value={v.imageAlt ?? ''} onChange={imageAlt => set({ imageAlt: imageAlt || undefined })} max={200} />}
      </Section>
      <Section title="The approach">
        <TextInput label="Eyebrow" value={v.approachEyebrow} onChange={approachEyebrow => set({ approachEyebrow })} max={60} />
        <ListEditor items={v.approach} onChange={approach => set({ approach })} makeNew={() => ({ id: newId('ap'), title: '', description: '' })} addLabel="Add item" max={8}
          itemLabel={(a, i) => a.title || `Item ${i + 1}`}
          render={(a, up) => <div className="space-y-2"><TextInput label="Title" value={a.title} onChange={title => up({ title })} max={60} /><TextInput label="Description" value={a.description} onChange={description => up({ description })} multiline rows={2} max={300} /></div>} />
      </Section>
      <Section title="Button">
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Button label" value={v.ctaLabel} onChange={ctaLabel => set({ ctaLabel })} max={60} hint="Leave empty to hide the button." />
          <TextInput label="Button address" value={v.ctaHref} onChange={ctaHref => set({ ctaHref })} placeholder="/shop" />
        </div>
      </Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
    </div>
  )
}

export function ContactForm({ value: v, onChange }: FormProps<ContactSnapshot>) {
  const set = (p: Partial<ContactSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Page text" description="The contact form itself (fields, subjects, sending) is fixed. Only the text around it is editable.">
        <TextInput label="Page title" value={v.heroTitle} onChange={heroTitle => set({ heroTitle })} max={100} />
        <TextInput label="Introduction (above the form)" value={v.intro} onChange={intro => set({ intro })} multiline rows={3} max={600} />
        <TextInput label="Support hours / response time" value={v.supportHours} onChange={supportHours => set({ supportHours })} multiline rows={2} max={300} />
        <TextInput label="Help note (below the form)" value={v.helpNote} onChange={helpNote => set({ helpNote })} multiline rows={2} max={400} />
      </Section>
      <Section title="After sending">
        <TextInput label="Confirmation title" value={v.successTitle} onChange={successTitle => set({ successTitle })} max={100} />
        <TextInput label="Confirmation message" value={v.successBody} onChange={successBody => set({ successBody })} multiline rows={2} max={400} />
      </Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
    </div>
  )
}

export function SupportPageForm({ value: v, onChange }: FormProps<SupportPageSnapshot>) {
  const set = (p: Partial<SupportPageSnapshot>) => onChange({ ...v, ...p })
  return (
    <div className="space-y-4">
      <Section title="Size Guide page text" description="The tables come from the size guides marked “show on the public page”.">
        <TextInput label="Page title" value={v.heroTitle} onChange={heroTitle => set({ heroTitle })} max={100} />
        <TextInput label="Introduction" value={v.intro} onChange={intro => set({ intro })} multiline rows={3} max={800} />
        <RichTextEditor value={v.tip} onChange={tip => set({ tip })} compact label="Fit tip (below the tables)" variant="support" />
        <ListEditor items={v.links} onChange={links => set({ links })} makeNew={() => ({ id: newId('l'), label: '', href: '' })} addLabel="Add link" max={6}
          itemLabel={(l, i) => l.label || `Link ${i + 1}`}
          render={(l, up) => <div className="grid gap-2 sm:grid-cols-2"><TextInput label="Label" value={l.label} onChange={label => up({ label })} max={80} /><TextInput label="Address" value={l.href} onChange={href => up({ href })} placeholder="/shop?type=hoodies" /></div>} />
      </Section>
      <Section title="Search & sharing"><SeoForm value={v.seo} onChange={seo => set({ seo })} /></Section>
    </div>
  )
}

// ── announcement ──────────────────────────────────────────────────────────────

/** ISO instant -> value for <input type="datetime-local"> in the chosen zone. */
function toLocalInput(iso: string | null, zone: 'local' | 'utc'): string {
  if (!iso) return ''
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const p = (n: number) => String(n).padStart(2, '0')
  return zone === 'utc'
    ? `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())}T${p(d.getUTCHours())}:${p(d.getUTCMinutes())}`
    : `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}T${p(d.getHours())}:${p(d.getMinutes())}`
}
function fromLocalInput(v: string, zone: 'local' | 'utc'): string | null {
  if (!v) return null
  const d = zone === 'utc' ? new Date(`${v}:00Z`) : new Date(v)
  return Number.isNaN(d.getTime()) ? null : d.toISOString()
}

export function AnnouncementForm({ value: v, onChange }: FormProps<AnnouncementSnapshot>) {
  const set = (p: Partial<AnnouncementSnapshot>) => onChange({ ...v, ...p })
  const [zone, setZone] = useState<'local' | 'utc'>('local')
  const tzName = useMemo(() => { try { return Intl.DateTimeFormat().resolvedOptions().timeZone } catch { return 'your browser time zone' } }, [])
  return (
    <div className="space-y-4">
      <Section title="Announcement bar" description="The thin bar at the very top of every page. When it is off or outside its dates the bar is simply empty.">
        <Toggle label="Show the announcement bar" checked={v.enabled} onChange={enabled => set({ enabled })} />
        <ListEditor<AnnouncementMessage> items={v.messages} onChange={messages => set({ messages })} makeNew={() => ({ id: newId('m'), text: '' })} addLabel="Add message" max={5}
          empty="No messages yet." itemLabel={(_, i) => `Message ${i + 1}`}
          render={(m, up) => <div className="grid gap-2 sm:grid-cols-2"><TextInput label="Text" value={m.text} onChange={text => up({ text })} max={140} /><TextInput label="Link (optional)" value={m.href ?? ''} onChange={href => up({ href: href || undefined })} placeholder="/shop" /></div>} />
        <p className="text-[11px] text-[#8A8A85]">With several messages the bar rotates through them.</p>
      </Section>
      <Section title="Schedule (optional)" description="Leave both empty to show it whenever it is switched on.">
        <Select label="Enter times in" value={zone} onChange={setZone} options={[{ value: 'local', label: `My time zone (${tzName})` }, { value: 'utc', label: 'UTC' }]} />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Starts" type="datetime-local" value={toLocalInput(v.startsAt, zone)} onChange={s => set({ startsAt: fromLocalInput(s, zone) })} hint={v.startsAt ? `Stored as ${v.startsAt} (UTC)` : 'Shows immediately'} />
          <TextInput label="Ends" type="datetime-local" value={toLocalInput(v.endsAt, zone)} onChange={s => set({ endsAt: fromLocalInput(s, zone) })} hint={v.endsAt ? `Stored as ${v.endsAt} (UTC)` : 'No end date'} />
        </div>
      </Section>
      <Section title="Preview">
        <div className="flex h-9 items-center justify-center rounded-[8px] bg-[#0E0E0E] px-4 text-center text-[11px] font-light tracking-[0.12em] text-[#F0EDE8]" aria-label="Announcement preview">
          {v.enabled && v.messages[0]?.text ? v.messages[0].text : <span className="text-[#F0EDE8]/40">Empty bar</span>}
        </div>
      </Section>
    </div>
  )
}

// ── navigation / footer ───────────────────────────────────────────────────────

function LinkRow({ l, up }: { l: NavLink; up: (p: Partial<NavLink>) => void }) {
  return (
    <div className="grid gap-2 sm:grid-cols-[1fr_1fr_auto] sm:items-end">
      <TextInput label="Label" value={l.label} onChange={label => up({ label })} max={60} />
      <TextInput label="Address" value={l.href} onChange={href => up({ href })} placeholder="/shop or https://…" />
      <Toggle label="New tab" checked={!!l.newTab} onChange={v => up({ newTab: v || undefined })} />
    </div>
  )
}
const missing = (links: NavLink[], req: readonly string[]) => req.filter(r => !links.some(l => !/[?#]/.test(l.href) && l.href.toLowerCase().replace(/\/$/, '') === r))

export function NavigationForm({ value: v, onChange }: FormProps<NavigationSnapshot>) {
  const lists = [['desktop', 'Desktop menu (top bar)', 12], ['mobile', 'Mobile menu (drawer)', 20]] as const
  return (
    <div className="space-y-4">
      <AdminNotice tone="info">The Shop and Contact links must stay in both menus. Internal addresses start with “/”; outside links must be https://.</AdminNotice>
      {lists.map(([key, title, max]) => {
        const miss = missing(v[key], REQUIRED_NAV_PATHS)
        return (
          <Section key={key} title={title}>
            {miss.length > 0 && <AdminNotice tone="danger" title="Required link missing">Add a link to {miss.join(' and ')} before publishing.</AdminNotice>}
            <ListEditor items={v[key]} onChange={links => onChange({ ...v, [key]: links })} makeNew={() => ({ id: newId('n'), label: '', href: '/' })} addLabel="Add link" max={max}
              itemLabel={(l, i) => l.label || `Link ${i + 1}`} render={(l, up) => <LinkRow l={l} up={up} />} />
          </Section>
        )
      })}
    </div>
  )
}

export function FooterForm({ value: v, onChange }: FormProps<FooterSnapshot>) {
  const set = (p: Partial<FooterSnapshot>) => onChange({ ...v, ...p })
  const all = v.groups.flatMap(g => g.links)
  const miss = missing(all, REQUIRED_FOOTER_PATHS)
  return (
    <div className="space-y-4">
      {miss.length > 0 && <AdminNotice tone="danger" title="Required links missing">The footer must link to {miss.join(', ')}.</AdminNotice>}
      <Section title="Brand">
        <TextInput label="Brand name" value={v.brandName} onChange={brandName => set({ brandName })} max={60} />
        <TextInput label="Taglines" value={v.taglines.join('\n')} onChange={t => set({ taglines: t.split('\n').filter(l => l.trim()) })} multiline rows={2} hint="One line per row (up to 4)." />
        <div className="grid gap-3 sm:grid-cols-2">
          <TextInput label="Copyright holder" value={v.copyrightHolder} onChange={copyrightHolder => set({ copyrightHolder })} max={80} hint="Shown as “© year holder.”" />
          <TextInput label="Copyright text" value={v.copyrightSuffix} onChange={copyrightSuffix => set({ copyrightSuffix })} max={200} hint="Blank = “All rights reserved.” in the shopper’s language." />
        </div>
      </Section>
      <Section title="Link groups" description="Columns of links. The required legal, support and shop links must stay somewhere.">
        <ListEditor items={v.groups} onChange={groups => set({ groups })} makeNew={() => ({ id: newId('g'), heading: '', links: [] })} addLabel="Add group" max={6}
          itemLabel={(g, i) => g.heading || `Group ${i + 1}`}
          render={(g, upG) => (
            <div className="space-y-3">
              <TextInput label="Heading" value={g.heading} onChange={heading => upG({ heading })} max={60} />
              <ListEditor items={g.links} onChange={links => upG({ links })} makeNew={() => ({ id: newId('fl'), label: '', href: '/' })} addLabel="Add link" max={12}
                itemLabel={(l, i) => l.label || `Link ${i + 1}`} render={(l, up) => <LinkRow l={l} up={up} />} />
            </div>
          )} />
      </Section>
      <Section title="Social links">
        <ListEditor items={v.social} onChange={social => set({ social })} makeNew={() => ({ id: newId('s'), platform: 'other' as const, label: '', href: 'https://' })} addLabel="Add social link" max={8}
          itemLabel={(s, i) => s.label || `Link ${i + 1}`}
          render={(s, up) => (
            <div className="grid gap-2 sm:grid-cols-3">
              <Select label="Network" value={s.platform} onChange={platform => up({ platform })} options={[{ value: 'instagram', label: 'Instagram' }, { value: 'tiktok', label: 'TikTok' }, { value: 'other', label: 'Other' }]} />
              <TextInput label="Label" value={s.label} onChange={label => up({ label })} max={60} hint="Read by screen readers." />
              <TextInput label="Address" value={s.href} onChange={href => up({ href })} placeholder="https://…" />
            </div>
          )} />
      </Section>
    </div>
  )
}

export const FORMS: Record<Kind, (p: FormProps<any>) => ReactNode> = {
  policies: PolicyForm, pages: PageForm, blocks: BlockForm, 'size-guides': SizeGuideForm, faq: FaqForm,
  about: AboutForm, contact: ContactForm, 'support-pages': SupportPageForm, announcement: AnnouncementForm,
  navigation: NavigationForm, footer: FooterForm,
}
export { cx }
