#!/usr/bin/env node
// Read-only post-build check. Neither this script nor cf:build deploys anything.
import assert from 'node:assert/strict';
import { existsSync, statSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const file=(name)=>path.join(root,name);
function required(name,minSize=1){
 assert.ok(existsSync(file(name)),`Missing Cloudflare artifact: ${name}`);
 const stats=statSync(file(name));
 assert.ok(stats.isFile() && stats.size>=minSize,`Missing or empty: ${name}`);
 console.log(`PASS ${name} (${stats.size} bytes)`);
}
for(const name of ['.env','.env.local','.env.production','.env.production.local']) {
 assert.ok(!existsSync(file(name)),`STOP: environmental secrets file ${name}`);
}
const config=readFileSync(file('wrangler.toml'),'utf8');
assert.match(config,/main\s*=\s*"cloudflare-cron-wrapper\.js"/);
assert.match(config,/directory\s*=\s*"\.open-next\/assets"/);
assert.match(config,/nodejs_compat/);
const wrapper=readFileSync(file('cloudflare-cron-wrapper.js'),'utf8');
assert.match(wrapper,/import openNextWorker from ['"]\.\/\.open-next\/worker\.js['"]/);
assert.match(wrapper,/fetch:\s*openNextWorker\.fetch/);
assert.match(wrapper,/async scheduled\(/);
assert.match(wrapper,/async email\(/);
const pkg=JSON.parse(readFileSync(file('package.json'),'utf8'));
assert.equal(pkg.scripts['cf:build'],'npx opennextjs-cloudflare build');
console.log('PASS Wrangler entry, assets binding, worker compatibility and safe build-only command');
required('.open-next/worker.js',1000);
required('.open-next/assets/images/products/project-kvrn-heavyweight-hoodie/1.webp',500);
required('.open-next/assets/images/products/project-kvrn-heavyweight-sweatpants/1.webp',500);
assert.ok(existsSync(file('.open-next/assets/_next')),'Next.js asset directory missing');
console.log('PASS Cloudflare/OpenNext compile artifact checks; no deployment performed');
