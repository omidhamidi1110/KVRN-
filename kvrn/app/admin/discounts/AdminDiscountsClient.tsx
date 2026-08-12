'use client'
import { useEffect, useState } from 'react'

type Discount = {
  id: string; code: string; name: string; description: string | null
  type: 'fixed_amount' | 'percentage' | 'shipping'
  amountCents: number | null; percentageBps: number | null
  active: boolean; singleUse: boolean
  maxRedemptions: number | null; redemptionCount: number
  minimumSubtotalCents: number | null
  startsAt: string | null; expiresAt: string | null
  createdAt: string
}

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'
const BORDER = '1px solid #E8E5E0'

function fmtVal(d: Discount): string {
  if (d.type === 'fixed_amount' && d.amountCents !== null) return `$${(d.amountCents/100).toFixed(2)}`
  if (d.type === 'percentage'   && d.percentageBps !== null) return `${d.percentageBps/100}%`
  if (d.type === 'shipping') return 'Shipping'
  return '—'
}

function fmt(d: string | null) {
  if (!d) return '—'
  return new Date(d).toLocaleDateString('en-US', { month:'short', day:'numeric', year:'2-digit' })
}

function Badge({ v }: { v: boolean }) {
  return (
    <span style={{ fontSize:10, padding:'2px 7px', borderRadius:2,
      background: v ? '#D1FAE5' : '#F3F4F6',
      color: v ? '#065F46' : '#6B7280',
      fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase' }}>
      {v ? 'Active' : 'Inactive'}
    </span>
  )
}

const emptyForm = {
  code:'', name:'', description:'', type:'fixed_amount' as Discount['type'],
  amountCents: 1000, percentageBps: null as number | null,
  active: true, singleUse: false, maxRedemptions: null as number | null,
  minimumSubtotalCents: null as number | null,
  startsAt: '', expiresAt: '',
}

export function AdminDiscountsClient() {
  const [discounts, setDiscounts] = useState<Discount[]>([])
  const [loading,   setLoading]   = useState(true)
  const [error,     setError]     = useState('')
  const [form,      setForm]      = useState(emptyForm)
  const [creating,  setCreating]  = useState(false)
  const [showForm,  setShowForm]  = useState(false)
  const [saving,    setSaving]    = useState(false)

  const load = () => {
    setLoading(true)
    fetch('/api/admin/discounts')
      .then(r => r.json())
      .then(j => { if (j.success) setDiscounts(j.data); else setError(j.error ?? 'Failed.') })
      .catch(() => setError('Network error.'))
      .finally(() => setLoading(false))
  }

  useEffect(() => { load() }, [])

  const handleDeactivate = async (id: string) => {
    if (!confirm('Deactivate this discount?')) return
    const r = await fetch(`/api/admin/discounts/${id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ active: false })
    })
    if (r.ok) load()
  }

  const handleDelete = async (id: string) => {
    if (!confirm('Delete this discount? Only allowed if no redemptions exist.')) return
    const r = await fetch(`/api/admin/discounts/${id}`, { method: 'DELETE' })
    const j = await r.json()
    if (!r.ok) { alert(j.error ?? 'Delete failed.'); return }
    load()
  }

  const handleCreate = async () => {
    setSaving(true)
    const r = await fetch('/api/admin/discounts', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...form,
        amountCents:         form.type === 'fixed_amount' ? form.amountCents : null,
        percentageBps:       form.type === 'percentage'   ? form.percentageBps : null,
        startsAt:            form.startsAt  || null,
        expiresAt:           form.expiresAt || null,
        description:         form.description || null,
        maxRedemptions:      form.maxRedemptions,
        minimumSubtotalCents:form.minimumSubtotalCents,
      })
    })
    const j = await r.json()
    setSaving(false)
    if (!r.ok) { alert(j.error ?? 'Failed to create.'); return }
    setShowForm(false)
    setForm(emptyForm)
    load()
  }

  const inputSt = (extra?: any) => ({
    width: '100%', padding: '8px 10px', border: BORDER, fontSize: 13,
    outline: 'none', boxSizing: 'border-box' as const, fontFamily: FONT,
    ...extra
  })

  return (
    <div style={{ minHeight:'100vh', background:'#F9F8F6', paddingTop:'calc(36px + 56px)' }}>
      <div style={{ maxWidth:1200, margin:'0 auto', padding:'32px 24px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <h1 style={{ fontSize:20, fontWeight:500, color:'#1A1A1A', letterSpacing:'0.04em', textTransform:'uppercase', margin:0 }}>
            Discounts
          </h1>
          <button onClick={() => setShowForm(!showForm)}
            style={{ background:'#1A1A1A', color:'#fff', border:'none', cursor:'pointer', padding:'9px 16px',
                     fontFamily:FONT, fontSize:11, fontWeight:500, letterSpacing:'0.08em', textTransform:'uppercase' }}>
            {showForm ? 'CANCEL' : '+ NEW DISCOUNT'}
          </button>
        </div>

        {showForm && (
          <div style={{ background:'#fff', border:BORDER, padding:24, marginBottom:24 }}>
            <h2 style={{ fontSize:13, fontWeight:600, margin:'0 0 16px', letterSpacing:'0.04em' }}>CREATE DISCOUNT</h2>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr', gap:12, marginBottom:12 }}>
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Code *</label>
                <input value={form.code} onChange={e => setForm(f => ({ ...f, code: e.target.value.toUpperCase() }))} style={inputSt()} placeholder="KVRN10" />
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Name *</label>
                <input value={form.name} onChange={e => setForm(f => ({ ...f, name: e.target.value }))} style={inputSt()} placeholder="Internal name" />
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Type *</label>
                <select value={form.type} onChange={e => setForm(f => ({ ...f, type: e.target.value as Discount['type'] }))} style={{ ...inputSt(), background:'#fff' }}>
                  <option value="fixed_amount">Fixed amount</option>
                  <option value="percentage">Percentage</option>
                  <option value="shipping">Shipping</option>
                </select>
              </div>
            </div>
            <div style={{ display:'grid', gridTemplateColumns:'1fr 1fr 1fr 1fr', gap:12, marginBottom:12 }}>
              {form.type === 'fixed_amount' && (
                <div>
                  <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Amount (cents)</label>
                  <input type="number" value={form.amountCents ?? ''} onChange={e => setForm(f => ({ ...f, amountCents: Number(e.target.value) }))} style={inputSt()} placeholder="1000" />
                </div>
              )}
              {form.type === 'percentage' && (
                <div>
                  <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>% BPS</label>
                  <input type="number" value={form.percentageBps ?? ''} onChange={e => setForm(f => ({ ...f, percentageBps: Number(e.target.value) }))} style={inputSt()} placeholder="1000 = 10%" />
                </div>
              )}
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Max uses</label>
                <input type="number" value={form.maxRedemptions ?? ''} onChange={e => setForm(f => ({ ...f, maxRedemptions: e.target.value ? Number(e.target.value) : null }))} style={inputSt()} placeholder="∞" />
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Min subtotal (cents)</label>
                <input type="number" value={form.minimumSubtotalCents ?? ''} onChange={e => setForm(f => ({ ...f, minimumSubtotalCents: e.target.value ? Number(e.target.value) : null }))} style={inputSt()} placeholder="none" />
              </div>
              <div>
                <label style={{ display:'block', fontSize:10, color:'#888', letterSpacing:'0.06em', textTransform:'uppercase', marginBottom:4 }}>Expires at</label>
                <input type="date" value={form.expiresAt} onChange={e => setForm(f => ({ ...f, expiresAt: e.target.value }))} style={inputSt()} />
              </div>
            </div>
            <div style={{ display:'flex', gap:16, marginBottom:16 }}>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, cursor:'pointer' }}>
                <input type="checkbox" checked={form.singleUse} onChange={e => setForm(f => ({ ...f, singleUse: e.target.checked }))} />
                Single use
              </label>
              <label style={{ display:'flex', alignItems:'center', gap:6, fontSize:12, cursor:'pointer' }}>
                <input type="checkbox" checked={form.active} onChange={e => setForm(f => ({ ...f, active: e.target.checked }))} />
                Active
              </label>
            </div>
            <button onClick={handleCreate} disabled={saving}
              style={{ background:'#1A1A1A', color:'#fff', border:'none', cursor:'pointer', padding:'10px 20px',
                       fontFamily:FONT, fontSize:11, fontWeight:500, letterSpacing:'0.08em', textTransform:'uppercase',
                       opacity: saving ? 0.5 : 1 }}>
              {saving ? 'SAVING…' : 'CREATE DISCOUNT'}
            </button>
          </div>
        )}

        {loading && <p style={{ color:'#9B9B9B', fontSize:13 }}>Loading…</p>}
        {error   && <p style={{ color:'#B91C1C', fontSize:13 }}>{error}</p>}

        {!loading && (
          <div style={{ overflowX:'auto' }}>
            <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
              <thead>
                <tr style={{ borderBottom:'2px solid #E8E5E0' }}>
                  {['Code','Name','Type','Value','Active','Single use','Uses','Max','Min subtotal','Expires','Created'].map(h => (
                    <th key={h} style={{ padding:'8px 10px', textAlign:'left', fontSize:10, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'#6b7280', whiteSpace:'nowrap' }}>{h}</th>
                  ))}
                  <th style={{ padding:'8px 10px' }}></th>
                </tr>
              </thead>
              <tbody>
                {discounts.map(d => (
                  <tr key={d.id} style={{ borderBottom:'1px solid #F1EEE8' }}>
                    <td style={{ padding:'10px', fontFamily:'monospace', fontWeight:600 }}>{d.code}</td>
                    <td style={{ padding:'10px', color:'#5A5A5A' }}>{d.name}</td>
                    <td style={{ padding:'10px', color:'#6b7280', textTransform:'capitalize' }}>{d.type.replace('_',' ')}</td>
                    <td style={{ padding:'10px' }}>{fmtVal(d)}</td>
                    <td style={{ padding:'10px' }}><Badge v={d.active} /></td>
                    <td style={{ padding:'10px', color:'#6b7280' }}>{d.singleUse ? 'Yes' : 'No'}</td>
                    <td style={{ padding:'10px', color:'#6b7280' }}>{d.redemptionCount}</td>
                    <td style={{ padding:'10px', color:'#6b7280' }}>{d.maxRedemptions ?? '∞'}</td>
                    <td style={{ padding:'10px', color:'#6b7280' }}>{d.minimumSubtotalCents ? `$${(d.minimumSubtotalCents/100).toFixed(0)}` : '—'}</td>
                    <td style={{ padding:'10px', color:'#6b7280', whiteSpace:'nowrap' }}>{fmt(d.expiresAt)}</td>
                    <td style={{ padding:'10px', color:'#9B9B9B', whiteSpace:'nowrap' }}>{fmt(d.createdAt)}</td>
                    <td style={{ padding:'10px', whiteSpace:'nowrap' }}>
                      {d.active && (
                        <button onClick={() => handleDeactivate(d.id)}
                          style={{ fontSize:10, padding:'3px 8px', border:BORDER, background:'none', cursor:'pointer', letterSpacing:'0.04em', textTransform:'uppercase', marginRight:4 }}>
                          Deactivate
                        </button>
                      )}
                      {d.redemptionCount === 0 && (
                        <button onClick={() => handleDelete(d.id)}
                          style={{ fontSize:10, padding:'3px 8px', border:'1px solid #FCA5A5', background:'none', cursor:'pointer', letterSpacing:'0.04em', textTransform:'uppercase', color:'#B91C1C' }}>
                          Delete
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            {discounts.length === 0 && (
              <p style={{ color:'#9B9B9B', fontSize:13, padding:'16px 0' }}>No discounts yet.</p>
            )}
          </div>
        )}
      </div>
    </div>
  )
}
