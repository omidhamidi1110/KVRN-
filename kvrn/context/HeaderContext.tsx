'use client'

import { createContext, useContext } from 'react'

// Bar is now always visible — context kept for future use / nav offset
interface HeaderContextValue {
  barVisible: true
}

const HeaderContext = createContext<HeaderContextValue>({ barVisible: true })

export function HeaderProvider({ children }: { children: React.ReactNode }) {
  return (
    <HeaderContext.Provider value={{ barVisible: true }}>
      {children}
    </HeaderContext.Provider>
  )
}

export function useHeader(): HeaderContextValue {
  return useContext(HeaderContext)
}
