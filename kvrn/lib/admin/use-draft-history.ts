'use client'

import { useCallback, useState, type Dispatch, type SetStateAction } from 'react'

/** Undo/redo UNSAVED form edits only. Never reverses persisted transactions. */
export function useDraftHistory<T>(initial: T | (() => T), limit = 30): {
  value: T
  set: Dispatch<SetStateAction<T>>
  replace: (value: T) => void
  undo: () => void
  redo: () => void
  canUndo: boolean
  canRedo: boolean
} {
  const [history, setHistory] = useState<{ past: T[]; present: T; future: T[] }>(() => ({
    past: [], present: typeof initial === 'function' ? (initial as () => T)() : initial, future: [],
  }))
  const set: Dispatch<SetStateAction<T>> = useCallback(updater => {
    setHistory(prev => {
      const value = typeof updater === 'function'
        ? (updater as (old: T) => T)(prev.present) : updater
      if (JSON.stringify(value) === JSON.stringify(prev.present)) return prev
      return { past: [...prev.past, prev.present].slice(-limit), present: value, future: [] }
    })
  }, [limit])
  const replace = useCallback((value: T) => setHistory({ past: [], present: value, future: [] }), [])
  const undo = useCallback(() => setHistory(prev => {
    if (!prev.past.length) return prev
    return { past: prev.past.slice(0, -1), present: prev.past[prev.past.length - 1],
      future: [prev.present, ...prev.future] }
  }), [])
  const redo = useCallback(() => setHistory(prev => {
    if (!prev.future.length) return prev
    return { past: [...prev.past, prev.present].slice(-limit), present: prev.future[0],
      future: prev.future.slice(1) }
  }), [limit])
  return { value: history.present, set, replace, undo, redo,
    canUndo: history.past.length > 0, canRedo: history.future.length > 0 }
}
