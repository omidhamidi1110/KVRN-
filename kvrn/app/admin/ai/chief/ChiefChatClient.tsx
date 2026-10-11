'use client'

import Link from 'next/link'
import { useEffect, useRef, useState, type FormEvent } from 'react'

type ChatItem = {
  id: number; who: 'owner' | 'chief'; text: string; worker?: string
  modelUsed?: boolean; model?: string; evidenceTopics?: string[]; unavailableTopics?: string[]
  requestedReasoning?: boolean; reason?: string
}
type ChiefReadiness = {
  paidAvailable: boolean; status: string; blockers: string[]
  models: { cheap: string; business: string; finance: string; video: string }
  videoRouting?: { agent: string; provider: string; model: string; apiVersion: string; configured: boolean; videoRequestTested: boolean } | null
  budgetMode?: string
}

const readOnlyNotice = 'Read-only. Chief cannot send messages, change orders, modify inventory, issue refunds, publish content, or deploy code from this chat.'
const detailText = 'Chief can inspect authorized read-only records and queue the existing QA registry monitor. Chat cannot launch browser tests, send marketing, issue refunds, edit products, or deploy. Conversation history remains in this browser tab and is not stored as a chat transcript. Do not enter secrets or customer personal information.'
const suggested = [
  'Audit all 11 AI agents and recent failures',
  'Review workforce, model routing, budget and QA readiness',
  'What requires my attention in finance and inventory?',
]

function EyeIcon() {
  return <svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" strokeLinejoin="round" className="h-4 w-4">
    <path d="M2 12s3.6-6 10-6 10 6 10 6-3.6 6-10 6S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>
  </svg>
}

/** Expand details in normal document flow, never as a popover over Chief's answers. */
function ReportBody({ text, isDeterministic }: { text: string; isDeterministic: boolean }) {
  if (!isDeterministic || !text.includes('Source: ')) {
    return <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.8] sm:text-[13px]">{text}</div>
  }
  const sections = text.split(/\n\n+/).filter(Boolean)
  return <div className="space-y-2">
    {sections.map((section, i) => {
      const [heading, ...detail] = section.split('\n')
      return <details key={i} open={i === 0} className="group/report rounded-xl border border-black/[0.07] bg-[#FAFAF9]">
        <summary className="cursor-pointer list-none break-words px-3 py-2.5 text-[11px] font-medium leading-5 text-black/80 [&::-webkit-details-marker]:hidden">
          <span className="mr-2 text-black/40" aria-hidden="true">▸</span>{heading}
        </summary>
        <div className="whitespace-pre-wrap break-words border-t border-black/[0.06] px-3 py-3 text-[11px] leading-[1.85] text-black/75 sm:text-[12px]">{detail.join('\n')}</div>
      </details>
    })}
  </div>
}

function cleanReply(value: string) {
  return value
    .replace(readOnlyNotice, '')
    .replace('Paid conversational reasoning is not active in this response. These are deterministic database/configuration reports.', '')
    .replace(/\n{3,}/g, '\n\n')
    .trim()
}

export function ChiefChatClient() {
  const [items, setItems] = useState<ChatItem[]>([])
  const [input, setInput] = useState('')
  const [reasoning, setReasoning] = useState(false)
  const [modelRole, setModelRole] = useState<'cheap' | 'business'>('cheap')
  const [readiness, setReadiness] = useState<ChiefReadiness | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const [safetyOpen, setSafetyOpen] = useState(false)
  const [safetyHover, setSafetyHover] = useState(false)
  const [headerOpen, setHeaderOpen] = useState(false)
  const [headerHover, setHeaderHover] = useState(false)
  const [footerOpen, setFooterOpen] = useState(false)
  const [footerHover, setFooterHover] = useState(false)
  const [monitorOpen, setMonitorOpen] = useState(false)
  const bottom = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLTextAreaElement | null>(null)

  useEffect(() => {
    let active = true
    fetch('/api/admin/ai/chief/readiness', { cache: 'no-store' })
      .then(res => res.ok ? res.json() : null)
      .then((data: ChiefReadiness | null) => { if (active && data) setReadiness(data) })
      .catch(() => {})
    return () => { active = false }
  }, [])
  useEffect(() => { bottom.current?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }) }, [items.length, busy])

  async function send(e: FormEvent<HTMLFormElement>) {
    e.preventDefault()
    const message = input.trim()
    if (message.length < 2 || busy) return
    const stamp = Date.now()
    const requestedReasoning = reasoning
    const history = items.slice(-6).map(item => ({ who: item.who, text: item.text.slice(0, 1200) }))
    setItems(old => [...old, { id: stamp, who: 'owner', text: message }])
    setInput(''); setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'message', message, reasoning, modelRole, history }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Chief could not load a verified report.')
      setItems(old => [...old, {
        id: stamp + 1, who: 'chief', text: String(body.reply),
        worker: body.worker, modelUsed: Boolean(body.modelUsed),
        requestedReasoning, reason: typeof body.reason === 'string' ? body.reason : undefined,
        model: typeof body.model === 'string' ? body.model : undefined,
        evidenceTopics: Array.isArray(body.evidenceTopics) ? body.evidenceTopics : undefined,
        unavailableTopics: Array.isArray(body.unavailableTopics) ? body.unavailableTopics : undefined,
      }])
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Chief chat failed.')
      // The owner should not lose a long audit prompt if the network/request fails.
      setInput(current => current || message)
    } finally { setBusy(false) }
  }

  async function queueMonitor(monitor: 'qa' | 'inventory' | 'finance') {
    if (busy) return
    setBusy(true); setError('')
    try {
      const res = await fetch('/api/admin/ai/chief/chat', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, cache: 'no-store',
        body: JSON.stringify({ mode: 'queue_readonly_monitor', monitor }),
      })
      const body = await res.json()
      if (!res.ok) throw Error(body.error || 'Unable to queue the monitor.')
      setItems(old => [...old, { id: Date.now(), who: 'chief', worker: 'Engineering, QA & Security', text: body.message, modelUsed: false }])
    } catch (err: unknown) { setError(err instanceof Error ? err.message : 'Unable to queue the monitor.') }
    finally { setBusy(false) }
  }

  return <div className="mx-auto flex w-full max-w-[1100px] flex-col gap-4 px-4 py-5 sm:px-7 sm:py-8 lg:px-10">
    <header className="flex flex-wrap items-center justify-between gap-3">
      <div>
        <p className="mb-1 text-[10px] font-medium uppercase tracking-[0.18em] text-black/35">KVRN AI Operating System</p>
        <h1 className="text-[26px] font-medium tracking-[-0.035em] text-[#171717] sm:text-[30px]">Chat with Chief</h1>
      </div>
      <div className="flex items-center gap-2">
        <span className="hidden text-[10px] font-medium text-black/35 sm:inline">Read-only</span>
        <button type="button" title="Safety details" aria-label="View safety details" aria-expanded={safetyOpen}
          onMouseEnter={() => setSafetyHover(true)} onMouseLeave={() => setSafetyHover(false)}
          onFocus={() => setSafetyHover(true)} onBlur={() => setSafetyHover(false)}
          onClick={() => setSafetyOpen(value => !value)}
          className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 text-[11px] text-black/60 hover:text-black focus-visible:outline-2 focus-visible:outline-black/30">
          <EyeIcon/><span>Safety</span>
        </button>
        <Link className="inline-flex h-9 items-center rounded-lg border border-black/[0.09] bg-white px-3 text-[11px] font-medium text-black/65 transition hover:border-black/20" href="/admin/ai">AI Operations</Link>
      </div>
    </header>
    {(safetyOpen || safetyHover) && <div className="rounded-xl border border-black/[0.08] bg-white px-4 py-3 text-[11px] leading-5 text-black/65" role="note">{detailText}</div>}

    {readiness && !readiness.paidAvailable && <div className="flex items-center justify-between gap-3 rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-[11px] text-amber-900">
      <span>Paid reasoning is unavailable. Deterministic read-only reports are still available.</span>
      <span className="text-[10px]">{readiness.blockers.join(' · ') || 'Paid inference has not been verified.'}</span>
    </div>}

    <section className="flex min-h-[560px] flex-col overflow-hidden rounded-2xl border border-black/[0.08] bg-white shadow-[0_3px_24px_rgba(0,0,0,0.025)] sm:min-h-[630px]" aria-label="Chief conversation">
      <div className="flex flex-wrap items-center justify-between gap-3 border-b border-black/[0.06] px-4 py-3 sm:px-5">
        <div className="flex min-w-0 items-center gap-2.5">
          <span className="flex h-9 w-9 items-center justify-center rounded-xl bg-[#161616] text-[13px] font-medium tracking-[-0.07em] text-white" aria-hidden="true">K</span>
          <div className="min-w-0"><h2 className="text-[13px] font-semibold text-[#171717]">Chief Operator</h2><p className="text-[10px] text-black/40">KVRN operations · Verified evidence</p></div>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <span className={`h-1.5 w-1.5 rounded-full ${readiness?.paidAvailable ? 'bg-emerald-500' : 'bg-amber-500'}`} aria-hidden="true"/>
          <span className="text-[10px] text-black/45">{readiness?.paidAvailable ? 'AI configured' : readiness ? 'Reports only' : 'Checking'}</span>
          <button type="button" title="AI routing details" aria-label="View AI routing details" aria-expanded={headerOpen}
            onMouseEnter={() => setHeaderHover(true)} onMouseLeave={() => setHeaderHover(false)}
            onFocus={() => setHeaderHover(true)} onBlur={() => setHeaderHover(false)}
            onClick={() => setHeaderOpen(value => !value)}
            className="inline-flex h-8 items-center gap-1.5 rounded-lg border border-black/[0.08] bg-white px-2.5 text-[10px] text-black/60 hover:text-black">
            <EyeIcon/><span>Routing</span>
          </button>
        </div>
        {(headerOpen || headerHover) && <div className="w-full rounded-lg border border-black/[0.06] bg-[#FAFAF9] px-3 py-2 text-[11px] leading-5 text-black/65" role="note">
          <p>Paid reasoning: {readiness?.paidAvailable ? 'Configured (not a live provider test)' : 'Unavailable or unverified'}</p>
          <p>Default model: {readiness?.models?.cheap ?? 'Claude Haiku 5.5'}</p>
          <p>Business model: {readiness?.models?.business ?? 'Claude Sonnet 5.5'}</p>
          {readiness?.videoRouting && <p>Video: {readiness.videoRouting.provider} / {readiness.videoRouting.model}; verified live video: {readiness.videoRouting.videoRequestTested ? 'yes' : 'no'}</p>}
        </div>}
      </div>

      <div className="h-[min(54vh,590px)] min-h-[305px] flex-1 space-y-4 overflow-y-auto bg-[#FAFAF9] px-3 py-5 sm:px-6 sm:py-6" role="log" aria-label="Chief conversation" aria-live="polite">
        {items.length === 0 && <div className="mx-auto flex h-full max-w-[490px] flex-col items-center justify-center py-8 text-center">
          <div className="mb-4 flex h-12 w-12 items-center justify-center rounded-2xl border border-black/[0.08] bg-white text-[18px] font-medium tracking-[-0.08em]">K</div>
          <h3 className="text-[17px] font-medium tracking-tight text-black/80">What should Chief review?</h3>
          <p className="mt-2 max-w-[370px] text-[12px] leading-5 text-black/45">Ask about your agents, finances, inventory, QA, or the state of the business. Chief only uses authorized reports.</p>
          <div className="mt-5 flex flex-wrap justify-center gap-2">
            {suggested.map(prompt => <button key={prompt} type="button" onClick={() => { setInput(prompt); inputRef.current?.focus() }} className="rounded-full border border-black/[0.08] bg-white px-3 py-2 text-left text-[10px] text-black/65 transition hover:border-black/25 hover:text-black">{prompt}</button>)}
          </div>
        </div>}
        {items.map(item => <div key={item.id} className={`flex ${item.who === 'owner' ? 'justify-end' : 'justify-start'}`}>
          <div className={`min-w-0 max-w-full rounded-2xl px-4 py-3 sm:max-w-[90%] sm:px-5 ${item.who === 'owner' ? 'rounded-br-md bg-[#171717] text-white' : 'rounded-bl-md border border-black/[0.07] bg-white text-[#171717]'}`}>
            <div className="mb-2 flex flex-wrap items-center gap-2">
              <span className={`text-[10px] font-medium ${item.who === 'owner' ? 'text-white/65' : 'text-black/50'}`}>{item.who === 'owner' ? 'You' : 'Chief'}</span>
              {item.who === 'chief' && <span className={`rounded-md px-2 py-0.5 text-[10px] font-medium ${item.modelUsed ? 'bg-emerald-50 text-emerald-800' : item.requestedReasoning ? 'bg-amber-50 text-amber-900' : 'bg-neutral-100 text-black/50'}`}>
                {item.modelUsed ? `AI · ${item.model || 'verified model'}` : item.requestedReasoning ? 'Paid AI unavailable · fallback' : 'Verified report · no AI'}
              </span>}
            </div>
            {item.who === 'chief' && item.requestedReasoning && !item.modelUsed && <p role="status" className="mb-3 rounded-lg border border-amber-200 bg-amber-50 p-2.5 text-[11px] leading-5 text-amber-900">
              Paid reasoning was requested but did not complete ({item.reason ?? 'AI_INFERENCE_FAILED'}). Showing canonical records instead. No paid AI answer was generated.
            </p>}
            {item.who === 'chief'
              ? <ReportBody text={cleanReply(item.text)} isDeterministic={!item.modelUsed}/>
              : <div className="whitespace-pre-wrap break-words text-[12px] leading-[1.8] sm:text-[13px]">{item.text}</div>}
            {item.who === 'chief' && <details className="mt-3 rounded-lg border border-black/[0.06] bg-[#FAFAF9] text-[11px] text-black/60">
              <summary title="View routing and evidence sources" className="flex cursor-pointer list-none items-center gap-2 rounded-lg px-2.5 py-2 hover:text-black [&::-webkit-details-marker]:hidden">
                <EyeIcon/> Evidence &amp; routing
              </summary>
              <div className="space-y-1 border-t border-black/[0.06] px-3 py-2.5 leading-5">
                <p>Department: {item.worker ?? 'Executive'}</p>
                <p>Reasoning: {item.modelUsed ? `Paid AI (${item.model || 'verified model'})` : 'Deterministic database/configuration report'}</p>
                <p>Sources: {item.evidenceTopics?.join(', ') || 'Not supplied'}</p>
                {!!item.unavailableTopics?.length && <p>Unavailable: {item.unavailableTopics.join(', ')}</p>}
                <p>{readOnlyNotice}</p>
              </div>
            </details>}
          </div>
        </div>)}
        {busy && <div className="flex items-center gap-2 px-1 text-[11px] text-black/40"><span className="h-2 w-2 animate-pulse rounded-full bg-black/40"/>Chief is reviewing the records…</div>}
        <div ref={bottom} />
      </div>

      <form onSubmit={send} className="border-t border-black/[0.06] bg-white px-3 py-3 sm:px-5 sm:py-4">
        {error && <div role="alert" className="mb-3 rounded-lg border border-red-100 bg-red-50 px-3 py-2 text-[11px] text-red-700">{error}</div>}
        <label htmlFor="chief-message" className="sr-only">Message Chief</label>
        <textarea ref={inputRef} id="chief-message" rows={2} maxLength={3500} value={input} onChange={e => setInput(e.target.value)} placeholder="Message Chief…" className="max-h-44 min-h-[64px] w-full resize-y rounded-xl border border-black/[0.09] bg-[#FAFAF9] px-3.5 py-3 text-[12px] leading-5 text-black/85 outline-none placeholder:text-black/30 focus:border-black/25 focus:ring-2 focus:ring-black/[0.03] sm:text-[13px]" />
        <div className="mt-2.5 flex flex-wrap items-end justify-between gap-3">
          <div className="flex flex-wrap items-center gap-3">
            <label className="inline-flex cursor-pointer items-center gap-2 text-[11px] font-medium text-black/65">
              <input type="checkbox" checked={reasoning} onChange={e => setReasoning(e.target.checked)} disabled={!readiness?.paidAvailable} className="accent-[#171717]" />Paid reasoning
            </label>
            {reasoning && <label className="flex items-center gap-1.5 text-[11px] text-black/45"><span className="sr-only">AI model</span>
              <select aria-label="Chief model" value={modelRole} onChange={e => setModelRole(e.target.value === 'business' ? 'business' : 'cheap')} className="rounded-lg border border-black/[0.09] bg-white px-2 py-1.5 text-[11px] text-black/70">
                <option value="cheap">Haiku 5.5</option><option value="business">Sonnet 5.5</option>
              </select>
            </label>}
            <button type="button" title="Paid reasoning details" aria-expanded={footerOpen}
              onMouseEnter={() => setFooterHover(true)} onMouseLeave={() => setFooterHover(false)}
              onFocus={() => setFooterHover(true)} onBlur={() => setFooterHover(false)}
              onClick={() => setFooterOpen(value => !value)}
              className="inline-flex items-center gap-1.5 rounded-lg border border-black/[0.08] px-2.5 py-1.5 text-[11px] text-black/60 hover:text-black">
              <EyeIcon/> Info
            </button>
            <button type="button" aria-expanded={monitorOpen} onClick={() => setMonitorOpen(value => !value)}
              className="rounded-lg border border-black/[0.08] px-2.5 py-1.5 text-[11px] text-black/60 hover:text-black">Request check</button>
          </div>
          <div className="flex items-center gap-3">
            {input.length > 2500 && <span className="text-[10px] tabular-nums text-black/35">{input.length}/3500</span>}
            <button disabled={busy || input.trim().length < 2} type="submit" className="inline-flex min-h-9 items-center gap-2 rounded-lg bg-[#171717] px-4 py-2 text-[11px] font-medium text-white transition hover:bg-black/85 disabled:opacity-40">{busy ? 'Working…' : 'Send'}<span aria-hidden="true">↗</span></button>
          </div>
        </div>
        {(footerOpen || footerHover) && <div role="note" className="mt-3 rounded-xl border border-black/[0.07] bg-[#FAFAF9] px-3 py-2.5 text-[11px] leading-5 text-black/65">
          {reasoning ? 'Paid reasoning transmits your bounded prompt, recent conversation and verified read-only summaries through the configured AI Gateway. Budget limits still apply. If the model call fails, Chief will clearly mark the fallback.' : 'Paid reasoning is off. Chief reads authorized canonical reports without calling an AI model.'}
        </div>}
        {monitorOpen && <div className="mt-3 rounded-xl border border-black/[0.07] bg-[#FAFAF9] p-3 text-[11px] text-black/65">
          <p className="mb-2 font-medium text-black/75">Request an existing department monitor</p>
          <p className="mb-3 leading-5">These checks may record AI events and alerts, but do not change business transactions, send messages or run browser tests.</p>
          <div className="flex flex-wrap gap-2">
            <button type="button" disabled={busy} onClick={() => queueMonitor('qa')} className="rounded-lg border border-black/10 bg-white px-3 py-2 hover:bg-black/[0.03] disabled:opacity-40">QA registry</button>
            <button type="button" disabled={busy} onClick={() => queueMonitor('inventory')} className="rounded-lg border border-black/10 bg-white px-3 py-2 hover:bg-black/[0.03] disabled:opacity-40">Stock health</button>
            <button type="button" disabled={busy} onClick={() => queueMonitor('finance')} className="rounded-lg border border-black/10 bg-white px-3 py-2 hover:bg-black/[0.03] disabled:opacity-40">Payment exceptions</button>
          </div>
        </div>}
      </form>
    </section>
  </div>
}
