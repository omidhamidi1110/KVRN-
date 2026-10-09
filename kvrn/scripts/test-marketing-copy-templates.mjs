import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const ts=createRequire(import.meta.url)('typescript')
const raw=readFileSync('lib/marketing-copy-templates.ts','utf8')
const sqlText=readFileSync('db/migrations/055_marketing_templates.sql','utf8')
const route=readFileSync('app/api/admin/marketing/templates/route.ts','utf8')
const opts={module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}
const js=ts.transpileModule(raw,{compilerOptions:opts}).outputText
const tokenExports={}
const tokenJs=ts.transpileModule(readFileSync('lib/marketing-copy-template-tokens.ts','utf8'),{compilerOptions:opts}).outputText
vm.runInNewContext(tokenJs,{exports:tokenExports,Set,Array,Object,Number,String,Date,RegExp,Error})
const exports={},sql=async()=>[]
vm.runInNewContext(js,{exports,Set,Array,Object,Number,String,Date,RegExp,Error,require(name){if(name==='@/lib/db')return {sql};if(name==='./marketing-copy-template-tokens')return tokenExports;throw Error(name)}})
const valid={channel:'sms',label:'Drop Notice',category:'launch',subject:null,body:'Hey, {{brand}} has a drop. {{site_url}}'}
let n=0
function test(name,fn){fn();console.log('PASS',name);n++}
test('simple launch SMS is valid',()=>assert.equal(exports.validateCopyTemplate(valid),true))
test('email must have subject',()=>assert.equal(exports.validateCopyTemplate({...valid,channel:'email'}),false))
test('SMS may not have subject',()=>assert.equal(exports.validateCopyTemplate({...valid,subject:'Look'}),false))
test('email subject bounded',()=>assert.equal(exports.validateCopyTemplate({...valid,channel:'email',subject:'x'.repeat(141)}),false))
test('unknown or PII placeholders rejected',()=>{
 for(const token of ['first_name','email','customer_name','unsubscribe_url','discount_code','__proto__','constructor'])assert.equal(exports.validateCopyTemplate({...valid,body:'{{'+token+'}}'}),false)
})
test('safe static brand tokens resolved without dynamic customer values',()=>{
 assert.equal(tokenExports.renderStaticBrandCopy('{{brand}} | {{site_url}} | {{support_email}}'),'KVRN | https://kvrn.shop | support@kvrn.shop')
})
test('invalid tokens cannot render later even if validation skipped',()=>assert.throws(()=>tokenExports.renderStaticBrandCopy('{{payment_card}}'),/UNSUPPORTED_MARKETING_PLACEHOLDER/))
test('unmatched braces cannot bypass validation or rendering',()=>{
 for(const body of ['{{hello world}}','prefix {{brand','suffix }}','{{ brand }}}']){
  assert.equal(exports.validateCopyTemplate({...valid,body}),false)
  assert.throws(()=>tokenExports.renderStaticBrandCopy(body),/UNSUPPORTED_MARKETING_PLACEHOLDER/)
 }
})
test('HTML script and javascript schemes rejected',()=>{
 for(const body of ['<script>alert(1)</script>','javascript:alert(1)'])assert.equal(exports.validateCopyTemplate({...valid,body}),false)
})
test('copy version updates use optimistic locking',()=>assert.match(sqlText,/v_old\.version<>p_expected_version/))
test('archived templates cannot be reopened or edited',()=>{
 assert.match(sqlText,/v_old\.state='archived'/)
 assert.match(sqlText,/MARKETING_TEMPLATE_TRANSITION_CONFLICT/)
})
test('audit append only; editorial ready never authorizes send',()=>{
 assert.match(sqlText,/MARKETING_TEMPLATE_AUDIT_APPEND_ONLY/)
 assert.match(sqlText,/Ready means reusable copy, NOT human approval/)
})
test('Admin API requires auth and bounded same-origin JSON',()=>{
 assert.match(route,/requireAdmin\(req\)/)
 assert.match(route,/readAdminMutationJson\(req,12000\)/)
 assert.match(route,/sendEnabled:false/)
 assert.doesNotMatch(route,/\bfetch\(|sendSms|sendEmail/)
})
console.log(`${n}/${n} marketing templates tests passed`)
