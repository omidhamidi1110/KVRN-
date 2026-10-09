/** Dedicated messaging privacy route, guarded until counsel/owner approval. */
import type {Metadata} from 'next'
import {notFound} from 'next/navigation'
import {cmsContentEnabled,contentPublic} from '@/lib/content-public'
import {PolicyView} from '@/components/content/cms-views'
import {policyMetadata} from '@/lib/content-storefront'
import {OwnerPolicyFallback} from '@/components/content/OwnerPolicyFallback'
export const dynamic='force-dynamic'
const active=()=>process.env.KVRN_SMS_POLICY_PUBLIC_ENABLED==='true'
const fallback:Metadata={title:'Messaging Privacy Policy — KVRN',alternates:{canonical:'/messaging-privacy'},robots:{index:false,follow:false}}
export async function generateMetadata():Promise<Metadata>{
 if(!active())return fallback
 if(!cmsContentEnabled())return fallback
 const p=await contentPublic().getPolicyById('messaging-privacy')
 return p?policyMetadata(p,fallback):fallback
}
export default async function MessagingPrivacyPage(){
 if(!active())notFound()
 if(cmsContentEnabled()){
   const p=await contentPublic().getPolicyById('messaging-privacy')
   if(p)return <PolicyView view={p}/>
 }
 return <OwnerPolicyFallback policy="messaging-privacy"/>
}
