import type {Metadata} from 'next'
import {TemplateClient} from './TemplateClient'
export const dynamic='force-dynamic'
export const metadata:Metadata={title:'Marketing Copy Templates — KVRN Admin',robots:{index:false,follow:false}}
export default function Page(){return <TemplateClient/>}
