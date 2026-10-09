import assert from 'node:assert/strict'
import vm from 'node:vm'
import {readFileSync} from 'node:fs'
import {createRequire} from 'node:module'
const req=createRequire(import.meta.url);let ts;try{ts=req('typescript')}catch{ts=req('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const src=readFileSync('lib/ai/inventory-integrity-insight.ts','utf8')
const js=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText
const base={variant_count:'12',active_variants:'10',available_units:'22',unknown_cost_units:'0',unreconciled_variants:'0',invalid_stock_rows:'0',known_cost_cents:'110000'}
let queries=0,returned=[base]
const exp={}
vm.runInNewContext(js,{exports:exp,Error,Number,Object,Math,require(name){if(name==='@/lib/db')return {sql:async()=>{queries++;return returned}};throw Error('unexpected '+name)}})
let n=0;async function test(name,fn){await fn();n++;console.log('PASS',name)}
await test('reconciled stock can display complete cost when all costs known',async()=>{const a=exp.interpretInventoryIntegrityRow(base);assert.equal(a.variantCount,12);assert.equal(a.availableUnits,22);assert.equal(a.completeValuation,true);assert.equal(a.knownLandedCostCents,110000)})
await test('unknown landed unit cost makes full valuation unknown',async()=>{const a=exp.interpretInventoryIntegrityRow({...base,unknown_cost_units:'2'});assert.equal(a.completeValuation,false)})
await test('FIFO mismatch disables availability and complete valuation',async()=>{const a=exp.interpretInventoryIntegrityRow({...base,unreconciled_variants:'1'});assert.equal(a.availableUnits,null);assert.equal(a.knownLandedCostCents,null)})
await test('reserved stock exceeding on-hand disables balances',async()=>{const a=exp.interpretInventoryIntegrityRow({...base,invalid_stock_rows:'1'});assert.equal(a.availableUnits,null);assert.equal(a.completeValuation,false)})
await test('overflow and negative monetary amounts rejected',async()=>{assert.throws(()=>exp.interpretInventoryIntegrityRow({...base,known_cost_cents:'999999999999999999999'}),/UNVERIFIED_NUMBER/);assert.throws(()=>exp.interpretInventoryIntegrityRow({...base,available_units:'-1'}),/UNVERIFIED_NUMBER/)})
await test('count mismatches rejected',async()=>assert.throws(()=>exp.interpretInventoryIntegrityRow({...base,active_variants:'13'}),/INVALID_COUNTS/))
await test('schema missing fails closed, never becomes fake zero',async()=>{returned=[];await assert.rejects(exp.getInventoryIntegritySummary(),/SCHEMA_UNAVAILABLE/);returned=[base]})
await test('read-only query aggregates canonical physical stock, reservations and FIFO layers',async()=>{queries=0;const a=await exp.getInventoryIntegritySummary();assert.equal(a.activeVariantCount,10);assert.equal(queries,1);assert.match(src,/inventory_valuation\(\)/);assert.match(src,/pv\.stock_on_hand-pv\.reserved_quantity/);assert.doesNotMatch(src,/UPDATE|INSERT|DELETE|fetch\(/)})
console.log(`${n}/${n} AI inventory integrity checks passed`)
