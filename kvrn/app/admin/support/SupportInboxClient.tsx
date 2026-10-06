'use client'
// app/admin/support/SupportInboxClient.tsx
//
// Support inbox for support@kvrn.shop and the storefront contact form.
//
// SAFETY: every customer-supplied string (names, subjects, bodies, filenames) is rendered as a
// React text node, which escapes it. There is no raw-HTML injection anywhere in this file and
// inbound HTML is never stored or rendered — the server keeps plain text only.
// Attachments are metadata only; the original file is in the forwarded mailbox.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

type Filter = 'open' | 'unread' | 'closed' | 'all'

interface ThreadSummary {
  id: string; customerEmail: string; customerName: string | null; subject: string; orderNumber: string | null
  status: 'open' | 'closed'; source: 'email' | 'contact_form'; unreadCount: number
  lastMessageAt: string; lastMessageDirection: 'inbound' | 'outbound'; preview: string; attachmentCount: number
}
interface AttachmentMeta { filename: string | null; mimeType: string; size: number | null; disposition: 'attachment' | 'inline' | null }
interface Message {
  id: string; direction: 'inbound' | 'outbound'; channel: 'email' | 'contact_form'
  fromEmail: string; fromName: string | null; toEmail: string; subject: string; bodyText: string
  attachments: AttachmentMeta[]; importNote: string | null; actorEmail: string | null; occurredAt: string
}
interface ThreadDetail extends Omit<ThreadSummary, 'preview' | 'attachmentCount'> { createdAt: string; messages: Message[] }
interface Counts { open: number; closed: number; unread: number }

const REPLY_MAX = 20_000
const MAILBOX = 'support@kvrn.shop'

const newRequestId = () =>
  typeof crypto !== 'undefined' && 'randomUUID' in crypto
    ? crypto.randomUUID()
    : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
        const r = (Math.random() * 16) | 0
        return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16)
      })

function when(iso: string): string {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  const diff = Date.now() - d.getTime()
  if (diff < 60_000) return 'just now'
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`
  if (diff < 7 * 86_400_000) return d.toLocaleDateString(undefined, { weekday: 'short', hour: 'numeric', minute: '2-digit' })
  return d.toLocaleDateString(undefined, { month: 'short', day: 'numeric', year: 'numeric' })
}
const full = (iso: string) => {
  const d = new Date(iso)
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })
}
function bytes(n: number | null) {
  if (n === null) return 'size unknown'
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

export function SupportInboxClient() {
  const [filter, setFilter] = useState<Filter>('open')
  const [search, setSearch] = useState('')
  const [q, setQ] = useState('')
  const [threads, setThreads] = useState<ThreadSummary[]>([])
  const [counts, setCounts] = useState<Counts>({ open: 0, closed: 0, unread: 0 })
  const [nextCursor, setNextCursor] = useState<string | null>(null)
  const [listErr, setListErr] = useState<string | null>(null)
  const [loadingList, setLoadingList] = useState(true)

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [thread, setThread] = useState<ThreadDetail | null>(null)
  const [threadErr, setThreadErr] = useState<string | null>(null)
  const [loadingThread, setLoadingThread] = useState(false)

  const [reply, setReply] = useState('')
  const [sending, setSending] = useState(false)
  const [sendErr, setSendErr] = useState<{ text: string; code?: string } | null>(null)
  const [sendOk, setSendOk] = useState<string | null>(null)
  const [statusBusy, setStatusBusy] = useState(false)
  const requestId = useRef<string>(newRequestId())
  const sendingRef = useRef(false)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const threadSeq = useRef(0)             // only the most recent thread request may update the panel

  // debounce the search box
  useEffect(() => {
    const t = setTimeout(() => setQ(search.trim()), 300)
    return () => clearTimeout(t)
  }, [search])

  const listQuery = useMemo(() => {
    const p = new URLSearchParams()
    p.set('status', filter === 'unread' ? 'all' : filter)
    if (filter === 'unread') p.set('unread', '1')
    if (q) p.set('q', q)
    return p
  }, [filter, q])

  const loadList = useCallback(async (opts: { append?: boolean; cursor?: string | null; quiet?: boolean } = {}) => {
    if (!opts.quiet) setLoadingList(true)
    try {
      const p = new URLSearchParams(listQuery)
      if (opts.cursor) p.set('cursor', opts.cursor)
      const res = await fetch(`/api/admin/support/threads?${p}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? 'Could not load threads.')
      setThreads(prev => (opts.append ? [...prev, ...data.threads] : data.threads))
      setCounts(data.counts)
      setNextCursor(data.nextCursor ?? null)
      setListErr(null)
    } catch (e: any) {
      setListErr(e?.message ?? 'Could not load threads.')
    } finally {
      if (!opts.quiet) setLoadingList(false)
    }
  }, [listQuery])

  useEffect(() => { loadList() }, [loadList])

  // quiet refresh every 60s while the tab is visible
  useEffect(() => {
    const t = setInterval(() => { if (document.visibilityState === 'visible') loadList({ quiet: true }) }, 60_000)
    return () => clearInterval(t)
  }, [loadList])

  const openThread = useCallback(async (id: string, opts: { quiet?: boolean } = {}) => {
    const seq = ++threadSeq.current
    setSelectedId(id)
    if (!opts.quiet) { setLoadingThread(true); setThreadErr(null) }
    try {
      const res = await fetch(`/api/admin/support/threads/${id}`, { cache: 'no-store' })
      const data = await res.json().catch(() => ({}))
      if (seq !== threadSeq.current) return                  // a newer click superseded this response
      if (!res.ok) throw new Error(data?.error ?? 'Could not load the thread.')
      const t: ThreadDetail = data.thread
      setThread(t)
      const last = t.messages[t.messages.length - 1]
      if (t.unreadCount > 0 && last) {
        // Opening a thread reads what is on screen. Sending the newest displayed message id means a customer
        // message that arrives afterwards stays unread. Best effort: a failure only leaves the unread dot on.
        fetch(`/api/admin/support/threads/${id}/read`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ seenMessageId: last.id }),
        }).then(() => loadList({ quiet: true })).catch(() => {})
      }
    } catch (e: any) {
      if (seq === threadSeq.current) setThreadErr(e?.message ?? 'Could not load the thread.')
    } finally {
      if (seq === threadSeq.current) setLoadingThread(false)
    }
  }, [loadList])

  useEffect(() => { bottomRef.current?.scrollIntoView?.({ block: 'end' }) }, [thread?.messages.length, thread?.id])

  const select = (id: string) => {
    if (id === selectedId) return
    setReply(''); setSendErr(null); setSendOk(null); requestId.current = newRequestId()
    openThread(id)
  }

  const send = async () => {
    if (!thread || sendingRef.current) return          // double-submit guard (state alone is async)
    const body = reply.trim()
    if (!body) { setSendErr({ text: 'Write a reply first.' }); return }
    sendingRef.current = true; setSending(true); setSendErr(null); setSendOk(null)
    try {
      const res = await fetch(`/api/admin/support/threads/${thread.id}/reply`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ body, clientRequestId: requestId.current }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) { setSendErr({ text: data?.error ?? 'Could not send the reply.', code: data?.code }); return }
      setReply(''); requestId.current = newRequestId()
      setSendOk(data.duplicate ? 'Already sent earlier — nothing was sent twice.' : `Reply sent from ${MAILBOX}.`)
      await openThread(thread.id, { quiet: true })
      loadList({ quiet: true })
    } catch {
      setSendErr({ text: 'Network error. Nothing was confirmed — check the thread before sending again.' })
    } finally {
      sendingRef.current = false; setSending(false)
    }
  }

  const setStatus = async (status: 'open' | 'closed') => {
    if (!thread || statusBusy) return
    setStatusBusy(true)
    try {
      const res = await fetch(`/api/admin/support/threads/${thread.id}/status`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status }),
      })
      const data = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error(data?.error ?? 'Could not update the thread.')
      await openThread(thread.id, { quiet: true })
      loadList({ quiet: true })
    } catch (e: any) {
      setThreadErr(e?.message ?? 'Could not update the thread.')
    } finally { setStatusBusy(false) }
  }

  const onReplyChange = (v: string) => {
    setReply(v)
    // After a failure that did NOT send anything, an edited body is a new request. After
    // "sent but not saved" the same id MUST be kept so a retry cannot send a second email.
    if (sendErr && sendErr.code !== 'sent_not_recorded') requestId.current = newRequestId()
  }

  const tabs: { key: Filter; label: string; n: number | null }[] = [
    { key: 'open', label: 'Open', n: counts.open },
    { key: 'unread', label: 'Unread', n: counts.unread },
    { key: 'closed', label: 'Closed', n: counts.closed },
    { key: 'all', label: 'All', n: counts.open + counts.closed },
  ]

  const showThreadOnMobile = selectedId !== null

  return (
    <div className="px-4 py-6 sm:px-8 max-w-[1280px]">
      <div className="flex flex-wrap items-end justify-between gap-3 mb-5">
        <div>
          <h1 className="text-[20px] font-medium">Support</h1>
          <p className="text-[12px] text-[#6B6B6B] mt-1">
            Mailbox <span className="font-medium text-[#171717]">{MAILBOX}</span> · replies are sent from this address ·
            storefront contact-form messages appear here too
          </p>
        </div>
        <button onClick={() => loadList()} className="text-[11px] tracking-[0.08em] uppercase border border-[#1A1A1A] px-3 py-2 bg-white">
          Refresh
        </button>
      </div>

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* ── list ─────────────────────────────────────────── */}
        <section className={`${showThreadOnMobile ? 'hidden lg:block' : 'block'} border border-[#E8E5E0] bg-white`} aria-label="Conversations">
          <div className="p-3 border-b border-[#E8E5E0] space-y-3">
            <div className="flex gap-1 flex-wrap" role="tablist">
              {tabs.map(t => (
                <button key={t.key} role="tab" aria-selected={filter === t.key} onClick={() => setFilter(t.key)}
                  className={`text-[11px] px-3 py-1.5 border ${filter === t.key ? 'bg-[#111] text-white border-[#111]' : 'bg-white border-[#E8E5E0] text-[#444]'}`}>
                  {t.label}{t.n !== null && <span className="ml-1.5 opacity-60">{t.n}</span>}
                </button>
              ))}
            </div>
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search email, name, subject, order #"
              aria-label="Search conversations" maxLength={100}
              className="w-full border border-[#E8E5E0] px-3 py-2 text-[12px] focus:outline-none focus:border-[#111]" />
          </div>

          {listErr && <p role="alert" className="p-3 text-[12px] text-[#B91C1C]">{listErr}</p>}
          {loadingList && threads.length === 0 && <p className="p-4 text-[12px] text-[#6B6B6B]">Loading…</p>}
          {!loadingList && !listErr && threads.length === 0 && (
            <p className="p-4 text-[12px] text-[#6B6B6B]">
              {q ? 'No conversations match your search.' : filter === 'unread' ? 'Nothing unread.' : 'No conversations here yet.'}
            </p>
          )}

          <ul className="max-h-[70vh] overflow-y-auto divide-y divide-[#F1EEE8]">
            {threads.map(t => (
              <li key={t.id}>
                <button onClick={() => select(t.id)} aria-current={t.id === selectedId}
                  className={`w-full text-left px-4 py-3 ${t.id === selectedId ? 'bg-[#F5F5F3]' : 'hover:bg-[#FAFAF8]'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`text-[13px] truncate ${t.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>
                      {t.customerName || t.customerEmail}
                    </p>
                    <span className="text-[10px] text-[#9B9B9B] whitespace-nowrap">{when(t.lastMessageAt)}</span>
                  </div>
                  {t.customerName && <p className="text-[11px] text-[#6B6B6B] truncate">{t.customerEmail}</p>}
                  <p className={`text-[12px] truncate mt-0.5 ${t.unreadCount > 0 ? 'font-semibold' : ''}`}>
                    {t.subject || '(no subject)'}
                  </p>
                  <p className="text-[11px] text-[#6B6B6B] truncate mt-0.5">
                    {t.lastMessageDirection === 'outbound' ? 'You: ' : ''}{t.preview || (t.attachmentCount ? 'Attachment only' : '')}
                  </p>
                  <div className="flex items-center gap-1.5 mt-1.5">
                    {t.unreadCount > 0 && (
                      <span className="text-[10px] px-1.5 py-0.5 bg-[#111] text-white" aria-label={`${t.unreadCount} unread`}>
                        {t.unreadCount} new
                      </span>
                    )}
                    {t.status === 'closed' && <span className="text-[10px] px-1.5 py-0.5 border border-[#D1D5DB] text-[#4B5563]">Closed</span>}
                    {t.source === 'contact_form' && <span className="text-[10px] px-1.5 py-0.5 border border-[#BFDBFE] text-[#1E40AF] bg-[#EFF6FF]">Contact form</span>}
                    {t.orderNumber && <span className="text-[10px] text-[#6B6B6B]">Order {t.orderNumber}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="p-3 border-t border-[#E8E5E0]">
              <button onClick={() => loadList({ append: true, cursor: nextCursor })}
                className="w-full text-[11px] tracking-[0.08em] uppercase border border-[#1A1A1A] px-3 py-2 bg-white">
                Load more
              </button>
            </div>
          )}
        </section>

        {/* ── conversation ─────────────────────────────────── */}
        <section className={`${showThreadOnMobile ? 'block' : 'hidden lg:block'} border border-[#E8E5E0] bg-white min-h-[320px]`} aria-label="Conversation">
          {!selectedId && <p className="p-6 text-[13px] text-[#6B6B6B]">Select a conversation to read and reply.</p>}
          {selectedId && loadingThread && !thread && <p className="p-6 text-[12px] text-[#6B6B6B]">Loading…</p>}
          {selectedId && threadErr && <p role="alert" className="p-4 text-[12px] text-[#B91C1C]">{threadErr}</p>}

          {selectedId && thread && thread.id === selectedId && (
            <div className="flex flex-col">
              <header className="p-4 border-b border-[#E8E5E0]">
                <button onClick={() => { setSelectedId(null); setThread(null) }}
                  className="lg:hidden text-[11px] text-[#6B6B6B] mb-2 underline">← All conversations</button>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="text-[15px] font-medium break-words">{thread.subject || '(no subject)'}</h2>
                    <p className="text-[12px] text-[#6B6B6B] mt-1 break-all">
                      {thread.customerName ? `${thread.customerName} · ` : ''}{thread.customerEmail}
                      {thread.orderNumber ? ` · Order ${thread.orderNumber}` : ''}
                    </p>
                    <p className="text-[11px] text-[#9B9B9B] mt-1">
                      {thread.source === 'contact_form' ? 'Started from the storefront contact form' : `Started by email to ${MAILBOX}`}
                      {' · '}{thread.status === 'closed' ? 'Closed' : 'Open'}
                    </p>
                  </div>
                  <button disabled={statusBusy} onClick={() => setStatus(thread.status === 'open' ? 'closed' : 'open')}
                    className="text-[11px] tracking-[0.08em] uppercase border border-[#1A1A1A] px-3 py-2 bg-white disabled:opacity-60">
                    {statusBusy ? '…' : thread.status === 'open' ? 'Mark closed' : 'Reopen'}
                  </button>
                </div>
              </header>

              <div className="p-4 space-y-3 max-h-[55vh] overflow-y-auto bg-[#FAFAF8]">
                {thread.messages.map(m => (
                  <article key={m.id} data-direction={m.direction}
                    className={`max-w-[92%] sm:max-w-[80%] p-3 border ${m.direction === 'outbound'
                      ? 'ml-auto bg-[#111] text-white border-[#111]' : 'mr-auto bg-white border-[#E8E5E0]'}`}>
                    <p className={`text-[10px] tracking-[0.06em] uppercase mb-1.5 ${m.direction === 'outbound' ? 'text-white/60' : 'text-[#9B9B9B]'}`}>
                      {m.direction === 'outbound'
                        ? `Sent from ${MAILBOX}${m.actorEmail ? ` by ${m.actorEmail}` : ''}`
                        : `${m.fromName ? `${m.fromName} · ` : ''}${m.fromEmail}${m.channel === 'contact_form' ? ' · contact form' : ''}`}
                      {' · '}{full(m.occurredAt)}
                    </p>
                    {/* Plain text only: React escapes this string. */}
                    <p className="text-[13px] whitespace-pre-wrap break-words">{m.bodyText || (m.attachments.length ? '' : '(empty message)')}</p>
                    {m.importNote && (
                      <p className={`text-[11px] mt-2 ${m.direction === 'outbound' ? 'text-white/70' : 'text-[#92400E]'}`}>⚠ {m.importNote}</p>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-2 border-t border-[#E8E5E0] pt-2">
                        <p className="text-[11px] font-medium">
                          {m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'} — the original file{m.attachments.length === 1 ? ' is' : 's are'} in the forwarded mailbox
                        </p>
                        <ul className="mt-1 text-[11px] text-[#6B6B6B] space-y-0.5">
                          {m.attachments.map((a, i) => (
                            <li key={i} className="break-all">
                              {a.filename || '(unnamed)'} · {a.mimeType} · {bytes(a.size)}{a.disposition === 'inline' ? ' · inline' : ''}
                            </li>
                          ))}
                        </ul>
                      </div>
                    )}
                  </article>
                ))}
                <div ref={bottomRef} />
              </div>

              <form onSubmit={e => { e.preventDefault(); send() }} className="p-4 border-t border-[#E8E5E0]">
                <label htmlFor="support-reply" className="block text-[11px] font-medium mb-1.5">
                  Reply to {thread.customerEmail}
                </label>
                <textarea id="support-reply" value={reply} onChange={e => onReplyChange(e.target.value)} rows={5}
                  maxLength={REPLY_MAX} disabled={sending} placeholder="Write your reply…"
                  className="w-full border border-[#E8E5E0] px-3 py-2 text-[13px] focus:outline-none focus:border-[#111] disabled:bg-[#F5F5F3]" />
                <div className="flex flex-wrap items-center justify-between gap-3 mt-2">
                  <p className="text-[11px] text-[#9B9B9B]">
                    From {MAILBOX} · {reply.length.toLocaleString()} / {REPLY_MAX.toLocaleString()}
                  </p>
                  <button type="submit" disabled={sending || !reply.trim()}
                    className="text-[11px] tracking-[0.08em] uppercase bg-[#111] text-white px-4 py-2.5 disabled:opacity-50">
                    {sending ? 'Sending…' : 'Send reply'}
                  </button>
                </div>
                {sendErr && <p role="alert" className="text-[12px] text-[#B91C1C] mt-2">{sendErr.text}</p>}
                {sendOk && <p role="status" className="text-[12px] text-[#166534] mt-2">{sendOk}</p>}
              </form>
            </div>
          )}
        </section>
      </div>
    </div>
  )
}
