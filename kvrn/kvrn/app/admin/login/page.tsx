import { Suspense } from 'react'
import { AdminLoginForm } from './AdminLoginForm'

export default function AdminLoginPage() {
  return (
    <Suspense fallback={
      <div className="min-h-screen flex items-center justify-center">
        <p className="label-11 text-kvrn-muted">Loading...</p>
      </div>
    }>
      <AdminLoginForm />
    </Suspense>
  )
}
