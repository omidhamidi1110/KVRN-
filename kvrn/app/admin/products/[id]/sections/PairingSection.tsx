'use client'
import { AdminCard, AdminSectionHeader, AdminField, adminInputClass } from '@/components/admin/ui/AdminUI'
import { type SectionProps, IssueList, Toggle } from '../editor-shared'
import { BundleSection } from '../BundleSection'

export function PairingSection({ snap, update, state, options, issues, locked }: SectionProps) {
  const ct = snap.completeTheSet
  const pairs = (options?.pairs ?? []).filter(p => p.id !== state.id)
  return (
    <div className="space-y-4">
      <AdminCard>
        <AdminSectionHeader title="Complete the Set" description="Offer one paired product on this page."
          info="Shows the paired product under the details with a combined total (the sum of both live prices; there is no discount). The paired product must be live to appear." />
        <div className="space-y-3">
          <Toggle label="Show Complete the Set" checked={ct.enabled} disabled={locked}
            onChange={v => update(s => { s.completeTheSet.enabled = v; if (!v) s.completeTheSet.pairedProductId = null })} />
          {ct.enabled && (
            <AdminField label="Paired product" htmlFor="p-pair">
              <select id="p-pair" className={adminInputClass} disabled={locked} value={ct.pairedProductId ?? ''}
                onChange={e => update(s => { s.completeTheSet.pairedProductId = e.target.value || null })}>
                <option value="">Choose a product</option>
                {pairs.map(p => <option key={p.id} value={p.id}>{p.name}{p.product_code ? ` (${p.product_code})` : ''}{p.status === 'published' ? '' : ` — ${p.status}`}</option>)}
              </select>
              <IssueList issues={issues.filter(i => i.field === 'completeTheSet')} />
            </AdminField>
          )}
        </div>
      </AdminCard>
      <BundleSection snap={snap} update={update} state={state} issues={issues} locked={locked} />
    </div>
  )
}
