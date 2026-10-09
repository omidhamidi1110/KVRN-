/** Dependency-injected runtime tests: never contacts Neon, Stripe or Resend. */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import vm from 'node:vm'
import {createRequire} from 'node:module'
import {webcrypto} from 'node:crypto'
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const env=process.env
Object.assign(env,{
 STORE_CREDIT_IDENTITY_EMAIL_ENABLED:'true',STORE_CREDIT_ACCOUNT_PEPPER:'x'.repeat(45),
 RESEND_API_KEY:'fake-test-api-key',STORE_CREDIT_IDENTITY_FROM:'KVRN <support@kvrn.shop>'
})
const UUID='12345678-1234-4123-8123-123456789abc'
const challenges=new Map(),sessions=new Map(),sent=[]
let permit=true,ledger={issued:'2000',captured:'300',held:'200'},dbCalls=0
const db=async (parts,...values)=>{
 dbCalls++
 const q=parts.join('?')
 if(q.includes('public_api_rate_allow'))return [{ok:permit}]
 if(q.includes('INSERT INTO store_credit_identity_challenges')){
  const [key,digest]=values; challenges.set(UUID,{key,digest,redeemed:false});return [{id:UUID}]
 }
 if(q.includes('kvrn_credit_redeem_identity_challenge')){
  const [id,digest,sess]=values,c=challenges.get(id)
  if(!c||c.redeemed||c.digest!==digest)return [{redeemed:false}]
  c.redeemed=true;sessions.set(sess,c.key);return [{redeemed:true}]
 }
 if(q.includes('kvrn_credit_verified_account_key'))return [{account_key:sessions.get(values[0])??null}]
 if(q.includes('FROM store_credit_accounts'))return [{...ledger}]
 if(q.includes('kvrn_credit_revoke_identity_session')){sessions.delete(values[0]);return [{value:true}]}
 throw Error('unexpected sql query '+q.slice(0,100))
}
const compile=(path,stubs)=>{
 const source=fs.readFileSync(path,'utf8')
 const js=ts.transpileModule(source,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}}).outputText
 const module={exports:{}}
 vm.runInNewContext(js,{module,exports:module.exports,require:id=>{
  if(id in stubs)return stubs[id]
  throw Error('unexpected dependency '+id)
 },process,crypto:webcrypto,URL,TextEncoder,Uint8Array,Date,Error}, {filename:path})
 return module.exports
}
const identity=compile('lib/store-credit-identity.ts',{})
const mod=compile('lib/store-credit-customer-identity.ts',{
 './db':{sql:db},'./store-credit-identity':identity,
 './resend-adapter':{getEmailProvider:()=>({send:async msg=>{sent.push(msg);return {ok:true,providerMessageId:'test-only'}}})},
})
let n=0
const t=async (label,fn)=>{await fn();console.log('PASS',label);n++}
try{
 await t('feature switch defaults to disabled',()=>{
  assert.equal(mod.creditIdentityConfigured({}),false)
  assert.equal(mod.creditIdentityConfigured({...env,STORE_CREDIT_IDENTITY_EMAIL_ENABLED:'false'}),false)
 })
 await t('configuration demands keyed account HMAC and verified sender',()=>{
  assert.equal(mod.creditIdentityConfigured({...env,STORE_CREDIT_ACCOUNT_PEPPER:'short'}),false)
  assert.equal(mod.creditIdentityConfigured({...env,STORE_CREDIT_IDENTITY_FROM:'Me <me@elsewhere.com>'}),false)
 })
 await t('origin requires exact same origin, rejects cross-site and absent origin',()=>{
  assert.equal(mod.creditRequestOriginAllowed('https://kvrn.shop','https://kvrn.shop','same-origin'),true)
  assert.equal(mod.creditRequestOriginAllowed('https://evil.test','https://kvrn.shop','same-origin'),false)
  assert.equal(mod.creditRequestOriginAllowed('https://kvrn.shop','https://kvrn.shop','cross-site'),false)
  assert.equal(mod.creditRequestOriginAllowed(null,'https://kvrn.shop','same-origin'),false)
 })
 await t('challenge secrets use fresh 256-bit random values',()=>{
  const a=mod.tokenHex(),b=mod.tokenHex()
  assert.match(a,/^[a-f0-9]{64}$/);assert.notEqual(a,b)
 })
 await t('token and session parsing rejects malformed values',()=>{
  assert.equal(mod.parseChallengeToken(`${UUID}.${'c'.repeat(64)}`).id,UUID)
  for(const v of [null,'bad',`${UUID}.${'z'.repeat(64)}`,`${UUID}.${'a'.repeat(63)}`,`${UUID}.${'a'.repeat(64)}.extra`])
   assert.equal(mod.parseChallengeToken(v),null)
  assert.equal(mod.parseSessionToken('b'.repeat(64)),'b'.repeat(64))
  assert.equal(mod.parseSessionToken('b'.repeat(63)),null)
 })
 await t('request persists only account HMAC and hashed token, then sends link',async()=>{
  await mod.requestCreditIdentityEmail('Customer@Example.com','https://kvrn.shop')
  assert.equal(challenges.size,1);assert.equal(sent.length,1)
  const c=challenges.get(UUID)
  assert.match(c.key,/^[0-9a-f]{64}$/)
  assert.match(c.digest,/^[0-9a-f]{64}$/)
  assert.ok(!JSON.stringify(c).includes('customer@example.com'))
  assert.equal(sent[0].to,'customer@example.com')
  assert.ok(sent[0].html.includes('/store-credit/verify#token='))
  assert.ok(!sent[0].html.includes(c.digest))
 })
 const raw=sent[0].html.match(/#token=([a-f0-9-]{36}\.[a-f0-9]{64})/)?.[1]
 await t('verification exchanges the secret for a NEW opaque cookie token',async()=>{
  assert.ok(raw)
  const cookie=await mod.redeemCreditIdentityToken(raw)
  assert.match(cookie,/^[0-9a-f]{64}$/)
  assert.notEqual(cookie,raw.split('.')[1])
  globalThis.testCreditCookie=cookie
 })
 await t('replayed verification cannot mint a second cookie',async()=>{
  assert.equal(await mod.redeemCreditIdentityToken(raw),null)
 })
 await t('wrong challenge secret cannot log in',async()=>{
  const bad=`${UUID}.${'d'.repeat(64)}`
  assert.equal(await mod.redeemCreditIdentityToken(bad),null)
 })
 await t('verified session matches original email only',async()=>{
  const key=await mod.resolveVerifiedCreditAccount(globalThis.testCreditCookie,'customer@example.com')
  assert.match(key,/^[a-f0-9]{64}$/)
  assert.equal(await mod.resolveVerifiedCreditAccount(globalThis.testCreditCookie,'other@example.com'),null)
 })
 await t('ledger available is outstanding minus holds, credit not a discount',async()=>{
  const b=await mod.readVerifiedCreditBalance(globalThis.testCreditCookie)
  assert.equal(b.availableCents,1500);assert.equal(b.outstandingCents,1700);assert.equal(b.heldCents,200)
 })
 await t('invalid canonical ledger values fail closed',async()=>{
  ledger={issued:'100',captured:'200',held:'0'}
  await assert.rejects(()=>mod.readVerifiedCreditBalance(globalThis.testCreditCookie),/UNBALANCED/)
  ledger={issued:'garbage',captured:'0',held:'0'}
  await assert.rejects(()=>mod.readVerifiedCreditBalance(globalThis.testCreditCookie),/INVALID_LEDGER/)
  ledger={issued:'2000',captured:'300',held:'200'}
 })
 await t('unrecognized cookie cannot disclose a balance',async()=>{
  assert.equal(await mod.readVerifiedCreditBalance('a'.repeat(64)),null)
  assert.equal(await mod.readVerifiedCreditBalance(null),null)
 })
 await t('session revoke invalidates future reads',async()=>{
  await mod.revokeCreditIdentitySession(globalThis.testCreditCookie)
  assert.equal(await mod.readVerifiedCreditBalance(globalThis.testCreditCookie),null)
 })
 await t('per-email throttling prevents a send',async()=>{
  permit=false;const before=sent.length
  await mod.requestCreditIdentityEmail('customer@example.com','https://kvrn.shop')
  assert.equal(sent.length,before);permit=true
 })
 await t('no keys / disabled gate means no database or mail work',async()=>{
  const before=dbCalls,beforeSent=sent.length
  env.STORE_CREDIT_IDENTITY_EMAIL_ENABLED='false'
  await assert.rejects(()=>mod.requestCreditIdentityEmail('customer@example.com','https://kvrn.shop'),/DISABLED/)
  assert.equal(await mod.redeemCreditIdentityToken(raw),null)
  assert.equal(await mod.readVerifiedCreditBalance(globalThis.testCreditCookie),null)
  assert.equal(dbCalls,before);assert.equal(sent.length,beforeSent)
 })
 const schema=fs.readFileSync('db/migrations/061_store_credit_verified_customer_identity.sql','utf8')
 await t('database challenge consumer uses row lock and single-use guard',()=>{
  assert.match(schema,/FOR UPDATE/)
  assert.match(schema,/redeemed_at IS NOT NULL/)
  assert.match(schema,/expires_at<=NOW\(\)/)
  assert.match(schema,/UNIQUE REFERENCES store_credit_identity_challenges/)
 })
 await t('identity cannot change canonical orders or authorize tender',()=>{
  for(const path of ['lib/store-credit-customer-identity.ts', ...[
   'app/api/store-credit/identity/start/route.ts','app/api/store-credit/identity/verify/route.ts',
   'app/api/store-credit/balance/route.ts','app/api/store-credit/identity/logout/route.ts'
  ]]){
   const content=fs.readFileSync(path,'utf8')
   assert.ok(!/finalizePaidOrder|stripe\.checkout|stripe\.paymentIntents|UPDATE orders|reserve_inventory/.test(content))
  }
 })
 console.log(`${n}/${n} store-credit verified-identity tests passed. Provider/network calls: ZERO (mocked).`)
}finally{
 delete env.STORE_CREDIT_IDENTITY_EMAIL_ENABLED
 delete env.STORE_CREDIT_ACCOUNT_PEPPER
 delete env.RESEND_API_KEY
 delete env.STORE_CREDIT_IDENTITY_FROM
}
