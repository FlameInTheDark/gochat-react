import { create } from 'zustand'

interface TypingUser {
  name: string
}

interface TypingState {
  /** Record<channelId, Record<userId, TypingUser>> */
  typing: Record<string, Record<string, TypingUser>>
  startTyping: (channelId: string, userId: string, name: string) => void
  stopTyping: (channelId: string, userId: string) => void
  /** Returns display names of users currently typing in a channel. */
  getTypingUsers: (channelId: string) => string[]
}

// ── Module-level expiry timers (kept outside Zustand to avoid re-renders) ─────
const timers = new Map<string, ReturnType<typeof setTimeout>>()

const TYPING_EXPIRE_MS = 7_000

function timerKey(channelId: string, userId: string): string {
  return `${channelId}:${userId}`
}

export const useTypingStore = create<TypingState>((set, get) => ({
  typing: {},

  startTyping: (channelId, userId, name) => {
    const key = timerKey(channelId, userId)

    // Reset the expiry timer
    const existing = timers.get(key)
    if (existing) clearTimeout(existing)
    timers.set(
      key,
      setTimeout(() => {
        timers.delete(key)
        get().stopTyping(channelId, userId)
      }, TYPING_EXPIRE_MS),
    )

    // Only update Zustand state if the user isn't already tracked
    const { typing } = get()
    const channelEntry = typing[channelId] ?? {}
    if (channelId in typing && userId in channelEntry && channelEntry[userId].name === name) {
      return // Already tracked — timer was reset above, no render needed
    }

    set({
      typing: {
        ...typing,
        [channelId]: { ...channelEntry, [userId]: { name } },
      },
    })
  },

  stopTyping: (channelId, userId) => {
    const key = timerKey(channelId, userId)
    const existing = timers.get(key)
    if (existing) {
      clearTimeout(existing)
      timers.delete(key)
    }

    const { typing } = get()
    const channelEntry = typing[channelId]
    if (!channelEntry || !(userId in channelEntry)) return

    const nextEntry = { ...channelEntry }
    delete nextEntry[userId]

    if (Object.keys(nextEntry).length === 0) {
      const nextTyping = { ...typing }
      delete nextTyping[channelId]
      set({ typing: nextTyping })
    } else {
      set({ typing: { ...typing, [channelId]: nextEntry } })
    }
  },

  getTypingUsers: (channelId) => {
    const entry = get().typing[channelId]
    if (!entry) return []
    return Object.values(entry).map((u) => u.name)
  },
}))
