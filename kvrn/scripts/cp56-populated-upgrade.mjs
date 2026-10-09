#!/usr/bin/env node
// Optional CP56 destructive-populated-schema staging test: brand-new disposable
// local PostgreSQL DB only. Existing CP55 database and Jest DBs untouched.
import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { realpathSync, readdirSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import pg from 'pg';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const dir=path.join(root,'db/migrations');
const db=`kvrn_cp56_upgrade_${randomBytes(4).toString('hex')}`;
const expected=path.join(os.homedir(),'.local/share/kvrn-audit2-pg16');
const cfg=(database)=>({host:'/tmp',port:5433,user:'postgres',database,ssl:false,
  connectionTimeoutMillis:6000,statement_timeout:30000,query_timeout:30000});
function migration(n) {
  const candidates=readdirSync(dir).filter(x=>/^\d{3}_.*\.sql$/.test(x)&&Number(x.slice(0,3))===n);
  assert.equal(candidates.length,1,`Expected unique migration ${n}`);
  const args=['-X','-w','-v','ON_ERROR_STOP=1','-h','/tmp','-p','5433',
    '-U','postgres','-d',db,'-f',path.join(dir,candidates[0])];
  const p=spawnSync('psql',args,{encoding:'utf8',timeout:55000,env:{
    HOME:os.homedir(),PATH:process.env.PATH||'/usr/bin:/bin',PGPASSWORD:''}});
  if(p.error||p.status!==0) throw Error(`Migration ${n} failed: ${String(p.stderr||p.error).slice(-1200)}`);
}
const rand=()=>randomBytes(6).toString('hex');
async function main() {
  const a=new pg.Client(cfg('postgres'));await a.connect();
  try {
    const origin=(await a.query('SHOW data_directory')).rows[0].data_directory;
    assert.equal(realpathSync(origin),realpathSync(expected),'Wrong database data directory: NO WRITES');
    const templateExists=await a.query("SELECT 1 FROM pg_database WHERE datname='kvrn_cp55_migrationtest'");
    assert.equal(templateExists.rowCount,1,'CP55 proof DB missing: refusing new DB');
    await a.query(`CREATE DATABASE "${db}" TEMPLATE template0`);
  } finally {await a.end();}
  console.log(`ISOLATED DATABASE: ${db}`);
  try {
    for(let i=1;i<=37;i++) migration(i);
    console.log('PASS: created 037 schema in fresh separate fixture');
    const c=new pg.Client(cfg(db));await c.connect();
    let before;
    try {
      await c.query('BEGIN');
      const slug=`cp56-${rand()}`;
      const prod=(await c.query(`INSERT INTO products(drop_code,product_code,name,slug,price_cents)
        VALUES('CP56','FIXTURE','Schema Upgrade Fixture',$1,8000) RETURNING id`,[slug])).rows[0].id;
      const variant=(await c.query(`INSERT INTO product_variants(product_id,sku,color_name,color_code,size,size_sort,stock_on_hand)
        VALUES($1,$2,'Black','#000000','M',1,4) RETURNING id`,[prod,slug])).rows[0].id;
      const stripeSession=`cs_test_${rand()}`;
      const res=(await c.query(`INSERT INTO reservations(status,expires_at,stripe_checkout_session_id)
        VALUES('completed',NOW()+INTERVAL '2 hours',$1) RETURNING id`,[stripeSession])).rows[0].id;
      const order=(await c.query(`INSERT INTO orders(order_number,stripe_checkout_session_id,reservation_id,
        payment_status,subtotal_cents,total_cents,paid_at)
        VALUES($1,$2,$3,'paid',8000,8000,NOW()) RETURNING id`,
        [`CP56-${rand()}`,stripeSession,res])).rows[0].id;
      const orderItem=(await c.query(`INSERT INTO order_items(order_id,variant_id,sku,product_name,size,color,
        quantity,unit_price_cents,line_total_cents)
        VALUES($1,$2,$3,'Schema Upgrade Fixture','M','Black',1,8000,8000) RETURNING id`,
        [order,variant,slug])).rows[0].id;
      const ret=(await c.query(`INSERT INTO order_returns(order_id,return_number,status)
        VALUES($1,$2,'requested') RETURNING id`,[order,`CP56-${rand()}`])).rows[0].id;
      const email=`cp56-upgrade-${rand()}@example.invalid`;
      const sub=(await c.query(`INSERT INTO marketing_subscribers(email,consent_source,status)
        VALUES($1,'footer','subscribed') RETURNING id`,[email])).rows[0].id;
      const discount=(await c.query(`INSERT INTO discounts(code,name,type,amount_cents)
        VALUES($1,'Populated upgrade discount','fixed_amount',700) RETURNING id`,[`CP56${rand()}`])).rows[0].id;
      const affiliate=(await c.query(`INSERT INTO affiliates(code,name,default_commission_rate_bps)
        VALUES($1,'Populated upgrade affiliate',1000) RETURNING id`,[`CP56${rand()}`])).rows[0].id;
      before={prod,variant,res,order,orderItem,ret,sub,discount,affiliate,email,slug};
      await c.query('COMMIT');
      console.log('PASS: populated commerce/inventory/returns/discount/subscriber/affiliate fixture at 037');
    } catch(e){await c.query('ROLLBACK');throw e;}finally{await c.end();}
    for(let i=38;i<=65;i++) migration(i);
    console.log('PASS: upgraded populated 037 -> 065 without applying anything to CP55 evidence');
    const verify=new pg.Client(cfg(db)); await verify.connect();
    try {
      for (const [table,field,value] of [
        ['products','id',before.prod],['product_variants','id',before.variant],
        ['reservations','id',before.res],['orders','id',before.order],
        ['order_items','id',before.orderItem],['order_returns','id',before.ret],
        ['marketing_subscribers','id',before.sub],['discounts','id',before.discount],
        ['affiliates','id',before.affiliate]
      ]) {
        const row=(await verify.query(`SELECT count(*)::int AS n FROM ${table} WHERE ${field}=$1`,[value])).rows[0];
        assert.equal(row.n,1,`Lost or duplicated existing ${table} record`);
      }
      const inv=(await verify.query('SELECT stock_on_hand,reserved_quantity FROM product_variants WHERE id=$1',[before.variant])).rows[0];
      assert.equal(inv.stock_on_hand,4);assert.equal(inv.reserved_quantity,0);
      const ord=(await verify.query('SELECT subtotal_cents,total_cents FROM orders WHERE id=$1',[before.order])).rows[0];
      assert.deepEqual([ord.subtotal_cents,ord.total_cents],[8000,8000]);
      const disc=(await verify.query('SELECT amount_cents FROM discounts WHERE id=$1',[before.discount])).rows[0];
      assert.equal(disc.amount_cents,700);
      const subscriber=(await verify.query('SELECT email,status FROM marketing_subscribers WHERE id=$1',[before.sub])).rows[0];
      assert.deepEqual(subscriber,{email:before.email,status:'subscribed'});
      const aff=(await verify.query('SELECT default_commission_rate_bps FROM affiliates WHERE id=$1',[before.affiliate])).rows[0];
      assert.equal(aff.default_commission_rate_bps,1000);
      console.log('PASS: 9/9 historical IDs intact, stock/economics/subscriber/affiliate values unchanged');
      console.log('POPULATED UPGRADE PASS; DATABASE PRESERVED:',db);
    } finally {await verify.end();}
  } catch(e){console.error('DATABASE PRESERVED FOR FORENSICS:',db);throw e;}
}
main().catch(e=>{console.error(`FAIL ${e?.stack||e}`);process.exitCode=1;});
