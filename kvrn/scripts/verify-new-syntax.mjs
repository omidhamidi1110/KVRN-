import {createRequire} from 'node:module'
import {readFileSync,existsSync,statSync,readdirSync} from 'node:fs'
import {execFileSync} from 'node:child_process'
import {resolve,extname} from 'node:path'
import assert from 'node:assert/strict'
// The Codespaces full type check remains required. The system TypeScript compiler
// lets us at least check syntax without attempting dependency installation or deployment.
const require=createRequire(import.meta.url)
let ts
try{ts=require('typescript')}catch{ts=require('/opt/nvm/versions/node/v22.16.0/lib/node_modules/typescript')}
const input=execFileSync('git',['status','--porcelain','-uall'],{encoding:'utf8'}).trim().split('\n')
let count=0,errors=0
for(const line of input){
 const f=line.slice(3).trim();if(!f||!existsSync(f)||!statSync(f).isFile()||!['.ts','.tsx'].includes(extname(f)))continue
 const txt=readFileSync(f,'utf8')
 const src=ts.createSourceFile(f,txt,ts.ScriptTarget.Latest,true,extname(f)==='.tsx'?ts.ScriptKind.TSX:ts.ScriptKind.TS)
 for(const diagnostic of src.parseDiagnostics){console.error('SYNTAX FAILURE',f,ts.flattenDiagnosticMessageText(diagnostic.messageText,' '));errors++}
 count++
}
console.log(`Syntax parser: ${count} changed TS/TSX files, ${errors} parse failures`)
assert.equal(errors,0)
