import type {Metadata} from 'next'
import {PrivateInsightClient} from './PrivateInsightClient'
export const dynamic='force-dynamic'
export const metadata:Metadata={title:'Private Operational Insights — KVRN Admin',robots:{index:false,follow:false}}
export default function Page(){return <PrivateInsightClient/>}
