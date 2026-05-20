import { beforeEach, describe, expect, it } from 'vitest'
import { useUnreadStore } from './unreadStore'

describe('unreadStore', () => {
  beforeEach(() => {
    useUnreadStore.setState({ channels: new Map() })
  })

  it('prunes unread entries for channels no longer visible in a guild', () => {
    const store = useUnreadStore.getState()
    store.markUnread('10', '1')
    store.markUnread('11', '1')
    store.markUnread('20', '2')
    store.markUnread('30', null)

    store.pruneGuildChannels('1', new Set(['10']))

    expect(useUnreadStore.getState().channels.has('10')).toBe(true)
    expect(useUnreadStore.getState().channels.has('11')).toBe(false)
    expect(useUnreadStore.getState().channels.has('20')).toBe(true)
    expect(useUnreadStore.getState().channels.has('30')).toBe(true)
  })
})
