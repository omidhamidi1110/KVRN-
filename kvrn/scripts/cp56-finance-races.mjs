#!/usr/bin/env node
// CP56 real PostgreSQL concurrency checks. TEST-ONLY: never connects to Neon.
// Clones the owner's existing read-only 64-migration evidence database, applies
// the NEW draft 065 *only in the clone*, and leaves the clone for investigation.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const LOCAL_PGDIR = path.join(os.homedir(), '.local/share/kvrn-audit2-pg16');
const TEMPLATE = 'kvrn_cp55_migrationtest';
const PORT = 5433;
const HOST = '/tmp';
const ROLE = 'postgres';
const LOCK_CREDIT = '48112026051';
const LOCK_MARKETING = '48112026046';
const cloneName = `kvrn_cp56_fin_${randomBytes(4).toString('hex')}`;
const qHash = (x) => createHash('sha256').update(x).digest('hex');
const token = () => randomBytes(7).toString('hex');
const key = (label) => `cp56_${label}_${token()}`;
let checks = 0;
const pass = (label) => { checks += 1; console.log(`PASS ${String(checks).padStart(2, '0')} ${label}`); };
const sqlDir = path.join(ROOT,'db/migrations');
const config = (database) => ({host:HOST,port:PORT,user:ROLE,database,
  connectionTimeoutMillis:6000,query_timeout:20000,statement_timeout:20000,ssl:false});
let client;
async function sql(text,values=[]) {return client.query(text,values);}
// A scalar reader that doesn't rely on column names.
async function scalar(text,values=[]) { const row=(await sql(text,values)).rows[0]; return row?.[Object.keys(row)[0]]; }
async function rejection(text, params, expected) {
  let err;
  try { await sql(text,params); } catch(e) { err=e; }
  assert.ok(err,`Expected rejection containing ${expected}`);
  assert.match(err.message,new RegExp(expected));
}
async function insertReturning(query,params) {return String(await scalar(query,params));}
function checksumPreflight() {
  const checks = JSON.parse(readFileSync(path.join(ROOT,'scripts/cp56-cp55-sql-hashes.json'),'utf8'));
  for (const [relative, digest] of Object.entries(checks)) {
    const actual=qHash(readFileSync(path.join(ROOT,relative)));
    assert.equal(actual,digest,`CP55 source drift in ${relative}. STOP before creating DB.`);
  }
  const sql065=readFileSync(path.join(sqlDir,'065_cp56_checkout_lock_order_and_provider_marker.sql'),'utf8');
  assert.match(sql065,/CREATE OR REPLACE FUNCTION finalize_paid_order\(/);
  assert.match(sql065,/terminal\.event_type IN \('capture','release'\)/);
  const beginFinalizer = sql065.indexOf('CREATE OR REPLACE FUNCTION finalize_paid_order(');
  assert.ok(sql065.indexOf('PERFORM pg_advisory_xact_lock(48112026051::bigint);',beginFinalizer) < sql065.indexOf('INSERT INTO webhook_events',beginFinalizer),'New finalizer must take lock before rows');
  pass('CP55 high-risk SQL hashes match handoff; 065 draft found');
}
async function checkLocalOrigin(admin) {
  const actual=String((await admin.query('SHOW data_directory')).rows[0].data_directory);
  assert.equal(realpathSync(actual),realpathSync(LOCAL_PGDIR),
    `Database is not isolated Codespaces PG data directory! Found: ${actual}`);
  assert.equal(await (async()=>{
    const r=await admin.query('SELECT current_user AS u, inet_server_addr() AS a');
    assert.equal(r.rows[0].u,'postgres');
    assert.equal(r.rows[0].a,null,'Refusing TCP or hosted DB');return true;
  })(),true);
  const found=await admin.query('SELECT datname FROM pg_database WHERE datname=$1 AND datallowconn=true',[TEMPLATE]);
  assert.equal(found.rowCount,1,'CP55 evidence database missing. No auto migration/reinstall');
  const original = new pg.Client(config(TEMPLATE));
  await original.connect();
  try {
    const known=await original.query("SELECT to_regclass('store_credit_checkout_holds') AS hold, to_regclass('marketing_delivery_attempts') AS marketing, to_regprocedure('kvrn_credit_mark_checkout_provider_started(uuid,text)') AS fn");
    assert.ok(known.rows[0].hold && known.rows[0].marketing && known.rows[0].fn,
      'CP55 database does not have complete 064 schema');
  } finally {await original.end();}
  pass('Isolated socket, port, PGDATA, role and CP55 evidence verified READ ONLY');
}
async function cloneLocally(admin) {
  console.log(`ISOLATED CLONE ${cloneName} FROM ${TEMPLATE} (preserve original)`);
  await admin.query(`CREATE DATABASE "${cloneName}" TEMPLATE "${TEMPLATE}"`);
  const env={HOME:os.homedir(),PATH:process.env.PATH||'/usr/bin:/bin',PGPASSWORD:''};
  const output=execFileSync('psql',[
    '-X','-w','-v','ON_ERROR_STOP=1','-h',HOST,'-p',String(PORT),'-U',ROLE,
    '-d',cloneName,'-f',path.join(sqlDir,'065_cp56_checkout_lock_order_and_provider_marker.sql')
  ],{env,encoding:'utf8',timeout:40000});
  assert.match(output,/COMMIT/);
  pass('Cloned completed 064 fixture; applied 065 only to independent local database');
}
async function race(queries, advisoryKey) {
  const gate=new pg.Client(config(cloneName));
  const observer=new pg.Client(config(cloneName));
  const workers=queries.map(()=>new pg.Client(config(cloneName)));
  let locked=false;
  try {
    await Promise.all([gate.connect(),observer.connect(),...workers.map(c=>c.connect())]);
    await gate.query('SELECT pg_advisory_lock($1::bigint)',[advisoryKey]);
    locked=true;
    const pending=queries.map((item,i)=>workers[i].query(item.text,item.params)
      .then(r=>({ok:true,value:r.rows[0][Object.keys(r.rows[0])[0]]}),e=>({ok:false,error:e.message})));
    let count=0;
    for(let i=0;i<75;i++) {
      // Advisory locks are per database; the only competing local sessions are ours.
      const r=await observer.query("SELECT count(*)::int AS n FROM pg_locks WHERE locktype='advisory' AND NOT granted AND database=(SELECT oid FROM pg_database WHERE datname=current_database())");
      count=r.rows[0].n;
      if(count>=queries.length) break;
      await new Promise(resolve=>setTimeout(resolve,100));
    }
    assert.ok(count>=queries.length,`Concurrency barrier unproven (${count}/${queries.length} waiting)`);
    await gate.query('SELECT pg_advisory_unlock($1::bigint)',[advisoryKey]);
    locked=false;
    return await Promise.all(pending);
  } finally {
    if(locked) {try {await gate.query('SELECT pg_advisory_unlock($1::bigint)',[advisoryKey]);}catch{}}
    await Promise.allSettled([...workers,observer,gate].map(c=>c.end()));
  }
}
function successes(results) {return results.filter(x=>x.ok);}
function failures(results) {return results.filter(x=>!x.ok);}
function assertRace(results,n,expectedMessage) {
  assert.equal(successes(results).length,n,JSON.stringify(results));
  if(expectedMessage) for(const f of failures(results)) assert.match(f.error,new RegExp(expectedMessage));
}
async function seedAccount(cents) {
  const order=await insertReturning(`INSERT INTO orders
    (order_number,stripe_checkout_session_id,payment_status,subtotal_cents,total_cents,paid_at)
    VALUES($1,$2,'paid',$3,$3,NOW()) RETURNING id`,[key('orig'),`cs_test_${token()}`,cents]);
  const returned=await insertReturning(`INSERT INTO order_returns(order_id,return_number,status,
    requested_at,received_at,completed_at)
    VALUES($1,$2,'completed',NOW()-INTERVAL '3 days',NOW()-INTERVAL '1 day',NOW()) RETURNING id`,[order,key('return')]);
  const account=await insertReturning(`INSERT INTO store_credit_accounts(account_key) VALUES($1) RETURNING id`,[qHash(token())]);
  await sql(`INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,return_id)
    VALUES($1,'issue',$2,$3,$4)`,[account,cents,key('issue'),returned]);
  return account;
}
async function reservation(session=null) {
  return insertReturning("INSERT INTO reservations(status,expires_at,stripe_checkout_session_id) VALUES('open',NOW()+INTERVAL '60 minutes',$1) RETURNING id",[session]);
}
async function hold(account,res,amt,holdKey=key('hold'),requestKey=key('request')) {
  const value=await scalar('SELECT kvrn_credit_create_checkout_hold($1,$2,$3,$4,$5) AS v',
    [account,res,holdKey,requestKey,amt]);
  return {id:String(value),holdKey,requestKey};
}
async function creditTests() {
  const account=await seedAccount(100);
  const res1=await reservation(),res2=await reservation();
  const first={text:'SELECT kvrn_credit_create_checkout_hold($1,$2,$3,$4,$5) AS v',params:[account,res1,key('hold'),key('request'),70]};
  const second={text:first.text,params:[account,res2,key('hold'),key('request'),70]};
  const out=await race([first,second],LOCK_CREDIT);
  assertRace(out,1,'CREDIT_INSUFFICIENT');
  const held=Number(await scalar("SELECT COALESCE(sum(amount_cents),0) FROM store_credit_ledger WHERE account_id=$1 AND event_type='hold'",[account]));
  assert.equal(held,70);
  pass('Simultaneous holds cannot spend 140 cents from 100 cents');
  const winner=out[0].ok?first:second;
  const again=await race([winner,winner],LOCK_CREDIT);
  assertRace(again,2);assert.equal(String(again[0].value),String(again[1].value));
  assert.equal(String(again[0].value),String(out.find(x=>x.ok).value));
  await rejection(first.text,[winner.params[0],winner.params[1],winner.params[2],winner.params[3],71],'CREDIT_RESERVATION_ALREADY_HELD');
  await rejection(first.text,[account,await reservation(),key('hold'),winner.params[3],1],'CREDIT_HOLD_IDEMPOTENCY_CONFLICT');
  pass('Concurrent exact hold replay stable; conflicting replay rejected');
  await rejection('DELETE FROM store_credit_ledger WHERE account_id=$1',[account],'STORE_CREDIT_EVENTS_ARE_APPEND_ONLY');
  pass('Credit ledger append-only enforcement');
}
async function providerStartTests() {
  const account=await seedAccount(90),res=await reservation();
  await hold(account,res,40);
  const a={text:'SELECT kvrn_credit_release_before_provider($1,$2) AS v',params:[res,key('released')]};
  const b={text:'SELECT kvrn_credit_mark_checkout_provider_started($1,$2) AS v',params:[res,key('coupon')]};
  const results=await race([a,b],LOCK_CREDIT);
  assertRace(results,1);
  const marked=Number(await scalar('SELECT count(*) FROM store_credit_checkout_provider_requests WHERE reservation_id=$1',[res]));
  const released=Number(await scalar(`SELECT count(*) FROM store_credit_ledger e JOIN store_credit_checkout_holds h
    ON e.account_id=h.account_id AND e.hold_key=h.hold_key
    WHERE h.reservation_id=$1 AND e.event_type='release'`,[res]));
  assert.equal(marked+released,1,`Both provider-start and release happened: ${JSON.stringify(results)}`);
  pass('Provider-start vs pre-provider release is mutually exclusive (CP56 fix)');
  if(marked) await rejection(a.text,[res,key('newrelease')],'CREDIT_PREPROVIDER_STRIPE_MAY_HAVE_STARTED');
  else await rejection(b.text,[res,key('newcoupon')],'CREDIT_PROVIDER_MARK_STALE_OR_TERMINAL_HOLD');
  pass('Terminal check persists after concurrent marker/release collision');
}
async function paidCaptureTests() {
  const account=await seedAccount(100);
  const cs=`cs_test_${token()}`,pi=`pi_${token()}`,res=await reservation(cs);
  const saved=await hold(account,res,60);
  await sql("UPDATE reservations SET status='completed',completed_at=NOW() WHERE id=$1",[res]);
  const order=await insertReturning(`INSERT INTO orders(order_number,stripe_checkout_session_id,
    stripe_payment_intent_id,reservation_id,payment_status,subtotal_cents,shipping_cents,
    tax_cents,discount_cents,total_cents,paid_at)
    VALUES($1,$2,$3,$4,'paid',100,0,0,0,40,NOW()) RETURNING id`,[key('order'),cs,pi,res]);
  const captureKey=key('capture');
  const capture={text:'SELECT kvrn_credit_capture_verified_checkout($1,$2,$3,$4,$5,$6,$7) AS v',
    params:[res,order,captureKey,cs,pi,40,100]};
  const release={text:'SELECT kvrn_credit_release_expired_checkout($1,$2,$3,$4) AS v',
    params:[res,key('expire'),cs,'none']};
  const results=await race([capture,release],LOCK_CREDIT);
  assertRace(results,1);assert.ok(results[0].ok,`Paid checkout capture must win: ${JSON.stringify(results)}`);
  assert.match(results[1].error,/CREDIT_RELEASE_RESERVATION_NOT_TERMINAL|CREDIT_RELEASE_HOLD_ALREADY_TERMINAL/);
  const captureId=String(results[0].value);
  assert.equal(String(await scalar(capture.text,capture.params)),captureId);
  await rejection(capture.text,[res,order,key('badreplay'),cs,pi,40,100],'CREDIT_CAPTURE_ALREADY_TERMINAL');
  assert.equal(Number(await scalar(`SELECT count(*) FROM store_credit_ledger l WHERE l.account_id=$1 AND l.hold_key=$2 AND l.event_type IN ('capture','release')`,[account,saved.holdKey])),1);
  assert.equal(Number(await scalar(`SELECT count(*) FROM store_credit_checkout_capture_proofs WHERE order_id=$1 AND cash_received_cents+credit_captured_cents=gross_order_cents`,[order])),1);
  pass('Verified synthetic paid split 40 cash + 60 credit; capture race/replay never double-captures');

  const acc2=await seedAccount(50),cs2=`cs_test_${token()}`,res2=await reservation(cs2);
  const hold2=await hold(acc2,res2,20);
  await sql("UPDATE reservations SET status='released',released_at=NOW() WHERE id=$1",[res2]);
  const expire={text:'SELECT kvrn_credit_release_expired_checkout($1,$2,$3,$4) AS v',params:[res2,key('expire'),cs2,'none']};
  const invalidCapture={text:capture.text,params:[res2,randomUUID(),key('capture'),cs2,`pi_${token()}`,30,50]};
  const round2=await race([expire,invalidCapture],LOCK_CREDIT);
  assertRace(round2,1);assert.ok(round2[0].ok,JSON.stringify(round2));
  assert.match(round2[1].error,/CREDIT_CAPTURE_ALREADY_TERMINAL|CREDIT_CAPTURE_RESERVATION_NOT_FINAL/);
  assert.equal(Number(await scalar(`SELECT count(*) FROM store_credit_ledger WHERE account_id=$1 AND hold_key=$2 AND event_type IN ('capture','release')`,[acc2,hold2.holdKey])),1);
  assert.equal(String(await scalar(expire.text,expire.params)),String(round2[0].value));
  pass('Verified synthetic expiry releases once; no phantom capture, release replay stable');
}
async function budgetTests() {
  // Enabling dispatch here is strictly limited to the disposable clone.
  await sql("UPDATE marketing_budget_policy SET dispatch_enabled=true WHERE id=1");
  const campaign=await insertReturning(`INSERT INTO marketing_campaign_drafts(channel,title,body,state,reviewed_at)
    VALUES('email',$1,'Local integration proof only','reviewed',NOW()) RETURNING id`,[key('campaign')]);
  const mk=(cost,k)=>({text:'SELECT kvrn_marketing_reserve($1,$2,$3,$4,$5,$6,$7,$8) AS v',
    params:[campaign,k,'email',false,cost,1000000,2000000,1000000]});
  const a=mk(700000,key('budget')),b=mk(700000,key('budget'));
  const outcomes=await race([a,b],LOCK_MARKETING);
  assertRace(outcomes,1,'MARKETING_BUDGET_EXCEEDED');
  const winner=outcomes[0].ok?a:b;
  assert.equal(String(await scalar(winner.text,winner.params)),String(outcomes.find(x=>x.ok).value));
  await rejection(winner.text,[campaign,winner.params[1],'email',false,650000,1000000,2000000,1000000],
    'MARKETING_IDEMPOTENCY_CONFLICT');
  assert.equal(Number(await scalar("SELECT SUM(reserved_micros) FROM marketing_budget_reservations WHERE campaign_id=$1 AND state='reserved'",[campaign])),700000);
  pass('Concurrent marketing reservations stay under owner daily cap, identical replay stable');
  await sql('UPDATE marketing_budget_policy SET dispatch_enabled=false WHERE id=1');
  await rejection(mk(1,key('disabled')).text,mk(1,key('disabled')).params,'MARKETING_DISPATCH_DISABLED');
  pass('Marketing dispatch policy remains fail-closed after local budget test');
}
async function identityTests() {
  const accountKey=qHash(token()),challengeHash=qHash(token());
  const id=await insertReturning(`INSERT INTO store_credit_identity_challenges(account_key,token_sha256)
    VALUES($1,$2) RETURNING id`,[accountKey,challengeHash]);
  const sqlText='SELECT kvrn_credit_redeem_identity_challenge($1,$2,$3) AS v';
  const results=await Promise.all([qHash(token()),qHash(token())].map(async session=>{
    const c=new pg.Client(config(cloneName));await c.connect();
    try {return (await c.query(sqlText,[id,challengeHash,session])).rows[0].v;}
    finally {await c.end();}
  }));
  assert.equal(results.filter(Boolean).length,1);
  assert.equal(Number(await scalar('SELECT count(*) FROM store_credit_identity_sessions WHERE challenge_id=$1',[id])),1);
  pass('Concurrent verified identity challenge redemption is single-use');
}
async function marketingClaimTests() {
  await sql('UPDATE marketing_budget_policy SET dispatch_enabled=true WHERE id=1');
  const email=`cp56-${token()}@example.invalid`;
  const subscriber=await insertReturning(`INSERT INTO marketing_subscribers(email,consent_source)
    VALUES($1,'footer') RETURNING id`,[email]);
  await sql(`INSERT INTO marketing_email_consent_events(subscriber_id,event_type,source,statement_version)
    VALUES($1,'affirmative_checkbox','footer','cp56-statement-1')`,[subscriber]);
  const campaign=await insertReturning(`INSERT INTO marketing_campaign_drafts(channel,title,subject,body,state,reviewed_at)
    VALUES('email',$1,'local only','Synthetic approved copy','reviewed',NOW()) RETURNING id`,[key('campaign')]);
  const snap=await insertReturning(`INSERT INTO marketing_audience_snapshots(campaign_id,campaign_version,channel,audience,request_key)
    VALUES($1,1,'email','all-consenting',$2) RETURNING id`,[campaign,key('snapshot')]);
  const member=await insertReturning('INSERT INTO marketing_audience_members(snapshot_id,email_subscriber_id) VALUES($1,$2) RETURNING id',[snap,subscriber]);
  const plan=await insertReturning('INSERT INTO marketing_staged_delivery_plans(snapshot_id,request_key) VALUES($1,$2) RETURNING id',[snap,key('plan')]);
  await sql('INSERT INTO marketing_staged_delivery_items(plan_id,audience_member_id) VALUES($1,$2)',[plan,member]);
  const ownerHash=qHash(token());
  const approval=await insertReturning(`INSERT INTO marketing_owner_approvals(plan_id,campaign_id,campaign_version,recipient_count,
    maximum_cost_micros,owner_identity_sha256,request_key,expires_at)
    VALUES($1,$2,1,1,500000,$3,$4,NOW()+INTERVAL '30 minutes') RETURNING id`,[plan,campaign,ownerHash,key('approve')]);
  const budget=await insertReturning(`SELECT kvrn_marketing_reserve($1,$2,'email',false,500000,2000000,10000000,10000000) AS v`,
    [campaign,key('reservation')]);
  const timezone=String(await scalar(`SELECT name FROM pg_timezone_names WHERE name LIKE 'Etc/GMT%'
    AND extract(hour from now() at time zone name) BETWEEN 10 AND 17
    ORDER BY name LIMIT 1`));
  assert.notEqual(timezone,'undefined','No legal test timezone with daytime local hour');
  const msgHash=qHash(token());
  const evidence=await insertReturning(`SELECT kvrn_marketing_record_email_recipient_evidence(
    $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,500000) AS v`,
    [plan,member,approval,ownerHash,qHash(token()),qHash(token()),qHash(token()),qHash(token()),msgHash,timezone]);
  const mk=(claimKey)=>({text:'SELECT kvrn_marketing_claim_at_most_once($1,$2,$3,$4,$5,$6,$7) AS v',
    params:[plan,member,approval,budget,evidence,msgHash,claimKey]});
  const outcomes=await race([mk(key('claim')),mk(key('claim'))],LOCK_MARKETING);
  assertRace(outcomes,1,'MARKETING_CLAIM_ALREADY_ATTEMPTED_NO_RETRY');
  assert.equal(Number(await scalar('SELECT count(*) FROM marketing_delivery_attempts WHERE plan_id=$1 AND audience_member_id=$2',[plan,member])),1);
  const attemptId=String(outcomes.find(x=>x.ok).value);
  const provisional=await race([
    {text:'SELECT kvrn_marketing_record_provisional_receipt($1,$2,$3,$4) AS v',params:[attemptId,'resend','uncertain',null]},
    {text:'SELECT kvrn_marketing_record_provisional_receipt($1,$2,$3,$4) AS v',params:[attemptId,'resend','uncertain',null]}
  ],LOCK_MARKETING);
  assertRace(provisional,2);assert.equal(String(provisional[0].value),String(provisional[1].value));
  assert.equal(Number(await scalar('SELECT count(*) FROM marketing_provider_provisional_receipts WHERE attempt_id=$1',[attemptId])),1);
  pass('Marketing recipient claimed once under barrier; uncertain receipt immutable/idempotent');
  await sql('UPDATE marketing_budget_policy SET dispatch_enabled=false WHERE id=1');
}
async function main(){
  checksumPreflight();
  const admin=new pg.Client(config('postgres'));
  await admin.connect();
  try {await checkLocalOrigin(admin);await cloneLocally(admin);}
  finally {await admin.end();}
  client=new pg.Client(config(cloneName));
  await client.connect();
  try {
    await creditTests();
    await providerStartTests();
    await paidCaptureTests();
    await budgetTests();
    await identityTests();
    await marketingClaimTests();
    pass(`ALL ${checks} isolated PostgreSQL integration gates green`);
  } finally {await client.end();}
  console.log(`TEST DATABASE PRESERVED: ${cloneName}`);
}
main().catch(e=>{
  console.error(`FAIL: ${e?.stack||e}`);
  console.error(`Isolated test clone (if created): ${cloneName}; CP55 original untouched`);
  process.exitCode=1;
});
