import { useEffect } from 'react'
import { Outlet, useParams, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { guildApi } from '@/api/client'
import type { DtoChannel } from '@/types'
import ChannelSidebar from '@/components/layout/ChannelSidebar'
import { subscribeGuilds, addPresenceSubscription } from '@/services/wsService'
import { useClientMode } from '@/hooks/useClientMode'

export interface ServerOutletContext {
  channels: DtoChannel[]
}

export default function ServerLayout() {
  const { serverId } = useParams<{ serverId: string }>()
  const isMobile = useClientMode() === 'mobile'
  const location = useLocation()
  // On mobile, detect if we're at the channel level by checking URL depth:
  // /app/:serverId → 2 parts → show channel list
  // /app/:serverId/:channelId → 3 parts → show chat
  const parts = location.pathname.split('/').filter(Boolean)
  const hasChannel = parts.length >= 3

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
