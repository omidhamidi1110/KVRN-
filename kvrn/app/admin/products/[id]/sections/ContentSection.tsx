'use client'
import { AdminField, AdminFieldGrid, AdminCard, AdminSectionHeader, AdminButton, adminInputClass } from '@/components/admin/ui/AdminUI'
import { LIMITS, GUIDANCE } from '@/lib/product-model'
import { type SectionProps, IssueList, Toggle, textareaClass, CharCount } from '../editor-shared'

function move<T>(arr: T[], i: number, d: -1 | 1): T[] {
  const j = i + d; if (j < 0 || j >= arr.length) return arr
  const a = arr.slice(); [a[i], a[j]] = [a[j], a[i]]; return a
}

export function ContentSection({ snap, update, state, issues, locked }: SectionProps) {
  const sec = snap.sections
  const g = state.defaults.shippingReturns
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Description" />
        <AdminField label="Description" htmlFor="p-desc" info="The Description accordion on the product page. Blank is allowed only if you hide the section.">
          <textarea id="p-desc" rows={5} className={textareaClass} value={snap.description} disabled={locked} maxLength={LIMITS.description}
            onChange={e => update(s => { s.description = e.target.value })} />
          <IssueList issues={issues.filter(i => i.field === 'description')} />
        </AdminField>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Details" description="The first three lines also appear beside the hero image."
          actions={<AdminButton size="sm" disabled={locked || snap.constructionDetails.length >= LIMITS.detailLines} onClick={() => update(s => { s.constructionDetails.push('') })}>Add line</AdminButton>} />
        <ul className="space-y-2">
          {snap.constructionDetails.map((l, i) => (
            <li key={i} className="flex items-center gap-1.5">
              <span className="w-5 text-[10px] text-[#8A8A85]">{i + 1}</span>
              <input aria-label={`Detail line ${i + 1}`} className={adminInputClass} value={l} disabled={locked} maxLength={LIMITS.detailLine}
                onChange={e => update(s => { s.constructionDetails[i] = e.target.value })} />
              {i < 3 && l.length > GUIDANCE.detailLine && <span className="text-[10px] text-[#92400E]">may wrap</span>}
              <AdminButton size="sm" variant="ghost" aria-label="Move up" disabled={locked || i === 0} onClick={() => update(s => { s.constructionDetails = move(s.constructionDetails, i, -1) })}>↑</AdminButton>
              <AdminButton size="sm" variant="ghost" aria-label="Move down" disabled={locked || i === snap.constructionDetails.length - 1} onClick={() => update(s => { s.constructionDetails = move(s.constructionDetails, i, 1) })}>↓</AdminButton>
              <AdminButton size="sm" variant="ghost" aria-label="Remove line" disabled={locked} onClick={() => update(s => { s.constructionDetails.splice(i, 1) })}>✕</AdminButton>
            </li>
          ))}
        </ul>
        <IssueList issues={issues.filter(i => i.field === 'constructionDetails')} />
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Features" actions={<AdminButton size="sm" disabled={locked || snap.features.length >= LIMITS.features} onClick={() => update(s => { s.features.push({ title: '', description: '' }) })}>Add feature</AdminButton>} />
        <ul className="space-y-2">
          {snap.features.map((f, i) => (
            <li key={i} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_2fr_auto]">
              <input aria-label={`Feature ${i + 1} title`} placeholder="Title" className={adminInputClass} value={f.title} disabled={locked} maxLength={LIMITS.featureTitle}
                onChange={e => update(s => { s.features[i].title = e.target.value })} />
              <input aria-label={`Feature ${i + 1} text`} placeholder="Text" className={adminInputClass} value={f.description} disabled={locked} maxLength={LIMITS.featureText}
                onChange={e => update(s => { s.features[i].description = e.target.value })} />
              <span className="flex gap-1">
                <AdminButton size="sm" variant="ghost" aria-label="Move up" disabled={locked || i === 0} onClick={() => update(s => { s.features = move(s.features, i, -1) })}>↑</AdminButton>
                <AdminButton size="sm" variant="ghost" aria-label="Move down" disabled={locked || i === snap.features.length - 1} onClick={() => update(s => { s.features = move(s.features, i, 1) })}>↓</AdminButton>
                <AdminButton size="sm" variant="ghost" aria-label="Remove feature" disabled={locked} onClick={() => update(s => { s.features.splice(i, 1) })}>✕</AdminButton>
              </span>
            </li>
          ))}
        </ul>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Specs" actions={<AdminButton size="sm" disabled={locked || snap.specs.length >= LIMITS.specs} onClick={() => update(s => { s.specs.push({ label: '', value: '' }) })}>Add spec</AdminButton>} />
        <ul className="space-y-2">
          {snap.specs.map((f, i) => (
            <li key={i} className="grid grid-cols-1 gap-1.5 sm:grid-cols-[1fr_2fr_auto]">
              <input aria-label={`Spec ${i + 1} label`} placeholder="Label" className={adminInputClass} value={f.label} disabled={locked} maxLength={LIMITS.specLabel}
                onChange={e => update(s => { s.specs[i].label = e.target.value })} />
              <input aria-label={`Spec ${i + 1} value`} placeholder="Value" className={adminInputClass} value={f.value} disabled={locked} maxLength={LIMITS.specValue}
                onChange={e => update(s => { s.specs[i].value = e.target.value })} />
              <span className="flex gap-1">
                <AdminButton size="sm" variant="ghost" aria-label="Move up" disabled={locked || i === 0} onClick={() => update(s => { s.specs = move(s.specs, i, -1) })}>↑</AdminButton>
                <AdminButton size="sm" variant="ghost" aria-label="Move down" disabled={locked || i === snap.specs.length - 1} onClick={() => update(s => { s.specs = move(s.specs, i, 1) })}>↓</AdminButton>
                <AdminButton size="sm" variant="ghost" aria-label="Remove spec" disabled={locked} onClick={() => update(s => { s.specs.splice(i, 1) })}>✕</AdminButton>
              </span>
            </li>
          ))}
        </ul>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Page sections" description="Hide what this product does not need." />
        <AdminFieldGrid cols={2}>
          <Toggle label="Description" checked={sec.description} disabled={locked} onChange={v => update(s => { s.sections.description = v })} />
          <Toggle label="Details" checked={sec.details} disabled={locked} onChange={v => update(s => { s.sections.details = v })} />
          <Toggle label="Shipping & Returns" checked={sec.shippingReturns} disabled={locked} onChange={v => update(s => { s.sections.shippingReturns = v })} />
          <Toggle label="Size guide link" checked={sec.sizeGuideLink} disabled={locked} onChange={v => update(s => { s.sections.sizeGuideLink = v })} />
          <Toggle label="Sticky add to bag (mobile)" checked={sec.stickyAddToBag} disabled={locked} onChange={v => update(s => { s.sections.stickyAddToBag = v })} />
        </AdminFieldGrid>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Shipping & Returns text" description="Uses the store-wide text unless you override it."
          info="Edit the store-wide text under Products → Defaults. An override applies to this product only." />
        <div className="space-y-3">
          <Toggle label="Override for this product" checked={snap.shippingReturns.mode === 'override'} disabled={locked}
            onChange={v => update(s => { s.shippingReturns.mode = v ? 'override' : 'global'; if (v && !s.shippingReturns.lines.length) s.shippingReturns.lines = [...g.lines] })} />
          {snap.shippingReturns.mode === 'override' ? (
            <AdminField label="Lines (one per row)" htmlFor="p-sr">
              <textarea id="p-sr" rows={4} className={textareaClass} disabled={locked} value={snap.shippingReturns.lines.join('\n')}
                onChange={e => update(s => { s.shippingReturns.lines = e.target.value.split('\n').slice(0, LIMITS.shippingLines).map(x => x.slice(0, LIMITS.shippingLine)) })} />
            </AdminField>
          ) : (
            <ul className="rounded-[10px] bg-[#FAFAF8] p-3 text-[12px] text-[#6B6B66]">{g.lines.map((l, i) => <li key={i}>{l}</li>)}</ul>
          )}
        </div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Size guide" info="By default the Size guide link goes to the store-wide size guide page. Add text here to show it inline for this product." />
        <div className="space-y-3">
          <Toggle label="Show custom size guide text" checked={snap.sizeGuide.mode === 'override'} disabled={locked}
            onChange={v => update(s => { s.sizeGuide.mode = v ? 'override' : 'global'; if (!v) s.sizeGuide.body = null })} />
          {snap.sizeGuide.mode === 'override' && (
            <AdminField label="Size guide text" htmlFor="p-sg">
              <textarea id="p-sg" rows={5} className={textareaClass} disabled={locked} value={snap.sizeGuide.body ?? ''} maxLength={LIMITS.body}
                onChange={e => update(s => { s.sizeGuide.body = e.target.value || null })} />
              <div className="mt-1 text-right"><CharCount value={snap.sizeGuide.body ?? ''} hard={LIMITS.body} /></div>
            </AdminField>
          )}
        </div>
      </AdminCard>
    </div>
  )
}
