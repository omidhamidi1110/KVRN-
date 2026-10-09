import {signMarketingUnsubscribe,verifyMarketingUnsubscribe} from '../marketing-unsubscribe'
const id='123e4567-e89b-42d3-a456-426614174000'
describe('KVRN marketing unsubscribe token',()=>{
  const before=process.env.MARKETING_UNSUBSCRIBE_SECRET
  beforeEach(()=>{process.env.MARKETING_UNSUBSCRIBE_SECRET='testing-only-32-bytes-at-least-no-prod'})
  afterAll(()=>{if(before===undefined)delete process.env.MARKETING_UNSUBSCRIBE_SECRET;else process.env.MARKETING_UNSUBSCRIBE_SECRET=before})
  it('has no email address and verifies the intended subscriber',async()=>{
    const token=await signMarketingUnsubscribe(id)
    expect(token).not.toContain('@')
    expect(await verifyMarketingUnsubscribe(token)).toBe(id)
  })
  it('rejects modified tokens and missing secrets',async()=>{
    const token=await signMarketingUnsubscribe(id)
    expect(await verifyMarketingUnsubscribe(token.slice(0,-16)+(token[token.length-16]==='A'?'B':'A')+token.slice(-15))).toBeNull()
    process.env.MARKETING_UNSUBSCRIBE_SECRET=''
    expect(await verifyMarketingUnsubscribe(token)).toBeNull()
  })
  it('rejects invalid ids',async()=>{await expect(signMarketingUnsubscribe('not-an-id')).rejects.toThrow('INVALID_SUBSCRIBER_ID')})
})
