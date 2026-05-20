import { beforeEach, describe, expect, it } from 'vitest'
import { useReadStateStore } from './readStateStore'
import { useUnreadStore } from './unreadStore'
import type { UserUserSettingsResponse } from '@/client'

describe('readStateStore', () => {
  beforeEach(() => {
    useReadStateStore.setState({
      readStates: {},
      lastMessages: {},
    })
    useUnreadStore.setState({
      channels: new Map(),
    })
  })

  it('associates unread joined threads with their guild from settings', () => {
    useReadStateStore.getState().setFromSettings({
      read_states: {
        '10': 100,
      },
      threads_last_messages: {
        '10': 200,
      },
      joined_threads: {
        '1': {
          '5': [10],
        },
      },
    } as unknown as UserUserSettingsResponse)

    expect(useUnreadStore.getState().channels.get('10')).toEqual({ guildId: '1' })
  })

  it('ignores zero last-message entries from settings', () => {
    useReadStateStore.getState().setFromSettings({
      guilds_last_messages: {
        '1': {
          '10': 0,
        },
      },
      threads_last_messages: {
        '20': 0,
      },
    } as unknown as UserUserSettingsResponse)

    expect(useReadStateStore.getState().lastMessages).toEqual({})
    expect(useUnreadStore.getState().channels.size).toBe(0)
  })
})
