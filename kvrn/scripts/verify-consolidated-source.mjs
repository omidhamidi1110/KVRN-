#!/usr/bin/env node
// Dependency-free, deliberately modest static guard. Not a substitute for end-to-end tests.
import { readFileSync, existsSync } from 'node:fs'
function read(path){return readFileSync(new URL(`../${path}`,import.meta.url),'utf8')}
const checks=[
 ['no production schema 027–037 reruns in script', !read('scripts/postscript-consent-dry-run.mjs').includes('DATABASE_URL')],
 ['Twilio marketing remains explicitly off in both Wrangler environments', (read('wrangler.toml').match(/TWILIO_MARKETING_SEND_ENABLED\s*=\s*"false"/g)||[]).length>=2],
 ['AI globally disabled in both Wrangler environments', (read('wrangler.toml').match(/^AI_ENABLED\s*=\s*"false"/gm)||[]).length>=2],
 ['canonical privacy/terms redirects', /permanentRedirect\(['"]\/privacy['"]\)/.test(read('app/legal/privacy/page.tsx')) && /permanentRedirect\(['"]\/terms['"]\)/.test(read('app/legal/terms/page.tsx'))],
 ['sitemap contains no filter-query page entries', !read('app/sitemap.ts').includes('${BASE}/shop?type=')],
 ['old unqualified tracking claim removed from public fallback', !read('app/support/faq/page.tsx').includes('All orders include tracking')],
 ['dry-run checker has no DB import', !/INSERT INTO|UPDATE sms_subscribers|fetch\(/i.test(read('scripts/postscript-consent-dry-run.mjs'))],
 ['pure store-credit domain has no database imports', !/from ['"]\.\/db|\bfetch\(/i.test(read('lib/store-credit-domain.ts'))],
 ['marketing preflight requires opt-in/send switch', read('lib/marketing-dispatch-policy.ts').includes('masterMarketingSwitchOn') && read('lib/marketing-dispatch-policy.ts').includes('suppressionRechecked')],
]
let failed=0
for(const [name,ok] of checks){console.log(`${ok?'PASS':'FAIL'} ${name}`);if(!ok)failed++}
console.log(`${checks.length-failed}/${checks.length} static consolidated source checks passed`)
if(failed) process.exitCode=1
