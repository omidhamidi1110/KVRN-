'use client'

import {useEffect, useRef, useState} from 'react'
import Link from 'next/link'

type Status = 'verifying' | 'verified' | 'invalid'

/** Never render challenge tokens; fragment is cleared before exchanging it. */
export default function CreditVerifyClient() {
  const [status,setStatus]=useState<Status>('verifying')
  // React StrictMode remounts effects in development. Retain the same single
  // request promise across effect replays so the one-use challenge is not spent
  // a second time or wrongly shown as expired.
  const verificationRequest=useRef<Promise<boolean>|null>(null)
  useEffect(()=>{
    if(!verificationRequest.current){
      const fragment=window.location.hash
      const token=fragment.startsWith('#token=') ? fragment.slice('#token='.length) : ''
      window.history.replaceState(null,'',window.location.pathname+window.location.search)
      verificationRequest.current=/^[0-9a-f-]{36}\.[a-f0-9]{64}$/i.test(token)
        ? fetch('/api/store-credit/identity/verify',{
            method:'POST',credentials:'same-origin',cache:'no-store',
            headers:{'Content-Type':'application/json'},body:JSON.stringify({token}),
          }).then(r=>r.ok).catch(()=>false)
        : Promise.resolve(false)
    }
    let active=true
    verificationRequest.current.then(ok=>{if(active)setStatus(ok?'verified':'invalid')})
    return ()=>{active=false}
  },[])
  return <main style={{minHeight:'70vh',background:'#F9F8F6',padding:'140px 24px 70px'}}>
    <section style={{maxWidth:520,margin:'0 auto',padding:32,background:'#fff',border:'1px solid #E8E5E0'}}>
      <h1 style={{fontSize:22,letterSpacing:'0.08em',textTransform:'uppercase'}}>Verify store credit</h1>
      <p role="status" style={{fontSize:14,lineHeight:1.7,margin:'20px 0',color:'#565656'}}>
        {status==='verifying'?'Verifying your one-time link…':
          status==='verified'?'Your email is verified for this browser for the next 30 minutes. Enter the same email when checking out.':
          'This verification link is invalid, has expired, or was already used. Request a new link from checkout.'}
      </p>
      <Link href="/checkout" style={{display:'inline-block',padding:'12px 24px',background:'#1A1A1A',color:'#fff'}}>
        Return to checkout
      </Link>
    </section>
  </main>
}
