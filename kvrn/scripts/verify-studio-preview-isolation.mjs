/** Verify the exact configuration used to deploy staging cannot claim production. */
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
const root = join(dirname(fileURLToPath(import.meta.url)), '..')
const conf = readFileSync(join(root, 'wrangler.studio-preview.toml'), 'utf8')
const wf = readFileSync(join(root, '../.github/workflows/kvrn-developer-studio.yml'), 'utf8')
assert.match(conf, /^name\s*=\s*"kvrn-preview"\s*$/m)
assert.match(conf, /^workers_dev\s*=\s*true\s*$/m)
for (const banned of [/(?:^|\n)\s*(?:route|routes|custom_domain|zone_id|zone_name)\s*=/i, /\[\[\s*(?:env\.\w+\.)?routes\s*\]\]/i, /\bkvrn\.shop\b/i, /\b(?:DATABASE_URL|STRIPE_SECRET_KEY|DEV_STUDIO_GITHUB_TOKEN)\b/]) {
  assert.doesNotMatch(conf, banned)
}
assert.match(wf, /opennextjs-cloudflare deploy --config=wrangler\.studio-preview\.toml/)
assert.doesNotMatch(wf, /opennextjs-cloudflare deploy --env preview/)
assert.doesNotMatch(wf, /Automatically merge owner-requested/)
console.log('PASS: preview Worker routes, secrets and domain are isolated from production.')
