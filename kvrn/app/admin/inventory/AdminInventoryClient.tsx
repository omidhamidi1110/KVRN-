'use client'
import { useState, useEffect, useCallback } from 'react'

type Variant = {
  id: string; sku: string; size: string; color_name: string
  stock_on_hand: number; reserved_quantity: number; available_quantity: number
  active: boolean; product_name: string; updated_at: string
}
type Movement = { id: string; quantity_delta: number; movement_type: string; reason: string; note: string | null; actor_email: string; created_at: string }

export default function AdminInventoryClient() {
  const [variants, setVariants] = useState<Variant[]>([])
  const [loading,  setLoading]  = useState(true)
  const [error,    setError]    = useState('')
  const [selected, setSelected] = useState<string | null>(null)
  const [movements, setMovements] = useState<Movement[]>([])
  const [form, setForm] = useState({ type: 'ADD', quantity: '', reason: '', note: '' })
  const [submitting, setSubmitting] = useState(false)
  const [feedback, setFeedback] = useState<{ ok: boolean; msg: string } | null>(null)

  const load = useCallback(async () => {
    setLoading(true)
    const r = await fetch('/api/admin/inventory')
    if (!r.ok) { setError('Not authorised or failed to load.'); setLoading(false); return }
    const data = await r.json()
    setVariants(data.variants)
    setLoading(false)
  }, [])

  useEffect(() => { load() }, [load])

  const loadMovements = async (variantId: string) => {
    const r = await fetch(`/api/admin/inventory/movements?variantId=${variantId}`)
    if (r.ok) setMovements((await r.json()).movements)
  }

  const selectVariant = (id: string) => { setSelected(id); loadMovements(id) }

  const submit = async () => {
    if (!selected || !form.reason.trim()) return
    const qty = parseInt(form.quantity, 10)
    if (isNaN(qty) || qty < 0) { setFeedback({ ok: false, msg: 'Invalid quantity.' }); return }
    setSubmitting(true)
    const r = await fetch('/api/admin/inventory', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: selected, type: form.type, quantity: qty, reason: form.reason, note: form.note }),
    })
    const data = await r.json()
    if (r.ok) {
      setFeedback({ ok: true, msg: 'Stock updated.' })
      setForm(f => ({ ...f, quantity: '', reason: '', note: '' }))
      await load(); await loadMovements(selected)
    } else {
      setFeedback({ ok: false, msg: data.error ?? 'Error.' })
    }
    setSubmitting(false)
  }

  const toggleActive = async (id: string, active: boolean) => {
    await fetch('/api/admin/inventory/active', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ variantId: id, active: !active }),
    })
    load()
  }

  if (loading) return <div style={S.wrap}><p>Loading inventory…</p></div>
  if (error)   return <div style={S.wrap}><p style={{ color: 'red' }}>{error}</p></div>

  const sel = variants.find(v => v.id === selected)

  return (
    <div style={S.wrap}>
      <h1 style={S.h1}>KVRN Inventory Dashboard</h1>

      <table style={S.table}>
        <thead>
          <tr>
            {['Product','Size','SKU','On Hand','Reserved','Available','Active','Updated','Actions'].map(h => (
              <th key={h} style={S.th}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {variants.map(v => (
            <tr key={v.id} style={{ background: selected === v.id ? '#f0f4ff' : undefined }}>
              <td style={S.td}>{v.product_name}</td>
              <td style={S.td}>{v.size}</td>
              <td style={{ ...S.td, fontFamily: 'monospace', fontSize: 11 }}>{v.sku}</td>
              <td style={S.td}>{v.stock_on_hand}</td>
              <td style={S.td}>{v.reserved_quantity}</td>
              <td style={{ ...S.td, fontWeight: 600, color: Number(v.available_quantity) > 0 ? '#15803d' : '#b91c1c' }}>
                {v.available_quantity}
              </td>
              <td style={S.td}>{v.active ? '✓' : '✗'}</td>
              <td style={{ ...S.td, fontSize: 11 }}>{new Date(v.updated_at).toLocaleString()}</td>
              <td style={S.td}>
                <button style={S.btn} onClick={() => selectVariant(v.id)}>Edit</button>
                <button style={{ ...S.btn, marginLeft: 4, background: v.active ? '#fee2e2' : '#dcfce7' }}
                  onClick={() => { if (confirm(`${v.active ? 'Deactivate' : 'Activate'} ${v.sku}?`)) toggleActive(v.id, v.active) }}>
                  {v.active ? 'Deactivate' : 'Activate'}
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>

      {sel && (
        <div style={S.panel}>
          <h2 style={{ margin: '0 0 12px' }}>Adjust: {sel.sku} (Current stock: {sel.stock_on_hand})</h2>

          <div style={{ display: 'flex', gap: 12, flexWrap: 'wrap', alignItems: 'flex-end' }}>
            <label style={S.label}>
              Action
              <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value }))} style={S.input}>
                <option value="ADD">Add stock</option>
                <option value="REMOVE">Remove stock</option>
                <option value="SET">Set absolute quantity</option>
              </select>
            </label>

            <label style={S.label}>
              Quantity *
              <input type="number" min={0} value={form.quantity}
                onChange={e => setForm(f => ({ ...f, quantity: e.target.value }))}
                style={S.input} />
            </label>

            <label style={S.label}>
              Reason * <span style={{ fontSize: 11, color: '#888' }}>(required)</span>
              <input type="text" value={form.reason}
                onChange={e => setForm(f => ({ ...f, reason: e.target.value }))}
                placeholder="e.g. Initial stock entry" style={{ ...S.input, width: 220 }} />
            </label>

            <label style={S.label}>
              Note <span style={{ fontSize: 11, color: '#888' }}>(optional)</span>
              <input type="text" value={form.note}
                onChange={e => setForm(f => ({ ...f, note: e.target.value }))}
                style={{ ...S.input, width: 220 }} />
            </label>

            <button onClick={submit} disabled={submitting || !form.reason.trim() || form.quantity === ''} style={S.submitBtn}>
              {submitting ? 'Saving…' : 'Save'}
            </button>
          </div>

          {feedback && (
            <p style={{ marginTop: 8, color: feedback.ok ? '#15803d' : '#b91c1c', fontWeight: 600 }}>
              {feedback.msg}
            </p>
          )}

          {movements.length > 0 && (
            <div style={{ marginTop: 20 }}>
              <h3 style={{ margin: '0 0 8px', fontSize: 14 }}>Recent movements</h3>
              <table style={{ ...S.table, fontSize: 12 }}>
                <thead>
                  <tr>{['Time','Type','Delta','Reason','Note','Actor'].map(h=><th key={h} style={S.th}>{h}</th>)}</tr>
                </thead>
                <tbody>
                  {movements.map(m => (
                    <tr key={m.id}>
                      <td style={S.td}>{new Date(m.created_at).toLocaleString()}</td>
                      <td style={S.td}>{m.movement_type}</td>
                      <td style={{ ...S.td, color: m.quantity_delta >= 0 ? '#15803d' : '#b91c1c' }}>
                        {m.quantity_delta >= 0 ? '+' : ''}{m.quantity_delta}
                      </td>
                      <td style={S.td}>{m.reason}</td>
                      <td style={S.td}>{m.note ?? '—'}</td>
                      <td style={S.td}>{m.actor_email}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}
    </div>
  )
}

const S = {
  wrap:      { maxWidth: 1200, margin: '0 auto', padding: '40px 24px', fontFamily: 'system-ui, sans-serif' },
  h1:        { fontSize: 24, marginBottom: 24, fontWeight: 600 },
  table:     { width: '100%', borderCollapse: 'collapse' as const, fontSize: 13 },
  th:        { textAlign: 'left' as const, padding: '8px 10px', background: '#f1f5f9', borderBottom: '1px solid #e2e8f0', fontWeight: 600, fontSize: 12 },
  td:        { padding: '8px 10px', borderBottom: '1px solid #f1f5f9' },
  panel:     { marginTop: 32, padding: 24, background: '#f8fafc', borderRadius: 8, border: '1px solid #e2e8f0' },
  label:     { display: 'flex' as const, flexDirection: 'column' as const, gap: 4, fontSize: 12, fontWeight: 500 },
  input:     { border: '1px solid #d1d5db', borderRadius: 4, padding: '6px 10px', fontSize: 13, width: 100 },
  btn:       { padding: '4px 10px', fontSize: 12, cursor: 'pointer', background: '#f1f5f9', border: '1px solid #d1d5db', borderRadius: 4 },
  submitBtn: { padding: '8px 20px', background: '#1A1A1A', color: '#fff', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 600, fontSize: 13, alignSelf: 'flex-end' as const },
}
