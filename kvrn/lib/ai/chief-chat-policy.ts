/** A closed list of read-only Chief chat topics. The model never chooses server tools. */
export type ChiefChatTopic =
  | 'qa'
  | 'ai-budget'
  | 'inventory-integrity'
  | 'payment-exceptions'
  | 'affiliate-integrity'
  | 'marketing-consent'
  | 'marketing-delivery'
  | 'store-credit'
  | 'operations-brief'

export type ChiefChatRoute = { topic: ChiefChatTopic; worker: string }

export function classifyChiefChatRequest(message: string): ChiefChatRoute {
  const lower = message.toLowerCase()
  if (/\b(test|tests|testing|qa|bug|regression|security|feature|features|browser|website|site down)\b/.test(lower)) {
    return { topic: 'qa', worker: 'Engineering, QA & Security' }
  }
  if (/\b(ai|gateway|model|budget|spent|spend|token|inference|cost cap)\b/.test(lower)) {
    return { topic: 'ai-budget', worker: 'Chief Operator' }
  }
  if (/\b(stock|inventory|supply|variant|replenish|reorder|size|hoodie)\b/.test(lower)) {
    return { topic: 'inventory-integrity', worker: 'Product, Inventory & Supply' }
  }
  if (/\b(payment|payments|stripe|refund|chargeback|dispute|fraud)\b/.test(lower)) {
    return { topic: 'payment-exceptions', worker: 'Finance, Attribution & Risk' }
  }
  if (/\b(affiliate|commission|creator|payout)\b/.test(lower)) {
    return { topic: 'affiliate-integrity', worker: 'Creator & Affiliate' }
  }
  if (/\b(sms|opt.in|subscriber|consent|unsubscribe|a2p)\b/.test(lower)) {
    return { topic: 'marketing-consent', worker: 'Customer Support / Lifecycle Revenue' }
  }
  if (/\b(marketing|campaign|email|delivery|outreach)\b/.test(lower)) {
    return { topic: 'marketing-delivery', worker: 'Ads & Social' }
  }
  if (/\b(store.credit|credit|liability|redemption)\b/.test(lower)) {
    return { topic: 'store-credit', worker: 'Finance, Attribution & Risk' }
  }
  return { topic: 'operations-brief', worker: 'Chief Operator' }
}

/** Deterministic scope guard. Proposals can be drafted but never executed via chat. */
export const CHIEF_CHAT_READ_ONLY_NOTICE =
  'Read-only. Chief cannot send messages, change orders, modify inventory, issue refunds, publish content, or deploy code from this chat.'

export function validateChiefChatMessage(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (value.length < 2 || value.length > 1000) return null
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null
  return value
}
