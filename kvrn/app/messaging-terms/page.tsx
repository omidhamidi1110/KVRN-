/** KVRN public SMS legal policy, readable while carrier approval is pending. */
import type {Metadata} from 'next'
import {cmsContentEnabled,contentPublic} from '@/lib/content-public'
import {PolicyView} from '@/components/content/cms-views'
import {MessagingTermsCopy} from '@/components/content/KvrnMessagingPolicies'
export const dynamic='force-dynamic'
export const metadata:Metadata={
 title:'Messaging Terms & Conditions — KVRN',
 description:'KVRN text messaging program disclosures, consent, STOP and HELP details.',
 alternates:{canonical:'/messaging-terms'},
}
export default async function Page(){
 // Keep the existing CMS policy renderer if an owner-published record exists.
 if(cmsContentEnabled()){
  const policy=await contentPublic().getPolicyById('messaging-terms')
  if(policy)return <PolicyView view={policy}/>
 }
 return <MessagingTermsCopy/>
}
