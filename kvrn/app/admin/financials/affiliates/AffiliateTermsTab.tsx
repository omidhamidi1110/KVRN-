'use client'
// Terms & settings: versioned program documents (publish = new immutable version), the re-acceptance
// list, and program settings (eligible countries, rate limits, defaults).

import { useCallback, useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminEmpty, AdminError, AdminField, AdminLoading, AdminNotice, AdminSectionHeader,
  AdminTable, AdminTd, AdminTh, InfoTip, StatusBadge, adminInputClass, useConfirm,
} from '@/components/admin/ui/AdminUI'
import { bpsToPercent, centsToDollars, dollarsToCents, formatDate, formatDateTime, percentToBps, readinessMessage } from '@/lib/affiliate-program-ui'
import { documentHref } from '@/lib/affiliate-program-docs'
import { adminApi } from './api'

const DOC_TYPES: Array<[string, string]> = [
  ['program_terms', 'Program terms'], ['disclosure_policy', 'Disclosure policy'], ['privacy_notice', 'Privacy notice'],
  ['brand_rules', 'Brand rules'], ['ugc_license', 'Content license'],
]

export function AffiliateTermsTab({ onChanged }: { onChanged?: () => void }) {
  return (
    <div className="space-y-8">
      <DocumentsSection onChanged={onChanged} />
      <ReacceptanceSection onChanged={onChanged} />
      <SettingsSection />
    </div>
  )
}

function DocumentsSection({ onChanged }: { onChanged?: () => void }) {
  const [docs, setDocs] = useState<any[] | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [docType, setDocType] = useState('program_terms')
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [summary, setSummary] = useState('')
  const [material, setMaterial] = useState(false)
  const [busy, setBusy] = useState(false)
  const { confirm, node } = useConfirm()

  const load = useCallback(async () => {
    const r = await adminApi('/api/admin/affiliates/documents')
    if (!r.ok) { setErr(r.error); return }
    setErr(null); setDocs(r.data.documents)
  }, [])
  useEffect(() => { void load() }, [load])

  const forType = (docs ?? []).filter(d => d.docType === docType)
  const current = forType.find(d => d.isCurrent)
  const draft = forType.find(d => d.isDraft)

  // Start editing from the draft if there is one, else from the current version.
  useEffect(() => {
    const src = draft ?? current
    if (src) { setTitle(src.title); setBody(src.body); setSummary(draft?.changeSummary ?? '') }
    else { setTitle(''); setBody(''); setSummary('') }
    setMaterial(false)
  }, [docType, docs]) // eslint-disable-line react-hooks/exhaustive-deps

  const act = async (payload: Record<string, unknown>, ok: string) => {
    setBusy(true); setErr(null)
    const r = await adminApi('/api/admin/affiliates/documents', { body: payload })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return false }
    setFlash(ok); await load(); onChanged?.(); return true
  }

  return (
    <section>
      <AdminSectionHeader title="Documents" info="Every published version is permanent and is never edited. A change is a new version. Affiliates accept the versions they were shown, and each acceptance is recorded." />
      {flash && <AdminNotice tone="success" className="mb-3">{flash}</AdminNotice>}
      {err && <AdminError message={err} onRetry={() => void load()} />}
      {!docs && !err && <AdminLoading />}
      {docs && (
        <div className="space-y-4">
          <AdminField label="Document" htmlFor="doc-type">
            <select id="doc-type" className={`${adminInputClass} w-64`} value={docType} onChange={e => setDocType(e.target.value)}>
              {DOC_TYPES.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
            </select>
          </AdminField>
          {current?.isPlaceholder && (
            <AdminNotice tone="warning" title="The current version is a placeholder">
              It has not had legal review. The public application form stays closed until real wording is published here.
            </AdminNotice>
          )}
          <AdminTable caption="Versions">
            <thead><tr><AdminTh>Version</AdminTh><AdminTh>Title</AdminTh><AdminTh>State</AdminTh><AdminTh>Published</AdminTh><AdminTh>Change</AdminTh><AdminTh /></tr></thead>
            <tbody>
              {forType.length === 0 && <tr><AdminTd>—</AdminTd><AdminTd>None yet</AdminTd><AdminTd /><AdminTd /><AdminTd /><AdminTd /></tr>}
              {forType.map(d => (
                <tr key={d.id}>
                  <AdminTd>{d.isDraft ? 'Draft' : d.version}</AdminTd>
                  <AdminTd>{d.title}</AdminTd>
                  <AdminTd>{d.isCurrent ? <StatusBadge status="Live" label="Current" /> : d.isDraft ? <StatusBadge status="Draft" /> : <StatusBadge status="Archived" label="Superseded" />}{d.isPlaceholder && <span className="ml-1"><StatusBadge status="Review" label="Placeholder" /></span>}</AdminTd>
                  <AdminTd>{formatDate(d.publishedAt)}</AdminTd>
                  <AdminTd>{d.materialChange ? 'Material' : '—'}{d.changeSummary ? <div className="text-[11px] text-[#6B6B66]">{d.changeSummary}</div> : null}</AdminTd>
                  <AdminTd>{!d.isDraft && <a className="underline underline-offset-2" href={documentHref(d.docType, d.version)} target="_blank" rel="noopener noreferrer">View</a>}</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>

          <AdminCard>
            <h3 className="text-[13px] font-medium">{draft ? 'Edit draft' : 'New version'}</h3>
            <div className="mt-3 space-y-3">
              <AdminField label="Title" htmlFor="doc-title"><input id="doc-title" className={adminInputClass} value={title} onChange={e => setTitle(e.target.value)} /></AdminField>
              <AdminField label="Text" htmlFor="doc-body" info="Use # for headings, - for bullet points and **bold**. Nothing else is rendered, so no HTML or scripts can run."><textarea id="doc-body" rows={14} className={`${adminInputClass} h-auto py-2 font-mono`} value={body} onChange={e => setBody(e.target.value)} /></AdminField>
              <AdminField label="What changed (optional)" htmlFor="doc-summary" hint="Shown to affiliates in the update email."><input id="doc-summary" className={adminInputClass} value={summary} onChange={e => setSummary(e.target.value)} /></AdminField>
              <div className="flex flex-wrap gap-2">
                <AdminButton loading={busy} onClick={() => void act({ action: 'save_draft', document: { docType, title, body, changeSummary: summary } }, 'Draft saved.')}>Save draft</AdminButton>
                {draft && <AdminButton variant="ghost" disabled={busy} onClick={() => void act({ action: 'discard_draft', documentId: draft.id }, 'Draft discarded.')}>Discard draft</AdminButton>}
              </div>
              {draft && (
                <div className="space-y-3 rounded-[12px] border border-black/[0.08] p-4">
                  <label className="flex items-start gap-2 text-[12px]">
                    <input type="checkbox" className="mt-0.5" checked={material} onChange={e => setMaterial(e.target.checked)} />
                    <span>This is a material change. Existing affiliates must accept it again and are emailed. <InfoTip label="About material changes">Tick this for changes that affect rights, pay or obligations. Leave it off for typo fixes. Affiliates who have not accepted the latest material version are flagged for re-acceptance.</InfoTip></span>
                  </label>
                  <AdminNotice tone="warning">Publishing is permanent. This text becomes the current version for new applicants immediately and can’t be edited afterwards. Save the draft first if you changed anything.</AdminNotice>
                  <AdminButton variant="primary" loading={busy} onClick={async () => {
                    if (await confirm(`Publish this ${material ? 'material ' : ''}version of the ${DOC_TYPES.find(d => d[0] === docType)?.[1].toLowerCase()}? It can’t be edited or removed afterwards.`)) void act({ action: 'publish', documentId: draft.id, material }, 'Published.')
                  }}>Publish…</AdminButton>
                </div>
              )}
            </div>
          </AdminCard>
        </div>
      )}
      {node}
    </section>
  )
}

function ReacceptanceSection({ onChanged }: { onChanged?: () => void }) {
  const [rows, setRows] = useState<any[] | null>(null)
  const [sel, setSel] = useState<Set<string>>(new Set())
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const load = useCallback(async () => {
    const r = await adminApi('/api/admin/affiliates/documents')
    if (!r.ok) { setErr(r.error); return }
    setErr(null); setRows(r.data.reacceptance)
  }, [])
  useEffect(() => { void load() }, [load])

  const toggle = (id: string) => setSel(s => { const n = new Set(s); n.has(id) ? n.delete(id) : n.add(id); return n })
  const send = async () => {
    setBusy(true); setErr(null)
    const r = await adminApi('/api/admin/affiliates/documents', { body: { action: 'request_reacceptance', affiliateIds: [...sel] } })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return }
    setFlash('Requests sent.'); setSel(new Set()); await load(); onChanged?.()
  }

  return (
    <section>
      <AdminSectionHeader title="Re-acceptance" info="Affiliates who have not accepted the current program terms and disclosure policy. Existing affiliates are not blocked automatically; asking marks them and sends an email." />
      {flash && <AdminNotice tone="success" className="mb-3">{flash}</AdminNotice>}
      {err && <AdminError message={err} onRetry={() => void load()} />}
      {!rows && !err && <AdminLoading />}
      {rows && rows.length === 0 && <AdminEmpty title="Everyone is up to date" />}
      {rows && rows.length > 0 && (
        <>
          <AdminTable caption="Affiliates needing re-acceptance">
            <thead><tr><AdminTh /><AdminTh>Affiliate</AdminTh><AdminTh>Accepted</AdminTh><AdminTh>Current</AdminTh><AdminTh>Reason</AdminTh></tr></thead>
            <tbody>
              {rows.map(r => (
                <tr key={r.affiliateId}>
                  <AdminTd><input type="checkbox" aria-label={`Select ${r.code}`} checked={sel.has(r.affiliateId)} onChange={() => toggle(r.affiliateId)} /></AdminTd>
                  <AdminTd><div className="font-medium">{r.displayName || r.code}</div><div className="font-mono text-[11px] text-[#6B6B66]">{r.code}</div></AdminTd>
                  <AdminTd>{r.acceptedProgramTermsVersion ?? 'None'} / {r.acceptedDisclosureVersion ?? 'None'}</AdminTd>
                  <AdminTd>{r.currentProgramTermsVersion} / {r.currentDisclosureVersion}</AdminTd>
                  <AdminTd>{r.reason === 'not_accepted' ? 'Never accepted' : 'Newer version published'}{r.requiresReacceptance ? ' (requested)' : ''}</AdminTd>
                </tr>
              ))}
            </tbody>
          </AdminTable>
          <div className="mt-3"><AdminButton variant="primary" loading={busy} disabled={sel.size === 0} onClick={() => void send()}>Ask {sel.size || ''} selected to accept</AdminButton></div>
        </>
      )}
    </section>
  )
}

function SettingsSection() {
  const [data, setData] = useState<any>(null)
  const [err, setErr] = useState<string | null>(null)
  const [flash, setFlash] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [f, setF] = useState<any>(null)

  const load = useCallback(async () => {
    const r = await adminApi('/api/admin/affiliates/settings')
    if (!r.ok) { setErr(r.error); return }
    const s = r.data.settings
    setErr(null); setData(r.data)
    setF({
      countries: s.countries.join(', '), allowPlaceholderDocuments: s.allowPlaceholderDocuments, inviteExpiryDays: String(s.inviteExpiryDays),
      perIpPerHour: String(s.rateLimits.perIpPerHour), perIpPerDay: String(s.rateLimits.perIpPerDay), perEmailPerDay: String(s.rateLimits.perEmailPerDay), globalPerHour: String(s.rateLimits.globalPerHour),
      commissionType: s.defaults.commissionType, rate: bpsToPercent(s.defaults.commissionRateBps), window: String(s.defaults.attributionWindowDays), hold: String(s.defaults.commissionHoldDays),
      threshold: centsToDollars(s.defaults.payoutThresholdCents), schedule: s.defaults.payoutSchedule ?? '', ads: s.defaults.paidAdsPolicy,
    })
  }, [])
  useEffect(() => { void load() }, [load])

  const save = async () => {
    const rate = percentToBps(f.rate), thr = dollarsToCents(f.threshold)
    if (Number.isNaN(rate) || Number.isNaN(thr)) { setErr('Check the default commission and threshold.'); return }
    setBusy(true); setErr(null)
    const r = await adminApi('/api/admin/affiliates/settings', {
      method: 'PUT',
      body: {
        revision: data.revision,
        settings: {
          countries: f.countries.split(/[\s,]+/).filter(Boolean).map((c: string) => c.toUpperCase()), allowPlaceholderDocuments: !!f.allowPlaceholderDocuments,
          inviteExpiryDays: Number(f.inviteExpiryDays),
          rateLimits: { perIpPerHour: Number(f.perIpPerHour), perIpPerDay: Number(f.perIpPerDay), perEmailPerDay: Number(f.perEmailPerDay), globalPerHour: Number(f.globalPerHour) },
          defaults: { commissionType: f.commissionType, commissionRateBps: rate, attributionWindowDays: Number(f.window), commissionHoldDays: Number(f.hold), payoutThresholdCents: thr, payoutSchedule: f.schedule || null, paidAdsPolicy: f.ads },
        },
      },
    })
    setBusy(false)
    if (!r.ok) { setErr(r.error); return }
    setFlash('Settings saved.'); await load()
  }

  if (err && !data) return <AdminError message={err} onRetry={() => void load()} />
  if (!data || !f) return <AdminLoading />
  const ready = readinessMessage(data.readiness)
  const set = (k: string, v: any) => setF((p: any) => ({ ...p, [k]: v }))

  return (
    <section>
      <AdminSectionHeader title="Program settings" />
      <AdminNotice tone={ready.tone} title={ready.title} className="mb-3">
        {ready.reasons.length > 0 && <ul className="list-disc pl-5">{ready.reasons.map(r => <li key={r}>{r}</li>)}</ul>}
      </AdminNotice>
      {flash && <AdminNotice tone="success" className="mb-3">{flash}</AdminNotice>}
      {err && <AdminNotice tone="danger" className="mb-3">{err}</AdminNotice>}
      <AdminCard>
        <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-3">
          <AdminField label="Eligible countries" htmlFor="st-countries" info="Two-letter country codes, separated by commas. Applicants from other countries are turned away."><input id="st-countries" className={adminInputClass} value={f.countries} onChange={e => set('countries', e.target.value)} /></AdminField>
          <AdminField label="Invitation lifetime (days)" htmlFor="st-inv"><input id="st-inv" inputMode="numeric" className={adminInputClass} value={f.inviteExpiryDays} onChange={e => set('inviteExpiryDays', e.target.value)} /></AdminField>
          <AdminField label="Applications per hour, per visitor" htmlFor="st-iph" info="Limits are keyed on a one-way hash of the visitor’s network address, never the address itself."><input id="st-iph" inputMode="numeric" className={adminInputClass} value={f.perIpPerHour} onChange={e => set('perIpPerHour', e.target.value)} /></AdminField>
          <AdminField label="Applications per day, per visitor" htmlFor="st-ipd"><input id="st-ipd" inputMode="numeric" className={adminInputClass} value={f.perIpPerDay} onChange={e => set('perIpPerDay', e.target.value)} /></AdminField>
          <AdminField label="Applications per day, per email" htmlFor="st-epd"><input id="st-epd" inputMode="numeric" className={adminInputClass} value={f.perEmailPerDay} onChange={e => set('perEmailPerDay', e.target.value)} /></AdminField>
          <AdminField label="Applications per hour, in total" htmlFor="st-gph"><input id="st-gph" inputMode="numeric" className={adminInputClass} value={f.globalPerHour} onChange={e => set('globalPerHour', e.target.value)} /></AdminField>
          <AdminField label="Default commission (%)" htmlFor="st-rate" hint="Pre-fills the approval form."><input id="st-rate" inputMode="decimal" className={adminInputClass} value={f.rate} onChange={e => set('rate', e.target.value)} /></AdminField>
          <AdminField label="Default window (days)" htmlFor="st-win"><input id="st-win" inputMode="numeric" className={adminInputClass} value={f.window} onChange={e => set('window', e.target.value)} /></AdminField>
          <AdminField label="Default hold (days)" htmlFor="st-hold"><input id="st-hold" inputMode="numeric" className={adminInputClass} value={f.hold} onChange={e => set('hold', e.target.value)} /></AdminField>
          <AdminField label="Default payout threshold ($)" htmlFor="st-thr"><input id="st-thr" inputMode="decimal" className={adminInputClass} value={f.threshold} onChange={e => set('threshold', e.target.value)} /></AdminField>
          <AdminField label="Default payout schedule" htmlFor="st-sched"><select id="st-sched" className={adminInputClass} value={f.schedule} onChange={e => set('schedule', e.target.value)}><option value="">Not set</option><option value="weekly">Weekly</option><option value="biweekly">Every two weeks</option><option value="monthly">Monthly</option><option value="quarterly">Quarterly</option><option value="manual">Manual</option></select></AdminField>
          <AdminField label="Default paid ads" htmlFor="st-ads"><select id="st-ads" className={adminInputClass} value={f.ads} onChange={e => set('ads', e.target.value)}><option value="not_permitted">Not permitted</option><option value="written_approval">Written approval needed</option><option value="approved">Approved</option></select></AdminField>
        </div>
        <label className="mt-4 flex items-start gap-2 text-[12px]">
          <input type="checkbox" className="mt-0.5" checked={f.allowPlaceholderDocuments} onChange={e => set('allowPlaceholderDocuments', e.target.checked)} />
          <span>Testing only: open the form even though the documents are placeholders.</span>
        </label>
        {f.allowPlaceholderDocuments && <AdminNotice tone="danger" className="mt-2" title="Do not leave this on in production">Real applicants would accept unreviewed wording.</AdminNotice>}
        <div className="mt-4"><AdminButton variant="primary" loading={busy} onClick={() => void save()}>Save settings</AdminButton></div>
      </AdminCard>
    </section>
  )
}
