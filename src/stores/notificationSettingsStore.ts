import { create } from 'zustand'
import type { ModelUserSettingsData, ModelUserSettingsNotifications } from '@/client'

interface NotificationSettingsState {
  settings: ModelUserSettingsData
  setSettings: (s: ModelUserSettingsData) => void
  getGuildNotif: (guildId: string) => ModelUserSettingsNotifications | undefined
  getChannelNotif: (channelId: string) => ModelUserSettingsNotifications | undefined
  getUserNotif: (userId: string) => ModelUserSettingsNotifications | undefined
}

export const useNotificationSettingsStore = create<NotificationSettingsState>((set, get) => ({
  settings: {},
  setSettings: (s) => set({ settings: s }),
  getGuildNotif: (guildId) =>
    get().settings.guilds?.find((g) => String(g.guild_id) === guildId)?.notifications,
  getChannelNotif: (channelId) =>
    get().settings.channels?.find((c) => String(c.channel_id) === channelId)?.notifications,
  getUserNotif: (userId) =>
    get().settings.users?.find((u) => String(u.user_id) === userId)?.notifications,
}))
