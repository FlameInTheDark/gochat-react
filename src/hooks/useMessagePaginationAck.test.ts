import { describe, expect, it } from 'vitest'
import { resolveAckMessageId } from './useMessagePagination'

describe('resolveAckMessageId', () => {
  it('uses the newest known message when the loaded latest is older', () => {
    expect(resolveAckMessageId('200', '300')).toBe('300')
  })

  it('uses the loaded message when it is newer than the cached latest pointer', () => {
    expect(resolveAckMessageId('400', '300')).toBe('400')
  })
})
