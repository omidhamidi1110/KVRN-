'use client'

import { useEffect, useState } from 'react'
import { maskPhone } from '@/lib/phone'

type Sub = {
  id: string; phoneE164: string; status: string
  consentSource: string; consentedAt: string
  syncStatus: string | null; createdAt: string
}
type Stats = { total: number; subscribed: number; unsubscribed: number; recent: Sub[] }

const STATUS_COLOURS: Record<string, string> = { subscribed:'#059669', unsubscribed:'#6B7280' }

function Badge({ text, colour }: { text: string; colour: string }) {
  return (
    <span style={{ display:'inline-block', padding:'2px 8px', borderRadius:2,
      fontSize:11, fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase',
      background: colour+'18', color: colour, border:`1px solid ${colour}40` }}>{text}</span>
  )
}

export function AdminSmsClient() {
  const [data, setData] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/sms', { cache:'no-store' })
      .then(r => r.json())
      .then(j => { if (j.success) setData(j.data); else setError(j.error ?? 'Failed.') })
      .catch(() => setError('Network error.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <div style={{ minHeight:'100vh', background:'#F9F8F6', paddingTop:'calc(36px + 56px)' }}>
      <div style={{ maxWidth:1100, margin:'0 auto', padding:'32px 24px' }}>
        <div style={{ display:'flex', justifyContent:'space-between', alignItems:'center', marginBottom:24 }}>
          <h1 style={{ fontSize:20, fontWeight:500, color:'#1A1A1A', letterSpacing:'0.04em', textTransform:'uppercase' }}>
            SMS Subscribers
          </h1>
          <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer"
            style={{ fontSize:12, color:'#6b7280', textDecoration:'underline' }}>
            Twilio Console ↗
          </a>
        </div>

        <div style={{ background:'#FEF3C7', border:'1px solid #F59E0B', padding:'10px 14px',
                      fontSize:12, color:'#92400E', marginBottom:24 }}>
          A2P 10DLC Brand/Campaign approval is pending. Promotional SMS sends are not yet enabled at scale.
        </div>

        {loading && <p style={{ color:'#9B9B9B', fontSize:13 }}>Loading…</p>}
        {error   && <p style={{ color:'#B91C1C', fontSize:13 }}>{error}</p>}

        {data && (
          <>
            <div style={{ display:'flex', gap:16, flexWrap:'wrap', marginBottom:32 }}>
              {[
                { label:'Total',        value: data.total },
                { label:'Subscribed',   value: data.subscribed },
                { label:'Unsubscribed', value: data.unsubscribed },
              ].map(s => (
                <div key={s.label} style={{ background:'#fff', border:'1px solid #E8E5E0',
                  padding:'16px 24px', minWidth:120 }}>
                  <p style={{ fontSize:11, color:'#9B9B9B', letterSpacing:'0.06em', textTransform:'uppercase', margin:0 }}>{s.label}</p>
                  <p style={{ fontSize:28, fontWeight:500, color:'#1A1A1A', margin:'4px 0 0' }}>{s.value}</p>
                </div>
              ))}
            </div>

            <div style={{ overflowX:'auto' }}>
              <table style={{ width:'100%', borderCollapse:'collapse', fontSize:12 }}>
                <thead>
                  <tr style={{ borderBottom:'2px solid #E8E5E0' }}>
                    {['Phone','Status','Source','Consented','Signed Up'].map(h => (
                      <th key={h} style={{ padding:'8px 10px', textAlign:'left', fontSize:11,
                        fontWeight:600, letterSpacing:'0.06em', textTransform:'uppercase', color:'#6b7280' }}>
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {data.recent.map(s => (
                    <tr key={s.id} style={{ borderBottom:'1px solid #F1EEE8' }}>
                      <td style={{ padding:'10px', fontFamily:'monospace' }}>{maskPhone(s.phoneE164)}</td>
                      <td style={{ padding:'10px' }}>
                        <Badge text={s.status} colour={STATUS_COLOURS[s.status] ?? '#6B7280'} />
                      </td>
                      <td style={{ padding:'10px', color:'#6b7280' }}>{s.consentSource}</td>
                      <td style={{ padding:'10px', color:'#6b7280' }}>
                        {new Date(s.consentedAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}
                      </td>
                      <td style={{ padding:'10px', color:'#9B9B9B' }}>
                        {new Date(s.createdAt).toLocaleDateString('en-US',{month:'short',day:'numeric',year:'2-digit'})}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
              {data.recent.length === 0 && (
                <p style={{ color:'#9B9B9B', fontSize:13, padding:'16px 0' }}>No SMS subscribers yet.</p>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
