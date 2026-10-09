/** Pure source/SQL safety tests. Never contacts Neon, Resend or any recipient. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
const sql=readFileSync('db/migrations/047_resend_topic_optout_reconciliation.sql','utf8')
const cron=readFileSync('app/api/internal/marketing-sync/route.ts','utf8')
const adapter=readFileSync('lib/resend-marketing.ts','utf8')
const checks=[
 ['matching UUID/email and subscribed row required', /WHERE id=p_id AND email=v_email AND status='subscribed'/],
 ['provider contact ID constrained before writing', /length\(p_provider_contact_id\) NOT BETWEEN 8 AND 150[\s\S]*?p_provider_contact_id !~ /],
 ['local suppression committed before append-only audit event', /UPDATE marketing_subscribers[\s\S]*?SET status='unsubscribed'[\s\S]*?INSERT INTO marketing_email_consent_events/],
 ['provider topic audit provenance is explicit', /'unsubscribed','resend_topic_reconciliation'/],
 ['no provider sending or campaign enablement in migration', /^((?!https?:\/\/|sendBroadcast|dispatch_enabled=true|twilio\.messages|resend\.emails).)*$/s],
 ['adapter identifies only explicit provider topic opt_out', /topic\.subscription === 'opt_out'[\s\S]*?providerTopicOptOut: true/],
 ['cron persists suppression before accepting topic opt-out as reconciled', /await suppressMarketingEmailFromResendTopic\([\s\S]*?await updateSyncStatus\(/],
 ['Resend topic STOP moves to unsubscribed not subscribed', /'Provider topic opted out; reconcile segment removal\.', 'unsubscribed'/],
]
for(const [title,re] of checks){assert.match(title.includes('cron') || title.startsWith('Resend')? cron : title.startsWith('adapter')?adapter:sql,re,title);console.log('PASS',title)}
console.log(`${checks.length}/${checks.length} topic opt-out source guards passed. No migration applied.`)
