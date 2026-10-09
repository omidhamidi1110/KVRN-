import type {Metadata} from 'next'
import {cmsContentEnabled,contentPublic} from '@/lib/content-public'
import {PolicyView} from '@/components/content/cms-views'
import {policyMetadata} from '@/lib/content-storefront'
import {OwnerPolicyFallback} from '@/components/content/OwnerPolicyFallback'
const FALLBACK_METADATA:Metadata={
 title:'Privacy Policy — KVRN',description:'How KVRN collects, uses, and protects personal information.',
 alternates:{canonical:'/privacy'},robots:{index:true,follow:true},
}
export const dynamic='force-dynamic'
export async function generateMetadata():Promise<Metadata>{
 if(!cmsContentEnabled())return FALLBACK_METADATA
 const policy=await contentPublic().getPolicyById('privacy')
 return policy?policyMetadata(policy,FALLBACK_METADATA):FALLBACK_METADATA
}
export default async function PrivacyPage(){
 if(cmsContentEnabled()){
   const policy=await contentPublic().getPolicyById('privacy')
   if(policy)return <PolicyView view={policy}/>
 }
 return <OwnerPolicyFallback policy="privacy"/>
}
