import {type Metadata} from 'next'
import {StoreCreditClient} from './StoreCreditClient'
export const dynamic='force-dynamic'
export const metadata:Metadata={title:'Store Credit — KVRN Admin',robots:{index:false,follow:false}}
export default function Page(){return <StoreCreditClient/>}
