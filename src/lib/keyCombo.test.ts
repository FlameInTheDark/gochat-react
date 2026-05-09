import { describe, expect, it } from 'vitest'
import { eventToKeyCombo, formatKeyCombo, keyComboMatchesEvent, normalizeKeyCombo, pressedKeysMatchCombo } from '@/lib/keyCombo'

describe('keyCombo', () => {
  it('captures non-modifier keys with active modifiers in a stable order', () => {
    expect(eventToKeyCombo({
      code: 'KeyQ',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    })).toBe('Alt+KeyQ')

    expect(eventToKeyCombo({
      code: 'Space',
      ctrlKey: true,
      altKey: false,
      shiftKey: true,
      metaKey: false,
    })).toBe('Ctrl+Shift+Space')
  })

  it('ignores modifier-only capture events', () => {
    expect(eventToKeyCombo({
      code: 'AltLeft',
      ctrlKey: false,
      altKey: true,
      shiftKey: false,
      metaKey: false,
    })).toBe('')
  })

  it('normalizes aliases and formats saved combos for display', () => {
    expect(normalizeKeyCombo('Control+Alt+KeyQ')).toBe('Ctrl+Alt+KeyQ')
    expect(formatKeyCombo('Ctrl+Alt+KeyQ')).toBe('Ctrl + Alt + Q')
    expect(formatKeyCombo('Shift+Space')).toBe('Shift + Space')
  })

  it('matches exact keydown modifiers and exact pressed modifier state', () => {
    const keyQ = { code: 'KeyQ', ctrlKey: false, altKey: true, shiftKey: false, metaKey: false }

    expect(keyComboMatchesEvent('Alt+KeyQ', keyQ)).toBe(true)
    expect(keyComboMatchesEvent('Ctrl+Alt+KeyQ', keyQ)).toBe(false)

    expect(pressedKeysMatchCombo('Alt+KeyQ', new Set(['AltLeft', 'KeyQ']))).toBe(true)
    expect(pressedKeysMatchCombo('Alt+KeyQ', new Set(['ControlLeft', 'AltLeft', 'KeyQ']))).toBe(false)
  })
})
