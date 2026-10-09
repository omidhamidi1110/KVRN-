'use client'

import {useEffect,useState} from 'react'

type Balance={availableCents:number;heldCents:number;outstandingCents:number;redemptionEnabled:boolean}
const dollars=(cents:number)=>`$${(cents/100).toFixed(2)}`
/** No floating-point money arithmetic. Only strictly formatted USD cents. */
export function parseCreditDollars(input:string):number|null {
  if(!/^(?:0|[1-9][0-9]{0,6})(?:\.[0-9]{1,2})?$/.test(input))return null
  const [whole,fraction='']=input.split('.')
  const amount=Number(whole)*100+Number(fraction.padEnd(2,'0'))
  return Number.isSafeInteger(amount)&&amount>0?amount:null
}

export default function StoreCreditCheckout({email,netMerchandiseCents,totalCents,onChange}:{
  email:string;netMerchandiseCents:number;totalCents:number;onChange:(cents:number|null)=>void
}){
  const [enabled,setEnabled]=useState(false)
  const [balance,setBalance]=useState<Balance|null>(null)
  const [verified,setVerified]=useState(false)
  const [loading,setLoading]=useState(false)
  const [sent,setSent]=useState(false)
  const [input,setInput]=useState('')
  const [applied,setApplied]=useState<number|null>(null)
  const [error,setError]=useState('')
  const maximum=Math.max(0,Math.min(balance?.availableCents??0,netMerchandiseCents,Math.max(0,totalCents-100)))

  useEffect(()=>{
    let active=true
    fetch('/api/store-credit/balance',{cache:'no-store',credentials:'same-origin'})
      .then(async r=>({status:r.status,data:await r.json().catch(()=>({}))}))
      .then(({status,data})=>{
        if(!active)return
        const feature=data.redemptionEnabled===true
        setEnabled(feature)
        setVerified(status===200&&feature)
        setBalance(status===200&&feature&&Number.isSafeInteger(data.availableCents)&&data.availableCents>=0?data as Balance:null)
      }).catch(()=>{if(active){setEnabled(false);setBalance(null)}})
    return ()=>{active=false}
  },[])

  useEffect(()=>{
    // Checkout address, promotion, email or cart changed: no stale tender quote.
    setApplied(null);setInput('');setError('');onChange(null)
    // onChange deliberately omitted: the parent callback changes each render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  },[email,netMerchandiseCents,totalCents])

  if(!enabled)return null
  const sendVerification=async()=>{
    if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email.trim())){
      setError('Enter a valid email address in the contact step first.');return
    }
    setLoading(true);setError('')
    try{
      const r=await fetch('/api/store-credit/identity/start',{
        method:'POST',headers:{'Content-Type':'application/json'},credentials:'same-origin',
        body:JSON.stringify({email:email.trim()}),
      })
      if(!r.ok)throw Error('Verification service unavailable. Please try again.')
      setSent(true)
    }catch{setError('Unable to request a verification link right now.')}
    finally{setLoading(false)}
  }
  const apply=()=>{
    const cents=parseCreditDollars(input)
    if(cents===null||cents>maximum){setError(`Enter an amount from $0.01 to ${dollars(maximum)}.`);return}
    setError('');setApplied(cents);onChange(cents)
  }
  return <section aria-label="Store credit" style={{margin:'28px 0 12px',padding:'20px',border:'1px solid #E8E5E0',background:'#fff'}}>
    <h3 style={{fontSize:12,fontWeight:600,letterSpacing:'.06em',textTransform:'uppercase'}}>KVRN store credit</h3>
    {!verified ? <>
      <p style={{fontSize:13,marginTop:12,color:'#676767'}}>Verify the email used for your store credit to redeem it at checkout.</p>
      <button type="button" disabled={loading} onClick={sendVerification}
        style={{marginTop:12,textDecoration:'underline',fontSize:13,color:'#1a1a1a'}}>
        {loading?'Requesting…':'Email me a verification link'}
      </button>
      {sent&&<p role="status" style={{fontSize:12,marginTop:8}}>If eligible, a verification email will arrive shortly. Open it to verify, then return to checkout.</p>}
    </> : <>
      <p style={{fontSize:13,marginTop:12}}>Available credit: <strong>{dollars(balance?.availableCents??0)}</strong></p>
      <p style={{fontSize:12,marginTop:6,color:'#676767'}}>Credit covers merchandise only. At least $1.00 remains payable here; the server verifies the final Stripe minimum.</p>
      {maximum>0? <div style={{display:'flex',gap:8,marginTop:14,flexWrap:'wrap'}}>
        <label style={{fontSize:12,flex:'1 1 150px'}}>Credit to use (USD)
          <input type="text" inputMode="decimal" autoComplete="off" value={input} placeholder={dollars(maximum)}
            onChange={e=>{setInput(e.target.value);setApplied(null);onChange(null)}}
            style={{display:'block',padding:'10px',border:'1px solid #aaa',width:'100%',marginTop:5}} />
        </label>
        <button type="button" onClick={apply} style={{alignSelf:'end',padding:'11px 20px',border:'1px solid #1a1a1a'}}>Apply credit</button>
      </div>:<p style={{fontSize:12,marginTop:8}}>No credit is currently applicable to this order.</p>}
      {applied!==null&&<p role="status" style={{fontSize:12,marginTop:8}}>Applying {dollars(applied)} credit. Final amount verified by Stripe.</p>}
      {applied!==null&&<button type="button" onClick={()=>{setApplied(null);setInput('');onChange(null)}} style={{fontSize:12,textDecoration:'underline',marginTop:8}}>Remove credit</button>}
    </>}
    {error&&<p role="alert" style={{fontSize:12,color:'#B91C1C',marginTop:10}}>{error}</p>}
  </section>
}
