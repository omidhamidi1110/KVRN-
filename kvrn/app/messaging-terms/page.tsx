/** Dedicated public terms route, guarded until counsel/owner approval. */
import type {Metadata} from 'next'
import {notFound} from 'next/navigation'
import {cmsContentEnabled,contentPublic} from '@/lib/content-public'
import {PolicyView} from '@/components/content/cms-views'
import {policyMetadata} from '@/lib/content-storefront'
import {OwnerPolicyFallback} from '@/components/content/OwnerPolicyFallback'
export const dynamic='force-dynamic'
const active=()=>process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED==='true'
const fallback:Metadata={title:'Messaging Terms & Conditions — KVRN',alternates:{canonical:'/messaging-terms'},robots:{index:false,follow:false}}
export async function generateMetadata():Promise<Metadata>{
 if(!active())return fallback
 if(!cmsContentEnabled())return fallback
 const p=await contentPublic().getPolicyById('messaging-terms')
 return p?policyMetadata(p,fallback):fallback
}
export default async function MessagingTermsPage(){
 if(!active())notFound()
 if(cmsContentEnabled()){
   const p=await contentPublic().getPolicyById('messaging-terms')
   if(p)return <PolicyView view={p}/>
 }
 return <OwnerPolicyFallback policy="messaging-terms"/>
}
