/** A real first-party operational reconciliation of the store-credit ledger.
 * Pure SELECT aggregates. No customer identifiers, tokens, orders or provider
 * details leave the DB. This augments (never replaces) the liability totals.
 * Requires staged migration 057 for capture proof reconciliation.
 */
import {sql} from '@/lib/db'

export type StoreCreditOperationsSummary={
 accountCount:number;issueEventCount:number;holdEventCount:number;
 captureEventCount:number;releaseEventCount:number;
 openHoldCount:number;expiredOpenHoldCount:number;paidOpenHoldCount:number;
 invalidHoldLinkCount:number;unpairedTerminalCount:number;
 inconsistentTerminalCount:number;unprovedCaptureCount:number;
 issuedCents:number|null;capturedCents:number|null;
 pendingHoldCents:number|null;availableLiabilityCents:number|null;
 integrityVerified:boolean
}
const parse=(raw:unknown,field:string):bigint=>{
 if(typeof raw!=='string'||!/^(0|[1-9][0-9]*)$/.test(raw))throw Error('CREDIT_OPS_INVALID_'+field)
 return BigInt(raw)
}
const numeric=(v:bigint,field:string):number=>{
 if(v>BigInt(Number.MAX_SAFE_INTEGER))throw Error('CREDIT_OPS_OVERFLOW_'+field)
 return Number(v)
}
export function interpretStoreCreditOperationsRow(r:Record<string,unknown>):StoreCreditOperationsSummary{
 const count=(k:string)=>numeric(parse(r[k],k),k)
 const accountCount=count('account_count'),issueEventCount=count('issue_events')
 const holdEventCount=count('hold_events'),captureEventCount=count('capture_events')
 const releaseEventCount=count('release_events'),openHoldCount=count('open_holds')
 const expiredOpenHoldCount=count('expired_open_holds'),paidOpenHoldCount=count('paid_open_holds')
 const invalidHoldLinkCount=count('invalid_hold_links')
 const unpairedTerminalCount=count('unpaired_terminals')
 const inconsistentTerminalCount=count('inconsistent_terminals')
 const unprovedCaptureCount=count('unproved_captures')
 if(issueEventCount<0||openHoldCount>holdEventCount||expiredOpenHoldCount>openHoldCount||paidOpenHoldCount>openHoldCount||
  captureEventCount+releaseEventCount>holdEventCount||unprovedCaptureCount>captureEventCount||
  invalidHoldLinkCount>holdEventCount||inconsistentTerminalCount>holdEventCount||
  unpairedTerminalCount>captureEventCount+releaseEventCount)throw Error('CREDIT_OPS_INCONSISTENT_COUNTS')
 const issued=parse(r.issued_cents,'issued_cents'),captured=parse(r.captured_cents,'captured_cents')
 const pending=parse(r.pending_cents,'pending_cents')
 const balanced=captured<=issued&&pending<=issued-captured
 const integrityVerified=balanced&&invalidHoldLinkCount===0&&unpairedTerminalCount===0&&
  inconsistentTerminalCount===0&&unprovedCaptureCount===0&&paidOpenHoldCount===0
 // Never present a fabricated $0 or "available" monetary amount when the ledger
 // is internally inconsistent or exceeds JS safe integer precision.
 const issuedCents=issued<=BigInt(Number.MAX_SAFE_INTEGER)?Number(issued):null
 const capturedCents=captured<=BigInt(Number.MAX_SAFE_INTEGER)?Number(captured):null
 const pendingHoldCents=pending<=BigInt(Number.MAX_SAFE_INTEGER)?Number(pending):null
 const remaining=balanced?issued-captured-pending:null
 const availableLiabilityCents=integrityVerified&&remaining!==null&&remaining<=BigInt(Number.MAX_SAFE_INTEGER)?Number(remaining):null
 return {accountCount,issueEventCount,holdEventCount,captureEventCount,releaseEventCount,
  openHoldCount,expiredOpenHoldCount,paidOpenHoldCount,invalidHoldLinkCount,
  unpairedTerminalCount,inconsistentTerminalCount,unprovedCaptureCount,
  issuedCents,capturedCents,pendingHoldCents,availableLiabilityCents,integrityVerified}
}

export async function getStoreCreditOperationsSummary():Promise<StoreCreditOperationsSummary>{
 // Independent one-row aggregates avoid multiplying liability totals by holds,
 // reservations or capture proofs. All money uses numeric sums, never floating point.
 const rows=await sql`WITH
 accounts AS (SELECT COUNT(*)::text AS account_count FROM store_credit_accounts),
 ledger AS (
  SELECT COUNT(*) FILTER(WHERE event_type='issue')::text AS issue_events,
   COUNT(*) FILTER(WHERE event_type='hold')::text AS hold_events,
   COUNT(*) FILTER(WHERE event_type='capture')::text AS capture_events,
   COUNT(*) FILTER(WHERE event_type='release')::text AS release_events,
   COALESCE(SUM(amount_cents::numeric) FILTER(WHERE event_type='issue'),0)::text AS issued_cents,
   COALESCE(SUM(amount_cents::numeric) FILTER(WHERE event_type='capture'),0)::text AS captured_cents
  FROM store_credit_ledger
 ),
 holds AS (
  SELECT h.id,h.account_id,h.hold_key,h.amount_cents,
   ch.id AS checkout_hold_id,ch.reservation_id,ch.account_id AS checkout_account_id,
   ch.amount_cents AS checkout_amount,
   r.status AS reservation_status,r.expires_at AS reservation_expires_at,
   COUNT(t.id)::int AS terminal_count,
   COALESCE(BOOL_OR(t.amount_cents<>h.amount_cents),false) AS wrong_terminal_amount
  FROM store_credit_ledger h
  LEFT JOIN store_credit_checkout_holds ch ON ch.hold_event_id=h.id
  LEFT JOIN reservations r ON r.id=ch.reservation_id
  LEFT JOIN store_credit_ledger t ON t.account_id=h.account_id AND t.hold_key=h.hold_key
    AND t.event_type IN ('capture','release')
  WHERE h.event_type='hold'
  GROUP BY h.id,h.account_id,h.hold_key,h.amount_cents,ch.id,ch.reservation_id,
    ch.account_id,ch.amount_cents,r.status,r.expires_at
 ),
 holds_summary AS (
  SELECT COUNT(*) FILTER(WHERE terminal_count=0)::text AS open_holds,
   COUNT(*) FILTER(WHERE terminal_count=0 AND reservation_expires_at<=NOW())::text AS expired_open_holds,
   COUNT(*) FILTER(WHERE terminal_count=0 AND reservation_status='completed')::text AS paid_open_holds,
   COUNT(*) FILTER(WHERE checkout_hold_id IS NULL OR checkout_account_id<>account_id
     OR checkout_amount<>amount_cents OR reservation_id IS NULL)::text AS invalid_hold_links,
   COUNT(*) FILTER(WHERE terminal_count>1 OR wrong_terminal_amount)::text AS inconsistent_terminals,
   COALESCE(SUM(amount_cents::numeric) FILTER(WHERE terminal_count=0),0)::text AS pending_cents
  FROM holds
 ),
 terminal_summary AS (
  SELECT COUNT(*) FILTER(WHERE h.id IS NULL)::text AS unpaired_terminals
  FROM store_credit_ledger t LEFT JOIN store_credit_ledger h ON h.account_id=t.account_id
    AND h.hold_key=t.hold_key AND h.event_type='hold'
  WHERE t.event_type IN ('capture','release')
 ),
 capture_summary AS (
  SELECT COUNT(*) FILTER(WHERE proof.id IS NULL)::text AS unproved_captures
  FROM store_credit_ledger t LEFT JOIN store_credit_checkout_capture_proofs proof
   ON proof.capture_event_id=t.id
  WHERE t.event_type='capture'
 )
 SELECT * FROM accounts CROSS JOIN ledger CROSS JOIN holds_summary
  CROSS JOIN terminal_summary CROSS JOIN capture_summary`
 if(rows.length!==1)throw Error('CREDIT_OPS_SCHEMA_UNAVAILABLE')
 return interpretStoreCreditOperationsRow(rows[0] as Record<string,unknown>)
}
