'use client'
// app/admin/financials/expenses/ExpensesClient.tsx
//
// Two layers, deliberately shown as separate tabs so they cannot be confused:
//
//   EXPECTED (definitions)   a recurring obligation. NOT a bill. Does not reduce profit.
//   ACTUAL   (transactions)  a real invoice. The ONLY thing that reduces realised profit.
//
// Recording "Neon $19/month" as a definition does not spend $19. Until an invoice is
// entered as a transaction, realised operating profit is untouched.

import { useEffect, useState, useCallback } from 'react'
import { money, moneyOrUnknown } from '@/components/admin/FinancialUI'
import { useDraftHistory } from '@/lib/admin/use-draft-history'
import {
  AdminPage, AdminPageHeader, AdminSectionHeader, AdminCard, AdminNotice, AdminButton, AdminField,
  AdminStat, AdminStatGrid, AdminTabs, AdminTable, AdminTh, AdminTd, AdminEmpty, AdminLoading,
  StatusBadge, AdminTag, useConfirm, adminInputClass, adminSelectClass,
} from '@/components/admin/ui/AdminUI'

type Definition = {
  id: string; provider: string; category: string; name: string
  cadence: string; expectedAmountCents: number | null
  monthlyEquivalentCents: number | null
  renewalDate: string | null; active: boolean; notes: string | null
}
type Transaction = {
  id: string; provider: string; category: string; name: string
  amountCents: number; periodStart: string | null; periodEnd: string | null
  paidAt: string | null; invoiceId: string | null; source: string
  definitionName: string | null
  /** Set when the invoice was VOIDED: retained as history, counted nowhere. */
  voidedAt?: string | null; voidedBy?: string | null; voidReason?: string | null
}

const CATEGORIES = ['infrastructure','development','communications','payments',
                    'shipping_platform','domain','software','contractor','packaging','other']

// Display labels. 'packaging' is deliberately relabelled: per-unit mailers and boxes
// belong in product landed COGS, and entering them here as well would double-count
// the same physical cost against profit.
const CATEGORY_LABELS: Record<string, string> = {
  infrastructure:    'infrastructure',
  development:       'development',
  communications:    'communications',
  payments:          'payments',
  shipping_platform: 'shipping platform',
  domain:            'domain',
  software:          'software',
  contractor:        'contractor',
  packaging:         'packaging overhead (non-unit)',
  other:             'other',
}
const catLabel = (c: string) => CATEGORY_LABELS[c] ?? c.replace(/_/g, ' ')

const PACKAGING_WARNING =
  'Packaging overhead is for non-unit supplies only — bulk stock, storage, equipment. ' +
  'Per-unit mailers, boxes and tissue already sit in product landed COGS under Product Costs. ' +
  'Recording them here as well would double-count the same cost.'
const CADENCES = ['monthly','annual','one_time','usage_based']
const SOURCES  = ['manual','provider_api','imported']
// monthly/annual = fixed recurring; one_time = one-time manual;
// usage_based = variable bill, entered by hand under "Actual billed" when the real bill is known.
const CADENCE_LABELS: Record<string, string> = {
  monthly: 'monthly (fixed recurring)', annual: 'annual (fixed recurring)',
  one_time: 'one-time (manual)', usage_based: 'variable bill (enter actual when billed)',
}

export function ExpensesClient() {
  const [tab, setTab] = useState<'actual' | 'expected'>('actual')
  const [defs, setDefs] = useState<Definition[]>([])
  const [txns, setTxns] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)
  const { confirm, node: confirmNode } = useConfirm()

  const { value: defForm, set: setDefForm, replace: replaceDef, undo: undoDef, redo: redoDef, canUndo: canUndoDef, canRedo: canRedoDef } = useDraftHistory({
    provider: '', category: 'infrastructure', name: '', cadence: 'monthly',
    expectedAmount: '', renewalDate: '', notes: '',
  })
  const { value: txForm, set: setTxForm, replace: replaceTx, undo: undoTx, redo: redoTx, canUndo: canUndoTx, canRedo: canRedoTx } = useDraftHistory({
    expenseDefinitionId: '', provider: '', category: 'infrastructure', name: '',
    amount: '', periodStart: '', periodEnd: '',
    paidAt: new Date().toISOString().slice(0, 10), invoiceId: '', source: 'manual',
  })

  const load = useCallback(async () => {
    setLoading(true)
    try {
      const [d, t] = await Promise.all([
        fetch('/api/admin/expenses/definitions').then(r => r.json()),
        fetch('/api/admin/expenses/transactions').then(r => r.json()),
      ])
      if (d.definitions)  setDefs(d.definitions)
      if (t.transactions) setTxns(t.transactions)
    } catch { setErr('Network error.') }
    finally { setLoading(false) }
  }, [])

  useEffect(() => { void load() }, [load])

  const toCents = (v: string) => {
    if (!v.trim()) return null
    const n = Math.round(parseFloat(v) * 100)
    return Number.isFinite(n) ? n : null
  }

  async function saveDefinition() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/expenses/definitions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          provider: defForm.provider, category: defForm.category, name: defForm.name,
          cadence: defForm.cadence,
          expectedAmountCents: defForm.cadence === 'usage_based'
            ? null : toCents(defForm.expectedAmount),
          renewalDate: defForm.renewalDate || null, notes: defForm.notes || null,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save.'); return }
      replaceDef({ ...defForm, provider: '', name: '', expectedAmount: '', notes: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  async function saveTransaction() {
    setSaving(true); setErr(null)
    try {
      const res = await fetch('/api/admin/expenses/transactions', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expenseDefinitionId: txForm.expenseDefinitionId || null,
          provider: txForm.provider, category: txForm.category, name: txForm.name,
          amountCents: toCents(txForm.amount),
          periodStart: txForm.periodStart || null, periodEnd: txForm.periodEnd || null,
          paidAt: txForm.paidAt || null, invoiceId: txForm.invoiceId || null,
          source: txForm.source,
        }),
      })
      const json = await res.json()
      if (!res.ok) { setErr(json.error ?? 'Could not save.'); return }
      replaceTx({ ...txForm, provider: '', name: '', amount: '', invoiceId: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  // Expected obligations (definitions) are plans, not booked money: they may be deleted.
  async function remove(kind: 'definitions', id: string) {
    setErr(null)
    if (!(await confirm('Delete this expected obligation? Billed invoices are not affected.',
      { title: 'Delete obligation', confirmLabel: 'Delete' }))) return
    try {
      const res = await fetch(`/api/admin/expenses/${kind}/${id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not delete.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  // Ending a recurring obligation only flips what is EXPECTED; it never touches billed rows.
  async function setActive(id: string, active: boolean) {
    setErr(null)
    try {
      const res = await fetch(`/api/admin/expenses/definitions/${id}`, {
        method: 'PATCH', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ active }),
      })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not update.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  // A booked invoice is a money fact: it is VOIDED (kept as history, counted nowhere), never erased.
  async function voidTransaction(id: string) {
    setErr(null)
    const reason = window.prompt(
      'Void this invoice? It stays in the history but stops counting.\n\nReason (required):')
    if (!reason || !reason.trim()) return
    try {
      const res = await fetch(`/api/admin/expenses/transactions/${id}`, {
        method: 'DELETE', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: reason.trim() }),
      })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not void.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  // Voided rows are history only: excluded from every total shown here.
  const activeTxns  = txns.filter(t => !t.voidedAt)
  const actualTotal = activeTxns.reduce((s, t) => s + t.amountCents, 0)
  const devTotal    = activeTxns.filter(t => t.category === 'development')
                          .reduce((s, t) => s + t.amountCents, 0)

  const disabledTx  = saving || !txForm.provider || !txForm.name || !txForm.amount
  const disabledDef = saving || !defForm.provider || !defForm.name

  return (
    <AdminPage>
      <AdminPageHeader
        title="Expenses"
        description="Billed invoices and expected costs."
        info={<>
          Expected obligations and actual invoices are tracked separately. Only actual billed
          transactions reduce realised operating profit. An expected obligation is a plan, not a bill.
        </>}
      />
      {confirmNode}

      <AdminTabs
        ariaLabel="Expense views"
        value={tab}
        onChange={setTab}
        tabs={[{ id: 'actual', label: 'Actual billed' }, { id: 'expected', label: 'Expected obligations' }]}
      />

      {err && <AdminNotice tone="danger" className="mb-4">{err}</AdminNotice>}

      {tab === 'actual' ? (
        <div className="space-y-6">
          <AdminStatGrid min={200}>
            <AdminStat label="Total billed" value={money(actualTotal)} sub="All time, voided excluded" />
            <AdminStat label="Of which development" value={money(devTotal)} sub="Reported after operating profit" />
          </AdminStatGrid>

          <AdminCard>
            <AdminSectionHeader title="Record an invoice" />
            <div className="flex items-center justify-end gap-2 pb-3">
              <span className="mr-auto text-xs text-[#777770]">Unsaved edits only</span>
              <AdminButton variant="ghost" size="sm" onClick={undoTx} disabled={!canUndoTx || saving}>↶ Undo</AdminButton>
              <AdminButton variant="ghost" size="sm" onClick={redoTx} disabled={!canRedoTx || saving}>↷ Redo</AdminButton>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              <AdminField label="Settles obligation" htmlFor="tx-def">
                <select id="tx-def" value={txForm.expenseDefinitionId} className={adminSelectClass}
                  onChange={e => {
                    const d = defs.find(x => x.id === e.target.value)
                    setTxForm({
                      ...txForm, expenseDefinitionId: e.target.value,
                      provider: d?.provider ?? txForm.provider,
                      category: d?.category ?? txForm.category,
                      name:     d?.name ?? txForm.name,
                    })
                  }}>
                  <option value="">None</option>
                  {defs.map(d => <option key={d.id} value={d.id}>{d.provider} · {d.name}</option>)}
                </select>
              </AdminField>
              <AdminField label="Provider *" htmlFor="tx-provider">
                <input id="tx-provider" className={adminInputClass} value={txForm.provider}
                  onChange={e => setTxForm({ ...txForm, provider: e.target.value })} placeholder="Twilio" />
              </AdminField>
              <AdminField label="Description *" htmlFor="tx-name">
                <input id="tx-name" className={adminInputClass} value={txForm.name}
                  onChange={e => setTxForm({ ...txForm, name: e.target.value })} placeholder="August invoice" />
              </AdminField>
              <AdminField label="Category" htmlFor="tx-category">
                <select id="tx-category" className={adminSelectClass} value={txForm.category}
                  onChange={e => setTxForm({ ...txForm, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{catLabel(c)}</option>)}
                </select>
              </AdminField>
              <AdminField label="Amount ($) *" htmlFor="tx-amount">
                <input id="tx-amount" type="number" step="0.01" min="0" className={adminInputClass} value={txForm.amount}
                  onChange={e => setTxForm({ ...txForm, amount: e.target.value })} placeholder="3.15" />
              </AdminField>
              <AdminField label="Paid on" htmlFor="tx-paid">
                <input id="tx-paid" type="date" className={adminInputClass} value={txForm.paidAt}
                  onChange={e => setTxForm({ ...txForm, paidAt: e.target.value })} />
              </AdminField>
              <AdminField label="Service period start" htmlFor="tx-pstart"
                info={<>
                  A service period spanning several months is recognised across reporting windows —
                  an annual renewal is one transaction, never twelve. The full amount still counts as
                  cash paid on the Infrastructure page.
                </>}>
                <input id="tx-pstart" type="date" className={adminInputClass} value={txForm.periodStart}
                  onChange={e => setTxForm({ ...txForm, periodStart: e.target.value })} />
              </AdminField>
              <AdminField label="Service period end" htmlFor="tx-pend">
                <input id="tx-pend" type="date" className={adminInputClass} value={txForm.periodEnd}
                  onChange={e => setTxForm({ ...txForm, periodEnd: e.target.value })} />
              </AdminField>
              <AdminField label="Invoice ID" htmlFor="tx-invoice">
                <input id="tx-invoice" className={adminInputClass} value={txForm.invoiceId}
                  onChange={e => setTxForm({ ...txForm, invoiceId: e.target.value })} />
              </AdminField>
              <AdminField label="Source" htmlFor="tx-source">
                <select id="tx-source" className={adminSelectClass} value={txForm.source}
                  onChange={e => setTxForm({ ...txForm, source: e.target.value })}>
                  {SOURCES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select>
              </AdminField>
            </div>
            {txForm.category === 'packaging' && (
              <AdminNotice tone="warning" className="mt-3">{PACKAGING_WARNING}</AdminNotice>
            )}
            <div className="mt-4">
              <AdminButton variant="primary" onClick={saveTransaction} disabled={disabledTx} loading={saving}>
                Record invoice
              </AdminButton>
            </div>
          </AdminCard>

          <section>
            <AdminSectionHeader
              title="Billed invoices"
              info="Real invoices. These are the only expenses that reduce realised profit. Voided invoices stay in the history but count nowhere."
            />
            <AdminTable caption="Billed invoices" minWidth={820} stack>
              <thead><tr>
                {['Provider', 'Description', 'Category', 'Amount', 'Paid', 'Service period', 'Source', ''].map((h, i) => (
                  <AdminTh key={i}>{h}</AdminTh>
                ))}
              </tr></thead>
              <tbody>
                {loading && <tr><AdminTd colSpan={8}><AdminLoading /></AdminTd></tr>}
                {!loading && txns.length === 0 && (
                  <tr><AdminTd colSpan={8}>
                    <AdminEmpty title="No invoices recorded."
                      description="Expected obligations don’t affect profit until an invoice is entered here." />
                  </AdminTd></tr>
                )}
                {txns.map(t => (
                  <tr key={t.id} className={t.voidedAt ? 'bg-black/[0.02] text-[#8A8A85]' : undefined}>
                    <AdminTd>{t.provider}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{t.name}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{catLabel(t.category)}</AdminTd>
                    <AdminTd className={`font-medium ${t.voidedAt ? 'line-through' : ''}`}>{money(t.amountCents)}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{t.paidAt ?? 'Unpaid'}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">
                      {t.periodStart ? `${t.periodStart} → ${t.periodEnd ?? t.periodStart}` : '—'}
                    </AdminTd>
                    <AdminTd className="text-[#6B6B66]">{t.source.replace(/_/g, ' ')}</AdminTd>
                    <AdminTd>
                      {t.voidedAt ? (
                        <div className="text-[11px]">
                          <AdminTag tone="neutral">Voided</AdminTag>
                          <p className="mt-1 text-[#6B6B66]">
                            {t.voidedAt.slice(0, 10)} by {t.voidedBy ?? 'unknown'}
                            {t.voidReason ? ` — ${t.voidReason}` : ''}
                          </p>
                        </div>
                      ) : (
                        <AdminButton variant="ghost" size="sm" onClick={() => voidTransaction(t.id)}>Void</AdminButton>
                      )}
                    </AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </section>
        </div>
      ) : (
        <div className="space-y-6">
          <AdminNotice tone="warning">
            Expectations, not bills. Nothing here reduces realised profit — record the matching
            invoice under &ldquo;Actual billed&rdquo; when it arrives.
          </AdminNotice>

          <AdminCard>
            <AdminSectionHeader title="Add an obligation" />
            <div className="flex items-center justify-end gap-2 pb-3">
              <span className="mr-auto text-xs text-[#777770]">Unsaved edits only</span>
              <AdminButton variant="ghost" size="sm" onClick={undoDef} disabled={!canUndoDef || saving}>↶ Undo</AdminButton>
              <AdminButton variant="ghost" size="sm" onClick={redoDef} disabled={!canRedoDef || saving}>↷ Redo</AdminButton>
            </div>
            <div className="grid min-w-0 gap-4 sm:grid-cols-2 2xl:grid-cols-3">
              <AdminField label="Provider *" htmlFor="def-provider">
                <input id="def-provider" className={adminInputClass} value={defForm.provider}
                  onChange={e => setDefForm({ ...defForm, provider: e.target.value })} placeholder="Neon" />
              </AdminField>
              <AdminField label="Name *" htmlFor="def-name">
                <input id="def-name" className={adminInputClass} value={defForm.name}
                  onChange={e => setDefForm({ ...defForm, name: e.target.value })} placeholder="Postgres plan" />
              </AdminField>
              <AdminField label="Category" htmlFor="def-category">
                <select id="def-category" className={adminSelectClass} value={defForm.category}
                  onChange={e => setDefForm({ ...defForm, category: e.target.value })}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{catLabel(c)}</option>)}
                </select>
              </AdminField>
              <AdminField label="Cadence" htmlFor="def-cadence">
                <select id="def-cadence" className={adminSelectClass} value={defForm.cadence}
                  onChange={e => setDefForm({ ...defForm, cadence: e.target.value })}>
                  {CADENCES.map(c => <option key={c} value={c}>{CADENCE_LABELS[c] ?? c.replace(/_/g, ' ')}</option>)}
                </select>
              </AdminField>
              <AdminField label={`Expected amount ($) ${defForm.cadence === 'usage_based' ? '(n/a)' : '*'}`} htmlFor="def-amount">
                <input id="def-amount" type="number" step="0.01" min="0" className={adminInputClass}
                  value={defForm.expectedAmount} disabled={defForm.cadence === 'usage_based'}
                  onChange={e => setDefForm({ ...defForm, expectedAmount: e.target.value })} placeholder="19.00" />
              </AdminField>
              <AdminField label="Start / next renewal date" htmlFor="def-renewal">
                <input id="def-renewal" type="date" className={adminInputClass} value={defForm.renewalDate}
                  onChange={e => setDefForm({ ...defForm, renewalDate: e.target.value })} />
              </AdminField>
            </div>
            {defForm.category === 'packaging' && (
              <AdminNotice tone="warning" className="mt-3">{PACKAGING_WARNING}</AdminNotice>
            )}
            <div className="mt-4">
              <AdminButton variant="primary" onClick={saveDefinition} disabled={disabledDef} loading={saving}>
                Add obligation
              </AdminButton>
            </div>
          </AdminCard>

          <section>
            <AdminSectionHeader
              title="Expected obligations"
              info="Monthly equivalent is for planning comparison only — it never creates billed rows."
            />
            <AdminTable caption="Expected obligations" minWidth={900} stack>
              <thead><tr>
                {['Provider', 'Name', 'Category', 'Cadence', 'Expected', 'Monthly equiv.', 'Start / renews', 'Status', ''].map((h, i) => (
                  <AdminTh key={i}>{h}</AdminTh>
                ))}
              </tr></thead>
              <tbody>
                {loading && <tr><AdminTd colSpan={9}><AdminLoading /></AdminTd></tr>}
                {!loading && defs.length === 0 && (
                  <tr><AdminTd colSpan={9}><AdminEmpty title="No obligations recorded." /></AdminTd></tr>
                )}
                {defs.map(d => (
                  <tr key={d.id}>
                    <AdminTd>{d.provider}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{d.name}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{catLabel(d.category)}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{d.cadence.replace(/_/g, ' ')}</AdminTd>
                    <AdminTd>{moneyOrUnknown(d.expectedAmountCents, 'usage-based')}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">
                      {d.monthlyEquivalentCents === null ? '—' : `${money(d.monthlyEquivalentCents)}/mo`}
                    </AdminTd>
                    <AdminTd className="text-[#6B6B66]">{d.renewalDate ?? '—'}</AdminTd>
                    <AdminTd>
                      {d.active ? <StatusBadge status="Active" /> : <StatusBadge status="Inactive" label="Ended" />}
                    </AdminTd>
                    <AdminTd>
                      <div className="flex gap-1">
                        <AdminButton variant="ghost" size="sm" onClick={() => setActive(d.id, !d.active)}>
                          {d.active ? 'End' : 'Reactivate'}
                        </AdminButton>
                        <AdminButton variant="ghost" size="sm" onClick={() => remove('definitions', d.id)}>Delete</AdminButton>
                      </div>
                    </AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          </section>
        </div>
      )}
    </AdminPage>
  )
}
