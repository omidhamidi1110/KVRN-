/** A closed list of read-only Chief chat topics. The model never chooses server tools. */
export type ChiefChatTopic =
  | 'qa'
  | 'ai-budget'
  | 'ai-workforce'
  | 'business-health'
  | 'ai-routing'
  | 'inventory-integrity'
  | 'payment-exceptions'
  | 'affiliate-integrity'
  | 'marketing-consent'
  | 'marketing-delivery'
  | 'store-credit'
  | 'operations-brief'

export type ChiefChatRoute = { topic: ChiefChatTopic; worker: string }

const ROUTES: Array<{ topic: ChiefChatTopic; worker: string; pattern: RegExp }> = [
  { topic: 'ai-workforce', worker: 'Chief Operator', pattern: /\b(workforce|all (?:11|eleven) (?:agents|workers)|agent status|agents?|employees?|delegat(?:e|ion)|tasks?|scheduler|scheduled|queue|events?|dead.?letter|discarded|failures?|operational readiness)\b/ },
  { topic: 'business-health', worker: 'Chief Operator', pattern: /\b(analytics|funnel|conversion|conversions|support|customers|customer orders|sales|store performance|business performance)\b/ },
  { topic: 'ai-routing', worker: 'Chief Operator', pattern: /\b(provider|providers|gateway|routing|model|models|gemini|anthropic|openai|sonnet|haiku|connections?|integrations?|pushover|notification|alerts?|capabilities)\b/ },
  { topic: 'qa', worker: 'Engineering, QA & Security', pattern: /\b(test|tests|testing|qa|bug|regression|security|feature|features|browser|website|site down)\b/ },
  { topic: 'ai-budget', worker: 'Chief Operator', pattern: /\b(ai budget|budget|spent|spend|token|inference|cost cap|ai cost)\b/ },
  { topic: 'inventory-integrity', worker: 'Product, Inventory & Supply', pattern: /\b(stock|inventory|supply|variant|replenish|reorder|size|hoodie)\b/ },
  { topic: 'payment-exceptions', worker: 'Finance, Attribution & Risk', pattern: /\b(finance|revenue|customer orders|paid orders|payment|payments|stripe|refund|chargeback|dispute|fraud)\b/ },
  { topic: 'affiliate-integrity', worker: 'Creator & Affiliate', pattern: /\b(affiliate|commission|creator|payout)\b/ },
  { topic: 'marketing-consent', worker: 'Customer Support / Lifecycle Revenue', pattern: /\b(sms|opt.in|subscriber|consent|unsubscribe|a2p)\b/ },
  { topic: 'marketing-delivery', worker: 'Ads & Social', pattern: /\b(marketing|campaign|email|delivery|outreach|ads|advertising)\b/ },
  { topic: 'store-credit', worker: 'Finance, Attribution & Risk', pattern: /\b(store.credit|credit|liability|redemption)\b/ },
]

export function classifyChiefChatRequest(message: string): ChiefChatRoute {
  const match = ROUTES.find(r => r.pattern.test(message.toLowerCase()))
  return match ? {topic:match.topic,worker:match.worker} : {topic:'operations-brief',worker:'Chief Operator'}
}

/**
 * Cross-department audits are explicitly selected by the SERVER. Limit to six
 * distinct canonical summaries, not an unbounded parallel query or model tool loop.
 */
export function selectChiefChatTopics(message: string, previousOwnerMessage?: string): ChiefChatTopic[] {
  const lower = message.toLowerCase()
  // "order to fix problems" is a planning request, not a customer order.
  if (/\b(urgent|highest.priority|most important|biggest problems|top problems|prioriti[sz]e|triage)\b/.test(lower) &&
      /\b(problems?|issues?|risks?|failures?|business|system|operations?|agents?|health|fix)\b/.test(lower) &&
      !/\b(order number|specific order|checkout order|paid order|order #)\b/.test(lower)) {
    return ['ai-workforce', 'qa', 'operations-brief', 'business-health', 'ai-budget', 'ai-routing']
  }
  const audit = /\b(audit|comprehensive|entire|everything|full|all departments|all (?:11|eleven)|workforce health|system health|overall readiness|operating system|how is everything|whole business)\b/.test(lower)
  if (audit && /\b(ai|agents?|chief|workforce|employees?|operations?|departments?|system|everything|business|readiness)\b/.test(lower)) {
    // Aggregate workforce evidence, configuration, QA and representative canonical business domains.
    // The owner can ask follow-up domain-specific questions for omitted domains.
    return ['ai-workforce', 'ai-routing', 'qa', 'ai-budget', 'business-health', 'operations-brief']
  }
  const found = ROUTES.filter(r => r.pattern.test(lower)).map(r => r.topic)
  // Distinct domains appearing together should all be checked, not misrouted
  // because "QA" or "AI" appears earlier than the more specific topic.
  const unique = [...new Set(found)].slice(0, 6)
  if (unique.length) return unique
  if (/^(?:what about|and|why|how about|explain|tell me more|what next|then)\b/i.test(message) && previousOwnerMessage) {
    return selectChiefChatTopics(previousOwnerMessage)
  }
  return ['operations-brief']
}

/** Deterministic scope guard. Proposals can be drafted but never executed via chat. */
export const CHIEF_CHAT_READ_ONLY_NOTICE =
  'Read-only. Chief cannot send messages, change orders, modify inventory, issue refunds, publish content, or deploy code from this chat.'

export function validateChiefChatMessage(input: unknown): string | null {
  if (typeof input !== 'string') return null
  const value = input.trim()
  if (value.length < 2 || value.length > 3500) return null
  if (/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/.test(value)) return null
  return value
}
