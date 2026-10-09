#!/usr/bin/env node
// KVRN CP56 - STRICTLY LOCAL PostgreSQL 16 integration/concurrency verification.
// Clones EXISTING CP55 migration test database; never touches the template or Neon.
// Node v24, installed pg from npm ci in pre-existing Codespaces staging source.
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import pg from 'pg';

const { Client, Pool } = pg;
const sourceRoot = resolve(fileURLToPath(new URL('..', import.meta.url)));
const safeHome = process.env.HOME;
const expectedDir = `${safeHome}/.local/share/kvrn-audit2-pg16`;
const template = 'kvrn_cp55_migrationtest';
const db = `kvrn_cp56_${process.pid}_${randomUUID().replaceAll('-', '').slice(0, 10)}`;
const runs = [];
let admin;
let pool;
let created = false;
let checksComplete = false;
let cloneDropped = false;
const poolConnectionErrors = [];
const denySecrets = ['DATABASE_URL','NEON_DATABASE_URL','POSTGRES_URL','POSTGRES_PRISMA_URL','STRIPE_SECRET_KEY','TWILIO_AUTH_TOKEN','RESEND_API_KEY'];

function fail(message) { throw new Error(message); }
function pass(name) { runs.push(name); console.log(`PASS ${runs.length}: ${name}`); }
function expectError(result, snippets) {
  assert.equal(result.status, 'rejected', 'call should have been rejected');
  const message = result.reason?.message || String(result.reason);
  assert.ok(snippets.some((s) => message.includes(s)), `Unexpected error: ${message}`);
}
function sqlPool(query, args = []) { return pool.query(query, args); }
async function id(query, args = []) { return (await sqlPool(query, args)).rows[0].id; }
async function count(query, args = []) { return Number((await sqlPool(query, args)).rows[0].n); }
async function call(fn, args, casts) {
  const places = args.map((_, i) => `$${i + 1}::${casts[i]}`).join(',');
  return (await sqlPool(`SELECT ${fn}(${places}) AS value`, args)).rows[0].value;
}
const makeKey = (tag) => `cp56-${tag}-${randomUUID().replaceAll('-', '')}`;
const mkHold = (acct, res, cents, key = makeKey('hold'), req = makeKey('req')) =>
  call('kvrn_credit_create_checkout_hold', [acct, res, key, req, cents], ['uuid','uuid','text','text','bigint']);
const mark = (res) => call('kvrn_credit_mark_checkout_provider_started', [res, makeKey('coupon').slice(0, 80)], ['uuid','text']);
const preRelease = (res, key = makeKey('release')) => call('kvrn_credit_release_before_provider', [res, key], ['uuid','text']);
const expireRelease = (res, key, session) => call('kvrn_credit_release_expired_checkout', [res,key,session,'none'], ['uuid','text','text','text']);
const capture = (res, order, key, session, pi, cash, gross) => call('kvrn_credit_capture_verified_checkout', [res,order,key,session,pi,cash,gross], ['uuid','uuid','text','text','text','bigint','bigint']);

async function seedAccount(creditCents) {
  // In disposable cloned DB ONLY: a synthetic prior paid order and an inspected
  // return establish an issue ledger event without changing app/source functions.
  const order = await id(`INSERT INTO orders(order_number,stripe_checkout_session_id,
      stripe_payment_intent_id, payment_status, subtotal_cents, total_cents, paid_at)
    VALUES($1,$2,$3,'paid',3000,3000,NOW()) RETURNING id`,
    [makeKey('priororder'),`cs_test_${randomUUID().replaceAll('-','')}`,`pi_${randomUUID().replaceAll('-','')}`]);
  const ret = await id(`INSERT INTO order_returns(order_id,return_number)
    VALUES($1,$2) RETURNING id`, [order,makeKey('priorreturn')]);
  const acct = await id(`INSERT INTO store_credit_accounts(account_key)
    VALUES($1) RETURNING id`, [randomUUID().replaceAll('-', '') + randomUUID().replaceAll('-', '')]);
  await sqlPool(`INSERT INTO store_credit_ledger(account_id,event_type,amount_cents,idempotency_key,return_id)
    VALUES($1,'issue',$2,$3,$4)`, [acct,creditCents,makeKey('issue'),ret]);
  return acct;
}
async function reservation(session = null) {
  return id(`INSERT INTO reservations(status,stripe_checkout_session_id,expires_at)
    VALUES('open',$1,NOW()+INTERVAL '2 hours') RETURNING id`, [session]);
}
async function ledgerState(account) {
  const { rows } = await sqlPool(`SELECT event_type,COUNT(*)::int n,
    COALESCE(SUM(amount_cents),0)::text cents FROM store_credit_ledger
    WHERE account_id=$1 GROUP BY event_type`, [account]);
  return Object.fromEntries(rows.map((r) => [r.event_type,{n:r.n,cents:Number(r.cents)}]));
}
async function test() {
  // 1. Holds cannot oversubscribe the same account at READ COMMITTED.
  const a = await seedAccount(1000), r1 = await reservation(), r2 = await reservation();
  const both = await Promise.allSettled([mkHold(a,r1,750),mkHold(a,r2,750)]);
  assert.equal(both.filter((r) => r.status === 'fulfilled').length, 1);
  expectError(both.find((r) => r.status === 'rejected'), ['CREDIT_INSUFFICIENT_OR_LEDGER_INTEGRITY']);
  assert.deepEqual((await ledgerState(a)).hold, {n:1,cents:750});
  pass('parallel holds cannot overspend issuance');

  // 2. Concurrent identical hold replay returns exactly the original ledger ID.
  const b = await seedAccount(1500), r3 = await reservation();
  const hk = makeKey('held'), rk = makeKey('req');
  const replay = await Promise.allSettled([mkHold(b,r3,500,hk,rk),mkHold(b,r3,500,hk,rk)]);
  assert.ok(replay.every((r) => r.status === 'fulfilled'), JSON.stringify(replay));
  assert.equal(String(replay[0].value),String(replay[1].value));
  assert.equal(await count(`SELECT COUNT(*)::int n FROM store_credit_ledger WHERE account_id=$1 AND event_type='hold'`,[b]),1);
  pass('parallel same-key hold replay is idempotent');

  // 3. Pre-provider release racing provider-start must never allow both.
  const c = await seedAccount(1500), r4 = await reservation();
  await mkHold(c,r4,400);
  const race = await Promise.allSettled([mark(r4),preRelease(r4)]);
  assert.equal(race.filter((r) => r.status === 'fulfilled').length,1);
  const markerCount = await count(`SELECT COUNT(*)::int n FROM store_credit_checkout_provider_requests WHERE reservation_id=$1`,[r4]);
  const releaseCount = await count(`SELECT COUNT(*)::int n FROM store_credit_ledger l JOIN store_credit_checkout_holds h ON h.hold_key=l.hold_key
    AND h.account_id=l.account_id WHERE h.reservation_id=$1 AND l.event_type='release'`,[r4]);
  assert.equal(markerCount + releaseCount,1);
  pass('provider-start vs pre-provider release is mutually exclusive');

  // 4. Explicit adversarial order: release committed, then provider-start must fail.
  const d = await seedAccount(700), r5 = await reservation();
  await mkHold(d,r5,250);
  await preRelease(r5);
  expectError((await Promise.allSettled([mark(r5)]))[0], ['CREDIT_PROVIDER_MARK_STALE_OR_TERMINAL_HOLD']);
  assert.equal(await count(`SELECT COUNT(*)::int n FROM store_credit_checkout_provider_requests WHERE reservation_id=$1`,[r5]),0);
  pass('released hold can never subsequently start Stripe provider request');

  // 5. Reverse order: provider-start committed; release must not unlock funds.
  const e = await seedAccount(700), r6 = await reservation();
  await mkHold(e,r6,250);
  assert.equal(await mark(r6),true);
  expectError((await Promise.allSettled([preRelease(r6)]))[0], ['CREDIT_PREPROVIDER_STRIPE_MAY_HAVE_STARTED']);
  expectError((await Promise.allSettled([mark(r6)]))[0], ['CREDIT_PROVIDER_REQUEST_ALREADY_STARTED_NO_RETRY']);
  pass('provider-start is irreversible and repeated start fails closed');

  // 6. Concurrent terminal provider-verified release is idempotent.
  const f = await seedAccount(700), session = `cs_test_${randomUUID().replaceAll('-','')}`, r7 = await reservation();
  await mkHold(f,r7,220);
  await sqlPool(`UPDATE reservations SET status='released',stripe_checkout_session_id=$2,
    expires_at=NOW()-INTERVAL '1 minute' WHERE id=$1`,[r7,session]);
  const expirationKey = makeKey('expired');
  const rr = await Promise.allSettled([expireRelease(r7,expirationKey,session),expireRelease(r7,expirationKey,session)]);
  assert.ok(rr.every((r) => r.status === 'fulfilled'),JSON.stringify(rr));
  assert.equal(String(rr[0].value),String(rr[1].value));
  assert.equal(await count(`SELECT COUNT(*)::int n FROM store_credit_checkout_release_proofs p
    JOIN store_credit_checkout_holds h ON h.hold_event_id=p.hold_event_id WHERE h.reservation_id=$1`,[r7]),1);
  expectError((await Promise.allSettled([expireRelease(r7,makeKey('other'),session)]))[0],['CREDIT_RELEASE_HOLD_ALREADY_TERMINAL']);
  pass('parallel provider-verified expiry release creates one immutable proof');

  // 7. Concurrent capture of the same paid split-tender order cannot double-spend.
  const g = await seedAccount(2000), r8 = await reservation();
  await mkHold(g,r8,800);
  const paidSession = `cs_test_${randomUUID().replaceAll('-','')}`, pi = `pi_${randomUUID().replaceAll('-','')}`;
  await sqlPool(`UPDATE reservations SET status='completed',completed_at=NOW(),stripe_checkout_session_id=$2 WHERE id=$1`,[r8,paidSession]);
  const order = await id(`INSERT INTO orders(order_number,stripe_checkout_session_id,
    stripe_payment_intent_id,reservation_id,payment_status,subtotal_cents,discount_cents,
    shipping_cents,tax_cents,total_cents,paid_at)
    VALUES($1,$2,$3,$4,'paid',2000,0,0,0,1200,NOW()) RETURNING id`,
    [makeKey('splitorder'),paidSession,pi,r8]);
  const capKey = makeKey('capture');
  const cc = await Promise.allSettled([
    capture(r8,order,capKey,paidSession,pi,1200,2000),
    capture(r8,order,capKey,paidSession,pi,1200,2000)
  ]);
  assert.ok(cc.every((r) => r.status === 'fulfilled'),JSON.stringify(cc));
  assert.equal(String(cc[0].value),String(cc[1].value));
  assert.equal(await count(`SELECT COUNT(*)::int n FROM store_credit_checkout_capture_proofs WHERE reservation_id=$1`,[r8]),1);
  const totals = await ledgerState(g);
  assert.equal(totals.capture.cents,800);
  expectError((await Promise.allSettled([preRelease(r8)]))[0], ['CREDIT_PREPROVIDER_ALREADY_TERMINAL']);
  pass('parallel paid split-tender capture records one proof and one 800-cent liability redemption');

  // 8. Deadlock regression: finalizer MUST wait on advisory lock BEFORE
  // attempting to acquire the reservation row lock held next by the owner.
  const lockOwner = await pool.connect();
  const finalizerEvent = `evt_cp56_${randomUUID().replaceAll('-','')}`;
  let finalizer;
  try {
    await lockOwner.query('BEGIN');
    await lockOwner.query('SELECT pg_advisory_xact_lock(48112026051::bigint)');
    finalizer = call('finalize_paid_order',
      [paidSession,r8,pi,finalizerEvent,'checkout.session.completed','usd',1200,null,null,null,{}],
      ['text','uuid','text','text','text','text','integer','text','text','text','jsonb']);
    let locked = false;
    for (let attempt=0;attempt<40;attempt++) {
      const waiting = await sqlPool(`SELECT COUNT(*)::int n FROM pg_stat_activity
        WHERE datname=current_database() AND wait_event_type='Lock'
        AND query LIKE 'SELECT finalize_paid_order(%'`);
      if (Number(waiting.rows[0].n) > 0) {locked=true;break;}
      await new Promise((done)=>setTimeout(done,75));
    }
    assert.ok(locked, 'finalizer did not visibly wait for shared advisory lock');
    await lockOwner.query("SET LOCAL lock_timeout = '1500ms'");
    const lockRes = await lockOwner.query('SELECT id FROM reservations WHERE id=$1 FOR UPDATE',[r8]);
    assert.equal(lockRes.rowCount,1,'finalizer improperly held reservation row while waiting');
    await lockOwner.query('COMMIT');
  } catch (error) {
    await lockOwner.query('ROLLBACK').catch(()=>{});
    if (finalizer) await finalizer.catch(()=>{});
    throw error;
  } finally { lockOwner.release(); }
  const finalizeResult = await finalizer;
  assert.equal(finalizeResult.outcome,'already_had_order');
  pass('finalizer does not deadlock with advisory-lock owner and reservation row');

  // 9. Same-credit integrity invariants / no accidental customer communication.
  const violations = await sqlPool(`SELECT COUNT(*)::int n FROM store_credit_ledger l
    JOIN store_credit_ledger other ON other.account_id=l.account_id AND other.hold_key=l.hold_key
    AND other.event_type='release' WHERE l.event_type='capture'`);
  assert.equal(Number(violations.rows[0].n),0);
  assert.equal(await count(`SELECT COUNT(*)::int n FROM transactional_emails`),0);
  pass('no hold both captured/released; no customer outbox queued by test');

  // 10. Marketing budget gate must be disabled in a clean cloned CP55 database.
  const policy = await sqlPool('SELECT dispatch_enabled FROM marketing_budget_policy WHERE id=1');
  assert.equal(policy.rows[0]?.dispatch_enabled,false);
  const campaign = await id(`INSERT INTO marketing_campaign_drafts(channel,title,body,state)
    VALUES('email','CP56 isolated budget','Test-only text','reviewed') RETURNING id`);
  const blocked = await Promise.allSettled([call('kvrn_marketing_reserve',
    [campaign,makeKey('budget'),'email',false,500000,1000000,1000000,1000000],
    ['uuid','text','text','boolean','bigint','bigint','bigint','bigint'])]);
  expectError(blocked[0],['MARKETING_DISPATCH_DISABLED']);
  pass('marketing provider dispatch remains disabled without explicit owner approval');

  // 11. Test budgeting serialization (only within the disposable DB) under cap.
  // Enable LOCAL CLONE policy only; this never reaches provider APIs.
  await sqlPool('UPDATE marketing_budget_policy SET dispatch_enabled=true WHERE id=1');
  const mc = await Promise.allSettled([
    call('kvrn_marketing_reserve',[campaign,makeKey('budget'),'email',false,700000,1000000,1000000,1000000],
      ['uuid','text','text','boolean','bigint','bigint','bigint','bigint']),
    call('kvrn_marketing_reserve',[campaign,makeKey('budget'),'email',false,700000,1000000,1000000,1000000],
      ['uuid','text','text','boolean','bigint','bigint','bigint','bigint'])
  ]);
  assert.equal(mc.filter((r)=>r.status==='fulfilled').length,1);
  expectError(mc.find((r)=>r.status==='rejected'),['MARKETING_BUDGET_EXCEEDED']);
  assert.equal(await count(`SELECT COUNT(*)::int n FROM marketing_budget_reservations WHERE campaign_id=$1`,[campaign]),1);
  pass('concurrent marketing budget reservations cannot exceed daily cap');

  // 12. Identical provider cost reconciliation can settle only once.
  const budgetId = mc.find((r)=>r.status==='fulfilled').value;
  const evidence = await id(`INSERT INTO marketing_provider_cost_evidence
    (reservation_id,provider,outcome,source,provider_reference_sha256,actual_micros)
    VALUES($1,'resend','charged','provider_final_status',$2,500000) RETURNING id`,
    [budgetId,randomUUID().replaceAll('-','')+randomUUID().replaceAll('-','')]);
  const set = await Promise.allSettled([
    call('kvrn_marketing_finalize_cost',[budgetId,evidence],['uuid','uuid']),
    call('kvrn_marketing_finalize_cost',[budgetId,evidence],['uuid','uuid'])
  ]);
  assert.ok(set.every((r)=>r.status==='fulfilled'),JSON.stringify(set));
  assert.ok(set.every((r)=>r.value==='settled'));
  const settled = await sqlPool('SELECT state,actual_micros FROM marketing_budget_reservations WHERE id=$1',[budgetId]);
  assert.equal(settled.rows[0].state,'settled');
  assert.equal(Number(settled.rows[0].actual_micros),500000);
  pass('concurrent budget reconciliation settles authoritative cost once');
}

try {
  for (const k of denySecrets) if (process.env[k]) fail(`REFUSE: inherited provider/production secret ${k}`);
  if (!safeHome?.startsWith('/home/codespace')) fail('REFUSE: expected Codespaces HOME');
  if (process.env.PGHOST && process.env.PGHOST !== '/tmp') fail('REFUSE: PGHOST not /tmp');
  if (process.env.PGPORT && process.env.PGPORT !== '5433') fail('REFUSE: PGPORT not 5433');
  const local = {host:'/tmp',port:5433,user:'postgres',database:'postgres',ssl:false,
    application_name:'kvrn-cp56-local-integrity',connectionTimeoutMillis:2500};
  admin = new Client(local);
  await admin.connect();
  const actual = (await admin.query('SHOW data_directory')).rows[0].data_directory;
  if (actual !== expectedDir) fail(`REFUSE: unexpected PostgreSQL data directory ${actual}`);
  const ver = (await admin.query('SHOW server_version_num')).rows[0].server_version_num;
  if (Number(ver) < 160000 || Number(ver) >= 170000) fail(`REFUSE: not PostgreSQL 16 (${ver})`);
  const existed = await admin.query('SELECT datname FROM pg_database WHERE datname=$1',[template]);
  if (existed.rowCount !== 1) fail(`REFUSE: missing existing CP55 baseline database ${template}`);
  const sanity = new Client({...local,database:template});
  try {
    await sanity.connect();
    const baseline = await sanity.query(`SELECT
      (SELECT COUNT(*)::int FROM orders) AS orders,
      (SELECT COUNT(*)::int FROM store_credit_ledger) AS credit_events,
      (SELECT COUNT(*)::int FROM marketing_budget_reservations) AS marketing_reservations,
      to_regclass('public.store_credit_checkout_provider_requests') IS NOT NULL AS has_062,
      to_regclass('public.marketing_recipient_delivery_evidence') IS NOT NULL AS has_064`);
    const check = baseline.rows[0];
    if (check.orders || check.credit_events || check.marketing_reservations || !check.has_062 || !check.has_064)
      fail(`REFUSE: unexpected CP55 template contents: ${JSON.stringify(check)}`);
  } finally { await sanity.end().catch(()=>{}); }
  // Only our random fresh name, verified absent, can be created/deleted.
  if (!/^kvrn_cp56_\d+_[a-f0-9]{10}$/.test(db)) fail('Invalid disposable database name');
  await admin.query(`CREATE DATABASE "${db}" TEMPLATE "${template}"`);
  created = true;
  pool = new Pool({...local,database:db,max:8,
    options:'-c statement_timeout=15000 -c lock_timeout=11000'});
  // node-postgres can emit an error event for an idle client. Do not crash
  // without a diagnostic, and NEVER treat a connection error as a test pass.
  pool.on('error', (error) => {
    poolConnectionErrors.push(error.message);
    process.exitCode = 1;
    console.error(`FAIL: unexpected local PostgreSQL pool connection error: ${error.message}`);
  });
  const sql65 = await readFile(resolve(sourceRoot,'db/migrations/065_cp56_checkout_lock_order_and_provider_marker.sql'),'utf8');
  await pool.query(sql65);
  console.log(`LOCAL POSTGRES 16 VERIFIED: ${actual}; isolated database: ${db}; migration 065 applied`);
  await test();
  checksComplete = true;
  console.log(`CHECKS PASS: CP56 ${runs.length}/12 financial concurrency/integrity checks (cleanup pending)`);
} catch (err) {
  console.error(`FAIL: CP56 ${runs.length} cases completed; ${err.stack || err}`);
  process.exitCode = 1;
} finally {
  if (pool) {
    try {
      await pool.end();
      console.log('CLEANUP: local PostgreSQL test pool drained');
    } catch (error) {
      console.error(`CLEANUP FAIL: pool did not close cleanly: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (created && admin) {
    try {
      // pg-pool can finish bookkeeping before the server has observed the
      // last backend exit. Never use DROP ... FORCE: it can kill an exiting
      // connection and emit an unhandled pg client error AFTER 12 tests pass.
      // Wait briefly for a natural drain; preserve the disposable clone on
      // timeout or any unexpected connection instead of terminating sessions.
      let sessions = [];
      for (let attempt = 0; attempt < 30; attempt++) {
        const result = await admin.query(`SELECT pid, application_name, state
          FROM pg_stat_activity WHERE datname=$1 ORDER BY pid`, [db]);
        sessions = result.rows;
        if (sessions.length === 0) break;
        await new Promise((done) => setTimeout(done, 100));
      }
      if (sessions.length) {
        console.error(`CLEANUP FAIL: disposable ${db} has ${sessions.length} active backend(s): ${JSON.stringify(sessions)}. Clone preserved; no sessions terminated.`);
        process.exitCode = 1;
      } else {
        await admin.query(`DROP DATABASE "${db}"`);
        cloneDropped = true;
        console.log(`CLEANUP PASS: disposable ${db} deleted naturally; ${template} unchanged; no forced disconnections`);
      }
    } catch (error) {
      console.error(`CLEANUP FAIL: disposable ${db} preserved for inspection: ${error.message}`);
      process.exitCode = 1;
    }
  }
  if (admin) {
    try { await admin.end(); }
    catch (error) { console.error(`CLEANUP FAIL: admin connection: ${error.message}`); process.exitCode = 1; }
  }
  if (poolConnectionErrors.length) process.exitCode = 1;
  if (checksComplete && cloneDropped && process.exitCode !== 1) {
    console.log(`PASS: CP56 ${runs.length}/12 isolated PostgreSQL concurrency/integrity checks AND safe cleanup`);
  } else if (checksComplete) {
    console.error('CP56: 12 SQL checks passed, but cleanup or a connection error still requires investigation.');
  }
}
