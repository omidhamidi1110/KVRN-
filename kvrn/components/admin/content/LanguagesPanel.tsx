'use client'
// Languages & currency: which languages the storefront offers, each language's default currency,
// which display currencies are enabled, and the exchange rates used for ESTIMATES.
//
// Honest by construction:
//   * a language whose wording is incomplete shows NOT READY and cannot be enabled;
//   * translations are marked AI-assisted until a person reviews them;
//   * a currency can be shown as an estimate with a dated rate, but customers are charged in USD —
//     the support table says exactly why no other currency is chargeable yet.

import { useEffect, useState } from 'react'
import {
  AdminButton, AdminCard, AdminError, AdminLoading, AdminNotice, AdminSectionHeader, AdminTable, AdminTh, AdminTd,
  AdminTag, AdminField, adminInputClass, adminSelectClass, adminCheckboxClass, AdminDisclosure,
} from '@/components/admin/ui/AdminUI'
import { api, BASE, type ApiResult } from './api'
import { ErrorNotice } from './ui'

interface LocaleRow {
  code: string; label: string; nativeLabel: string; rtl: boolean; enabled: boolean; defaultCurrency: string
  staticTotal: number; staticPresent: number; staticMissing: number; staticPlaceholderIssues: number; ready: boolean
  review: { status: string; note: string }
  cms: { translated: number; stale: number; missing: number; fields: number; products: number; publishedRows: number; draftRows: number }
}
interface CurrencyRow { code: string; name: string; displayable: boolean; displayNote: string; payable: boolean; payableNote: string; blockers: string[] }
interface Blocker { id: string; where: string; reason: string; work: string }
interface State {
  config: { value: { enabledLocales: string[]; defaultCurrencyByLocale: Record<string, string>; enabledCurrencies: string[] }; revision: number; stored: boolean }
  fx: { value: { rates: Record<string, number>; asOf: string; source: string } | null; revision: number; status: 'fresh' | 'stale' | 'expired' | 'missing'; ageDays: number | null; staleAfterDays: number; expiredAfterDays: number }
  locales: LocaleRow[]
  currencies: CurrencyRow[]
  messageKeyCount: number
  payable: { auditPassed: string[]; multiCurrencyFlag: boolean; blockers: Blocker[] }
}

const REVIEW_LABEL: Record<string, string> = {
  source: 'Source language', ai_assisted_unreviewed: 'AI-assisted, not reviewed',
  native_reviewed: 'Reviewed by a native speaker', professionally_reviewed: 'Professionally reviewed',
}

export function LanguagesPanel() {
  const [st, setSt] = useState<State | null>(null)
  const [err, setErr] = useState<string | null>(null)
  const [enabled, setEnabled] = useState<string[]>([])
  const [defaults, setDefaults] = useState<Record<string, string>>({})
  const [currencies, setCurrencies] = useState<string[]>(['USD'])
  const [rates, setRates] = useState<Record<string, string>>({})
  const [asOf, setAsOf] = useState('')
  const [source, setSource] = useState('')
  const [cfgResult, setCfgResult] = useState<ApiResult | null>(null)
  const [fxResult, setFxResult] = useState<ApiResult | null>(null)
  const [busy, setBusy] = useState<'cfg' | 'fx' | null>(null)
  const [saved, setSaved] = useState<'cfg' | 'fx' | null>(null)

  function adopt(s: State) {
    setSt(s)
    setEnabled(s.config.value.enabledLocales)
    setDefaults(s.config.value.defaultCurrencyByLocale)
    setCurrencies(s.config.value.enabledCurrencies)
    setRates(Object.fromEntries(Object.entries(s.fx.value?.rates ?? {}).map(([k, v]) => [k, String(v)])))
    setAsOf(s.fx.value?.asOf ?? '')
    setSource(s.fx.value?.source ?? '')
  }
  async function load() {
    const r = await api<State>('GET', `${BASE}/i18n`)
    if (!r.ok) { setErr(r.error ?? 'Could not load.'); return }
    setErr(null); adopt(r.data!)
  }
  useEffect(() => { load() }, [])

  if (err) return <AdminError message={err} onRetry={load} />
  if (!st) return <AdminLoading />

  const toggleLocale = (code: string, on: boolean) => { setSaved(null); setEnabled(on ? [...new Set([...enabled, code])] : enabled.filter(c => c !== code)) }
  const toggleCurrency = (code: string, on: boolean) => {
    setSaved(null)
    const next = on ? [...new Set([...currencies, code])] : currencies.filter(c => c !== code)
    setCurrencies(next)
    // A language whose default currency was just switched off goes back to USD.
    setDefaults(d => Object.fromEntries(Object.entries(d).map(([l, c]) => [l, next.includes(c) ? c : 'USD'])))
  }

  async function saveConfig() {
    setBusy('cfg'); setSaved(null)
    const r = await api<{ revision: number }>('PUT', `${BASE}/i18n`, {
      section: 'config', revision: st!.config.revision,
      value: { enabledLocales: enabled, defaultCurrencyByLocale: defaults, enabledCurrencies: currencies },
    })
    setBusy(null); setCfgResult(r)
    if (r.ok) { setSaved('cfg'); await load() }
  }
  async function saveFx() {
    setBusy('fx'); setSaved(null)
    const r = await api<{ revision: number }>('PUT', `${BASE}/i18n`, {
      section: 'fx', revision: st!.fx.revision,
      value: { rates: Object.fromEntries(Object.entries(rates).filter(([, v]) => v.trim() !== '')), asOf, source },
    })
    setBusy(null); setFxResult(r)
    if (r.ok) { setSaved('fx'); await load() }
  }
  async function clearFx() {
    setBusy('fx'); setSaved(null)
    const r = await api('PUT', `${BASE}/i18n`, { section: 'fx', revision: st!.fx.revision, value: { clear: true } })
    setBusy(null); setFxResult(r)
    if (r.ok) { setSaved('fx'); await load() }
  }

  const nonUsd = st.currencies.filter(c => c.code !== 'USD')
  const fxTone = st.fx.status === 'fresh' ? 'success' : st.fx.status === 'stale' ? 'warning' : st.fx.status === 'expired' ? 'danger' : 'info'

  return (
    <div className="space-y-4">
      <AdminNotice tone="info">
        English is the source language and always stays on. Choosing a language on the storefront also applies that language’s default
        currency here; the currency selector can still override it. Customers are charged in <strong>USD</strong>.
      </AdminNotice>

      <AdminCard>
        <AdminSectionHeader title="Languages" description={`Wording built into the site (${st.messageKeyCount} items) plus your translated content.`} />
        <AdminTable caption="Languages" minWidth={880}>
          <thead><tr>
            <AdminTh>On</AdminTh><AdminTh>Language</AdminTh><AdminTh>Site wording</AdminTh>
            <AdminTh info="Product text translated in Admin and published. Missing means the English text is shown and labelled as English.">Content translations</AdminTh>
            <AdminTh>Review</AdminTh><AdminTh>Default currency</AdminTh>
          </tr></thead>
          <tbody>
            {st.locales.map(l => {
              const isEn = l.code === 'en'
              const blocked = !l.ready && !isEn
              return (
                <tr key={l.code}>
                  <AdminTd>
                    <input type="checkbox" className={adminCheckboxClass} aria-label={`Offer ${l.label}`}
                      checked={enabled.includes(l.code)} disabled={isEn || (blocked && !enabled.includes(l.code))}
                      onChange={e => toggleLocale(l.code, e.target.checked)} />
                  </AdminTd>
                  <AdminTd>
                    <p className="font-medium">{l.label} <span className="font-normal text-[#8A8A85]">{l.nativeLabel}</span></p>
                    {l.rtl && <AdminTag tone="info">Right-to-left</AdminTag>}
                  </AdminTd>
                  <AdminTd>
                    {l.ready
                      ? <AdminTag tone="success">Ready · {l.staticPresent}/{l.staticTotal}</AdminTag>
                      : <><AdminTag tone="danger">NOT READY</AdminTag>
                          <p className="mt-1 text-[11px] text-[#991B1B]">{l.staticMissing} missing{l.staticPlaceholderIssues ? `, ${l.staticPlaceholderIssues} broken` : ''}. Can’t be turned on.</p></>}
                  </AdminTd>
                  <AdminTd>
                    {isEn ? <span className="text-[#8A8A85]">Source</span> : (
                      <div className="text-[11px] leading-[1.5]">
                        <p>{l.cms.fields === 0 ? 'No products to translate yet' : `${l.cms.translated}/${l.cms.fields} fields translated`}</p>
                        {l.cms.stale > 0 && <p className="text-[#92400E]">{l.cms.stale} out of date</p>}
                        {l.cms.fields > 0 && l.cms.missing > 0 && <p className="text-[#6B6B66]">{l.cms.missing} show English</p>}
                        {l.cms.draftRows > 0 && <p className="text-[#6B6B66]">{l.cms.draftRows} unpublished draft{l.cms.draftRows === 1 ? '' : 's'}</p>}
                      </div>
                    )}
                  </AdminTd>
                  <AdminTd>
                    <AdminTag tone={l.review.status === 'ai_assisted_unreviewed' ? 'warning' : 'neutral'}>{REVIEW_LABEL[l.review.status] ?? l.review.status}</AdminTag>
                  </AdminTd>
                  <AdminTd>
                    <select className={adminSelectClass} aria-label={`Default currency for ${l.label}`}
                      value={defaults[l.code] ?? 'USD'} disabled={!enabled.includes(l.code)}
                      onChange={e => { setSaved(null); setDefaults({ ...defaults, [l.code]: e.target.value }) }}>
                      {currencies.map(c => <option key={c} value={c}>{c}</option>)}
                    </select>
                  </AdminTd>
                </tr>
              )
            })}
          </tbody>
        </AdminTable>
        <p className="mt-2 text-[11px] text-[#6B6B66]">Translations of the site wording are AI-assisted and have not been reviewed by a native speaker or professional translator. Treat them as a starting point and have each reviewed before relying on them.</p>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Currencies shown to visitors" description="Prices are stored and charged in USD. Other currencies are shown as an estimate (“≈ €220”) when a dated rate is set below." />
        <div className="grid gap-2 sm:grid-cols-3">
          <label className="flex items-center gap-2 text-[12px]"><input type="checkbox" className={adminCheckboxClass} checked disabled /> USD (always)</label>
          {nonUsd.map(c => (
            <label key={c.code} className="flex items-center gap-2 text-[12px]">
              <input type="checkbox" className={adminCheckboxClass} checked={currencies.includes(c.code)} onChange={e => toggleCurrency(c.code, e.target.checked)} />
              {c.code} <span className="text-[#8A8A85]">{c.name}</span>
            </label>
          ))}
        </div>
        <div className="mt-3 flex items-center gap-3">
          <AdminButton variant="primary" loading={busy === 'cfg'} onClick={saveConfig}>Save languages & currencies</AdminButton>
          {saved === 'cfg' && <span role="status" className="text-[12px] text-[#166534]">Saved. The storefront picks it up within a minute.</span>}
        </div>
        <div className="mt-2"><ErrorNotice result={cfgResult} /></div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="Exchange rates (estimates only)" description="Units of each currency per 1 USD. Used only to show an estimate. They never change what is charged." />
        <div className="mb-3 flex flex-wrap items-center gap-2 text-[12px]">
          <AdminTag tone={fxTone as any}>{st.fx.status === 'missing' ? 'No rates set' : st.fx.status === 'fresh' ? 'Fresh' : st.fx.status === 'stale' ? 'Getting old' : 'Expired'}</AdminTag>
          {st.fx.ageDays !== null && <span className="text-[#6B6B66]">Rates are {st.fx.ageDays} day{st.fx.ageDays === 1 ? '' : 's'} old.</span>}
        </div>
        {st.fx.status === 'stale' && <AdminNotice tone="warning" className="mb-3">These rates are more than {st.fx.staleAfterDays} days old. Update them soon; after {st.fx.expiredAfterDays} days the storefront stops using them and shows USD.</AdminNotice>}
        {st.fx.status === 'expired' && <AdminNotice tone="danger" className="mb-3">These rates are more than {st.fx.expiredAfterDays} days old, so the storefront is showing USD only. Enter current rates to show estimates again.</AdminNotice>}
        {st.fx.status === 'missing' && <AdminNotice tone="info" className="mb-3">No rates are set, so every visitor sees USD. There are no built-in rates.</AdminNotice>}
        <div className="grid gap-3 sm:grid-cols-3">
          {nonUsd.filter(c => currencies.includes(c.code)).map(c => (
            <AdminField key={c.code} label={`${c.code} per 1 USD`} htmlFor={`fx-${c.code}`}>
              <input id={`fx-${c.code}`} inputMode="decimal" className={adminInputClass} value={rates[c.code] ?? ''}
                onChange={e => { setSaved(null); setRates({ ...rates, [c.code]: e.target.value }) }} />
            </AdminField>
          ))}
          {nonUsd.every(c => !currencies.includes(c.code)) && <p className="text-[12px] text-[#6B6B66]">Turn on a currency above to set its rate.</p>}
        </div>
        <div className="mt-3 grid gap-3 sm:grid-cols-2">
          <AdminField label="Rates taken on" htmlFor="fx-asof" hint="YYYY-MM-DD"><input id="fx-asof" className={adminInputClass} value={asOf} onChange={e => { setSaved(null); setAsOf(e.target.value) }} placeholder="2026-10-01" /></AdminField>
          <AdminField label="Source" htmlFor="fx-source" hint="Where you got them, e.g. “ECB reference rates”."><input id="fx-source" className={adminInputClass} value={source} maxLength={120} onChange={e => { setSaved(null); setSource(e.target.value) }} /></AdminField>
        </div>
        <div className="mt-3 flex flex-wrap items-center gap-3">
          <AdminButton variant="primary" loading={busy === 'fx'} onClick={saveFx}>Save rates</AdminButton>
          {st.fx.value && <AdminButton loading={busy === 'fx'} onClick={clearFx}>Remove rates (show USD)</AdminButton>}
          {saved === 'fx' && <span role="status" className="text-[12px] text-[#166534]">Saved.</span>}
        </div>
        <div className="mt-2"><ErrorNotice result={fxResult} /></div>
      </AdminCard>

      <AdminCard>
        <AdminSectionHeader title="What customers can be charged in" description="Showing a price in a currency is not the same as charging it." />
        <AdminTable caption="Currency support" minWidth={760}>
          <thead><tr><AdminTh>Currency</AdminTh><AdminTh>Shown to visitors</AdminTh><AdminTh>Charged in</AdminTh></tr></thead>
          <tbody>
            {st.currencies.map(c => (
              <tr key={c.code}>
                <AdminTd><span className="font-medium">{c.code}</span> <span className="text-[#8A8A85]">{c.name}</span></AdminTd>
                <AdminTd><AdminTag tone={c.displayable ? 'success' : 'neutral'}>{c.displayable ? 'Yes (estimate)' : 'No'}</AdminTag><p className="mt-1 text-[11px] text-[#6B6B66]">{c.displayNote}</p></AdminTd>
                <AdminTd><AdminTag tone={c.payable ? 'success' : 'danger'}>{c.payable ? 'Yes' : 'Not yet'}</AdminTag><p className="mt-1 text-[11px] text-[#6B6B66]">{c.payableNote}</p></AdminTd>
              </tr>
            ))}
          </tbody>
        </AdminTable>
        <div className="mt-3">
          <AdminNotice tone="warning" title="Checkout is USD only">
            The “multi-currency checkout” switch is {st.payable.multiCurrencyFlag ? 'on' : 'off'}, and it makes no difference today: no currency other than USD has passed the order, refund, dispute, fee and reporting audit, so none can be turned on from here.
          </AdminNotice>
        </div>
        <div className="mt-3">
          <AdminDisclosure summary={`Why not? ${st.payable.blockers.length} things to fix first`}>
            <ul className="space-y-3 text-[12px]">
              {st.payable.blockers.map(b => (
                <li key={b.id}><p className="font-medium">{b.where}</p><p className="text-[#4A4A46]">{b.reason}</p><p className="text-[#6B6B66]">To fix: {b.work}</p></li>
              ))}
            </ul>
          </AdminDisclosure>
        </div>
      </AdminCard>
    </div>
  )
}
