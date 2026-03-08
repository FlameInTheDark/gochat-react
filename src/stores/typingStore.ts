import { create } from 'zustand'

const TYPING_TIMEOUT_MS = 6000

export interface TypingUser {
  userId: string
  username: string
  expiresAt: number
}

interface TypingState {
  typingUsers: Record<string, TypingUser[]> // keyed by channelId
  timers: Record<string, ReturnType<typeof setTimeout>> // key: "userId:channelId"
  startTyping: (channelId: string, userId: string, username: string) => void
  stopTyping: (channelId: string, userId: string) => void
  getTypingUsers: (channelId: string) => TypingUser[]
}

export const useTypingStore = create<TypingState>((set, get) => ({
  typingUsers: {},
  timers: {},

  startTyping: (channelId, userId, username) => {
    const key = `${userId}:${channelId}`

    // Clear any existing auto-expiry timer for this user+channel
    const existing = get().timers[key]
    if (existing !== undefined) clearTimeout(existing)

    // Schedule auto-removal after timeout
    const timer = setTimeout(() => {
      get().stopTyping(channelId, userId)
    }, TYPING_TIMEOUT_MS)

    set((state) => {
      const prev = state.typingUsers[channelId] ?? []
      const filtered = prev.filter((u) => u.userId !== userId)
      return {
        typingUsers: {
          ...state.typingUsers,
          [channelId]: [
            ...filtered,
            { userId, username, expiresAt: Date.now() + TYPING_TIMEOUT_MS },
          ],
        },
        timers: { ...state.timers, [key]: timer },
      }
    })
  },

  stopTyping: (channelId, userId) => {
    const key = `${userId}:${channelId}`
    const timer = get().timers[key]
    if (timer !== undefined) clearTimeout(timer)

    set((state) => {
      const prev = state.typingUsers[channelId] ?? []
      const updated = prev.filter((u) => u.userId !== userId)
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const { [key]: _removed, ...restTimers } = state.timers
      return {
        typingUsers: { ...state.typingUsers, [channelId]: updated },
        timers: restTimers,
      }
    })
  },

  getTypingUsers: (channelId) => {
    const now = Date.now()
    return (get().typingUsers[channelId] ?? []).filter((u) => u.expiresAt > now)
  },
}))
