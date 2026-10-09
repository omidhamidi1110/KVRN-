#!/usr/bin/env node
/** Read-only evidence that a reviewed nonproduction Git merge matches CP60 staging bytes. */
import assert from 'node:assert/strict'
import { createHash } from 'node:crypto'
import { spawnSync } from 'node:child_process'
import { existsSync, lstatSync, readFileSync, realpathSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const target=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..')
const stage='/workspaces/KVRN-/kvrn-merged-staging'
const hash=p=>createHash('sha256').update(readFileSync(p)).digest('hex')
try {
  assert.equal(realpathSync(target),'/workspaces/KVRN-/kvrn','Must run in original repo, only AFTER reviewed merge')
  assert.notEqual(realpathSync(stage),realpathSync(target),'Staging and target must remain different directories')
  const manifest=JSON.parse(readFileSync(path.join(stage,'CP60_SOURCE_MANIFEST.json'),'utf8'))
  assert.equal(manifest.checkpoint,'CP60')
  const git=spawnSync('git',['-C','/workspaces/KVRN-','branch','--show-current'],{encoding:'utf8',timeout:12000})
  assert.equal(git.status,0,'Git branch inspection failed')
  const branch=git.stdout.trim()
  assert.ok(branch && !/^(main|master|production|prod|live)$/i.test(branch),'Refuse to treat production branch as reviewed integration')
  const recoveryMetadataExceptions=new Set(['MANIFEST_SHA256.json','README_RECOVERY.txt'])
  const mismatches=[]
  let count=0
  for(const [rel,expected] of Object.entries(manifest.files)){
    const source=path.join(stage,rel),dest=path.join(target,rel)
    if(!existsSync(source)||!existsSync(dest)||lstatSync(dest).isSymbolicLink()||!lstatSync(dest).isFile()) {
      mismatches.push(rel)
    } else if(recoveryMetadataExceptions.has(rel)) {
      // These were preserved as local documentation-only differences during CP60.
      // Post-merge they must be byte-identical between staging and the target,
      // without falsely claiming to match the original canonical manifest hash.
      if(hash(source)!==hash(dest)) mismatches.push(rel)
    } else if(hash(source)!==expected||hash(dest)!==expected) mismatches.push(rel)
    count++
    if(mismatches.length===12)break
  }
  assert.equal(mismatches.length,0,`Merged source mismatch: ${mismatches.join(', ')}`)
  const out={status:'PASS',branch,sourceEntriesVerified:count,productionDeployed:false,gitCommitPerformed:false}
  writeFileSync('/tmp/kvrn-cp60-postmerge.json',JSON.stringify(out,null,2),{mode:0o600})
  console.log(`CP60 POST-MERGE SOURCE PASS: ${count} verified files on non-production branch ${branch}`)
  console.log('Source equivalence only; real provider integration and production deployment remain NOT VERIFIED')
} catch(e) {console.error('CP60 POST-MERGE BLOCKED:',e.message||e);process.exitCode=1}
