import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const ui=readFileSync('app/admin/store-credit/StoreCreditClient.tsx','utf8')
const route=readFileSync('app/api/admin/store-credit/route.ts','utf8')
const api=readFileSync('app/api/admin/store-credit/issue/route.ts','utf8')
let passed=0
const t=(label,f)=>{f();console.log('PASS '+label);passed++}
t('server requires admin and owner with disabled-by-default flag',()=>{assert.match(route,/requireAdmin\(req\)/);assert.match(route,/STORE_CREDIT_ISSUANCE_ENABLED==='true'/);assert.match(route,/isCreditIssuanceOwner\(identity.email\)/)})
t('form is hidden unless server reports issuance available',()=>assert.match(ui,/data\?\.issuanceAvailable&&<AdminCard/))
t('credit API enforces same-origin bounded request and owner permission',()=>{assert.match(api,/readAdminMutationJson\(req,1024\)/);assert.match(api,/isCreditIssuanceOwner\(identity.email\)/)})
t('no browser-selected customer email/account key or credit balance accepted',()=>{assert.doesNotMatch(ui,/customerEmail|accountKey|recipientPhone/);assert.match(ui,/returnId,requestedCents:cents,deliveredAt:date\.toISOString/);assert.match(ui,/deliveryEvidenceRef,requestKey:issueKey/)})
t('browser confirms explicit physical inspection',()=>{assert.match(ui,/inspectionConfirmed/);assert.match(ui,/confirmInspectedReturn:true/);assert.match(ui,/disabled=\{issuing\|\|!inspectionConfirmed\}/)})
t('idempotency key is retained after uncertainty and regenerated only on confirmed success',()=>{assert.match(ui,/setIssueKey\(`kvrn-credit-\$\{crypto\.randomUUID\(\)\}`\)/);assert.match(ui,/if\(!response.ok\|\|typeof result.creditEventId!=='string'\)throw/);const after=ui.indexOf('setIssueKey(`kvrn-credit-');const before=ui.indexOf("if(!response.ok||typeof result.creditEventId!=='string')throw");assert.ok(after>before)})
t('all amounts use integer cents conversion, not JS floating arithmetic',()=>{assert.match(ui,/function dollarsToCents/);assert.match(ui,/Number\(whole\)\*100\+Number\(frac\.padEnd\(2,'0'\)\)/)})
t('no unsanitized injection HTML, external network or direct payment action',()=>{assert.doesNotMatch(ui,/dangerouslySetInnerHTML|innerHTML|stripe\.com|refunds\.create/);assert.match(ui,/api\/admin\/store-credit\/issue/)})
const js=ts.transpileModule(ui,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022,jsx:ts.JsxEmit.ReactJSX}}).outputText
assert.ok(js.includes('dollarsToCents'))
console.log(`${passed}/${passed} store-credit owner UI checks passed`)
