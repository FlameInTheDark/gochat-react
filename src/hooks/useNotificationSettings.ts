import { useEffect } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { useTranslation } from 'react-i18next'
import { toast } from 'sonner'
import { userApi } from '@/api/client'
import type { ModelUserSettingsData, ModelUserSettingsNotifications } from '@/client'
import { useNotificationSettingsStore } from '@/stores/notificationSettingsStore'

export function useNotificationSettings() {
  const queryClient = useQueryClient()
  const { t } = useTranslation()

  const { data: settings } = useQuery({
    queryKey: ['user-settings'],
    queryFn: () => userApi.userMeSettingsGet().then((r) => r.data?.settings ?? {}),
    staleTime: 60_000,
  })

  useEffect(() => {
    if (settings) {
      useNotificationSettingsStore.getState().setSettings(settings)
    }
  }, [settings])

  function getGuildNotifications(guildId: string): ModelUserSettingsNotifications | undefined {
    return settings?.guilds?.find((g) => String(g.guild_id) === guildId)?.notifications
  }

  function getChannelNotifications(channelId: string): ModelUserSettingsNotifications | undefined {
    return settings?.channels?.find((c) => String(c.channel_id) === channelId)?.notifications
  }

  function getUserNotifications(userId: string): ModelUserSettingsNotifications | undefined {
    return settings?.users?.find((u) => String(u.user_id) === userId)?.notifications
  }

  async function setGuildNotifications(guildId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const res = await userApi.userMeSettingsGet()
      const existing: ModelUserSettingsData = res.data?.settings ?? {}
      const guilds = existing.guilds ?? []
      const idx = guilds.findIndex((g) => String(g.guild_id) === guildId)
      const updated =
        idx >= 0
          ? guilds.map((g, i) => i === idx ? { ...g, notifications: { ...g.notifications, ...patch } } : g)
          : [...guilds, { guild_id: Number(guildId), notifications: patch }]
      await userApi.userMeSettingsPost({ request: { ...existing, guilds: updated } })
      await queryClient.invalidateQueries({ queryKey: ['user-settings'] })
    } catch {
      toast.error(t('notifications.saveFailed'))
    }
  }

  async function setChannelNotifications(channelId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const res = await userApi.userMeSettingsGet()
      const existing: ModelUserSettingsData = res.data?.settings ?? {}
      const channels = existing.channels ?? []
      const idx = channels.findIndex((c) => String(c.channel_id) === channelId)
      const updated =
        idx >= 0
          ? channels.map((c, i) => i === idx ? { ...c, notifications: { ...c.notifications, ...patch } } : c)
          : [...channels, { channel_id: Number(channelId), notifications: patch }]
      await userApi.userMeSettingsPost({ request: { ...existing, channels: updated } })
      await queryClient.invalidateQueries({ queryKey: ['user-settings'] })
    } catch {
      toast.error(t('notifications.saveFailed'))
    }
  }

  async function setUserNotifications(userId: string, patch: Partial<ModelUserSettingsNotifications>) {
    try {
      const res = await userApi.userMeSettingsGet()
      const existing: ModelUserSettingsData = res.data?.settings ?? {}
      const users = existing.users ?? []
      const idx = users.findIndex((u) => String(u.user_id) === userId)
      const updated =
        idx >= 0
          ? users.map((u, i) => i === idx ? { ...u, notifications: { ...u.notifications, ...patch } } : u)
          : [...users, { user_id: Number(userId), notifications: patch }]
      await userApi.userMeSettingsPost({ request: { ...existing, users: updated } })
      await queryClient.invalidateQueries({ queryKey: ['user-settings'] })
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
