import type {ReactNode} from 'react'
import type {Metadata} from 'next'
export const metadata:Metadata={
  title:'Track Order — KVRN',
  description:'Securely check the status of a KVRN order using your order number and checkout email.',
  robots:{index:false,follow:false},
}
export default function TrackLayout({children}:{children:ReactNode}){return children}
