/** Pure aggregate guard tests: no database/Stripe calls. */
import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
import vm from 'node:vm'
const require=createRequire(import.meta.url)
const ts=require('typescript')
const file='lib/store-credit-ledger-integrity.ts'
const result=ts.transpileModule(readFileSync(file,'utf8'),{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}})
const exports={}
vm.runInNewContext(result.outputText,{exports},{filename:file})
const inspect=exports.inspectCreditLiabilityTotals
const good=(issued,redeemed,outstanding)=>({total_issued_cents:issued,total_redeemed_cents:redeemed,outstanding_liability_cents:outstanding})
const cases=[
 ['valid zero liability',()=>assert.equal(inspect(good('0','0','0')).outstandingCents,0)],
 ['valid outstanding liability',()=>assert.equal(inspect(good('8000','3000','5000')).outstandingCents,5000)],
 ['never represent missing data as zero',()=>assert.equal(inspect(null),null)],
 ['reject untrustworthy decimal float',()=>assert.equal(inspect(good(1.5,0,1.5)),null)],
 ['reject negative liabilities',()=>assert.equal(inspect(good('10','20','-10')),null)],
 ['reject internal accounting mismatch',()=>assert.equal(inspect(good('100','30','80')),null)],
 ['reject overflow instead of imprecise Number conversion',()=>assert.equal(inspect(good((2n**63n).toString(),'0',(2n**63n).toString())),null)],
 ['reject non-integer SQL string',()=>assert.equal(inspect(good('10.0','0','10')),null)],
 ['accept bigint exact integers',()=>assert.equal(inspect(good(9007199254740991n,1n,9007199254740990n)).outstandingCents,9007199254740990)],
]
for(const [name,fn] of cases){fn();console.log('PASS',name)}
console.log(`${cases.length}/${cases.length} store-credit aggregate integrity assertions passed`)
