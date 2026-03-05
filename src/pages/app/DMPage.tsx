import { useEffect, useMemo } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { subscribeChannel } from '@/services/wsService'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import { useMessagePagination } from '@/hooks/useMessagePagination'
import { userApi } from '@/api/client'
import { ChannelType } from '@/types'

export default function DMPage() {
  // NOTE: the route param is named :userId but by the time we land here the
  // navigation target is the DM *channel* ID returned by the friends API.
  const { userId: channelId } = useParams<{ userId: string }>()

  const {
    messages, isLoading, isLoadingOlder, isLoadingNewer,
    endReached, latestReached, unreadSeparatorAfter,
    loadOlder, loadNewer, ackLatest,
  } = useMessagePagination(channelId)

  // Subscribe to real-time messages for this DM channel (op=5, d.channel).
  useEffect(() => {
    if (channelId) subscribeChannel(channelId)
  }, [channelId])

  // Fetch DM channel info to get participant details
  const { data: dmChannel } = useQuery({
    queryKey: ['dm-channel', channelId],
    queryFn: async () => {
      if (!channelId) return null
      const res = await userApi.userMeChannelsGet()
      return res.data?.find((ch) => String(ch.id) === channelId) ?? null
    },
    enabled: !!channelId,
  })

  // For 1-on-1 DMs, fetch the participant's user info
  const isGroupDm = dmChannel?.type === ChannelType.ChannelTypeGroupDM
  const participantId = !isGroupDm && dmChannel?.participant_id
    ? String(dmChannel.participant_id)
    : null

  const { data: participantUser } = useQuery({
    queryKey: ['user', participantId],
    queryFn: async () => {
      if (!participantId) return null
      const res = await userApi.userUserIdGet({ userId: participantId })
      return res.data ?? null
    },
    enabled: !!participantId,
    staleTime: 5 * 60 * 1000,
  })

  // Determine the display name for the input placeholder
  const displayName = useMemo(() => {
    if (isGroupDm) {
      return dmChannel?.name ?? 'Group'
    }
    const name = participantUser?.name ?? dmChannel?.name ?? channelId
    return `@${name}`
  }, [isGroupDm, dmChannel?.name, participantUser?.name, channelId])

  if (!channelId) return null

  return (
    <div className="flex flex-col flex-1 min-h-0">
      <MessageList
        messages={messages}
        isLoading={isLoading}
        isLoadingOlder={isLoadingOlder}
        isLoadingNewer={isLoadingNewer}
        endReached={endReached}
        latestReached={latestReached}
        unreadSeparatorAfter={unreadSeparatorAfter}
        onLoadOlder={loadOlder}
        onLoadNewer={loadNewer}
        onAckLatest={ackLatest}
      />
      <MessageInput channelId={channelId} channelName={displayName} />
    </div>
  )
}
