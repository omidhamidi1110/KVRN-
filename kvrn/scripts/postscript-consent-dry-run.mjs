#!/usr/bin/env node
/**
 * KVRN Postscript -> Twilio consent preflight. READ-ONLY, OFFLINE, AGGREGATE ONLY.
 * Never uploads, logs or writes customer phone numbers. It intentionally does not
 * produce an import-ready subscriber file. Human approval and a restricted importer
 * are required for any database mutation.
 */
import { readFileSync, statSync } from 'node:fs'

function parseCsv(s) {
  const rows=[]; let row=[], cell='', quote=false
  s = s.replace(/^\uFEFF/, '')
  for(let i=0; i<s.length; i++) {
    const ch=s[i]
    if(quote) {
      if(ch==='"' && s[i+1]==='"') {cell+='"';i++}
      else if(ch==='"') quote=false
      else cell+=ch
    } else if(ch==='"') { if(cell.trim()) throw new Error('Unexpected quote in CSV'); quote=true }
    else if(ch===',') {row.push(cell);cell=''}
    else if(ch==='\n') {row.push(cell.replace(/\r$/,''));if(row.some(v=>v!=='')) rows.push(row);row=[];cell=''}
    else cell+=ch
  }
  if(quote) throw new Error('Unterminated quoted CSV value')
  row.push(cell.replace(/\r$/,''))
  if(row.some(v=>v!==''))rows.push(row)
  if(rows.some(r=>r.length!==rows[0]?.length)) throw new Error('Inconsistent CSV column counts')
  return rows
}
function headerIndex(h, names) {
  return names.map(n=>h.indexOf(n)).find(i=>i>=0) ?? -1
}
function isOptedIn(s) { return ['subscribed','opted_in','opted in','active','yes','true'].includes(s.trim().toLowerCase()) }
function isOptedOut(s) { return ['unsubscribed','opted_out','opted out','inactive','stopped','stop','no','false'].includes(s.trim().toLowerCase()) }
function normalizedPhone(s) {
  const p=s.trim().replace(/[\s().-]/g,'')
  return /^\+[1-9]\d{7,14}$/.test(p) ? p : null
}
function validDate(s) { return !!s && !Number.isNaN(Date.parse(s)) }
export function analyzePostscriptCsv(csv) {
  const all=parseCsv(csv)
  if(all.length<2) throw new Error('CSV must include a header and at least one data row')
  const header=all[0].map(x=>x.trim().toLowerCase().replace(/[ -]+/g,'_'))
  const phone=headerIndex(header,['phone','phone_number','phone_e164','subscriber_phone','mobile_phone'])
  const state=headerIndex(header,['sms_status','status','subscription_status','consent_status'])
  const consentAt=headerIndex(header,['consented_at','opted_in_at','sms_consent_at','subscribed_at','opt_in_date'])
  const origin=headerIndex(header,['consent_source','source','opt_in_source','signup_source'])
  const brand=headerIndex(header,['consent_brand','brand','brand_name'])
  const revokedAt=headerIndex(header,['unsubscribed_at','opted_out_at','sms_opt_out_at','opt_out_date'])
  if(phone<0 || state<0) throw new Error('Required columns: phone and SMS status')
  const seen=new Map()
  const counters={ rows:0, uniqueNumbers:0, duplicates:0, activeWithEvidence:0, suppressed:0, invalidNumbers:0, missingEvidence:0, ambiguousStatus:0, conflicts:0 }
  for(const row of all.slice(1)) {
    counters.rows++
    const p=normalizedPhone(row[phone]??'')
    if(!p){counters.invalidNumbers++;continue}
    const value=(row[state]??'').trim()
    const suppress=isOptedOut(value) || (revokedAt>=0 && validDate(row[revokedAt]??''))
    const active=isOptedIn(value) && !suppress
    const evidence=consentAt>=0 && validDate(row[consentAt]??'')
      && origin>=0 && !!row[origin]?.trim()
      && brand>=0 && row[brand]?.trim().toLowerCase()==='kvrn'
    const current=seen.get(p)
    if(current) {counters.duplicates++; if(current.suppress!==suppress) counters.conflicts++}
    // Evidence must belong to the SAME active row as the asserted consent.
    // A separate unrelated/incomplete row must not be stitched together into
    // fabricated marketing eligibility. Any opt-out dominates all opt-ins.
    seen.set(p,{ suppress:suppress || !!current?.suppress,
      active:active || !!current?.active, eligible:(active && evidence) || !!current?.eligible,
      ambiguous:(!active && !suppress) || !!current?.ambiguous })
  }
  counters.uniqueNumbers=seen.size
  for(const r of seen.values()) {
    if(r.suppress) counters.suppressed++
    else if(r.ambiguous) counters.ambiguousStatus++
    else if(r.active && r.eligible) counters.activeWithEvidence++
    else counters.missingEvidence++
  }
  return { ...counters, reportType:'offline-dry-run', safeToAutomaticallyImport:false,
    note:'Counts only. Consent evidence, original disclosures, suppression and current status require manual review before any import.' }
}
if(process.argv[1]?.endsWith('/postscript-consent-dry-run.mjs')) {
  const filename=process.argv[2]
  if(!filename || process.argv.length!==3) {
    console.error('Usage: node scripts/postscript-consent-dry-run.mjs /private/path/postscript.csv')
    process.exit(2)
  }
  try {
    if(statSync(filename).size>15*1024*1024) throw new Error('CSV too large for the offline preflight')
    const content=readFileSync(filename,'utf8')
    if(Buffer.byteLength(content)>15*1024*1024) throw new Error('CSV too large for the offline preflight')
    process.stdout.write(JSON.stringify(analyzePostscriptCsv(content),null,2)+'\n')
  } catch(error) {
    console.error(`Consent dry-run could not complete: ${error instanceof Error ? error.message : 'unknown error'}`)
    process.exitCode=1
  }
}
