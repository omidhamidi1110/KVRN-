import {MARKETING_RELEASE_GATES,MARKETING_DRAFT_CAPS} from '../marketing-suite-readiness'
describe('Production marketing gates',()=>{
  it('defaults all provider and payment gates to blocked',()=>{
    expect(MARKETING_RELEASE_GATES).toHaveLength(7)
    expect(MARKETING_RELEASE_GATES.every(x=>x.codeStatus==='blocked')).toBe(true)
  })
  it('keeps SMS budget under suggested daily/monthly limits',()=>{
    expect(MARKETING_DRAFT_CAPS.smsDailyMicros).toBe(3000000)
    expect(MARKETING_DRAFT_CAPS.smsMonthlyMicros).toBe(15000000)
  })
})
