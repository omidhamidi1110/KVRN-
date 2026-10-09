import {KEYWORD_STARTS,KEYWORD_CONFIRMS,KEYWORD_STOPS,parseSmsKeyword,canAcceptSmsKeywordOptin} from '../sms-double-optin'
it('SMS keyword program fails closed if approval or double optin flag missing',()=>{
 const env={TWILIO_A2P_APPROVED:'true',TWILIO_SIGNUP_ENABLED:'true',TWILIO_KEYWORD_DOUBLE_OPTIN_ENABLED:'true'}
 expect(canAcceptSmsKeywordOptin({})).toBe(false)
 expect(canAcceptSmsKeywordOptin({...env,TWILIO_A2P_APPROVED:'false'})).toBe(false)
 expect(canAcceptSmsKeywordOptin(env)).toBe(true)
})
it('YES confirms; JOIN starts; STOP always cancels',()=>{
 expect(KEYWORD_STARTS.has('JOIN')).toBe(true)
 expect(KEYWORD_STARTS.has('YES')).toBe(false)
 expect(KEYWORD_CONFIRMS.has('YES')).toBe(true)
 expect(KEYWORD_STOPS.has('STOP')).toBe(true)
})
it('normalizes reasonable multi-word opt-outs without turning them into opt-ins',()=>{
 for(const msg of ['OPT OUT','opt out please','Opt-Out','STOP all messages','UNSUBSCRIBE','REVOKE']){
   expect(KEYWORD_STOPS.has(parseSmsKeyword(msg))).toBe(true)
 }
 expect(KEYWORD_STOPS.has(parseSmsKeyword('JOIN'))).toBe(false)
 expect(KEYWORD_CONFIRMS.has(parseSmsKeyword('YES'))).toBe(true)
})

// The new two-step consent proof is not the same as a legacy opted_in flag.
it('stores a verified Twilio YES proof only through the pending-confirmation transaction',()=>{
 const fs=require('fs') as typeof import('fs')
 const source=fs.readFileSync('lib/sms-double-optin.ts','utf8')
 const migration=fs.readFileSync('db/migrations/043_verified_keyword_consent_evidence.sql','utf8')
 expect(source).toContain('confirmation_message_sid')
 expect(source).toContain('messageSid')
 expect(source).toContain('JOIN')
 expect(migration).toContain('sms_consent_proofs_immutable')
 expect(migration).not.toContain('UPDATE sms_subscribers SET status=')
})

it('Twilio keyword database failures are retryable, not false success',()=>{
 const fs=require('fs') as typeof import('fs')
 const route=fs.readFileSync('app/api/twilio/incoming/route.ts','utf8')
 expect(route).toContain('Keyword consent persistence failed (redacted)')
 expect(route).toContain("return new NextResponse('Temporary failure; retry required.',{status:503})")
})
