import { countAiAttempts, isAutomatedMailbox, parseSupportReplyDraft, shouldEscalate, SUPPORT_AI_ACTOR } from '../ai/support-reply-policy'
import type { SupportClassification } from '../ai/agents/support'
import type { ThreadDetail } from '../support-inbox'

const uuid = '123e4567-e89b-42d3-a456-426614174000'
const classification: SupportClassification = { category:'sizing', urgency:'normal',confidence:0.99,needsOwner:false,reason:'clear',summary:'sizing question' }
function makeThread(overrides:Partial<ThreadDetail>={}):ThreadDetail {
  return {
    id:uuid, customerEmail:'customer@example.com',customerName:null,subject:'Sizing question',orderNumber:null,
    source:'email',status:'open',unreadCount:1,lastMessageAt:'2026-10-14T12:00:00Z',lastMessageDirection:'inbound',
    createdAt:'2026-10-14T12:00:00Z',messages:[{
      id:uuid,direction:'inbound',channel:'email',fromEmail:'customer@example.com',fromName:null,
      toEmail:'support@kvrn.shop',subject:'Sizing question',bodyText:'What size should I order?',attachments:[],
      importNote:null,actorEmail:null,occurredAt:'2026-10-14T12:00:00Z',
    }],...overrides,
  }
}
function withAiTurns(count:number, lastBody:string):ThreadDetail {
  const base = makeThread()
  const outbound = Array.from({length:count},(_,i)=>({...base.messages[0],id:`${i}`,direction:'outbound' as const,
    actorEmail:SUPPORT_AI_ACTOR,bodyText:'KVRN size guidance'}))
  return makeThread({messages:[base.messages[0],...outbound,{...base.messages[0],id:'last',bodyText:lastBody}]})
}

describe('support agent safeguards',()=>{
  test('ordinary verified sizing can be answered',()=>{
    expect(shouldEscalate({classification,thread:makeThread(),subject:'Sizing',body:'Which size fits?'})).toBeNull()
  })
  test('customer requesting a human is escalated immediately',()=>{
    expect(shouldEscalate({classification,thread:makeThread(),subject:'Hi',body:'I want to speak to a manager'})).toBe('customer_requested_owner')
  })
  test('legal and chargeback questions require human',()=>{
    expect(shouldEscalate({classification:{...classification,category:'chargeback'},thread:makeThread(),subject:'',body:'Help'})).toBe('sensitive_payment_or_legal')
  })
  test('low-confidence triage requires human',()=>{
    expect(shouldEscalate({classification:{...classification,confidence:0.7},thread:makeThread(),subject:'',body:'Help'})).toBe('triage_low_confidence')
  })
  test('unhappy customer after two replies reaches owner',()=>{
    expect(countAiAttempts(withAiTurns(2,'Still not resolved'))).toBe(2)
    expect(shouldEscalate({classification,thread:withAiTurns(2,'Still not resolved'),subject:'',body:'Still not resolved'})).toBe('unresolved_after_multiple_attempts')
  })
  test('three AI attempts trigger human even without complaint',()=>{
    expect(shouldEscalate({classification,thread:withAiTurns(3,'Thanks'),subject:'',body:'Thanks'})).toBe('max_ai_turns')
  })
  test('specific order status requires matching canonical verification',()=>{
    const c={...classification,category:'order_status' as const}
    expect(shouldEscalate({classification:c,thread:makeThread(),subject:'',body:'Where is my order?'})).toBe('unverified_order_specific_status')
    expect(shouldEscalate({classification:c,thread:makeThread(),subject:'',body:'Where is my order?',verifiedOrder:true})).toBeNull()
  })
  test('case-specific refunds and returns escalate',()=>{
    expect(shouldEscalate({classification:{...classification,category:'return_exchange'},thread:makeThread(),subject:'',body:'Can you issue a refund?'})).toBe('needs_case_specific_action')
  })
  test('autoresponders and no-reply addresses are recognized',()=>{
    expect(isAutomatedMailbox(makeThread({customerEmail:'no-reply@example.com'}))).toBe(true)
    expect(isAutomatedMailbox(makeThread({subject:'Out of office'}))).toBe(true)
    expect(isAutomatedMailbox(makeThread())).toBe(false)
  })
  test('safe JSON response is accepted and output is bounded',()=>{
    const r=parseSupportReplyDraft(JSON.stringify({decision:'reply',confidence:0.98,body:'Thank you for contacting KVRN! Our size guide is available at https://kvrn.shop/support/size-guide.',reason:'verified sizing'}))
    expect(r?.decision).toBe('reply')
  })
  test('unsafe promises, unknown domains and low confidence are rejected',()=>{
    const base={decision:'reply',confidence:0.99,reason:'test'}
    expect(parseSupportReplyDraft(JSON.stringify({...base,body:'KVRN: I have refunded your purchase, no further action needed.'}))).toBeNull()
    expect(parseSupportReplyDraft(JSON.stringify({...base,body:'KVRN: Please confirm your info at https://attacker.example/checkout before we can help.'}))).toBeNull()
    expect(parseSupportReplyDraft(JSON.stringify({...base,confidence:0.72,body:'Thanks for contacting KVRN, we can explain the process.'}))).toBeNull()
  })
})
