'use client'
// components/admin/charts/ChartBoundary.tsx
//
// A rendering failure inside one chart (a malformed API value, an unexpected shape) must
// never take down the page and the figures around it. This boundary replaces ONLY the
// failing chart with a plain message; everything else keeps working.

import React from 'react'

const FONT = '-apple-system, Helvetica Neue, Arial, sans-serif'

export class ChartBoundary extends React.Component<
  { children: React.ReactNode; label?: string },
  { failed: boolean }
> {
  state = { failed: false }
  static getDerivedStateFromError() { return { failed: true } }
  componentDidCatch(err: unknown) {
    // Message only, truncated; chart data is aggregate but keep logs minimal.
    console.error('[admin chart] render failed:', String((err as any)?.message ?? err).slice(0, 120))
  }
  render() {
    if (!this.state.failed) return this.props.children
    return (
      <div role="alert" style={{ padding: '18px 14px', border: '1px solid #FECACA', background: '#FEF2F2',
                                  fontFamily: FONT, fontSize: 12, color: '#991B1B' }}>
        {this.props.label ? `${this.props.label} could not be drawn.` : 'This chart could not be drawn.'}
        {' '}The numbers elsewhere on this page are unaffected.
      </div>
    )
  }
}

/** Shown when a chart's data request fails. Not the same as "no data". */
export function ChartError({ message = 'Chart data could not be loaded.' }: { message?: string }) {
  return (
    <div role="alert" style={{ padding: '18px 14px', border: '1px solid #FECACA', background: '#FEF2F2',
                                fontFamily: FONT, fontSize: 12, color: '#991B1B' }}>
      {message} The figures above are unaffected; try refreshing.
    </div>
  )
}

/** Loading placeholder consistent with the rest of the admin ("Loading…"). */
export function ChartLoading({ height = 200 }: { height?: number }) {
  return (
    <div role="status" style={{ height, display: 'flex', alignItems: 'center', justifyContent: 'center',
                                 border: '1px solid #E8E5E0', background: '#fff',
                                 fontFamily: FONT, fontSize: 12, color: '#6B6B6B' }}>
      Loading…
    </div>
  )
}
