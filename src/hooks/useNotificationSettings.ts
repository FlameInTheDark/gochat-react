import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { userApi } from '@/api/client'
import type { ModelUserSettingsData, ModelUserSettingsNotifications } from '@/client'
import { useNotificationSettingsStore } from '@/stores/notificationSettingsStore'
import { saveSettings } from '@/lib/settingsApi'

export function useNotificationSettings() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  // Select only the notification-relevant slices so components using this hook
  // don't re-render when unrelated settings (voice, appearance, etc.) change.
  // TanStack Query's structural sharing preserves array references when they
  // haven't changed, so the selected value stays stable.
  const { data: notifSlice } = useQuery({
    queryKey: ['user-settings'],
    queryFn: () => userApi.userMeSettingsGet().then((r) => r.data?.settings ?? {}),
    select: (data) => ({
      guilds: data?.guilds,
      channels: data?.channels,
      users: data?.users,
    }),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (notifSlice) {
      useNotificationSettingsStore.getState().setSettings(notifSlice)
    }
  }, [notifSlice])

  function getGuildNotifications(guildId: string): ModelUserSettingsNotifications | undefined {
    return notifSlice?.guilds?.find((g) => String(g.guild_id) === guildId)?.notifications
  }

  function getChannelNotifications(channelId: string): ModelUserSettingsNotifications | undefined {
    return notifSlice?.channels?.find((c) => String(c.channel_id) === channelId)?.notifications
  }

  function getUserNotifications(userId: string): ModelUserSettingsNotifications | undefined {
    return notifSlice?.users?.find((u) => String(u.user_id) === userId)?.notifications
  }

  async function setGuildNotifications(guildId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const existing: ModelUserSettingsData = queryClient.getQueryData<ModelUserSettingsData>(['user-settings']) ?? {}
      const guilds = existing.guilds ?? []
      const idx = guilds.findIndex((g) => String(g.guild_id) === guildId)
      const updated =
        idx >= 0
          ? guilds.map((g, i) => i === idx ? { ...g, notifications: { ...g.notifications, ...patch } } : g)
          : [...guilds, { guild_id: Number(guildId), notifications: patch }]
      await saveSettings({ guilds: updated })
    } catch {
      toast.error(t('notifications.saveFailed'))
    }
  }

  async function setChannelNotifications(channelId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const existing: ModelUserSettingsData = queryClient.getQueryData<ModelUserSettingsData>(['user-settings']) ?? {}
      const channels = existing.channels ?? []
      const idx = channels.findIndex((c) => String(c.channel_id) === channelId)
      const updated =
        idx >= 0
          ? channels.map((c, i) => i === idx ? { ...c, notifications: { ...c.notifications, ...patch } } : c)
          : [...channels, { channel_id: Number(channelId), notifications: patch }]
      await saveSettings({ channels: updated })
    } catch {
      toast.error(t('notifications.saveFailed'))
    }
  }

  async function setUserNotifications(userId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const existing: ModelUserSettingsData = queryClient.getQueryData<ModelUserSettingsData>(['user-settings']) ?? {}
      const users = existing.users ?? []
      const idx = users.findIndex((u) => String(u.user_id) === userId)
      const updated =
        idx >= 0
          ? users.map((u, i) => i === idx ? { ...u, notifications: { ...u.notifications, ...patch } } : u)
          : [...users, { user_id: Number(userId), notifications: patch }]
      await saveSettings({ users: updated })
    } catch {
      toast.error(t('notifications.saveFailed'))
    }
  }

  return {
    getGuildNotifications,
    getChannelNotifications,
    getUserNotifications,
    setGuildNotifications,
    setChannelNotifications,
    setUserNotifications,
  }
}
