/**
 * Conservative marketing time-window evaluator. Pure and side-effect free.
 * A verified recipient timezone and an independently approved jurisdictional rule
 * are REQUIRED. Never infer a phone recipient's timezone from their area code.
 * No locale, timezone or clock value is treated as affirmative SMS consent.
 */
export interface RecipientDeliveryWindow {
  /** Verified IANA timezone (e.g. America/Los_Angeles), not inferred from dial code. */
  timezone: string | null
  timezoneVerified: boolean
  /** Checked against the applicable country/state/recipient rules, not an assumption. */
  jurisdictionRuleVerified: boolean
  /** Optional stricter reviewed rule. 9:00–20:00 is a default conservative range,
   * not a legal compliance guarantee in any specific jurisdiction. End is exclusive. */
  allowedStartLocalHour?: number
  allowedEndLocalHour?: number
}
export type RecipientWindowDecision = {
  allowed: boolean
  localHour: number | null
  reason: 'ok'|'unknown_timezone'|'unverified_jurisdiction'|'invalid_window'|'invalid_clock'|'quiet_hours'
}
/** Blocks on invalid clocks, unknown zones, ambiguous evidence and quiet hours. */
export function evaluateRecipientDeliveryWindow(e: RecipientDeliveryWindow, utcInstant: Date): RecipientWindowDecision {
  const fail=(reason:RecipientWindowDecision['reason']):RecipientWindowDecision=>({allowed:false,localHour:null,reason})
  if(!(utcInstant instanceof Date)||!Number.isFinite(utcInstant.getTime()))return fail('invalid_clock')
  if(!e.timezoneVerified||!e.timezone||typeof e.timezone!=='string'||e.timezone.length>80)return fail('unknown_timezone')
  if(e.jurisdictionRuleVerified!==true)return fail('unverified_jurisdiction')
  const start=e.allowedStartLocalHour ?? 9
  const end=e.allowedEndLocalHour ?? 20
  if(!Number.isInteger(start)||!Number.isInteger(end)||start<0||end>24||end<=start||end-start>12)return fail('invalid_window')
  let hour:number
  try{
    // Use the actual IANA timezone rules for the date (including DST), never
    // fixed UTC offsets. En-US hourCycle h23 avoids the 24:00 representation.
    const f=new Intl.DateTimeFormat('en-US',{timeZone:e.timezone,hour:'2-digit',hourCycle:'h23'})
    const part=f.formatToParts(utcInstant).find(p=>p.type==='hour')?.value
    if(!part)return fail('unknown_timezone')
    hour=Number(part)
    if(!Number.isInteger(hour)||hour<0||hour>23)return fail('unknown_timezone')
  }catch{return fail('unknown_timezone')}
  return hour>=start&&hour<end?{allowed:true,localHour:hour,reason:'ok'}:{allowed:false,localHour:hour,reason:'quiet_hours'}
}
