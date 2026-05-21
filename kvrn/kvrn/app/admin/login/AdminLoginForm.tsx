'use client'

import { useState } from 'react'
import { useRouter, useSearchParams } from 'next/navigation'
import { Button } from '@/components/ui/Button'

export function AdminLoginForm() {
  const router       = useRouter()
  const searchParams = useSearchParams()
  const returnTo     = searchParams.get('return') ?? '/admin'

  const [password, setPassword] = useState('')
  const [error,    setError]    = useState('')
  const [loading,  setLoading]  = useState(false)

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault()
    setError('')
    setLoading(true)

    try {
      const res = await fetch('/api/admin-login', {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ password }),
      })

      if (res.ok) {
        router.push(returnTo)
        router.refresh()
      } else {
        setError('Incorrect password.')
      }
    } catch {
      setError('Something went wrong. Try again.')
    } finally {
      setLoading(false)
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-kvrn-bg">
      <div className="w-full max-w-sm">
        <p className="label-11 text-kvrn-muted mb-6 text-center">KVRN Admin</p>

        <form onSubmit={handleSubmit} className="space-y-4">
          <div>
            <label htmlFor="password" className="sr-only">Admin password</label>
            <input
              id="password"
              type="password"
              autoComplete="current-password"
              placeholder="Password"
              value={password}
              onChange={(e) => { setPassword(e.target.value); setError('') }}
              className="input-base"
              autoFocus
            />
          </div>

          {error && (
            <p role="alert" className="text-[12px] text-kvrn-error">{error}</p>
          )}

          <Button type="submit" variant="primary" size="lg" fullWidth loading={loading}>
            Sign in
          </Button>
        </form>

        <p className="text-[11px] text-kvrn-subtle text-center mt-6 leading-relaxed">
          Set <code className="bg-kvrn-bg-raised px-1 py-0.5">ADMIN_SECRET</code> in your environment.
        </p>
      </div>
    </div>
  )
}
