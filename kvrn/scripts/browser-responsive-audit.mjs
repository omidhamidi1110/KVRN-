#!/usr/bin/env node
/** Read-only STAGING browser QA. Never use against the production hostname. */
const base=(process.env.KVRN_QA_STAGING_URL || '').replace(/\/$/,'')
if(!base){console.error('Set KVRN_QA_STAGING_URL to isolated staging origin, NOT kvrn.shop');process.exit(2)}
let target
try{target=new URL(base)}catch{console.error('Invalid staging URL');process.exit(2)}
if(target.protocol!=='https:' && target.hostname!=='localhost' && target.hostname!=='127.0.0.1'){
 console.error('Staging must use HTTPS or localhost');process.exit(2)
}
if(target.pathname !== '/' || target.search || target.hash || target.username || target.password) {
 console.error('Staging URL must be an origin with no path, query or credentials');process.exit(2)
}
if(/(^|\.)kvrn\.shop$/i.test(target.hostname)) {
 console.error('REFUSED: No automated browser QA against production kvrn.shop');process.exit(2)
}
const {chromium,webkit}=await import('playwright').catch(()=>{
 console.error('Missing optional Playwright. Install in Codespaces staging QA environment.');process.exit(2)
})
const viewports=[320,360,375,390,414,430,768,820,1024,1280,1440]
const publicPaths=['/','/shop','/privacy','/terms','/cookies','/privacy-choices','/messaging-terms','/messaging-privacy','/support/shipping-returns','/support/faq','/contact','/support/track']
// These two routes deliberately 404 when the SMS policy-public flag is disabled.
const smsPoliciesOff = process.env.KVRN_QA_EXPECT_SMS_POLICIES_OFF === 'true'
const gatedSmsPaths = new Set(['/messaging-terms','/messaging-privacy'])
const adminPaths=['/admin','/admin/financials/shipping','/admin/financials','/admin/products','/admin/content','/admin/analytics','/admin/marketing','/admin/live','/admin/store-credit','/admin/media']
const engines=process.env.KVRN_QA_WEBKIT==='true' ? [chromium,webkit]:[chromium]
let failures=0, passed=0, expectedGated404s=0
for(const engine of engines){
 const browser=await engine.launch({headless:true, ...(engine===chromium && process.env.KVRN_QA_CHROMIUM_EXECUTABLE ? {executablePath:process.env.KVRN_QA_CHROMIUM_EXECUTABLE}: {})})
 try{
   for(const width of viewports){
     const ctx=await browser.newContext({viewport:{width,height:900}, ...(process.env.KVRN_QA_STORAGE_STATE ? {storageState:process.env.KVRN_QA_STORAGE_STATE}: {})})
    await ctx.route('**/*', async route => {
      let hostname
      try { hostname = new URL(route.request().url()).hostname } catch { return route.abort('blockedbyclient') }
      if(/(^|\.)kvrn\.shop$/i.test(hostname)) return route.abort('blockedbyclient')
      if (new URL(route.request().url()).origin !== new URL(base).origin) return route.abort('blockedbyclient')
      return route.continue()
    })
     try{
       for(const path of [...publicPaths,...(process.env.KVRN_QA_STORAGE_STATE?adminPaths:[])]){
         const page=await ctx.newPage()
         try{
           const res=await page.goto(base+path,{waitUntil:'domcontentloaded',timeout:20000})
           const expectedStatus = smsPoliciesOff && gatedSmsPaths.has(path) ? 404 : 200
           if(!res || (expectedStatus === 404 ? res.status() !== 404 : res.status() >= 400))
             throw new Error(`HTTP ${res?.status() ?? 'no-response'} (expected ${expectedStatus === 404 ? 'gated 404' : 'successful page'})`)
           // A deliberately gated 404 is a route-policy pass, not a responsive-layout sample.
           if(expectedStatus === 404){ expectedGated404s++; passed++; continue }
           await page.waitForTimeout(150)
           const metrics=await page.evaluate(()=>{
             const root=document.documentElement
             const viewport=root.clientWidth
             const main=document.querySelector('#admin-main')
             const adminShell=main?.closest('.min-h-screen')
             return { viewport,scrollWidth:root.scrollWidth,
               adminMainLeft:main?.getBoundingClientRect().left??null,
               adminMainRight:main?.getBoundingClientRect().right??null,
               shellRight:adminShell?.getBoundingClientRect().right??null }
           })
           if(metrics.scrollWidth>metrics.viewport+2)throw new Error(`whole-page horizontal overflow ${metrics.scrollWidth}/${metrics.viewport}`)
           if(path.startsWith('/admin') && width<=1024 && metrics.shellRight!==null && metrics.shellRight<width-3)
             throw new Error(`admin shell ends before viewport ${metrics.shellRight}/${width}`)
           passed++
         }catch(e){failures++;console.error(`FAIL ${engine.name()} ${width}px ${path}: ${String(e?.message||e).slice(0,180)}`)}
         finally{await page.close()}
       }
     }finally{await ctx.close()}
   }
 } finally {await browser.close()}
}
console.log(`Responsive QA: ${passed} passed (${expectedGated404s} deliberately gated messaging-policy 404s), ${failures} failed. Admin tests ${process.env.KVRN_QA_STORAGE_STATE?'included':'SKIPPED (no staging auth storage state)'}.`)
process.exitCode=failures?1:0
