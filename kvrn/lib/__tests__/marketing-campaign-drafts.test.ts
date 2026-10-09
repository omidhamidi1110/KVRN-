import {validateCampaignDraft} from '../marketing-campaign-drafts'
const email={channel:'email',title:'Fall launch',subject:'New collection',body:'Explore the fall drop',audience:'all-consenting'}
describe('Marketing campaign drafts: strict input boundary',()=>{
 it('accepts valid email draft',()=>expect(validateCampaignDraft(email).ok).toBe(true))
 it('accepts SMS without email subject',()=>expect(validateCampaignDraft({...email,channel:'sms',subject:null}).ok).toBe(true))
 it('rejects an unknown audience',()=>expect(validateCampaignDraft({...email,audience:'affiliate-leads'}).ok).toBe(false))
 it('rejects SMS with email subject',()=>expect(validateCampaignDraft({...email,channel:'sms'}).ok).toBe(false))
 it('rejects extra personal data',()=>expect(validateCampaignDraft({...email,phone_e164:'+15555551212'}).ok).toBe(false))
 it('rejects oversized message',()=>expect(validateCampaignDraft({...email,body:'a'.repeat(10001)}).ok).toBe(false))
 it('rejects missing subject',()=>expect(validateCampaignDraft({...email,subject:''}).ok).toBe(false))
})
