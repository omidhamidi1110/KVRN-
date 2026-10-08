'use client'
import { useState } from 'react'
import { AdminField, AdminCard, AdminSectionHeader, adminInputClass } from '@/components/admin/ui/AdminUI'
import { LIMITS, GUIDANCE, slugify } from '@/lib/product-model'
import { type SectionProps, IssueList, Row, CharCount, textareaClass } from '../editor-shared'

const pick = (issues: SectionProps['issues'], ...fields: string[]) => issues.filter(i => fields.includes(i.field))

export function BasicsSection({ snap, update, state, options, issues, locked }: SectionProps) {
  const published = state.publishedVersionNo !== null
  // Until the URL is edited by hand it follows the name (new drafts only).
  const [slugTouched, setSlugTouched] = useState(published || snap.slug !== '' && snap.slug !== slugify(snap.name))
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Basics" />
        <div className="space-y-3">
          <Row>
            <AdminField label="Name" htmlFor="p-name" error={null}
              info={`Shown as the product title. Over ${GUIDANCE.name} characters may wrap awkwardly on small screens.`}>
              <input id="p-name" className={adminInputClass} value={snap.name} disabled={locked} maxLength={LIMITS.name}
                onChange={e => update(s => { s.name = e.target.value; if (!slugTouched) s.slug = slugify(e.target.value) })} />
              <div className="mt-1 text-right"><CharCount value={snap.name} soft={GUIDANCE.name} hard={LIMITS.name} /></div>
              <IssueList issues={pick(issues, 'name')} />
            </AdminField>
            <AdminField label="Eyebrow" htmlFor="p-eyebrow" info="Small line above the title, e.g. the collection or drop. Leave empty for none.">
              <input id="p-eyebrow" className={adminInputClass} value={snap.eyebrow ?? ''} disabled={locked} maxLength={LIMITS.eyebrow}
                onChange={e => update(s => { s.eyebrow = e.target.value || null })} />
              <IssueList issues={pick(issues, 'eyebrow')} tone="warning" />
            </AdminField>
          </Row>
          <Row cols={3}>
            <AdminField label="Product code" info="Fixed once created. Used in SKUs (KVRN-CODE-COLOR-SIZE) and shipping lookups.">
              <input className={adminInputClass} value={state.productCode ?? ''} disabled readOnly />
            </AdminField>
            <AdminField label="Type" htmlFor="p-type" info="Lowercase words joined by hyphens, e.g. hoodie, sweatpants, tee. Used for shop filters.">
              <input id="p-type" className={adminInputClass} value={snap.productType} disabled={locked} maxLength={LIMITS.productType} list="p-types"
                onChange={e => update(s => { s.productType = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') })} />
              <datalist id="p-types">{(options?.types ?? []).map(t => <option key={t} value={t} />)}</datalist>
              <IssueList issues={pick(issues, 'productType')} />
            </AdminField>
            <AdminField label="URL" htmlFor="p-slug" info={published ? 'Changing the URL of a live product keeps the old link working with a redirect.' : 'The page address. Lowercase letters, numbers and hyphens.'}>
              <div className="flex items-center gap-1">
                <span className="text-[11px] text-[#8A8A85]">/products/</span>
                <input id="p-slug" className={adminInputClass} value={snap.slug} disabled={locked} maxLength={LIMITS.slug}
                  onChange={e => { setSlugTouched(true); update(s => { s.slug = e.target.value.toLowerCase().replace(/[^a-z0-9-]/g, '-') }) }} />
              </div>
              <IssueList issues={pick(issues, 'slug')} />
            </AdminField>
          </Row>
          <AdminField label="Short description" htmlFor="p-short" info="One line used in listings and as the search fallback.">
            <input id="p-short" className={adminInputClass} value={snap.shortDescription} disabled={locked} maxLength={LIMITS.shortDescription}
              onChange={e => update(s => { s.shortDescription = e.target.value })} />
          </AdminField>
          <Row>
            <AdminField label="Pricing message" htmlFor="p-founder" info={`Shown next to the price, e.g. a launch-pricing note. Over ${GUIDANCE.founderNote} characters may wrap.`}>
              <input id="p-founder" className={adminInputClass} value={snap.founderNote ?? ''} disabled={locked} maxLength={LIMITS.founderNote}
                onChange={e => update(s => { s.founderNote = e.target.value || null })} />
              <IssueList issues={pick(issues, 'founderNote')} tone="warning" />
            </AdminField>
            <AdminField label="Fit note" htmlFor="p-fit" info="Shown under the size picker.">
              <input id="p-fit" className={adminInputClass} value={snap.fitNote ?? ''} disabled={locked} maxLength={LIMITS.fitNote}
                onChange={e => update(s => { s.fitNote = e.target.value || null })} />
              <IssueList issues={pick(issues, 'fitNote')} tone="warning" />
            </AdminField>
          </Row>
        </div>
      </AdminCard>
    </div>
  )
}

export { textareaClass }
