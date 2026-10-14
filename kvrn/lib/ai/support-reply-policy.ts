// KVRN support autonomy: deterministic guardrails around model output.
// This module never sends messages or accesses providers. All customer-provided text is untrusted.
import type { SupportClassification } from './agents/support'
import type { ThreadDetail } from '@/lib/support-inbox'
import { boundedConfidence, parseStrictJsonObject, sanitizeExternalText } from './sanitize'

export const SUPPORT_AI_ACTOR = 'ai-support@kvrn.internal'
export const SUPPORT_OWNER_ACK = [
  'Thank you for contacting KVRN. I’m sorry we haven’t been able to resolve your concern here.',
  'I’ve escalated your message for personal review by KVRN’s owner. They will follow up as soon as they are able.',
].join(' ')

// A model cannot approve money movement, alter terms, or verify identity by writing a sentence.
const HUMAN_ONLY = new Set(['payment', 'chargeback', 'legal', 'fraud_security'])
const ORDER_SPECIFIC = new Set(['order_status', 'tracking'])
const UNSAFE_PROMISE = /\b(?:i (?:have|just) (?:refunded|canceled|cancelled|shipped|changed|updated|approved|issued)|your (?:refund|replacement|credit) (?:has been|is now) (?:processed|issued|approved|completed)|guaranteed delivery|will arrive (?:on|by) [a-z])/i
const OWNER_REQUEST = /\b(?:speak (?:to|with) (?:a |the )?(?:person|human|manager|owner)|real person|human agent|talk to (?:the )?owner|escalate (?:this|to)|contact (?:the )?owner|your supervisor|your manager)\b/i
const UNHAPPY = /\b(?:still (?:not|no)|does(?:n'?t| not) (?:help|work|solve|answer)|not (?:satisfied|happy|resolved|acceptable)|unhappy|disappointed|fed up|frustrat(?:ed|ing)|again and again|already (?:asked|tried|contacted)|second time|third time|you keep|stop repeating|terrible|worst)\b/i

export function isAutomatedMailbox(thread: ThreadDetail): boolean {
  return /^(?:no[-_.]?reply|do[-_.]?not[-_.]?reply|mailer-daemon|postmaster)@/i.test(thread.customerEmail)
    || /^(?:automatic reply|auto(?:matic)? response|out of office|delivery status notification|undeliverable)\b/i.test(thread.subject)
}

export function countAiAttempts(thread: ThreadDetail): number {
  return thread.messages.filter(m => m.direction === 'outbound' && m.actorEmail?.toLowerCase() === SUPPORT_AI_ACTOR).length
}
export function shouldEscalate(input: {
  classification: SupportClassification
  thread: ThreadDetail
  subject: string
  body: string
  verifiedOrder?: boolean
}): string | null {
  const { classification: c, thread } = input
  const text = `${input.subject}\n${input.body}`.slice(0, 9000)
  if (OWNER_REQUEST.test(text)) return 'customer_requested_owner'
  if (HUMAN_ONLY.has(c.category)) return 'sensitive_payment_or_legal'
  if (c.urgency === 'urgent' || c.needsOwner) return 'triage_requires_owner'
  if (c.confidence == null || c.confidence < 0.82) return 'triage_low_confidence'
  if (thread.messages.at(-1)?.direction !== 'inbound') return 'thread_changed'
  if (countAiAttempts(thread) >= 2 && UNHAPPY.test(text)) return 'unresolved_after_multiple_attempts'
  if (countAiAttempts(thread) >= 3) return 'max_ai_turns'
  if (thread.messages.some(m => m.direction === 'outbound' && m.actorEmail !== SUPPORT_AI_ACTOR)) {
    return 'human_already_participated'
  }
  // Exact status/tracking/payment/refund decisions require authenticated canonical order data.
  // General tracking instructions can be answered, but not the status of a specific order.
  if (ORDER_SPECIFIC.has(c.category) && !input.verifiedOrder && /\b(?:where is|where's|status of|has .*shipp?ed|delivery date|track my|my order|my package)\b/i.test(text)) {
    return 'unverified_order_specific_status'
  }
  if (c.category === 'return_exchange' && /\b(?:refund me|issue (?:a |my )?refund|approve (?:my |a )?return|exchange my|start (?:my |a )?return|return label|damaged|defective|missing item|wrong item)\b/i.test(text)) {
    return 'needs_case_specific_action'
  }
  if (thread.messages.at(-1)?.attachments.length) return 'attachments_need_review'
  return null
}

export type SupportReplyDraft = { decision: 'reply' | 'owner'; confidence: number; body: string; reason: string }
export function parseSupportReplyDraft(raw: string): SupportReplyDraft | null {
  const obj = parseStrictJsonObject(raw)
  if (!obj) return null
  const decision = obj.decision === 'reply' || obj.decision === 'owner' ? obj.decision : null
  const confidence = boundedConfidence(obj.confidence)
  const body = typeof obj.body === 'string' ? obj.body.trim() : ''
  const reason = sanitizeExternalText(obj.reason, 160) || 'not specified'
  if (!decision || confidence == null) return null
  if (decision === 'reply') {
    if (confidence < 0.9 || body.length < 30 || body.length > 1800) return null
    if (/<[^>]{1,60}>|\[REDACTED|\b(?:credit card|password|social security number)\b/i.test(body)) return null
    if (UNSAFE_PROMISE.test(body)) return null
    for (const match of body.matchAll(/https?:\/\/[^\s<>)]{2,300}/gi)) {
      try { const url = new URL(match[0].replace(/[.,;]+$/, '')); if (url.protocol !== 'https:' || url.hostname !== 'kvrn.shop') return null }
      catch { return null }
    }
    if (/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi.test(body.replace(/support@kvrn\.shop/gi, ''))) return null
    if (!/\bKVRN\b/i.test(body) && !/\bkvrn\.shop\b/i.test(body)) return null
  }
  return { decision, confidence, body: decision === 'owner' ? '' : body, reason }
}
