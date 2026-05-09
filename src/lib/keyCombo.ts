export type KeyComboEvent = Pick<KeyboardEvent, 'code' | 'ctrlKey' | 'altKey' | 'shiftKey' | 'metaKey'>

const MODIFIER_TOKENS = new Map<string, 'Ctrl' | 'Alt' | 'Shift' | 'Meta'>([
  ['ctrl', 'Ctrl'],
  ['control', 'Ctrl'],
  ['alt', 'Alt'],
  ['shift', 'Shift'],
  ['meta', 'Meta'],
  ['cmd', 'Meta'],
  ['command', 'Meta'],
  ['win', 'Meta'],
])

const MODIFIER_CODES = new Set([
  'ControlLeft',
  'ControlRight',
  'AltLeft',
  'AltRight',
  'ShiftLeft',
  'ShiftRight',
  'MetaLeft',
  'MetaRight',
])

const DISPLAY_CODE_MAP: Record<string, string> = {
  Space: 'Space',
  Tab: 'Tab',
  CapsLock: 'Caps Lock',
  Enter: 'Enter',
  Escape: 'Esc',
  Backspace: 'Backspace',
  Delete: 'Delete',
  Insert: 'Insert',
  Home: 'Home',
  End: 'End',
  PageUp: 'Page Up',
  PageDown: 'Page Down',
  ArrowUp: 'Arrow Up',
  ArrowDown: 'Arrow Down',
  ArrowLeft: 'Arrow Left',
  ArrowRight: 'Arrow Right',
  Backquote: '`',
  Minus: '-',
  Equal: '=',
  BracketLeft: '[',
  BracketRight: ']',
  Backslash: '\\',
  Semicolon: ';',
  Quote: "'",
  Comma: ',',
  Period: '.',
  Slash: '/',
}

export function isModifierOnlyCode(code: string): boolean {
  return MODIFIER_CODES.has(code)
}

export function normalizeKeyCombo(value: string | null | undefined): string {
  if (!value) return ''

  const tokens = value.split('+').map((token) => token.trim()).filter(Boolean)
  const modifiers = new Set<'Ctrl' | 'Alt' | 'Shift' | 'Meta'>()
  let code = ''

  for (const token of tokens) {
    const modifier = MODIFIER_TOKENS.get(token.toLowerCase())
    if (modifier) {
      modifiers.add(modifier)
    } else {
      code = token
    }
  }

  if (!code) return ''

  return [
    modifiers.has('Ctrl') ? 'Ctrl' : '',
    modifiers.has('Alt') ? 'Alt' : '',
    modifiers.has('Shift') ? 'Shift' : '',
    modifiers.has('Meta') ? 'Meta' : '',
    code,
  ].filter(Boolean).join('+')
}

export function eventToKeyCombo(event: KeyComboEvent): string {
  if (!event.code || isModifierOnlyCode(event.code)) return ''

  return normalizeKeyCombo([
    event.ctrlKey ? 'Ctrl' : '',
    event.altKey ? 'Alt' : '',
    event.shiftKey ? 'Shift' : '',
    event.metaKey ? 'Meta' : '',
    event.code,
  ].filter(Boolean).join('+'))
}

export function keyComboMatchesEvent(combo: string, event: KeyComboEvent): boolean {
  return normalizeKeyCombo(combo) === eventToKeyCombo(event)
}

export function pressedKeysMatchCombo(combo: string, pressedCodes: ReadonlySet<string>): boolean {
  const normalized = normalizeKeyCombo(combo)
  if (!normalized) return false

  const parts = normalized.split('+')
  const code = parts[parts.length - 1]
  const requiresCtrl = parts.includes('Ctrl')
  const requiresAlt = parts.includes('Alt')
  const requiresShift = parts.includes('Shift')
  const requiresMeta = parts.includes('Meta')

  const hasCtrl = pressedCodes.has('ControlLeft') || pressedCodes.has('ControlRight')
  const hasAlt = pressedCodes.has('AltLeft') || pressedCodes.has('AltRight')
  const hasShift = pressedCodes.has('ShiftLeft') || pressedCodes.has('ShiftRight')
  const hasMeta = pressedCodes.has('MetaLeft') || pressedCodes.has('MetaRight')

  return pressedCodes.has(code)
    && hasCtrl === requiresCtrl
    && hasAlt === requiresAlt
    && hasShift === requiresShift
    && hasMeta === requiresMeta
}

function formatKeyCode(code: string): string {
  if (code.startsWith('Key')) return code.slice(3).toUpperCase()
  if (code.startsWith('Digit')) return code.slice(5)
  if (code.startsWith('Numpad')) return `Num ${code.slice(6)}`
  if (code.startsWith('F') && /^F\d{1,2}$/.test(code)) return code
  return DISPLAY_CODE_MAP[code] ?? code
}

export function formatKeyCombo(combo: string): string {
  const normalized = normalizeKeyCombo(combo)
  if (!normalized) return ''

  return normalized.split('+').map((part) => (
    part === 'Ctrl' || part === 'Alt' || part === 'Shift' || part === 'Meta'
      ? part
      : formatKeyCode(part)
  )).join(' + ')
}
