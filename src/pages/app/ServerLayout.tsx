import { useEffect, useRef } from 'react'
import { Outlet, useParams, useLocation, useNavigate } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { guildApi } from '@/api/client'
import type { DtoChannel } from '@/types'
import ChannelSidebar from '@/components/layout/ChannelSidebar'
import { subscribeGuilds, addPresenceSubscription } from '@/services/wsService'
import { useClientMode } from '@/hooks/useClientMode'
import { useFolderStore } from '@/stores/folderStore'

export interface ServerOutletContext {
  channels: DtoChannel[]
}

export default function ServerLayout() {
  const { serverId } = useParams<{ serverId: string }>()
  const isMobile = useClientMode() === 'mobile'
  const location = useLocation()
  const navigate = useNavigate()
  // On mobile, detect if we're at the channel level by checking URL depth:
  // /app/:serverId → 2 parts → show channel list
  // /app/:serverId/:channelId → 3 parts → show chat
  const parts = location.pathname.split('/').filter(Boolean)
  const hasChannel = parts.length >= 3
  const channelId = parts.length >= 3 ? parts[2] : null

  const selectedChannels = useFolderStore((s) => s.selectedChannels)
  const setSelectedChannel = useFolderStore((s) => s.setSelectedChannel)

  const { data: channels } = useQuery({
    queryKey: ['channels', serverId],
    queryFn: () =>
      guildApi
        .guildGuildIdChannelGet({ guildId: serverId! })
        .then((r) => r.data ?? []),
    enabled: !!serverId,
  })

  // Same key as MemberList — both share the cached result, no duplicate request
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  // Eagerly subscribe to this guild's WS events (op=5, d.guilds) as soon as
  // the serverId is known — before the global userMeGuildsGet() in useWebSocket
  // returns. subscribeGuilds() is idempotent so double-subscribing is harmless.
  useEffect(() => {
    if (serverId) {
      subscribeGuilds([serverId])
    }
  }, [serverId])

  // Subscribe to presence updates for all guild members (op=6, d.add).
  // Done here — not only inside MemberList — so presence events arrive even
  // when the member list panel is closed. addPresenceSubscription is idempotent
  // (skips IDs already in the active set) so MemberList doing the same is fine.
  useEffect(() => {
    if (!members) return
    const ids = members
      .filter((m) => m.user?.id !== undefined)
      .map((m) => String(m.user!.id))
    if (ids.length > 0) {
      addPresenceSubscription(ids)
    }
  }, [members])

  // Auto-navigate to saved channel when opening a guild with no channel in URL.
  // Runs after channels load; only fires when there is no channel already selected.
  useEffect(() => {
    if (!serverId || hasChannel || !channels?.length) return
    const savedChannelId = selectedChannels[serverId]
    if (!savedChannelId) return
    const exists = channels.some((ch) => String(ch.id) === savedChannelId)
    if (exists) {
      navigate(`/app/${serverId}/${savedChannelId}`, { replace: true })
    }
  }, [serverId, hasChannel, channels, selectedChannels, navigate])

  // Persist the selected channel for this guild when the user navigates to a channel.
  // Debounced 1.5 s so rapid channel switches don't trigger unnecessary API calls.
  const saveTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(() => {
    if (!serverId || !channelId) return
    if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    saveTimerRef.current = setTimeout(() => {
      setSelectedChannel(serverId, channelId)
    }, 1500)
    return () => {
      if (saveTimerRef.current) clearTimeout(saveTimerRef.current)
    }
  }, [serverId, channelId, setSelectedChannel])

  const resolvedChannels = channels ?? []

  // Mobile: show only one panel at a time based on URL depth
  if (isMobile) {
    if (hasChannel) {
      // Channel selected → full-screen chat, no sidebar
      return <Outlet context={{ channels: resolvedChannels } satisfies ServerOutletContext} />
    }
    // Server selected, no channel → full-screen channel list
    return <ChannelSidebar channels={resolvedChannels} serverId={serverId!} />
  }

  // Desktop: both side by side
  return (
    <>
      <ChannelSidebar channels={resolvedChannels} serverId={serverId!} />
      <Outlet context={{ channels: resolvedChannels } satisfies ServerOutletContext} />
    </>
  )
}
