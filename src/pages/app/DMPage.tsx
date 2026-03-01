import { useEffect } from 'react'
import { useParams } from 'react-router-dom'
import { subscribeChannel } from '@/services/wsService'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import { useMessagePagination } from '@/hooks/useMessagePagination'

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
      <MessageInput channelId={channelId} />
    </div>
  )
}
