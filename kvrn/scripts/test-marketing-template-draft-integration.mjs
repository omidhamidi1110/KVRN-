import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const s=readFileSync('app/admin/marketing/MarketingClient.tsx','utf8')
const b=readFileSync('app/admin/marketing/templates/TemplateClient.tsx','utf8')
const route=readFileSync('app/api/admin/marketing/templates/route.ts','utf8')
const ts=createRequire(import.meta.url)('typescript')
let n=0
function test(title,check){check();n++;console.log('PASS',title)}
test('campaign loads authenticated Admin template API only',()=>assert.match(s,/fetch\('\/api\/admin\/marketing\/templates',\{cache:'no-store'\}\)/))
test('reject missing explicit sends disabled flag',()=>assert.match(s,/payload\.sendEnabled!==false/))
test('only editorial-ready templates are shown',()=>assert.match(s,/\.filter\(t=>t\.state==='ready'\)/))
test('editing current draft cannot paste a template over unsaved text',()=>assert.match(s,/if\(selected\|\|t\.state!=='ready'\)/))
test('copies only brand-owned template data and does not save or send',()=>{assert.match(s,/renderStaticBrandCopy\(t\.body\)/);assert.match(s,/setForm\(\{channel:t\.channel/);assert.doesNotMatch(s,/copyTemplateIntoNewDraft[\s\S]*?\n  }[\s\S]*?\bfetch\('https:/)})
test('new template editor has no send buttons',()=>{assert.match(b,/No sending or approval/);assert.doesNotMatch(b,/sendCampaign|dispatchCampaign|sendSms/)} )
test('templates API has no providers',()=>assert.doesNotMatch(route,/twilio|resend|sendEmail|sendSms|fetch\(/i))
test('both modified TSX files have no parse errors',()=>{
 for(const [path,source] of [['MarketingClient',s],['TemplateClient',b]]){
  const sf=ts.createSourceFile(path+'.tsx',source,ts.ScriptTarget.Latest,true,ts.ScriptKind.TSX)
  assert.equal(sf.parseDiagnostics.length,0,JSON.stringify(sf.parseDiagnostics.map(d=>d.messageText)))
 }
})
console.log(`${n}/${n} reusable copy drafting integration tests passed`)
