'use client'

import {
  createContext,
  useContext,
  useState,
  useCallback,
  useEffect,
  useRef,
} from 'react'
import { cn } from '@/lib/utils'

// ─── TYPES ───────────────────────────────────────────────────────────────────

type ToastType = 'default' | 'success' | 'error'

interface Toast {
  id:      string
  message: string
  type:    ToastType
}

interface ToastContextValue {
  toast: (message: string, type?: ToastType) => void
}

// ─── CONTEXT ─────────────────────────────────────────────────────────────────

const ToastContext = createContext<ToastContextValue | null>(null)

export function ToastProvider({ children }: { children: React.ReactNode }) {
  const [toasts, setToasts] = useState<Toast[]>([])
  const timeoutsRef = useRef<Record<string, ReturnType<typeof setTimeout>>>({})

  const dismiss = useCallback((id: string) => {
    setToasts((prev) => prev.filter((t) => t.id !== id))
    clearTimeout(timeoutsRef.current[id])
    delete timeoutsRef.current[id]
  }, [])

  const toast = useCallback(
    (message: string, type: ToastType = 'default') => {
      const id = `toast-${Date.now()}-${Math.random()}`
      setToasts((prev) => [...prev.slice(-2), { id, message, type }])

      timeoutsRef.current[id] = setTimeout(() => {
        dismiss(id)
      }, 3500)
    },
    [dismiss]
  )

  // Cleanup on unmount
  useEffect(() => {
    const timeouts = timeoutsRef.current
    return () => {
      Object.values(timeouts).forEach(clearTimeout)
    }
  }, [])

  return (
    <ToastContext.Provider value={{ toast }}>
      {children}
      {/* Toast container */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="fixed bottom-6 left-1/2 -translate-x-1/2 z-[500] flex flex-col items-center gap-2 pointer-events-none w-full max-w-sm px-4"
      >
        {toasts.map((t) => (
          <ToastItem key={t.id} toast={t} onDismiss={() => dismiss(t.id)} />
        ))}
      </div>
    </ToastContext.Provider>
  )
}

function ToastItem({
  toast,
  onDismiss,
}: {
  toast: Toast
  onDismiss: () => void
}) {
  return (
    <div
      className={cn(
        'px-5 py-3 text-[13px] font-body font-light tracking-widest uppercase',
        'animate-fade-up pointer-events-auto cursor-pointer',
        'transition-opacity duration-200',
        toast.type === 'error'
          ? 'bg-kvrn-error text-white'
          : toast.type === 'success'
          ? 'bg-kvrn-success text-white'
          : 'bg-kvrn-text text-kvrn-bg'
      )}
      onClick={onDismiss}
    >
      {toast.message}
    </div>
  )
}

// ─── HOOK ────────────────────────────────────────────────────────────────────

export function useToast(): ToastContextValue {
  const ctx = useContext(ToastContext)
  if (!ctx) throw new Error('useToast must be used within ToastProvider')
  return ctx
}
