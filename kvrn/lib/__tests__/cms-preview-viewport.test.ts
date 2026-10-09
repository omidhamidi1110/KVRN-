import { fitScale, frameGeometry, isAllowedDeviceWidth, MIN_SCALE } from '@/lib/cms-preview-viewport'

describe('CMS preview viewport sizing', () => {
  test('never upscales and scales a 1280 desktop into a 640 column', () => {
    expect(fitScale(2000, 1280)).toBe(1)
    expect(fitScale(640, 1280)).toBe(0.5)
  })
  test('bad input degrades to 1, tiny panes clamp to MIN_SCALE', () => {
    expect(fitScale(0, 1280)).toBe(1)
    expect(fitScale(NaN, 1280)).toBe(1)
    expect(fitScale(100, 1280)).toBe(MIN_SCALE)
  })
  test('geometry: scaled frame fills the pane height and box matches the scaled width', () => {
    const g = frameGeometry({ mode: 'desktop', paneWidth: 640, paneHeight: 700, deviceWidth: 1280 })
    expect(g).toMatchObject({ frameWidth: 1280, scale: 0.5, boxWidth: 640, boxHeight: 700, frameHeight: 1400 })
  })
  test('mobile device inside a wide pane stays 1:1 and centred (box = device width)', () => {
    const g = frameGeometry({ mode: 'mobile', paneWidth: 700, paneHeight: 800, deviceWidth: 390 })
    expect(g).toMatchObject({ frameWidth: 390, scale: 1, boxWidth: 390, frameHeight: 800 })
  })
  test('allowed widths per mode', () => {
    expect(isAllowedDeviceWidth('mobile', 390)).toBe(true)
    expect(isAllowedDeviceWidth('mobile', 1280)).toBe(false)
    expect(isAllowedDeviceWidth('desktop', 1280)).toBe(true)
  })
})
