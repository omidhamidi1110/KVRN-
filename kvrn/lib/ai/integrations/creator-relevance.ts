type BraveHit={url?:unknown;title?:unknown;description?:unknown}
type CreatorLead={title:string;url:string;snippet:string}

const BLOCK=/\b(roblox|bloxburg|minecraft|fortnite|gaming|gameplay|gamepass|fakeheadless|headless|avatar)\b|dress to impress/i
const FASHION=/\b(streetwear|menswear|fashion|outfits?|styling|styled|hoodies?|clothing|apparel|lookbook|wardrobe|ootd|try[ -]?on)\b/i
const FILLER=new Set(['ugc','user','generated','content','creator','creators','influencer','influencers','tiktok','the','with','and','for'])

const words=(s:string)=>[...new Set((s.toLowerCase().match(/[a-z0-9]+/g)??[]).filter(w=>w.length>2&&!FILLER.has(w)))].slice(0,8)

export function buildBraveCreatorQuery(topic:string){
 const t=words(topic)
 return `site:tiktok.com/@ ${t.length?t.join(' '):'streetwear outfits'} -roblox -headless -gaming -minecraft -fortnite -avatar`
}
export function rankBraveCreatorHits(hits:BraveHit[],topic:string):CreatorLead[]{
 const found=new Map<string,{score:number;lead:CreatorLead}>()
 for(const hit of (Array.isArray(hits)?hits:[]).slice(0,20)){
  if(typeof hit.url!=='string'||hit.url.length>900)continue
  let u:URL
  try{u=new URL(hit.url)}catch{continue}
  if(u.protocol!=='https:'||u.username||u.password||!['tiktok.com','www.tiktok.com','m.tiktok.com'].includes(u.hostname.toLowerCase()))continue
  const match=u.pathname.match(/^\/@([A-Za-z0-9._]{2,24})(?:\/video\/\d{10,22})?\/?$/)
  if(!match)continue
  const handle=match[1].toLowerCase()
  const title=typeof hit.title==='string'?hit.title.slice(0,160):''
  const snippet=typeof hit.description==='string'?hit.description.slice(0,280):''
  const context=`${title} ${snippet} ${handle}`.toLowerCase()
  if(BLOCK.test(context))continue
  if(FASHION.test(topic)&&!FASHION.test(context))continue
  const matched=words(topic).filter(w=>w==='outfit'?/\boutfits?\b|\bootd\b/.test(context):w==='styling'?/\bstyl(?:ing|e|ed|ist)\b/.test(context):new RegExp(`\\b${w}(?:s)?\\b`).test(context)).length
  if(matched===0)continue
  const direct=/^\/@[^/]+\/?$/.test(u.pathname)
  const score=matched*4+(direct?3:0)
  const lead={title:direct?`@${handle} — ${title}`:`@${handle} — possible fashion creator (verify profile)`,url:`https://www.tiktok.com/@${handle}`,snippet}
  if(!found.has(handle)||score>found.get(handle)!.score)found.set(handle,{score,lead})
 }
 return [...found.values()].sort((a,b)=>b.score-a.score).slice(0,12).map(x=>x.lead)
}
