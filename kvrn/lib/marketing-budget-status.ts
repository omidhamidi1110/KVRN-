/** Server-only, read-only marketing spend/commitment status.
 * Reserves reflect worst-case liability, not the provider's final invoice.
 * Unknown totals are errors, NEVER a zero. Not a permission to send.
 */
import {sql} from '@/lib/db'
export type BudgetChannel='sms'|'email'
export type BudgetLine={channel:BudgetChannel;dailyCommittedMicros:number;monthlyCommittedMicros:number;
  dailyLimitMicros:number;monthlyLimitMicros:number;remainingDailyMicros:number;remainingMonthlyMicros:number;
  unresolvedReservations:number;oldestUnresolvedHours:number|null;status:'within_cap'|'exceeded'|'review_required'}
export type MarketingBudgetStatus={asOf:string;dispatchEnabled:boolean;lines:BudgetLine[];
  aiSmsMonthlyCommittedMicros:number;aiSmsMonthlyLimitMicros:number;
  aiSmsRemainingMicros:number;aiSmsStatus:'within_cap'|'exceeded';
  sendAuthorized:false;warnings:string[]}
const positive=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>0
const nonnegative=(v:unknown)=>typeof v==='number'&&Number.isSafeInteger(v)&&v>=0
const money=(v:unknown)=>{
 if((typeof v!=='string'&&typeof v!=='number')|| !/^[0-9]{1,16}$/.test(String(v)))throw Error('MARKETING_BUDGET_UNVERIFIED_TOTAL')
 const n=Number(v)
 if(!nonnegative(n))throw Error('MARKETING_BUDGET_UNSAFE_TOTAL')
 return n
}
export type RawBudgetFacts={dispatchEnabled:unknown;dailyCapSms:unknown;monthlyCapSms:unknown;
  dailyCapEmail:unknown;monthlyCapEmail:unknown;aiMonthlyCapSms:unknown;
  smsToday:unknown;smsMonth:unknown;emailToday:unknown;emailMonth:unknown;aiSmsMonth:unknown;
  smsPending:unknown;emailPending:unknown;smsOldestHours:unknown;emailOldestHours:unknown}
export function interpretBudgetFacts(raw:RawBudgetFacts,asOf:Date):MarketingBudgetStatus{
 if(!(asOf instanceof Date)||!Number.isFinite(asOf.getTime())||typeof raw.dispatchEnabled!=='boolean')throw Error('MARKETING_BUDGET_UNVERIFIED_POLICY')
 const limits=[raw.dailyCapSms,raw.monthlyCapSms,raw.dailyCapEmail,raw.monthlyCapEmail,raw.aiMonthlyCapSms].map(money)
 if(!limits.every(positive)||limits[0]>3_000_000||limits[1]>15_000_000||limits[2]>2_000_000||limits[3]>10_000_000||limits[4]>5_000_000)throw Error('MARKETING_BUDGET_INVALID_CAPS')
 const totals=[raw.smsToday,raw.smsMonth,raw.emailToday,raw.emailMonth,raw.aiSmsMonth].map(money)
 const pending=[raw.smsPending,raw.emailPending].map(money)
 if(pending.some(n=>n>2_147_483_647))throw Error('MARKETING_BUDGET_INVALID_PENDING_COUNT')
 const age=(v:unknown,pendingCount:number):number|null=>{
   if(pendingCount===0){if(v===null||v===undefined||v===0)return null;throw Error('MARKETING_BUDGET_OLD_PENDING_MISMATCH')}
   if(v===null||v===undefined)return null // unknown age is not a clean health report
   const n=Number(v)
   if(!nonnegative(n))throw Error('MARKETING_BUDGET_UNVERIFIED_PENDING_AGE')
   return n
 }
 const ages=[age(raw.smsOldestHours,pending[0]),age(raw.emailOldestHours,pending[1])]
 const lines:BudgetLine[]=['sms','email'].map((channel,i)=>{
   const daily=totals[i*2],monthly=totals[i*2+1],capDay=limits[i*2],capMonth=limits[i*2+1]
   const exceeded=daily>capDay||monthly>capMonth
   const stale=pending[i]>0&&(ages[i]===null||ages[i]!>=24)
   return {channel:channel as BudgetChannel,dailyCommittedMicros:daily,monthlyCommittedMicros:monthly,
     dailyLimitMicros:capDay,monthlyLimitMicros:capMonth,
     remainingDailyMicros:Math.max(0,capDay-daily),remainingMonthlyMicros:Math.max(0,capMonth-monthly),
     unresolvedReservations:pending[i],oldestUnresolvedHours:ages[i],
     status:exceeded?'exceeded':stale?'review_required':'within_cap'}
 })
 const ai=totals[4],aiCap=limits[4]
 return {asOf:asOf.toISOString(),dispatchEnabled:raw.dispatchEnabled,lines,
  aiSmsMonthlyCommittedMicros:ai,aiSmsMonthlyLimitMicros:aiCap,
  aiSmsRemainingMicros:Math.max(0,aiCap-ai),aiSmsStatus:ai>aiCap?'exceeded':'within_cap',
  sendAuthorized:false,warnings:[
   'Budget reserves are worst-case estimated costs, not provider invoice totals; unknown charges remain reserved.',
   'Zero or available budget does not establish consent, owner approval or provider authorization.',
   'Old/unresolved reservations require independent provider and finance review; this dashboard cannot release them.',
  ]}
}
export async function getMarketingBudgetStatus():Promise<MarketingBudgetStatus>{
 const rows=await sql`SELECT p.dispatch_enabled,p.sms_daily_cap_micros::text AS sms_daily_cap,
   p.sms_monthly_cap_micros::text AS sms_monthly_cap,
   p.email_daily_cap_micros::text AS email_daily_cap,
   p.email_monthly_cap_micros::text AS email_monthly_cap,
   p.ai_sms_monthly_cap_micros::text AS ai_sms_cap,
   (SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
      WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)::text
    FROM marketing_budget_reservations WHERE channel='sms' AND budget_utc_day=(NOW() AT TIME ZONE 'UTC')::date) AS sms_today,
   (SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
      WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)::text
    FROM marketing_budget_reservations WHERE channel='sms' AND budget_utc_month=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date) AS sms_month,
   (SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
      WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)::text
    FROM marketing_budget_reservations WHERE channel='email' AND budget_utc_day=(NOW() AT TIME ZONE 'UTC')::date) AS email_today,
   (SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
      WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)::text
    FROM marketing_budget_reservations WHERE channel='email' AND budget_utc_month=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date) AS email_month,
   (SELECT COALESCE(SUM(CASE WHEN state='reserved' THEN reserved_micros::numeric
      WHEN state='settled' THEN actual_micros::numeric ELSE 0 END),0)::text
    FROM marketing_budget_reservations WHERE channel='sms' AND ai_initiated=true
      AND budget_utc_month=date_trunc('month',NOW() AT TIME ZONE 'UTC')::date) AS ai_sms_month,
   (SELECT COUNT(*)::int FROM marketing_budget_reservations WHERE channel='sms' AND state='reserved') AS sms_pending,
   (SELECT COUNT(*)::int FROM marketing_budget_reservations WHERE channel='email' AND state='reserved') AS email_pending,
   (SELECT FLOOR(EXTRACT(EPOCH FROM NOW()-MIN(created_at))/3600)::integer
      FROM marketing_budget_reservations WHERE channel='sms' AND state='reserved') AS sms_oldest_hours,
   (SELECT FLOOR(EXTRACT(EPOCH FROM NOW()-MIN(created_at))/3600)::integer
      FROM marketing_budget_reservations WHERE channel='email' AND state='reserved') AS email_oldest_hours
  FROM marketing_budget_policy p WHERE p.id=1`
 if(rows.length!==1)throw Error('MARKETING_BUDGET_POLICY_MISSING')
 const r=rows[0]
 return interpretBudgetFacts({dispatchEnabled:r.dispatch_enabled,
   dailyCapSms:r.sms_daily_cap,monthlyCapSms:r.sms_monthly_cap,
   dailyCapEmail:r.email_daily_cap,monthlyCapEmail:r.email_monthly_cap,
   aiMonthlyCapSms:r.ai_sms_cap,smsToday:r.sms_today,smsMonth:r.sms_month,
   emailToday:r.email_today,emailMonth:r.email_month,aiSmsMonth:r.ai_sms_month,
   smsPending:r.sms_pending,emailPending:r.email_pending,
   smsOldestHours:r.sms_oldest_hours,emailOldestHours:r.email_oldest_hours},new Date())
}
