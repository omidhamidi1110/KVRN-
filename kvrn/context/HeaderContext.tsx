'use client'

import { createContext, useContext, useState, useCallback } from 'react'

interface HeaderContextValue {
  barVisible:  boolean
  hideBar:     () => void
}

const HeaderContext = createContext<HeaderContextValue>({
  barVisible: true,
  hideBar:    () => {},
})

export function HeaderProvider({ children }: { children: React.ReactNode }) {
  const [barVisible, setBarVisible] = useState(true)
  const hideBar = useCallback(() => setBarVisible(false), [])

  return (
    <HeaderContext.Provider value={{ barVisible, hideBar }}>
      {children}
    </HeaderContext.Provider>
  )
}

export function useHeader(): HeaderContextValue {
  return useContext(HeaderContext)
}
