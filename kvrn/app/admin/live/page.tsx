import type { Metadata } from 'next'
import { LiveViewClient } from './LiveViewClient'
export const dynamic='force-dynamic'
export const metadata:Metadata={title:'Live View — KVRN Admin',robots:{index:false,follow:false}}
export default function LiveViewPage(){return <LiveViewClient/>}
