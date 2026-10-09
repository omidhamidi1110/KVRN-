'use client'

import { useEffect, useState } from 'react'
import { maskPhone } from '@/lib/phone'
import {
  AdminPage, AdminPageHeader, AdminNotice, AdminStat, AdminStatGrid, AdminTable, AdminTh, AdminTd,
  AdminEmpty, AdminLoading, AdminError, AdminTag, StatusBadge, adminButtonClass,
} from '@/components/admin/ui/AdminUI'

type Sub = {
  id: string; phoneE164: string; status: string
  consentSource: string; consentedAt: string
  syncStatus: string | null; createdAt: string
}
type Stats = { total: number; subscribed: number; unsubscribed: number; recent: Sub[] }

const fmtDate = (iso: string) =>
  new Date(iso).toLocaleDateString('en-US', { month: 'short', day: 'numeric', year: '2-digit' })

export function AdminSmsClient() {
  const [data, setData] = useState<Stats | null>(null)
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')

  useEffect(() => {
    fetch('/api/admin/sms', { cache: 'no-store' })
      .then(r => r.json())
      .then(j => { if (j.success) setData(j.data); else setError(j.error ?? 'Failed.') })
      .catch(() => setError('Network error.'))
      .finally(() => setLoading(false))
  }, [])

  return (
    <AdminPage>
      <AdminPageHeader
        title="SMS subscribers"
        description="Text-message opt-ins."
        info="A2P 10DLC brand and campaign approval is a carrier registration for business texting. Until it is approved, promotional sends are not enabled at scale."
        actions={
          <a href="https://console.twilio.com" target="_blank" rel="noopener noreferrer"
            className={adminButtonClass('secondary', 'sm')}>
            Twilio Console ↗
          </a>
        }
      />

      <AdminNotice tone="warning" className="mb-6">
        Promotional sending is off — A2P approval pending.
      </AdminNotice>

      {loading && <AdminLoading />}
      {error && <AdminError message={error} />}

      {data && (
        <div className="space-y-6">
          <AdminStatGrid min={140}>
            <AdminStat label="Total" value={data.total} />
            <AdminStat label="Subscribed" value={data.subscribed} />
            <AdminStat label="Unsubscribed" value={data.unsubscribed} />
          </AdminStatGrid>

          {data.recent.length === 0 ? (
            <AdminEmpty title="No SMS subscribers yet." />
          ) : (
            <AdminTable caption="Recent SMS subscribers" minWidth={560} stack>
              <thead><tr>
                {['Phone', 'Status', 'Source', 'Consented', 'Signed up'].map(h => <AdminTh key={h}>{h}</AdminTh>)}
              </tr></thead>
              <tbody>
                {data.recent.map(s => (
                  <tr key={s.id}>
                    <AdminTd className="font-mono">{maskPhone(s.phoneE164)}</AdminTd>
                    <AdminTd>
                      {s.status === 'subscribed' ? <StatusBadge status="Active" label="Subscribed" />
                        : s.status === 'unsubscribed' ? <StatusBadge status="Inactive" label="Unsubscribed" />
                        : <AdminTag>{s.status}</AdminTag>}
                    </AdminTd>
                    <AdminTd className="text-[#6B6B66]">{s.consentSource}</AdminTd>
                    <AdminTd className="text-[#6B6B66]">{fmtDate(s.consentedAt)}</AdminTd>
                    <AdminTd className="text-[#8A8A85]">{fmtDate(s.createdAt)}</AdminTd>
                  </tr>
                ))}
              </tbody>
            </AdminTable>
          )}
        </div>
      )}
    </AdminPage>
  )
}
