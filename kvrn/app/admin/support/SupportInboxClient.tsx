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
import {
  AdminPage, AdminPageHeader, AdminButton, AdminTabs, AdminNotice, AdminTag, AdminLoading, StatusBadge,
  adminInputClass, adminTextareaClass,
} from '@/components/admin/ui/AdminUI'

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

  const tabs: Array<{ id: Filter; label: string; count: number }> = [
    { id: 'open', label: 'Open', count: counts.open },
    { id: 'unread', label: 'Unread', count: counts.unread },
    { id: 'closed', label: 'Closed', count: counts.closed },
    { id: 'all', label: 'All', count: counts.open + counts.closed },
  ]

  const showThreadOnMobile = selectedId !== null

  return (
    <AdminPage width="wide">
      <AdminPageHeader
        title="Support"
        description="Customer conversations."
        info={<>
          Mailbox <strong>{MAILBOX}</strong>. Replies are sent from this address, and storefront
          contact-form messages appear here too. Attachments are listed only; the original file is in the
          forwarded mailbox.
        </>}
        actions={<AdminButton size="sm" onClick={() => loadList()}>Refresh</AdminButton>}
      />

      <div className="grid gap-4 lg:grid-cols-[380px_minmax(0,1fr)]">
        {/* ── list ─────────────────────────────────────────── */}
        <section className={`${showThreadOnMobile ? 'hidden lg:block' : 'block'} min-w-0 rounded-[14px] border border-black/[0.08] bg-white`} aria-label="Conversations">
          <div className="border-b border-black/[0.08] px-3 pt-2 pb-3">
            <AdminTabs ariaLabel="Conversation filters" tabs={tabs} value={filter} onChange={setFilter} />
            <input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search email, name, subject, order #"
              aria-label="Search conversations" maxLength={100} className={adminInputClass} />
          </div>

          {listErr && <AdminNotice tone="danger" className="m-3">{listErr}</AdminNotice>}
          {loadingList && threads.length === 0 && <div className="px-4"><AdminLoading /></div>}
          {!loadingList && !listErr && threads.length === 0 && (
            <p className="p-4 text-[12px] text-[#6B6B66]">
              {q ? 'No conversations match your search.' : filter === 'unread' ? 'Nothing unread.' : 'No conversations here yet.'}
            </p>
          )}

          <ul className="max-h-[70vh] divide-y divide-black/[0.06] overflow-y-auto">
            {threads.map(t => (
              <li key={t.id}>
                <button onClick={() => select(t.id)} aria-current={t.id === selectedId}
                  className={`w-full px-4 py-3 text-left focus:outline-none focus-visible:bg-black/[0.04] ${t.id === selectedId ? 'bg-[#F5F5F3]' : 'hover:bg-[#FAFAF8]'}`}>
                  <div className="flex items-start justify-between gap-2">
                    <p className={`truncate text-[13px] ${t.unreadCount > 0 ? 'font-semibold' : 'font-medium'}`}>
                      {t.customerName || t.customerEmail}
                    </p>
                    <span className="whitespace-nowrap text-[11px] text-[#8A8A85]">{when(t.lastMessageAt)}</span>
                  </div>
                  {t.customerName && <p className="truncate text-[11px] text-[#6B6B66]">{t.customerEmail}</p>}
                  <p className={`mt-0.5 truncate text-[12px] ${t.unreadCount > 0 ? 'font-semibold' : ''}`}>
                    {t.subject || '(no subject)'}
                  </p>
                  <p className="mt-0.5 truncate text-[11px] text-[#6B6B66]">
                    {t.lastMessageDirection === 'outbound' ? 'You: ' : ''}{t.preview || (t.attachmentCount ? 'Attachment only' : '')}
                  </p>
                  <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
                    {t.unreadCount > 0 && <AdminTag tone="dark" label={`${t.unreadCount} unread`}>{t.unreadCount} new</AdminTag>}
                    {t.status === 'closed' && <AdminTag>Closed</AdminTag>}
                    {t.source === 'contact_form' && <AdminTag tone="info">Contact form</AdminTag>}
                    {t.orderNumber && <span className="text-[11px] text-[#6B6B66]">Order {t.orderNumber}</span>}
                  </div>
                </button>
              </li>
            ))}
          </ul>
          {nextCursor && (
            <div className="border-t border-black/[0.08] p-3">
              <AdminButton className="w-full" onClick={() => loadList({ append: true, cursor: nextCursor })}>Load more</AdminButton>
            </div>
          )}
        </section>

        {/* ── conversation ─────────────────────────────────── */}
        <section className={`${showThreadOnMobile ? 'block' : 'hidden lg:block'} min-h-[320px] min-w-0 rounded-[14px] border border-black/[0.08] bg-white`} aria-label="Conversation">
          {!selectedId && <p className="p-6 text-[13px] text-[#6B6B66]">Select a conversation to read and reply.</p>}
          {selectedId && loadingThread && !thread && <div className="px-6"><AdminLoading /></div>}
          {selectedId && threadErr && <AdminNotice tone="danger" className="m-4">{threadErr}</AdminNotice>}

          {selectedId && thread && thread.id === selectedId && (
            <div className="flex flex-col">
              <header className="border-b border-black/[0.08] p-4">
                <button onClick={() => { setSelectedId(null); setThread(null) }}
                  className="mb-2 min-h-[28px] text-[12px] text-[#6B6B66] underline lg:hidden">← All conversations</button>
                <div className="flex flex-wrap items-start justify-between gap-3">
                  <div className="min-w-0">
                    <h2 className="break-words text-[15px] font-medium">{thread.subject || '(no subject)'}</h2>
                    <p className="mt-1 break-all text-[12px] text-[#6B6B66]">
                      {thread.customerName ? `${thread.customerName} · ` : ''}{thread.customerEmail}
                      {thread.orderNumber ? ` · Order ${thread.orderNumber}` : ''}
                    </p>
                    <p className="mt-1 flex flex-wrap items-center gap-1.5 text-[11px] text-[#8A8A85]">
                      <span>{thread.source === 'contact_form' ? 'Started from the storefront contact form' : `Started by email to ${MAILBOX}`}</span>
                      <StatusBadge status={thread.status === 'closed' ? 'Resolved' : 'Open'} label={thread.status === 'closed' ? 'Closed' : 'Open'} />
                    </p>
                  </div>
                  <AdminButton disabled={statusBusy} onClick={() => setStatus(thread.status === 'open' ? 'closed' : 'open')}>
                    {statusBusy ? '…' : thread.status === 'open' ? 'Mark closed' : 'Reopen'}
                  </AdminButton>
                </div>
              </header>

              <div className="max-h-[55vh] space-y-3 overflow-y-auto bg-[#FAFAF8] p-4">
                {thread.messages.map(m => (
                  <article key={m.id} data-direction={m.direction}
                    className={`max-w-[92%] rounded-[12px] border p-3 sm:max-w-[80%] ${m.direction === 'outbound'
                      ? 'ml-auto border-[#171717] bg-[#171717] text-white' : 'mr-auto border-black/[0.08] bg-white'}`}>
                    <p className={`mb-1.5 text-[11px] ${m.direction === 'outbound' ? 'text-white/70' : 'text-[#6B6B66]'}`}>
                      {m.direction === 'outbound'
                        ? `Sent from ${MAILBOX}${m.actorEmail ? ` by ${m.actorEmail}` : ''}`
                        : `${m.fromName ? `${m.fromName} · ` : ''}${m.fromEmail}${m.channel === 'contact_form' ? ' · contact form' : ''}`}
                      {' · '}{full(m.occurredAt)}
                    </p>
                    {/* Plain text only: React escapes this string. */}
                    <p className="whitespace-pre-wrap break-words text-[13px]">{m.bodyText || (m.attachments.length ? '' : '(empty message)')}</p>
                    {m.importNote && (
                      <p className={`mt-2 text-[11px] ${m.direction === 'outbound' ? 'text-white/80' : 'text-[#92400E]'}`}>⚠ {m.importNote}</p>
                    )}
                    {m.attachments.length > 0 && (
                      <div className="mt-2 border-t border-black/[0.08] pt-2">
                        <p className="text-[11px] font-medium">
                          {m.attachments.length} attachment{m.attachments.length === 1 ? '' : 's'} — the original file{m.attachments.length === 1 ? ' is' : 's are'} in the forwarded mailbox
                        </p>
                        <ul className="mt-1 space-y-0.5 text-[11px] opacity-80">
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

              <form onSubmit={e => { e.preventDefault(); send() }} className="border-t border-black/[0.08] p-4">
                <label htmlFor="support-reply" className="mb-1.5 block text-[11px] font-medium text-[#4A4A46]">
                  Reply to {thread.customerEmail}
                </label>
                <textarea id="support-reply" value={reply} onChange={e => onReplyChange(e.target.value)} rows={5}
                  maxLength={REPLY_MAX} disabled={sending} placeholder="Write your reply…"
                  className={`${adminTextareaClass} text-[13px]`} />
                <div className="mt-2 flex flex-wrap items-center justify-between gap-3">
                  <p className="text-[11px] text-[#8A8A85]">
                    From {MAILBOX} · {reply.length.toLocaleString()} / {REPLY_MAX.toLocaleString()}
                  </p>
                  <AdminButton type="submit" variant="primary" disabled={sending || !reply.trim()}>
                    {sending ? 'Sending…' : 'Send reply'}
                  </AdminButton>
                </div>
                {sendErr && <AdminNotice tone="danger" className="mt-2">{sendErr.text}</AdminNotice>}
                {sendOk && <AdminNotice tone="success" className="mt-2">{sendOk}</AdminNotice>}
              </form>
            </div>
          )}
        </section>
      </div>
    </AdminPage>
  )
}
