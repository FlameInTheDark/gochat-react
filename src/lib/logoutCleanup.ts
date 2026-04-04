import { useAuthStore } from '@/stores/authStore'
import { useMessageStore } from '@/stores/messageStore'
import { useVoiceStore } from '@/stores/voiceStore'
import { usePresenceStore } from '@/stores/presenceStore'
import { useUnreadStore } from '@/stores/unreadStore'
import { useReadStateStore } from '@/stores/readStateStore'
import { useEmojiStore } from '@/stores/emojiStore'
import { useTypingStore } from '@/stores/typingStore'
import { useMentionStore } from '@/stores/mentionStore'
import { useNotificationSettingsStore } from '@/stores/notificationSettingsStore'
import { useFolderStore } from '@/stores/folderStore'
import { useGifStore } from '@/stores/gifStore'
import { queryClient } from '@/lib/queryClient'

/**
 * Clears all user-specific state from every in-memory store and the query
 * cache, then removes auth tokens.  Call this instead of
 * authStore.logout() directly so that a subsequent login by a different
 * account never sees stale data from the previous session.
 */
export function performLogout(): void {
  // Clear tokens + user identity first
  useAuthStore.getState().logout()

  // Wipe the TanStack Query cache (guilds, channels, friends, etc.)
  queryClient.clear()

  // Reset every in-memory store that holds user-specific data
  useMessageStore.setState({ messages: {}, pendingMessages: {}, messageRowKeys: {} })
  useVoiceStore.getState().reset()
  usePresenceStore.getState().clearAll()
  useUnreadStore.setState({ channels: new Map() })
  useReadStateStore.setState({ readStates: {}, lastMessages: {} })
  useEmojiStore.setState({ guildEmojis: {} })
  useTypingStore.setState({ typingUsers: {}, timers: {} })
  useMentionStore.setState({ mentions: {} })
  useNotificationSettingsStore.setState({ settings: {} })
  useFolderStore.setState({ folders: [], itemOrder: [], settingsVersion: 0, selectedChannels: {} })
  useGifStore.setState({ favoriteGifs: [], contentHosts: [] })
}
