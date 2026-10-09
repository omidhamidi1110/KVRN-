// Pure sizing rules for the Admin live-preview frame (no DOM, unit-testable).
//
// Problem this solves: the preview used to render the storefront at the width of the editor
// column (often 500–700px), so "Desktop" actually showed the tablet layout and nothing matched the
// real site. The frame now renders at a REAL device width and is scaled down to fit the column,
// so breakpoints, spacing and type are the production ones. Scaling is presentation only.

export type PreviewMode = 'desktop' | 'mobile'

export const DESKTOP_WIDTHS = [1280, 1440, 1024] as const
export const MOBILE_WIDTHS = [320, 360, 375, 390, 414, 430] as const
export const DEFAULT_DESKTOP_WIDTH = 1280
export const DEFAULT_MOBILE_WIDTH = 390
export const MIN_SCALE = 0.25

/** Largest scale <= 1 that makes a `deviceWidth` frame fit `paneWidth`. Never upscales. */
export function fitScale(paneWidth: number, deviceWidth: number): number {
  if (!Number.isFinite(paneWidth) || !Number.isFinite(deviceWidth) || paneWidth <= 0 || deviceWidth <= 0) return 1
  return Math.max(MIN_SCALE, Math.min(1, Math.floor((paneWidth / deviceWidth) * 1000) / 1000))
}

export type FrameGeometry = {
  /** CSS width of the iframe (the real device width). */
  frameWidth: number
  /** CSS height of the iframe in its own (unscaled) pixels, so that, once scaled, it fills the pane. */
  frameHeight: number
  scale: number
  /** Size of the clipping box that holds the scaled frame. */
  boxWidth: number
  boxHeight: number
}

export function frameGeometry(opts: { mode: PreviewMode; paneWidth: number; paneHeight: number; deviceWidth: number }): FrameGeometry {
  const deviceWidth = Math.round(opts.deviceWidth)
  const scale = fitScale(opts.paneWidth, deviceWidth)
  const paneHeight = Math.max(320, Math.round(opts.paneHeight))
  return {
    frameWidth: deviceWidth,
    frameHeight: Math.round(paneHeight / scale),
    scale,
    boxWidth: Math.round(deviceWidth * scale),
    boxHeight: paneHeight,
  }
}

export function isAllowedDeviceWidth(mode: PreviewMode, w: number): boolean {
  return (mode === 'mobile' ? (MOBILE_WIDTHS as readonly number[]) : (DESKTOP_WIDTHS as readonly number[])).includes(w)
}
