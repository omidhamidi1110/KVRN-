import type {Metadata} from 'next'
import {MarketingClient} from './MarketingClient'
export const dynamic='force-dynamic'
export const metadata:Metadata={title:'Marketing Suite — KVRN Admin',robots:{index:false,follow:false}}
export default function Page(){return <MarketingClient/>}
