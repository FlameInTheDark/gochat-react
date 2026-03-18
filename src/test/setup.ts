import '@testing-library/jest-dom/vitest'
import { afterEach, vi } from 'vitest'
import { cleanup } from '@testing-library/react'

function parsePixels(value: string | null | undefined) {
  if (!value) return 0
  const parsed = Number.parseFloat(value)
  return Number.isFinite(parsed) ? parsed : 0
}

function getDimension(element: HTMLElement, datasetKey: string, styleKey: 'height' | 'width') {
  const datasetValue = element.dataset[datasetKey]
  if (datasetValue) {
    const parsed = Number.parseFloat(datasetValue)
    if (Number.isFinite(parsed)) {
      return parsed
    }
  }

  const inlineValue = parsePixels(element.style[styleKey])
  if (inlineValue > 0) {
    return inlineValue
  }

  if (styleKey === 'height') {
    return Array.from(element.children).reduce((sum, child) => {
      if (!(child instanceof HTMLElement)) {
        return sum
      }
      return sum + child.offsetHeight
    }, 0)
  }

  return Array.from(element.children).reduce((max, child) => {
    if (!(child instanceof HTMLElement)) {
      return max
    }
    return Math.max(max, child.offsetWidth)
  }, 0)
}

Object.defineProperties(HTMLElement.prototype, {
  offsetHeight: {
    configurable: true,
    get() {
      return getDimension(this as HTMLElement, 'testHeight', 'height')
    },
  },
  offsetWidth: {
    configurable: true,
    get() {
      return getDimension(this as HTMLElement, 'testWidth', 'width')
    },
  },
  clientHeight: {
    configurable: true,
    get() {
      return getDimension(this as HTMLElement, 'testClientHeight', 'height')
    },
  },
  clientWidth: {
    configurable: true,
    get() {
      return getDimension(this as HTMLElement, 'testClientWidth', 'width')
    },
  },
})

if (!HTMLElement.prototype.scrollTo) {
  HTMLElement.prototype.scrollTo = function scrollTo(
    optionsOrX?: ScrollToOptions | number,
    y?: number,
  ) {
    if (typeof optionsOrX === 'number') {
      this.scrollLeft = optionsOrX
      this.scrollTop = y ?? 0
      return
    }

    if (optionsOrX?.left != null) {
      this.scrollLeft = optionsOrX.left
    }
    if (optionsOrX?.top != null) {
      this.scrollTop = optionsOrX.top
    }
  }
}

class ResizeObserverMock implements ResizeObserver {
  constructor(private readonly callback: ResizeObserverCallback) {}

  observe = (target: Element) => {
    this.callback([
      {
        target,
        contentRect: {
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          bottom: (target as HTMLElement).offsetHeight,
          right: (target as HTMLElement).offsetWidth,
          width: (target as HTMLElement).offsetWidth,
          height: (target as HTMLElement).offsetHeight,
          toJSON: () => ({}),
        },
        borderBoxSize: [
          {
            blockSize: (target as HTMLElement).offsetHeight,
            inlineSize: (target as HTMLElement).offsetWidth,
          },
        ],
        contentBoxSize: [
          {
            blockSize: (target as HTMLElement).offsetHeight,
            inlineSize: (target as HTMLElement).offsetWidth,
          },
        ],
        devicePixelContentBoxSize: [],
      } as ResizeObserverEntry,
    ], this)
  }

  unobserve = () => {}

  disconnect = () => {}

  takeRecords = () => []
}

vi.stubGlobal('ResizeObserver', ResizeObserverMock)

afterEach(() => {
  cleanup()
})
