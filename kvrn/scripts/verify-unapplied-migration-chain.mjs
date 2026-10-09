/** Read-only preflight for KVRN's NEVER-YET-APPLIED 038+ schema drafts.
 * This does not execute SQL or establish database schema compatibility.
 */
import fs from 'node:fs'
import path from 'node:path'
import {createHash} from 'node:crypto'

const ROOT=process.cwd()
const CHAIN=path.join(ROOT,'db','migrations')
const EXPECTED=path.join(ROOT,'qa','unapplied-migration-checksums.json')
const sha=s=>createHash('sha256').update(s).digest('hex')
const forbidden=[
 /\bDROP\s+TABLE\b/i, /\bTRUNCATE\s+(?:TABLE\s+)?\b/i,
 /\bALTER\s+TABLE\s+(?:public\.)?(?:orders|reservations|order_refunds|order_disputes)\b/i,
 /\b(?:UPDATE|DELETE\s+FROM)\s+(?:public\.)?(?:orders|reservations|order_refunds|order_disputes)\b/i,
 /\bCREATE\s+(?:OR\s+REPLACE\s+)?FUNCTION\s+(?:public\.)?(?:finalize_paid_order|reserve_inventory_v2)\b/i,
]
export function validateDraftMigration(filename,sql,expectedHash){
 const failures=[]
 if(!/^0[3-9][0-9]_[a-z0-9_]+\.sql$/.test(filename))failures.push('bad_filename')
 if(sha(sql)!==expectedHash)failures.push('hash_changed')
 const text=sql.replace(/--[^\n]*/g,'')
 const outerBegin=[...text.matchAll(/^BEGIN;\s*$/gm)].length
 const outerCommit=[...text.matchAll(/^COMMIT;\s*$/gm)].length
 if(outerBegin!==1||outerCommit!==1)failures.push('missing_or_duplicate_outer_transaction')
 if(!/^\s*BEGIN;/i.test(text)||!/COMMIT;\s*$/i.test(text))failures.push('transaction_boundary_changed')
 // Migration 062 is the first intentionally commerce-changing draft. It is
 // independently hash-pinned and reviewed via test-credit-split-finalizer.mjs.
 // All other migrations remain additive-only under the original guard.
 if(filename!=='062_store_credit_checkout_split_tender.sql'){
   for(const pattern of forbidden)if(pattern.test(text))failures.push('destructive_or_canonical_commerce_statement')
 } else if(!text.includes('kvrn_credit_capture_verified_checkout(')||
   !text.includes('pg_advisory_xact_lock(48112026051::bigint)')||
   !text.includes('KVRN_CREDIT|ONLY_VERIFIED_TEST_PAYMENTS')||
   !text.includes('CREATE OR REPLACE FUNCTION finalize_paid_order(')){
    failures.push('risky_062_missing_split_tender_contract')
 }
 return [...new Set(failures)]
}
export function inspectDraftChain(manifest,files){
 const errors=[]
 if(manifest?.baseline_git!=='07ac61f'||manifest.first_unapplied!==38||manifest.last_unapplied!==64||
   !manifest.files||typeof manifest.files!=='object')return ['invalid_baseline_manifest']
 const names=Object.keys(manifest.files)
 if(names.length!==27)errors.push('missing_expected_drafts')
 for(let n=38;n<=64;n++){
  const prefix=`${n.toString().padStart(3,'0')}_`
  const matching=names.filter(s=>s.startsWith(prefix))
  if(matching.length!==1){errors.push(`bad_migration_number:${n}`);continue}
  const filename=matching[0]
  if(typeof files[filename]!=='string'){errors.push(`missing_file:${filename}`);continue}
  for(const err of validateDraftMigration(filename,files[filename],manifest.files[filename]))errors.push(`${filename}:${err}`)
 }
 const unmanaged=Object.keys(files).filter(k=>/^0(?:3[89]|[45][0-9]|6[0-4])_/.test(k)&&!Object.hasOwn(manifest.files,k))
 if(unmanaged.length)errors.push('unexpected_unreviewed_migration_drafts')
 return errors
}
if(process.argv[1] && path.resolve(process.argv[1])===path.resolve(new URL(import.meta.url).pathname)){
 const manifest=JSON.parse(fs.readFileSync(EXPECTED,'utf8'))
 const files=Object.fromEntries(fs.readdirSync(CHAIN).filter(x=>/^0(?:3[89]|[45][0-9]|6[0-4])_.*\.sql$/.test(x)).map(x=>[x,fs.readFileSync(path.join(CHAIN,x),'utf8')]))
 const problems=inspectDraftChain(manifest,files)
 if(problems.length){console.error('MIGRATION DRAFT PREFLIGHT FAIL:',problems.join(', '));process.exitCode=1}
 else console.log('PASS 27/27 locked migration draft hashes, ordering, outer transactions and high-risk statement preflight. NO database connection made.')
}
