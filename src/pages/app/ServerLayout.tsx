import { useEffect } from 'react'
import { Outlet, useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { guildApi } from '@/api/client'
import type { DtoChannel } from '@/types'
import ChannelSidebar from '@/components/layout/ChannelSidebar'
import { subscribeGuilds, addPresenceSubscription } from '@/services/wsService'

export interface ServerOutletContext {
  channels: DtoChannel[]
}

export default function ServerLayout() {
  const { serverId } = useParams<{ serverId: string }>()

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

  return (
    <>
      <ChannelSidebar channels={resolvedChannels} serverId={serverId!} />
      <Outlet context={{ channels: resolvedChannels } satisfies ServerOutletContext} />
    </>
  )
}
