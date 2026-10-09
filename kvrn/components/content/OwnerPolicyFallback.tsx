/** Public owner-supplied October 6 policy copy shown only as a coded fallback.
 * The versioned CMS PUBLISHED policy takes priority when enabled. No drafting or
 * migration action is performed by this component. Text safely rendered by React.
 */
import {PageHero} from '@/components/layout/PageHero'
import {parsePolicyPaste} from '@/lib/content-paste-import'
import {OWNER_LEGAL_COPY} from '@/lib/owner-legal-generated'
import {renderRichText} from './render-richtext'

type OwnerPolicyId='privacy'|'terms'|'messaging-terms'|'messaging-privacy'
const headings:Readonly<Record<OwnerPolicyId,string>>={
  privacy:'Privacy Policy',terms:'Terms of Service',
  'messaging-terms':'Messaging Terms & Conditions',
  'messaging-privacy':'Messaging Privacy Policy',
}
export function OwnerPolicyFallback({policy}:{policy:OwnerPolicyId}){
  const doc=parsePolicyPaste(OWNER_LEGAL_COPY[policy])
  return <div>
    <PageHero title={headings[policy]} breadcrumb={headings[policy]}/>
    <article data-nav-theme="light" className="container-kvrn section-padding max-w-3xl min-w-0" aria-label={headings[policy]}>
      <p className="mb-10 text-xs uppercase tracking-wider text-kvrn-muted">Last updated: October 6, 2026</p>
      {renderRichText(doc.body,{variant:'legal'})}
    </article>
  </div>
}
