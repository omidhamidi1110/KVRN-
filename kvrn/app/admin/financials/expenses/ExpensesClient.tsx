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
import { FONT, BORDER, money, moneyOrUnknown, SectionTitle } from '@/components/admin/FinancialUI'

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

const inputStyle = { fontFamily: FONT, fontSize: 12, padding: '8px 10px',
                     border: BORDER, background: '#fff', width: '100%',
                     boxSizing: 'border-box' as const }
const btn = {
  fontFamily: FONT, fontSize: 11, letterSpacing: '0.08em',
  textTransform: 'uppercase' as const, padding: '9px 16px',
  background: '#1A1A1A', color: '#fff', border: 'none', cursor: 'pointer' as const,
}

export function ExpensesClient() {
  const [tab, setTab] = useState<'actual' | 'expected'>('actual')
  const [defs, setDefs] = useState<Definition[]>([])
  const [txns, setTxns] = useState<Transaction[]>([])
  const [loading, setLoading] = useState(true)
  const [saving, setSaving]   = useState(false)
  const [err, setErr]         = useState<string | null>(null)

  const [defForm, setDefForm] = useState({
    provider: '', category: 'infrastructure', name: '', cadence: 'monthly',
    expectedAmount: '', renewalDate: '', notes: '',
  })
  const [txForm, setTxForm] = useState({
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
      setDefForm({ ...defForm, provider: '', name: '', expectedAmount: '', notes: '' })
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
      setTxForm({ ...txForm, provider: '', name: '', amount: '', invoiceId: '' })
      await load()
    } catch { setErr('Network error.') }
    finally { setSaving(false) }
  }

  async function remove(kind: 'definitions' | 'transactions', id: string) {
    setErr(null)
    try {
      const res = await fetch(`/api/admin/expenses/${kind}/${id}`, { method: 'DELETE' })
      if (!res.ok) { const j = await res.json(); setErr(j.error ?? 'Could not delete.'); return }
      await load()
    } catch { setErr('Network error.') }
  }

  const actualTotal = txns.reduce((s, t) => s + t.amountCents, 0)
  const devTotal    = txns.filter(t => t.category === 'development')
                          .reduce((s, t) => s + t.amountCents, 0)

  return (
    <div style={{ padding: '28px 32px', maxWidth: 1180 }}>
      <h1 style={{ fontFamily: FONT, fontSize: 20, fontWeight: 500, margin: '0 0 4px' }}>
        Operating expenses
      </h1>
      <p style={{ fontFamily: FONT, fontSize: 12, color: '#6B6B6B', margin: '0 0 20px' }}>
        Expected obligations and actual invoices are tracked separately. Only actual billed
        transactions reduce realised operating profit.
      </p>

      <div style={{ display: 'flex', gap: 8, marginBottom: 20 }}>
        {([['actual', 'Actual billed'], ['expected', 'Expected obligations']] as const).map(([k, label]) => (
          <button key={k} onClick={() => setTab(k)}
            style={{ fontFamily: FONT, fontSize: 11, letterSpacing: '0.04em',
                     padding: '7px 14px', cursor: 'pointer',
                     border: tab === k ? '1px solid #1A1A1A' : BORDER,
                     background: tab === k ? '#1A1A1A' : '#fff',
                     color: tab === k ? '#fff' : '#1A1A1A' }}>
            {label}
          </button>
        ))}
      </div>

      {err && (
        <div style={{ fontFamily: FONT, fontSize: 12, color: '#B91C1C', background: '#FEF2F2',
                      border: '1px solid #FECACA', padding: '10px 14px', marginBottom: 16 }}>
          {err}
        </div>
      )}

      {tab === 'actual' ? (
        <>
          <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(200px,1fr))',
                        gap: 10, marginBottom: 22 }}>
            <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
              <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                          textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>
                Total billed (all time)</p>
              <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>
                {money(actualTotal)}</p>
            </div>
            <div style={{ border: BORDER, background: '#fff', padding: '14px 16px' }}>
              <p style={{ fontFamily: FONT, fontSize: 9, letterSpacing: '0.12em',
                          textTransform: 'uppercase', color: '#9B9B9B', margin: 0 }}>
                Of which development</p>
              <p style={{ fontFamily: FONT, fontSize: 22, fontWeight: 500, margin: '6px 0 0' }}>
                {money(devTotal)}</p>
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '4px 0 0' }}>
                Reported after operating profit</p>
            </div>
          </div>

          <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Settles obligation
                <select value={txForm.expenseDefinitionId}
                        onChange={e => {
                          const d = defs.find(x => x.id === e.target.value)
                          setTxForm({
                            ...txForm, expenseDefinitionId: e.target.value,
                            provider: d?.provider ?? txForm.provider,
                            category: d?.category ?? txForm.category,
                            name:     d?.name ?? txForm.name,
                          })
                        }}
                        style={{ ...inputStyle, marginTop: 4 }}>
                  <option value="">— none —</option>
                  {defs.map(d => <option key={d.id} value={d.id}>{d.provider} · {d.name}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Provider *
                <input value={txForm.provider} onChange={e => setTxForm({ ...txForm, provider: e.target.value })}
                       placeholder="Twilio" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Description *
                <input value={txForm.name} onChange={e => setTxForm({ ...txForm, name: e.target.value })}
                       placeholder="August invoice" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Category
                <select value={txForm.category} onChange={e => setTxForm({ ...txForm, category: e.target.value })}
                        style={{ ...inputStyle, marginTop: 4 }}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{catLabel(c)}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Amount $ *
                <input type="number" step="0.01" min="0" value={txForm.amount}
                       onChange={e => setTxForm({ ...txForm, amount: e.target.value })}
                       placeholder="3.15" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Paid on
                <input type="date" value={txForm.paidAt}
                       onChange={e => setTxForm({ ...txForm, paidAt: e.target.value })}
                       style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Service period start
                <input type="date" value={txForm.periodStart}
                       onChange={e => setTxForm({ ...txForm, periodStart: e.target.value })}
                       style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Service period end
                <input type="date" value={txForm.periodEnd}
                       onChange={e => setTxForm({ ...txForm, periodEnd: e.target.value })}
                       style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Invoice ID
                <input value={txForm.invoiceId} onChange={e => setTxForm({ ...txForm, invoiceId: e.target.value })}
                       style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Source
                <select value={txForm.source} onChange={e => setTxForm({ ...txForm, source: e.target.value })}
                        style={{ ...inputStyle, marginTop: 4 }}>
                  {SOURCES.map(s => <option key={s} value={s}>{s.replace(/_/g, ' ')}</option>)}
                </select></label>
            </div>
            {txForm.category === 'packaging' && (
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#92400E',
                          background: '#FFFBEB', border: '1px solid #FDE68A',
                          padding: '8px 12px', margin: '12px 0 0' }}>
                {PACKAGING_WARNING}
              </p>
            )}
            <p style={{ fontFamily: FONT, fontSize: 11, color: '#6B6B6B', margin: '12px 0 0' }}>
              A service period spanning several months is recognised across reporting windows —
              an annual renewal is one transaction, never twelve. The full amount still counts as
              cash paid on the Infrastructure page.
            </p>
            <button onClick={saveTransaction}
              disabled={saving || !txForm.provider || !txForm.name || !txForm.amount}
              style={{ ...btn, marginTop: 14,
                       opacity: saving || !txForm.provider || !txForm.name || !txForm.amount ? 0.45 : 1 }}>
              {saving ? 'Saving…' : 'Record invoice'}
            </button>
          </div>

          <SectionTitle note="Real invoices. These are the only expenses that reduce realised profit.">
            Billed transactions
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Provider','Description','Category','Amount','Paid','Service period','Source',''].map((h,i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 9,
                                       letterSpacing: '0.1em', textTransform: 'uppercase',
                                       color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>))}
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>Loading…</td></tr>}
                {!loading && txns.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No invoices recorded. Realised operating profit is unaffected by expected
                    obligations until an invoice is entered here.
                  </td></tr>
                )}
                {txns.map(t => (
                  <tr key={t.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{t.provider}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{t.name}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {catLabel(t.category)}
                    </td>
                    <td style={{ padding: '9px 10px', fontWeight: 500 }}>{money(t.amountCents)}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{t.paidAt ?? 'unpaid'}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {t.periodStart ? `${t.periodStart} → ${t.periodEnd ?? t.periodStart}` : '—'}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{t.source.replace(/_/g, ' ')}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <button onClick={() => remove('transactions', t.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer',
                                 color: '#6b7280', fontSize: 11, textDecoration: 'underline' }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      ) : (
        <>
          <div style={{ fontFamily: FONT, fontSize: 12, color: '#92400E', background: '#FFFBEB',
                        border: '1px solid #FDE68A', padding: '10px 14px', marginBottom: 20 }}>
            These are expectations, not bills. Nothing here reduces realised profit — record the
            matching invoice under &ldquo;Actual billed&rdquo; when it arrives.
          </div>

          <div style={{ border: BORDER, background: '#fff', padding: 18, marginBottom: 24 }}>
            <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fill,minmax(170px,1fr))', gap: 12 }}>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Provider *
                <input value={defForm.provider} onChange={e => setDefForm({ ...defForm, provider: e.target.value })}
                       placeholder="Neon" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Name *
                <input value={defForm.name} onChange={e => setDefForm({ ...defForm, name: e.target.value })}
                       placeholder="Postgres plan" style={{ ...inputStyle, marginTop: 4 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Category
                <select value={defForm.category} onChange={e => setDefForm({ ...defForm, category: e.target.value })}
                        style={{ ...inputStyle, marginTop: 4 }}>
                  {CATEGORIES.map(c => <option key={c} value={c}>{catLabel(c)}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Cadence
                <select value={defForm.cadence} onChange={e => setDefForm({ ...defForm, cadence: e.target.value })}
                        style={{ ...inputStyle, marginTop: 4 }}>
                  {CADENCES.map(c => <option key={c} value={c}>{c.replace(/_/g, ' ')}</option>)}
                </select></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>
                Expected amount $ {defForm.cadence === 'usage_based' ? '(n/a)' : '*'}
                <input type="number" step="0.01" min="0" value={defForm.expectedAmount}
                       disabled={defForm.cadence === 'usage_based'}
                       onChange={e => setDefForm({ ...defForm, expectedAmount: e.target.value })}
                       placeholder="19.00"
                       style={{ ...inputStyle, marginTop: 4,
                                opacity: defForm.cadence === 'usage_based' ? 0.5 : 1 }} /></label>
              <label style={{ fontFamily: FONT, fontSize: 11 }}>Renewal date
                <input type="date" value={defForm.renewalDate}
                       onChange={e => setDefForm({ ...defForm, renewalDate: e.target.value })}
                       style={{ ...inputStyle, marginTop: 4 }} /></label>
            </div>
            {defForm.category === 'packaging' && (
              <p style={{ fontFamily: FONT, fontSize: 11, color: '#92400E',
                          background: '#FFFBEB', border: '1px solid #FDE68A',
                          padding: '8px 12px', margin: '12px 0 0' }}>
                {PACKAGING_WARNING}
              </p>
            )}
            <button onClick={saveDefinition}
              disabled={saving || !defForm.provider || !defForm.name}
              style={{ ...btn, marginTop: 14,
                       opacity: saving || !defForm.provider || !defForm.name ? 0.45 : 1 }}>
              {saving ? 'Saving…' : 'Add obligation'}
            </button>
          </div>

          <SectionTitle note="Monthly equivalent is for planning comparison only — it never creates billed rows.">
            Expected obligations
          </SectionTitle>
          <div style={{ border: BORDER, background: '#fff', overflowX: 'auto' }}>
            <table style={{ width: '100%', borderCollapse: 'collapse', fontFamily: FONT, fontSize: 12 }}>
              <thead><tr style={{ background: '#FAF9F7' }}>
                {['Provider','Name','Category','Cadence','Expected','Monthly equiv.','Renews',''].map((h,i) => (
                  <th key={i} style={{ textAlign: 'left', padding: '9px 10px', fontSize: 9,
                                       letterSpacing: '0.1em', textTransform: 'uppercase',
                                       color: '#9B9B9B', borderBottom: BORDER }}>{h}</th>))}
              </tr></thead>
              <tbody>
                {loading && <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>Loading…</td></tr>}
                {!loading && defs.length === 0 && (
                  <tr><td colSpan={8} style={{ padding: '18px 12px', color: '#6B6B6B' }}>
                    No obligations recorded.
                  </td></tr>
                )}
                {defs.map(d => (
                  <tr key={d.id} style={{ borderBottom: '1px solid #F1EEE8' }}>
                    <td style={{ padding: '9px 10px' }}>{d.provider}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{d.name}</td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {catLabel(d.category)}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.cadence.replace(/_/g, ' ')}
                    </td>
                    <td style={{ padding: '9px 10px' }}>
                      {moneyOrUnknown(d.expectedAmountCents, 'usage-based')}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>
                      {d.monthlyEquivalentCents === null
                        ? '—' : `${money(d.monthlyEquivalentCents)}/mo`}
                    </td>
                    <td style={{ padding: '9px 10px', color: '#6B6B6B' }}>{d.renewalDate ?? '—'}</td>
                    <td style={{ padding: '9px 10px' }}>
                      <button onClick={() => remove('definitions', d.id)}
                        style={{ background: 'none', border: 'none', cursor: 'pointer',
                                 color: '#6b7280', fontSize: 11, textDecoration: 'underline' }}>
                        Delete
                      </button>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </>
      )}
    </div>
  )
}
