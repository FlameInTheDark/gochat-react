import { useState, useEffect, useMemo, useCallback } from 'react'
import { useParams, useOutletContext, useNavigate, useLocation } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Hash, Volume2, MicOff, Users, Search } from 'lucide-react'
import { Separator } from '@/components/ui/separator'
import { guildApi, rolesApi } from '@/api/client'
import { useVoiceStore } from '@/stores/voiceStore'
import { ChannelType } from '@/types'
import type { ServerOutletContext } from './ServerLayout'
import type { MentionResolver } from '@/lib/messageParser'
import MessageList from '@/components/chat/MessageList'
import MessageInput from '@/components/chat/MessageInput'
import MemberList from '@/components/layout/MemberList'
import SearchPanel from '@/components/chat/SearchPanel'
import { subscribeChannel } from '@/services/wsService'
import { useUiStore } from '@/stores/uiStore'
import TypingIndicator from '@/components/chat/TypingIndicator'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { useMessagePagination } from '@/hooks/useMessagePagination'

export default function ChannelPage() {
  const { channelId, serverId } = useParams<{ channelId: string; serverId: string }>()
  const { channels } = useOutletContext<ServerOutletContext>()
  const channel = channels.find((c) => String(c.id) === channelId)
  const isVoice = channel?.type === ChannelType.ChannelTypeGuildVoice

  const navigate = useNavigate()
  const location = useLocation()

  const [showMembers, setShowMembers] = useState(true)
  const [showSearch, setShowSearch] = useState(false)

  // Jump-to-message from search.
  //
  // Strategy: read the ID from route state once, immediately clear the route
  // state (prevents replay on back-navigation / refresh), but persist the ID
  // in local state so it survives the state-clear and remains available for
  // MessageList to highlight the message AFTER the async load completes.
  // Auto-clear after 3 s (animation is 2.5 s) so new arrivals don't re-scroll.
  const jumpIdFromState =
    (location.state as { jumpToMessageId?: string } | null)?.jumpToMessageId

  const [jumpToMessageId, setJumpToMessageId] = useState<string | undefined>(
    jumpIdFromState,
  )

  // Capture a new jump from route state and clear the route state.
  useEffect(() => {
    if (!jumpIdFromState) return
    setJumpToMessageId(jumpIdFromState)
    navigate(location.pathname, { replace: true, state: {} })
  }, [jumpIdFromState]) // eslint-disable-line react-hooks/exhaustive-deps

  // Auto-clear local jump ID after the highlight animation finishes.
  useEffect(() => {
    if (!jumpToMessageId) return
    const t = setTimeout(() => setJumpToMessageId(undefined), 3_000)
    return () => clearTimeout(t)
  }, [jumpToMessageId])

  const {
    messages, isLoading, isLoadingOlder, isLoadingNewer,
    endReached, latestReached, unreadSeparatorAfter,
    loadOlder, loadNewer, ackLatest,
  } = useMessagePagination(
    isVoice ? undefined : channelId,
    jumpToMessageId,
    channel?.last_message_id != null ? String(channel.last_message_id) : undefined,
  )

  const voiceChannelId = useVoiceStore((s) => s.channelId)
  const voicePeers = useVoiceStore((s) => s.peers)
  const localMuted = useVoiceStore((s) => s.localMuted)

  // Guild data for mention resolution in messages — reuse cached queries
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })
  const { data: roles } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () =>
      rolesApi.guildGuildIdRolesGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 60_000,
  })

  const openUserProfile = useUiStore((s) => s.openUserProfile)

  const handleUserClick = useCallback(
    (userId: string, x: number, y: number) => {
      openUserProfile(userId, serverId ?? null, x, y)
    },
    [openUserProfile, serverId],
  )

  const handleChannelClick = useCallback(
    (targetChannelId: string) => {
      navigate(`/app/${serverId}/${targetChannelId}`)
    },
    [navigate, serverId],
  )

  const mentionResolver = useMemo<MentionResolver>(
    () => ({
      user: (id) => {
        const m = members?.find((m) => String(m.user?.id) === id)
        return m?.username ?? m?.user?.name
      },
      channel: (id) => channels.find((c) => String(c.id) === id)?.name,
      role: (id) => roles?.find((r) => String(r.id) === id)?.name,
      onUserClick: handleUserClick,
      onChannelClick: handleChannelClick,
    }),
    [members, channels, roles, handleUserClick, handleChannelClick],
  )

  // Subscribe to real-time messages for this channel
  // (read state is managed by useMessagePagination / readStateStore)
  useEffect(() => {
    if (channelId) subscribeChannel(channelId)
  }, [channelId])

  if (!channelId) return null

  const Icon = isVoice ? Volume2 : Hash

  // Voice channel view
  if (isVoice) {
    const isConnected = voiceChannelId === channelId
    const peerEntries = Object.entries(voicePeers)

    return (
      <div className="flex flex-col flex-1 min-h-0">
        {/* Channel header */}
        <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-semibold">{channel?.name ?? channelId}</span>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="h-5 mx-1" />
              <span className="text-sm text-muted-foreground truncate">{channel.topic}</span>
            </>
          )}
        </div>

        {/* Voice participants */}
        <div className="flex-1 flex flex-col items-center justify-center gap-4 p-6">
          {isConnected ? (
            <>
              <p className="text-sm text-muted-foreground">
                Connected · {peerEntries.length + 1} participant{peerEntries.length !== 0 ? 's' : ''}
              </p>

              <div className="flex flex-wrap justify-center gap-4">
                {/* Local user */}
                <VoiceParticipant
                  label="You"
                  speaking={false}
                  muted={localMuted}
                />
                {/* Remote peers */}
                {peerEntries.map(([userId, peer]) => (
                  <VoiceParticipant
                    key={userId}
                    label={userId}
                    speaking={peer.speaking}
                    muted={peer.muted}
                  />
                ))}
              </div>
            </>
          ) : (
            <>
              <div className="w-16 h-16 rounded-full bg-muted flex items-center justify-center">
                <Volume2 className="w-8 h-8 text-muted-foreground" />
              </div>
              <h3 className="text-xl font-bold">{channel?.name}</h3>
              <p className="text-sm text-muted-foreground">
                Click the channel in the sidebar to join voice.
              </p>
            </>
          )}
        </div>
      </div>
    )
  }

  // Text channel view
  return (
    <div className="flex flex-1 min-h-0">
      {/* Main chat column */}
      <div className="flex flex-col flex-1 min-w-0">
        {/* Channel header */}
        <div className="h-12 border-b border-sidebar-border flex items-center px-4 gap-2 shrink-0 bg-background">
          <Icon className="w-5 h-5 text-muted-foreground shrink-0" />
          <span className="font-semibold">{channel?.name ?? channelId}</span>
          {channel?.topic && (
            <>
              <Separator orientation="vertical" className="h-5 mx-1" />
              <span className="text-sm text-muted-foreground truncate">{channel.topic}</span>
            </>
          )}

          {/* Toolbar */}
          <div className="ml-auto flex items-center gap-1">
            <button
              onClick={() => setShowSearch((v) => !v)}
              title={showSearch ? 'Close Search' : 'Search Messages'}
              className={cn(
                'w-8 h-8 flex items-center justify-center rounded transition-colors',
                showSearch
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Search className="w-4 h-4" />
            </button>
            <button
              onClick={() => setShowMembers((v) => !v)}
              title={showMembers ? 'Hide Member List' : 'Show Member List'}
              className={cn(
                'w-8 h-8 flex items-center justify-center rounded transition-colors',
                showMembers
                  ? 'text-foreground bg-accent'
                  : 'text-muted-foreground hover:text-foreground hover:bg-accent/50',
              )}
            >
              <Users className="w-4 h-4" />
            </button>
          </div>
        </div>

        <MessageList
          messages={messages}
          isLoading={isLoading}
          isLoadingOlder={isLoadingOlder}
          isLoadingNewer={isLoadingNewer}
          endReached={endReached}
          latestReached={latestReached}
          unreadSeparatorAfter={unreadSeparatorAfter}
          highlightMessageId={jumpToMessageId}
          channelName={channel?.name}
          resolver={mentionResolver}
          onLoadOlder={loadOlder}
          onLoadNewer={loadNewer}
          onAckLatest={ackLatest}
        />
        <TypingIndicator channelId={channelId} />
        <MessageInput channelId={channelId} channelName={channel?.name} />
      </div>

      {/* Search panel */}
      {showSearch && serverId && (
        <SearchPanel
          serverId={serverId}
          channelId={channelId}
          channels={channels}
          members={members}
          onClose={() => setShowSearch(false)}
        />
      )}

      {/* Member list sidebar */}
      {showMembers && serverId && <MemberList serverId={serverId} />}
    </div>
  )
}

function VoiceParticipant({
  label,
  speaking,
  muted,
}: {
  label: string
  speaking: boolean
  muted: boolean
}) {
  const initials = label.charAt(0).toUpperCase()
  return (
    <div className="flex flex-col items-center gap-2">
      <div className="relative">
        <Avatar
          className={cn(
            'w-16 h-16 transition-all',
            speaking && 'ring-2 ring-green-500 ring-offset-2 ring-offset-background',
          )}
        >
          <AvatarFallback className="text-lg">{initials}</AvatarFallback>
        </Avatar>
        {muted && (
          <div className="absolute -bottom-1 -right-1 w-5 h-5 rounded-full bg-destructive flex items-center justify-center">
            <MicOff className="w-3 h-3 text-white" />
          </div>
        )}
      </div>
      <span className="text-xs text-muted-foreground truncate max-w-[64px]">{label}</span>
    </div>
  )
}
