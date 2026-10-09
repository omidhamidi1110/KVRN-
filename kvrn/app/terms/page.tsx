import type {Metadata} from 'next'
import {cmsContentEnabled,contentPublic} from '@/lib/content-public'
import {PolicyView} from '@/components/content/cms-views'
import {policyMetadata} from '@/lib/content-storefront'
import {OwnerPolicyFallback} from '@/components/content/OwnerPolicyFallback'
const FALLBACK_METADATA:Metadata={
 title:'Terms of Service — KVRN',description:'KVRN terms governing shopping, service, and returns.',
 alternates:{canonical:'/terms'},robots:{index:true,follow:true},
}
export const dynamic='force-dynamic'
export async function generateMetadata():Promise<Metadata>{
 if(!cmsContentEnabled())return FALLBACK_METADATA
 const policy=await contentPublic().getPolicyById('terms')
 return policy?policyMetadata(policy,FALLBACK_METADATA):FALLBACK_METADATA
}
export default async function TermsPage(){
 if(cmsContentEnabled()){
   const policy=await contentPublic().getPolicyById('terms')
   if(policy)return <PolicyView view={policy}/>
 }
 return <OwnerPolicyFallback policy="terms"/>
}
