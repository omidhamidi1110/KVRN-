import assert from 'node:assert/strict'
import {readFileSync} from 'node:fs'
import {createHash} from 'node:crypto'
import {validateDraftMigration,inspectDraftChain} from './verify-unapplied-migration-chain.mjs'
const HASH=s=>createHash('sha256').update(s).digest('hex')
const base='-- staging-only\nBEGIN;\nCREATE TABLE IF NOT EXISTS safe_demo(id bigint);\nCOMMIT;\n'
const goodName='038_marketing_suite_drafts.sql'
let n=0
function t(label,f){f();console.log('PASS',label);n++}
t('valid additive transaction passes',()=>assert.deepEqual(validateDraftMigration(goodName,base,HASH(base)),[]))
t('changed SQL hash is rejected',()=>assert.ok(validateDraftMigration(goodName,base,HASH(base+'!')).includes('hash_changed')))
t('missing transaction cannot pass',()=>assert.ok(validateDraftMigration(goodName,'CREATE TABLE demo(id bigint);',HASH('CREATE TABLE demo(id bigint);')).includes('missing_or_duplicate_outer_transaction')))
t('drop table and truncate rejected',()=>{for(const op of ['DROP TABLE safe_demo;','TRUNCATE TABLE safe_demo;']){const s=base.replace('CREATE TABLE IF NOT EXISTS safe_demo(id bigint);',op);assert.ok(validateDraftMigration(goodName,s,HASH(s)).includes('destructive_or_canonical_commerce_statement'))}})
t('canonical order mutation rejected',()=>{for(const op of ['UPDATE orders SET total_cents=0;','ALTER TABLE orders ADD COLUMN dangerous text;','DELETE FROM reservations;','CREATE OR REPLACE FUNCTION finalize_paid_order() RETURNS void AS $$ BEGIN END $$ LANGUAGE plpgsql;']){const s=base.replace('CREATE TABLE IF NOT EXISTS safe_demo(id bigint);',op);assert.ok(validateDraftMigration(goodName,s,HASH(s)).includes('destructive_or_canonical_commerce_statement'))}})
t('comment cannot spoof destructive migration',()=>{const s=base.replace('CREATE TABLE IF NOT EXISTS safe_demo(id bigint);','-- DROP TABLE orders;\nCREATE TABLE IF NOT EXISTS safe_demo(id bigint);');assert.deepEqual(validateDraftMigration(goodName,s,HASH(s)),[])})
t('missing sequence or unexpected numbered draft rejected',()=>{const m=JSON.parse(readFileSync('qa/unapplied-migration-checksums.json','utf8'));const files=Object.fromEntries(Object.keys(m.files).map(k=>[k,readFileSync('db/migrations/'+k,'utf8')]));assert.deepEqual(inspectDraftChain(m,files),[]);delete files[Object.keys(files)[7]];assert.ok(inspectDraftChain(m,files).length>0);files['050_unreviewed.sql']=base;assert.ok(inspectDraftChain(m,files).includes('unexpected_unreviewed_migration_drafts'))})
t('manifest hash pin forbids silent edits to old draft',()=>{const m=JSON.parse(readFileSync('qa/unapplied-migration-checksums.json','utf8'));const files=Object.fromEntries(Object.keys(m.files).map(k=>[k,readFileSync('db/migrations/'+k,'utf8')]));const first=Object.keys(files)[0];files[first]+='\n-- edit\n';assert.ok(inspectDraftChain(m,files).some(x=>x.endsWith('hash_changed')))})
console.log(`${n}/${n} unapplied migration preflight tests passed`)
