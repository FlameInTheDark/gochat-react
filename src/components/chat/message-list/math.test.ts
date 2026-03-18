import { describe, expect, it } from 'vitest'
import {
  buildMeasurements,
  getAnchorIndex,
  getOffsetForAlignment,
  getVisibleRange,
  isAtBottomPosition,
} from './math'

describe('dynamic message list math', () => {
  it('builds offsets using cached heights when present', () => {
    const items = [
      { key: 'a' },
      { key: 'b' },
      { key: 'c' },
    ]
    const measurements = buildMeasurements(
      items,
      new Map([
        ['b', 72],
      ]),
      () => 40,
    )

    expect(measurements.sizes).toEqual([40, 72, 40])
    expect(measurements.offsets).toEqual([0, 40, 112])
    expect(measurements.totalHeight).toBe(152)
  })

  it('computes visible ranges and preserves about two viewports of overscan around them', () => {
    const measurements = {
      offsets: [0, 40, 80, 120, 160, 200, 240, 280],
      sizes: [40, 40, 40, 40, 40, 40, 40, 40],
      totalHeight: 320,
    }

    const range = getVisibleRange(
      measurements,
      8,
      45,
      70,
      0,
      1,
      1,
    )

    expect(range).toEqual({
      overscanStartIndex: 0,
      overscanStopIndex: 6,
      visibleStartIndex: 1,
      visibleStopIndex: 2,
    })
  })

  it('anchors to the bottom visible item while scrolling backward', () => {
    expect(getAnchorIndex({
      overscanStartIndex: 0,
      overscanStopIndex: 4,
      visibleStartIndex: 1,
      visibleStopIndex: 3,
    }, 'backward', 5)).toBe(3)

    expect(getAnchorIndex({
      overscanStartIndex: 0,
      overscanStopIndex: 4,
      visibleStartIndex: 1,
      visibleStopIndex: 3,
    }, 'forward', 5)).toBe(1)
  })

  it('aligns centered targets using measured offsets', () => {
    const measurements = {
      offsets: [0, 60, 160],
      sizes: [60, 100, 80],
      totalHeight: 240,
    }

    const offset = getOffsetForAlignment(
      measurements,
      1,
      'center',
      0,
      120,
      0,
      256,
    )

    expect(offset).toBe(50)
  })

  it('detects when the viewport is at the bottom threshold', () => {
    expect(isAtBottomPosition(540, 260, 820, 24)).toBe(true)
    expect(isAtBottomPosition(480, 260, 820, 24)).toBe(false)
  })
})
