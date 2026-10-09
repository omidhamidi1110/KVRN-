'use client'
import { AdminCard, AdminSectionHeader, AdminButton, AdminNotice, AdminTable, AdminTh, AdminTd, StatusBadge, AdminEmpty } from '@/components/admin/ui/AdminUI'
import type { EditorState } from '../editor-shared'

export function HistorySection({ state, busy, onRollback }: { state: EditorState; busy: boolean; onRollback: (versionNo: number) => void }) {
  const canRestore = state.status === 'published'
  return (
    <AdminCard>
      <AdminSectionHeader title="Version history" description="Every publish keeps a copy you can restore."
        info="Restoring brings back a version’s content (text, images, SEO) as a new version. Price, sizes and stock are left as they are now, and past orders never change." />
      {state.history.length === 0 ? <AdminEmpty title="No versions yet" /> : (
        <AdminTable caption="Versions" stack>
          <thead><tr><AdminTh>Version</AdminTh><AdminTh>State</AdminTh><AdminTh>Saved</AdminTh><AdminTh>By</AdminTh><AdminTh /></tr></thead>
          <tbody>
            {state.history.map(v => {
              const isLive = v.version_no === state.publishedVersionNo
              const isDraft = v.version_no === state.draftVersionNo
              return (
                <tr key={v.version_no}>
                  <AdminTd>v{v.version_no}{v.rolled_back_from ? <span className="ml-1 text-[10px] text-[#8A8A85]">(restored from v{v.rolled_back_from})</span> : null}{v.change_note ? <span className="block text-[11px] text-[#8A8A85]">{v.change_note}</span> : null}</AdminTd>
                  <AdminTd>{isLive ? <StatusBadge status="Live" /> : isDraft ? <StatusBadge status="Draft" /> : <StatusBadge status="Archived" label="Earlier" />}</AdminTd>
                  <AdminTd>{new Date(v.published_at ?? v.created_at).toLocaleString()}</AdminTd>
                  <AdminTd>{v.published_by ?? v.created_by ?? '—'}</AdminTd>
                  <AdminTd>{!isLive && !isDraft && canRestore && <AdminButton size="sm" disabled={busy} onClick={() => onRollback(v.version_no)}>Restore</AdminButton>}</AdminTd>
                </tr>
              )
            })}
          </tbody>
        </AdminTable>
      )}
      {!canRestore && state.history.length > 0 && <AdminNotice tone="info" className="mt-3">Restore is available while the product is live.</AdminNotice>}
    </AdminCard>
  )
}
