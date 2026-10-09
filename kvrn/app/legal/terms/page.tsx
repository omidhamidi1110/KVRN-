// Legacy alias: always redirect to the one canonical public policy route.
import { permanentRedirect } from 'next/navigation'

export default function LegacyLegalAlias() {
  permanentRedirect('/terms')
}
