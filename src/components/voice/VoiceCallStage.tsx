import { useCallback, useEffect, useMemo, useRef, useState, type ChangeEvent, type MouseEvent } from 'react'
import {
  HeadphoneOff,
  Headphones,
  Loader2,
  Mic,
  MicOff,
  Monitor,
  PhoneOff,
  RotateCcw,
  Video,
  VideoOff,
  Volume2,
  VolumeX,
  X,
} from 'lucide-react'
import { toast } from 'sonner'
import { useTranslation } from 'react-i18next'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { cn } from '@/lib/utils'
import { useAuthStore } from '@/stores/authStore'
import { useStreamStore, type StreamConnectionState } from '@/stores/streamStore'
import { useVoiceStore } from '@/stores/voiceStore'
import {
  disableCamera,
  enableCamera,
  leaveVoice,
  setDeafened,
  setMuted,
} from '@/services/voiceService'
import {
  STREAM_DEBUG_OVERLAY_EVENT,
  getStreamDebugStats,
  isStreamDebugOverlayEnabled,
  reconnectStream,
  startScreenShare,
  stopScreenShare,
  stopWatchingStream,
  watchStream,
  type StreamDebugStats,
} from '@/services/streamService'
import type { StreamAudioMode, StreamQualitySettings, StreamSourceType, VoiceStreamSummary } from '@/services/streamApi'
import StartStreamDialog from '@/components/voice/StartStreamDialog'

export interface VoiceCallParticipant {
  id: string
  name: string
  avatarUrl?: string
}

interface VoiceCallStageProps {
  guildId: string
  channelId: string
  title: string
  region?: string | null
  participants?: VoiceCallParticipant[]
  onJoin?: () => Promise<void> | void
  onLeave?: () => Promise<void> | void
  className?: string
  showHeader?: boolean
}

type ParticipantSize = 'normal' | 'compact' | 'spotlight'
type ParticipantStreamSummary = Pick<VoiceStreamSummary, 'id' | 'ownerUserId' | 'audioMode'>

interface VoiceParticipantItem {
  id: string
  label: string
  avatarUrl?: string
  speaking: boolean
  muted: boolean
  deafened?: boolean
  videoStream?: MediaStream | null
  isLocal?: boolean
  mirrorVideo?: boolean
  streamSummary?: ParticipantStreamSummary | null
  streamConnectionState?: StreamConnectionState | null
  streamError?: string | null
  isWatchingStream?: boolean
  videoMuted?: boolean
  videoVolume?: number
  isStreamTile?: boolean
}

function getRenderableVideoTrack(stream: MediaStream | null | undefined): MediaStreamTrack | null {
  return stream?.getVideoTracks().find((track) => track.readyState === 'live') ?? null
}

function clearVideoElement(el: HTMLVideoElement) {
  el.pause()
  el.srcObject = null
  el.removeAttribute('src')
  el.load()
}

function VideoFeed({
  stream,
  mirror = false,
  muted = true,
  volume = 1,
  fit = 'cover',
  onFrozen,
  onActive,
}: {
  stream: MediaStream
  mirror?: boolean
  muted?: boolean
  volume?: number
  fit?: 'cover' | 'contain'
  onFrozen?: () => void
  onActive?: () => void
}) {
  const videoRef = useRef<HTMLVideoElement>(null)

  useEffect(() => {
    const el = videoRef.current
    if (!el) return

    const boundTracks = new Set<MediaStreamTrack>()
    const clearStaleFrame = () => clearVideoElement(el)
    const bindVideoTracks = () => {
      for (const track of stream.getVideoTracks()) {
        if (boundTracks.has(track)) continue
        boundTracks.add(track)
        track.addEventListener('ended', clearStaleFrame)
        track.addEventListener('mute', clearStaleFrame)
        track.addEventListener('unmute', attachStream)
      }
    }
    const attachStream = () => {
      bindVideoTracks()
      if (!getRenderableVideoTrack(stream)) {
        clearVideoElement(el)
        return
      }
      if (el.srcObject !== stream) el.srcObject = stream
      el.play().catch(() => undefined)
    }

    attachStream()
    stream.addEventListener('addtrack', attachStream)
    stream.addEventListener('removetrack', attachStream)

    return () => {
      for (const track of boundTracks) {
        track.removeEventListener('ended', clearStaleFrame)
        track.removeEventListener('mute', clearStaleFrame)
        track.removeEventListener('unmute', attachStream)
      }
      stream.removeEventListener('addtrack', attachStream)
      stream.removeEventListener('removetrack', attachStream)
      clearVideoElement(el)
    }
  }, [stream])

  useEffect(() => {
    const el = videoRef.current
    if (!el) return
    el.muted = muted
    el.volume = Math.max(0, Math.min(1, volume))
  }, [muted, volume])

  useEffect(() => {
    if (!onFrozen && !onActive) return
    const el = videoRef.current
    if (!el) return

    let lastFrames = -1
    let staleCount = 0
    const timer = setInterval(() => {
      const q = el.getVideoPlaybackQuality?.()
      if (!q) return
      if (q.totalVideoFrames === lastFrames) {
        staleCount += 1
        if (staleCount === 6) onFrozen?.()
      } else {
        if (staleCount >= 6) onActive?.()
        staleCount = 0
        lastFrames = q.totalVideoFrames
      }
    }, 1000)
    return () => clearInterval(timer)
  }, [onActive, onFrozen, stream])

  return (
    <video
      ref={videoRef}
      autoPlay
      playsInline
      className={cn(
        'h-full w-full rounded-lg',
        fit === 'contain' ? 'object-contain' : 'object-cover',
        mirror && '[transform:scaleX(-1)]',
      )}
    />
  )
}

function formatDebugBitrate(value: number | null | undefined): string {
  if (value == null) return '--'
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)} Mbps`
  if (value >= 1_000) return `${Math.round(value / 1_000)} kbps`
  return `${Math.round(value)} bps`
}

function formatDebugNumber(value: number | null | undefined, suffix = ''): string {
  if (value == null) return '--'
  return `${Math.round(value)}${suffix}`
}

function StreamDebugOverlay({ stats }: { stats: StreamDebugStats | null }) {
  const video = stats?.video
  const audio = stats?.audio
  const resolution = video?.frameWidth && video.frameHeight
    ? `${Math.round(video.frameWidth)}x${Math.round(video.frameHeight)}`
    : '--'

  return (
    <div className="pointer-events-none absolute left-2 top-10 z-10 min-w-[190px] max-w-[260px] rounded-lg border border-cyan-300/25 bg-black/75 px-2.5 py-2 font-mono text-[10px] leading-relaxed text-cyan-50 shadow-xl backdrop-blur">
      <div className="mb-1 flex items-center justify-between gap-3 border-b border-cyan-200/20 pb-1 text-[9px] font-semibold uppercase tracking-[0.16em] text-cyan-200">
        <span>Stream Stats</span>
        <span>{stats?.connectionState ?? 'waiting'}</span>
      </div>
      <div className="grid grid-cols-[auto_1fr] gap-x-2">
        <span className="text-cyan-200/75">Video</span><span>{video?.codec ?? '--'}</span>
        <span className="text-cyan-200/75">Size</span><span>{resolution}</span>
        <span className="text-cyan-200/75">FPS</span><span>{formatDebugNumber(video?.framesPerSecond)}</span>
        <span className="text-cyan-200/75">V Bitrate</span><span>{formatDebugBitrate(video?.bitrateBps)}</span>
        <span className="text-cyan-200/75">Audio</span><span>{audio?.codec ?? '--'}</span>
        <span className="text-cyan-200/75">A Bitrate</span><span>{formatDebugBitrate(audio?.bitrateBps)}</span>
        <span className="text-cyan-200/75">RTT</span><span>{formatDebugNumber(stats?.currentRoundTripTimeMs, 'ms')}</span>
      </div>
    </div>
  )
}

function VoiceParticipant({
  label,
  avatarUrl,
  speaking,
  muted,
  deafened,
  videoStream,
  isLocal,
  mirrorVideo,
  streamSummary,
  streamConnectionState,
  streamError,
  isWatchingStream,
  isStreamTile,
  videoMuted,
  videoVolume,
  size = 'normal',
  onClick,
  onWatchStream,
  onStopWatching,
  onReconnectStream,
}: VoiceParticipantItem & {
  size?: ParticipantSize
  onClick?: () => void
  onWatchStream?: () => void
  onStopWatching?: () => void
  onReconnectStream?: () => void
}) {
  const { t } = useTranslation()
  const initials = label.charAt(0).toUpperCase()
  const streamId = videoStream?.id ?? null
  const videoTrack = getRenderableVideoTrack(videoStream)
  const activeStreamId = streamSummary?.id ?? null
  const streamControlsEnabled = !!isStreamTile
  const streamHasAudio = streamControlsEnabled && !!activeStreamId && isWatchingStream && streamSummary?.audioMode !== 'none'
  const currentVolume = Math.max(0, Math.min(100, Math.round((videoVolume ?? 1) * 100)))
  const streamAudioMuted = !!videoMuted
  const [streamAudioMenu, setStreamAudioMenu] = useState<{ x: number; y: number } | null>(null)
  const [streamDebugEnabled, setStreamDebugEnabled] = useState(() => activeStreamId ? isStreamDebugOverlayEnabled(activeStreamId) : false)
  const [streamDebugStats, setStreamDebugStats] = useState<StreamDebugStats | null>(null)
  const [videoStalled, setVideoStalled] = useState(false)
  const hasVideo = !!videoStream && !!videoTrack
  const shouldMirrorVideo = mirrorVideo ?? isLocal
  const hasActiveStream = !!streamSummary
  const isStreamConnecting = streamControlsEnabled && hasActiveStream && isWatchingStream && !hasVideo && (streamConnectionState === 'connecting' || streamConnectionState === 'reconnecting')
  const isStreamErrored = streamControlsEnabled && hasActiveStream && isWatchingStream && !hasVideo && streamConnectionState === 'error'

  useEffect(() => setVideoStalled(false), [streamId, activeStreamId])
  useEffect(() => {
    setStreamDebugEnabled(activeStreamId ? isStreamDebugOverlayEnabled(activeStreamId) : false)
    setStreamDebugStats(null)
  }, [activeStreamId])
  useEffect(() => {
    const handleDebugOverlayChange = () => {
      setStreamDebugEnabled(activeStreamId ? isStreamDebugOverlayEnabled(activeStreamId) : false)
    }
    window.addEventListener(STREAM_DEBUG_OVERLAY_EVENT, handleDebugOverlayChange)
    return () => window.removeEventListener(STREAM_DEBUG_OVERLAY_EVENT, handleDebugOverlayChange)
  }, [activeStreamId])
  useEffect(() => {
    if (!streamControlsEnabled || !streamDebugEnabled || !activeStreamId || !isWatchingStream || !hasVideo) {
      setStreamDebugStats(null)
      return
    }
    let cancelled = false
    const refresh = () => {
      void getStreamDebugStats(activeStreamId)
        .then((stats) => { if (!cancelled) setStreamDebugStats(stats) })
        .catch(() => { if (!cancelled) setStreamDebugStats(null) })
    }
    refresh()
    const timer = window.setInterval(refresh, 1000)
    return () => {
      cancelled = true
      window.clearInterval(timer)
    }
  }, [activeStreamId, hasVideo, isWatchingStream, streamControlsEnabled, streamDebugEnabled])
  useEffect(() => {
    if (!streamAudioMenu) return
    const closeMenu = () => setStreamAudioMenu(null)
    window.addEventListener('click', closeMenu)
    window.addEventListener('keydown', closeMenu)
    return () => {
      window.removeEventListener('click', closeMenu)
      window.removeEventListener('keydown', closeMenu)
    }
  }, [streamAudioMenu])

  function handleStreamContextMenu(event: MouseEvent<HTMLDivElement>) {
    if (!streamControlsEnabled || !activeStreamId || !isWatchingStream) return
    event.preventDefault()
    event.stopPropagation()
    setStreamAudioMenu({
      x: Math.max(8, Math.min(event.clientX, window.innerWidth - 196)),
      y: Math.max(8, Math.min(event.clientY, window.innerHeight - 120)),
    })
  }

  function handleToggleWatchedStreamAudio(event?: MouseEvent<HTMLButtonElement>) {
    event?.stopPropagation()
    if (!activeStreamId || !streamHasAudio) return
    useStreamStore.getState().setWatchedMuted(activeStreamId, !streamAudioMuted)
  }

  function handleWatchedStreamVolumeChange(event: ChangeEvent<HTMLInputElement>) {
    event.stopPropagation()
    if (!activeStreamId || !streamHasAudio) return
    const nextVolume = Number(event.currentTarget.value)
    useStreamStore.getState().setWatchedVolume(activeStreamId, nextVolume)
    if (nextVolume > 0 && streamAudioMuted) {
      useStreamStore.getState().setWatchedMuted(activeStreamId, false)
    }
  }

  const avatarCls = size === 'spotlight' ? 'w-24 h-24' : size === 'compact' ? 'w-12 h-12' : 'w-20 h-20'
  const fallbackCls = size === 'spotlight' ? 'text-3xl' : size === 'compact' ? 'text-base' : 'text-xl'
  const badgeCls = size === 'spotlight' ? 'w-7 h-7' : 'w-5 h-5'
  const badgeIconCls = size === 'spotlight' ? 'w-4 h-4' : 'w-3 h-3'
  const labelCls = size === 'compact' ? 'text-[10px] max-w-[80px]' : 'text-xs max-w-[100px]'

  return (
    <div className={cn('flex flex-col items-center gap-2', size === 'spotlight' && hasVideo && 'h-full w-full min-w-0')}>
      <div className={cn('relative transition-all duration-150', size === 'spotlight' && hasVideo && 'h-full w-full min-w-0', hasVideo && onClick && 'cursor-pointer')} onClick={onClick}>
        {hasVideo ? (
          <div className={cn('rounded-lg bg-zinc-900 overflow-hidden relative', size === 'spotlight' ? 'w-full h-full max-w-full max-h-full' : size === 'compact' ? 'w-36 h-24' : 'w-56 h-40')} onContextMenu={handleStreamContextMenu}>
            <VideoFeed
              key={streamId ?? videoStream!.id}
              stream={videoStream!}
              mirror={shouldMirrorVideo}
              muted={videoMuted}
              volume={videoVolume}
              fit={size === 'spotlight' ? 'contain' : 'cover'}
              onFrozen={isLocal ? undefined : () => setVideoStalled(true)}
              onActive={isLocal ? undefined : () => setVideoStalled(false)}
            />
            {hasActiveStream && <div className="absolute left-2 top-2 rounded-full bg-red-500/90 px-2 py-1 text-[10px] font-semibold uppercase tracking-[0.16em] text-white shadow-sm">{t('streams.liveBadge')}</div>}
            {streamControlsEnabled && streamDebugEnabled && activeStreamId && isWatchingStream && <StreamDebugOverlay stats={streamDebugStats} />}
            {streamControlsEnabled && videoStalled && hasActiveStream && isWatchingStream && (
              <div className="absolute bottom-9 left-2 z-10 inline-flex items-center gap-1.5 rounded-full border border-amber-300/30 bg-amber-950/75 px-2 py-1 text-[10px] font-medium text-amber-100 shadow-sm backdrop-blur">
                <Loader2 className="h-3 w-3 animate-spin" />
                {t('streams.videoStalled')}
              </div>
            )}
            {hasActiveStream && !isWatchingStream && onWatchStream && (
              <button type="button" onClick={(event) => { event.stopPropagation(); onWatchStream() }} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-background">
                <Monitor className="h-3 w-3" />
                {t('streams.watch')}
              </button>
            )}
            {hasActiveStream && isWatchingStream && onStopWatching && (
              <button type="button" onClick={(event) => { event.stopPropagation(); onStopWatching() }} className="absolute right-2 top-2 inline-flex items-center gap-1 rounded-full bg-background/90 px-2 py-1 text-[10px] font-medium text-foreground shadow-sm transition-colors hover:bg-background">
                <X className="h-3 w-3" />
                {t('streams.stopWatching')}
              </button>
            )}
            {streamAudioMenu && (
              <div className="fixed z-50 w-[188px] rounded-lg border border-border/70 bg-popover/95 p-2 text-popover-foreground shadow-xl backdrop-blur" style={{ left: streamAudioMenu.x, top: streamAudioMenu.y }} onClick={(event) => event.stopPropagation()} onPointerDown={(event) => event.stopPropagation()}>
                {streamHasAudio ? (
                  <div className="space-y-2">
                    <button type="button" onClick={handleToggleWatchedStreamAudio} className="flex w-full items-center justify-between rounded-md px-2 py-1.5 text-xs font-medium transition-colors hover:bg-accent">
                      <span>{streamAudioMuted ? t('streams.unmuteAudio') : t('streams.muteAudio')}</span>
                      {streamAudioMuted ? <VolumeX className="h-3.5 w-3.5" /> : <Volume2 className="h-3.5 w-3.5" />}
                    </button>
                    <label className="block px-2">
                      <span className="mb-1 flex items-center justify-between text-[10px] font-medium uppercase tracking-[0.12em] text-muted-foreground">
                        <span>{t('streams.volume')}</span>
                        <span>{currentVolume}%</span>
                      </span>
                      <input type="range" min={0} max={100} step={1} value={currentVolume} onChange={handleWatchedStreamVolumeChange} className="h-1.5 w-full accent-primary" />
                    </label>
                  </div>
                ) : (
                  <div className="flex items-center gap-2 px-2 py-1.5 text-xs text-muted-foreground">
                    <VolumeX className="h-3.5 w-3.5" />
                    <span>{t('streams.noStreamAudio')}</span>
                  </div>
                )}
              </div>
            )}
            <div className="absolute bottom-0 left-0 right-0 px-2 py-1 bg-black/50 flex items-center justify-between gap-1">
              <span className="text-xs text-white truncate">{label}</span>
              <div className="flex items-center gap-1 shrink-0">
                {deafened ? <HeadphoneOff className="w-3 h-3 text-destructive" /> : muted ? <MicOff className="w-3 h-3 text-destructive" /> : null}
              </div>
            </div>
            {speaking && <div className="absolute inset-0 ring-2 ring-green-500 rounded-lg pointer-events-none" />}
          </div>
        ) : (
          <>
            <Avatar className={cn(avatarCls, 'transition-all duration-150')}>
              {avatarUrl && <AvatarImage src={avatarUrl} alt={label} className="object-cover" />}
              <AvatarFallback className={fallbackCls}>{initials}</AvatarFallback>
            </Avatar>
            {speaking && <div className="absolute inset-0 rounded-full ring-2 ring-green-500 ring-offset-2 ring-offset-background pointer-events-none" />}
            {(deafened || muted) && (
              <div className={cn('absolute -bottom-1 -right-1 rounded-full bg-destructive border border-background flex items-center justify-center pointer-events-none', badgeCls)}>
                {deafened ? <HeadphoneOff className={cn(badgeIconCls, 'text-white')} /> : <MicOff className={cn(badgeIconCls, 'text-white')} />}
              </div>
            )}
          </>
        )}
      </div>
      {!hasVideo && (
        <div className="flex flex-col items-center gap-1">
          <span className={cn('text-muted-foreground truncate', labelCls)}>{label}</span>
          {hasActiveStream && !isWatchingStream && onWatchStream && (
            <button type="button" onClick={onWatchStream} className="inline-flex items-center gap-1 rounded-full border border-red-500/30 bg-red-500/10 px-2 py-1 text-[10px] font-medium text-red-400 transition-colors hover:bg-red-500/15">
              <Monitor className="h-3 w-3" />
              {t('streams.clickToWatch')}
            </button>
          )}
          {isStreamConnecting && <span className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/70 px-2 py-1 text-[10px] font-medium text-muted-foreground"><Loader2 className="h-3 w-3 animate-spin" />{t('streams.connecting')}</span>}
          {isStreamErrored && onReconnectStream && (
            <button type="button" onClick={onReconnectStream} className="inline-flex items-center gap-1 rounded-full border border-border/60 bg-muted/70 px-2 py-1 text-[10px] font-medium text-foreground transition-colors hover:bg-accent" title={streamError ?? undefined}>
              <RotateCcw className="h-3 w-3" />
              {t('streams.reconnect')}
            </button>
          )}
        </div>
      )}
    </div>
  )
}

export default function VoiceCallStage({
  guildId,
  channelId,
  title,
  region,
  participants = [],
  onJoin,
  onLeave,
  className,
  showHeader = true,
}: VoiceCallStageProps) {
  const { t } = useTranslation()
  const currentUser = useAuthStore((state) => state.user)
  const voice = useVoiceStore()
  const streamStore = useStreamStore()
  const [spotlightId, setSpotlightId] = useState<string | null>(null)
  const [streamDialogOpen, setStreamDialogOpen] = useState(false)
  const [isStartingStream, setIsStartingStream] = useState(false)

  const currentUserId = String(currentUser?.id ?? '')
  const isConnected = voice.guildId === guildId && voice.channelId === channelId
  const knownParticipants = useMemo(() => {
    const map = new Map<string, VoiceCallParticipant>()
    for (const participant of participants) map.set(participant.id, participant)
    if (currentUserId) {
      map.set(currentUserId, {
        id: currentUserId,
        name: currentUser?.name ?? t('channel.you'),
        avatarUrl: currentUser?.avatar?.url,
      })
    }
    return map
  }, [currentUser?.avatar?.url, currentUser?.name, currentUserId, participants, t])

  const displayNameForUser = (userId: string) => {
    if (userId === currentUserId) return currentUser?.name ?? t('channel.you')
    return knownParticipants.get(userId)?.name ?? `User ${userId.slice(0, 6)}`
  }
  const avatarForUser = (userId: string) => knownParticipants.get(userId)?.avatarUrl

  async function handleStartStream(sourceType: StreamSourceType, audioMode: StreamAudioMode, quality: StreamQualitySettings) {
    setIsStartingStream(true)
    try {
      await startScreenShare(guildId, channelId, sourceType, audioMode, quality)
      setStreamDialogOpen(false)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : t('common.error'))
    } finally {
      setIsStartingStream(false)
    }
  }

  async function handleToggleStream() {
    if (streamStore.publishing?.channelId === channelId) {
      await stopScreenShare()
      return
    }
    setStreamDialogOpen(true)
  }

  async function handleWatchParticipantStream(participantId: string, streamId: string) {
    const stream = streamStore.channelStreams[channelId]?.find((item) => item.id === streamId)
    if (!stream) return
    try {
      await watchStream(guildId, channelId, stream)
      setSpotlightId(participantId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to watch stream')
    }
  }

  function handleStopParticipantStream(participantId: string, streamId: string) {
    stopWatchingStream(streamId)
    if (spotlightId === participantId) setSpotlightId(null)
  }

  async function handleReconnectParticipantStream(participantId: string, streamId: string) {
    try {
      await reconnectStream(streamId)
      setSpotlightId(participantId)
    } catch (error) {
      toast.error(error instanceof Error ? error.message : 'Failed to reconnect stream')
    }
  }

  const peerEntries = Object.entries(voice.peers).filter(([userId]) => userId !== currentUserId)
  const channelStreams = streamStore.channelStreams[channelId] ?? []
  const publishing = streamStore.publishing
  const watchedStreams = streamStore.watched
  const localDisplayName = currentUser?.name ?? t('channel.you')
  const streamTileId = (streamId: string) => `stream:${streamId}`

  const userParticipants: VoiceParticipantItem[] = [
    {
      id: 'user:local',
      label: localDisplayName,
      avatarUrl: currentUser?.avatar?.url,
      speaking: voice.localSpeaking,
      muted: voice.localMuted,
      deafened: voice.localDeafened,
      videoStream: voice.localCameraEnabled ? voice.localVideoStream : null,
      isLocal: true,
      streamSummary: null,
      streamConnectionState: null,
      streamError: null,
      isWatchingStream: false,
      videoMuted: true,
      videoVolume: 1,
    },
    ...peerEntries.map(([userId, peer]) => ({
      id: `user:${userId}`,
      label: displayNameForUser(userId),
      avatarUrl: avatarForUser(userId),
      speaking: peer.speaking,
      muted: peer.muted,
      deafened: peer.deafened,
      videoStream: peer.videoStream,
      isLocal: false,
      streamSummary: null,
      streamConnectionState: null,
      streamError: null,
      isWatchingStream: false,
      videoMuted: true,
      videoVolume: 1,
    })),
  ]

  const hasLocalPublishedStreamTile = !!publishing?.streamId && channelStreams.some((stream) => stream.id === publishing.streamId)
  const localPublishingStreamSummary: ParticipantStreamSummary | null =
    publishing?.channelId === channelId && publishing.streamId
      ? { id: publishing.streamId, ownerUserId: publishing.ownerUserId, audioMode: publishing.audioMode }
      : null
  const channelStreamTiles: VoiceParticipantItem[] = channelStreams.map((stream) => {
    const watchedStream = watchedStreams[stream.id] ?? null
    const isOwnerLocal = stream.ownerUserId === currentUserId
    const localPreviewStream = isOwnerLocal && publishing?.streamId === stream.id ? publishing.previewStream : null
    return {
      id: streamTileId(stream.id),
      label: `${displayNameForUser(stream.ownerUserId)} · ${t('streams.liveBadge')}`,
      avatarUrl: avatarForUser(stream.ownerUserId),
      speaking: false,
      muted: isOwnerLocal ? voice.localMuted : voice.peers[stream.ownerUserId]?.muted ?? false,
      deafened: isOwnerLocal ? voice.localDeafened : voice.peers[stream.ownerUserId]?.deafened ?? false,
      videoStream: localPreviewStream ?? watchedStream?.mediaStream ?? null,
      isLocal: isOwnerLocal,
      mirrorVideo: false,
      streamSummary: stream,
      streamConnectionState: watchedStream?.connectionState ?? (isOwnerLocal && publishing?.streamId === stream.id ? publishing.connectionState : null),
      streamError: watchedStream?.error ?? (isOwnerLocal && publishing?.streamId === stream.id ? publishing.error : null),
      isWatchingStream: !!watchedStream,
      videoMuted: watchedStream ? watchedStream.muted : true,
      videoVolume: watchedStream ? watchedStream.volume / 100 : 1,
      isStreamTile: true,
    }
  })
  const localStreamPreview: VoiceParticipantItem | null =
    publishing?.channelId === channelId && publishing.previewStream && localPublishingStreamSummary && !hasLocalPublishedStreamTile
      ? {
          id: streamTileId(publishing.streamId),
          label: `${localDisplayName} · ${t('streams.liveBadge')}`,
          avatarUrl: currentUser?.avatar?.url,
          speaking: false,
          muted: voice.localMuted,
          deafened: voice.localDeafened,
          videoStream: publishing.previewStream,
          isLocal: true,
          mirrorVideo: false,
          streamSummary: localPublishingStreamSummary,
          streamConnectionState: publishing.connectionState,
          streamError: publishing.error,
          isWatchingStream: false,
          videoMuted: true,
          videoVolume: 1,
          isStreamTile: true,
        }
      : null
  const visibleParticipants = [...userParticipants, ...(localStreamPreview ? [...channelStreamTiles, localStreamPreview] : channelStreamTiles)]
  const spotlightParticipant = spotlightId ? visibleParticipants.find((p) => p.id === spotlightId) ?? null : null
  const stripParticipants = spotlightId ? visibleParticipants.filter((p) => p.id !== spotlightId) : []
  const isStreamingHere = publishing?.channelId === channelId
  const streamButtonDisabled = isStartingStream || (!isStreamingHere && voice.connectionState !== 'connected')
  const canControlStreamTile = (participant: VoiceParticipantItem) =>
    !!participant.isStreamTile && !!participant.streamSummary && participant.streamSummary.ownerUserId !== currentUserId

  const renderParticipant = (p: VoiceParticipantItem, size?: ParticipantSize) => {
    const streamId = p.streamSummary?.id ?? ''
    const canControlStream = !!streamId && canControlStreamTile(p)
    return (
      <VoiceParticipant
        key={p.id}
        {...p}
        size={size}
        onClick={
          canControlStream && !p.isWatchingStream
            ? () => { void handleWatchParticipantStream(p.id, streamId) }
            : p.videoStream
              ? () => setSpotlightId(p.id)
              : undefined
        }
        onWatchStream={canControlStream && !p.isWatchingStream ? () => { void handleWatchParticipantStream(p.id, streamId) } : undefined}
        onStopWatching={canControlStream && p.isWatchingStream ? () => handleStopParticipantStream(p.id, streamId) : undefined}
        onReconnectStream={canControlStream && p.streamConnectionState === 'error' ? () => { void handleReconnectParticipantStream(p.id, streamId) } : undefined}
      />
    )
  }

  const toggleMute = () => {
    if (voice.localMuted && voice.localDeafened) {
      setDeafened(false)
      setMuted(false)
    } else {
      setMuted(!voice.localMuted)
    }
  }
  const toggleDeafen = () => setDeafened(!voice.localDeafened)
  const toggleCamera = () => {
    if (voice.localCameraEnabled) {
      void disableCamera()
    } else {
      void enableCamera()
    }
  }
  const handleLeave = () => {
    if (onLeave) {
      void onLeave()
    } else {
      void leaveVoice()
    }
  }

  return (
    <div className={cn('flex min-h-[320px] flex-col border-b border-sidebar-border bg-background', className)}>
      {showHeader && (
        <div className="flex h-10 shrink-0 items-center justify-between border-b border-sidebar-border px-4">
          <div className="min-w-0">
            <p className="truncate text-sm font-semibold">{title}</p>
            <p className="text-[11px] text-muted-foreground">{region ? `Region: ${region}` : 'Region: Automatic'}</p>
          </div>
        </div>
      )}

      {isConnected ? (
        spotlightParticipant ? (
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            <div className="flex min-h-0 flex-1 items-center justify-center p-4">
              <VoiceParticipant {...spotlightParticipant} size="spotlight" onClick={() => setSpotlightId(null)} />
            </div>
            <div className="flex shrink-0 gap-3 overflow-x-auto border-t border-sidebar-border px-4 pb-3 pt-3">
              {stripParticipants.map((p) => renderParticipant(p, 'compact'))}
            </div>
          </div>
        ) : (
          <div className="flex flex-1 flex-col items-center justify-center gap-4 overflow-auto p-6">
            <p className="text-sm text-muted-foreground">
              {peerEntries.length === 0
                ? t('channel.connected', { count: 1 })
                : t('channel.connected_plural', { count: peerEntries.length + 1 })}
            </p>
            <div className="flex w-full flex-wrap justify-center gap-4">
              {visibleParticipants.map((p) => renderParticipant(p))}
            </div>
          </div>
        )
      ) : (
        <div className="flex flex-1 flex-col items-center justify-center gap-4 p-6">
          <div className="flex h-16 w-16 items-center justify-center rounded-full bg-muted">
            <Volume2 className="h-8 w-8 text-muted-foreground" />
          </div>
          <h3 className="text-xl font-bold">{title}</h3>
          <p className="text-sm text-muted-foreground">{t('channel.clickToJoin')}</p>
        </div>
      )}

      <div className="flex shrink-0 items-center justify-center gap-2 border-t border-sidebar-border bg-background px-4 py-3">
        {isConnected ? (
          <>
            <div className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.035] p-1">
              <button
                onClick={toggleMute}
                title={voice.localMuted ? t('voicePanel.unmute') : t('voicePanel.mute')}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                  voice.localMuted
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : voice.localSpeaking
                      ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {voice.localMuted ? <MicOff className="h-5 w-5" /> : <Mic className="h-5 w-5" />}
              </button>
              <button
                onClick={toggleDeafen}
                title={voice.localDeafened ? t('voicePanel.undeafen') : t('voicePanel.deafen')}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                  voice.localDeafened
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {voice.localDeafened ? <HeadphoneOff className="h-5 w-5" /> : <Headphones className="h-5 w-5" />}
              </button>
            </div>

            <div className="flex items-center gap-1 rounded-xl border border-white/[0.08] bg-white/[0.035] p-1">
              <button
                onClick={toggleCamera}
                title={voice.localCameraEnabled ? t('voicePanel.cameraOff') : t('voicePanel.cameraOn')}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors',
                  voice.localCameraEnabled
                    ? 'bg-primary/20 text-primary hover:bg-primary/30'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {voice.localCameraEnabled ? <Video className="h-5 w-5" /> : <VideoOff className="h-5 w-5" />}
              </button>
              <button
                onClick={() => { void handleToggleStream() }}
                disabled={streamButtonDisabled}
                title={isStreamingHere ? t('streams.stop') : t('streams.start')}
                className={cn(
                  'flex h-10 w-10 items-center justify-center rounded-lg transition-colors disabled:cursor-not-allowed disabled:opacity-50',
                  isStreamingHere
                    ? 'bg-red-500/20 text-red-400 hover:bg-red-500/30'
                    : 'bg-muted text-muted-foreground hover:bg-accent hover:text-foreground',
                )}
              >
                {isStartingStream ? <Loader2 className="h-5 w-5 animate-spin" /> : <Monitor className="h-5 w-5" />}
              </button>
            </div>

            <div className="flex items-center rounded-xl border border-white/[0.08] bg-white/[0.035] p-1">
              <button
                onClick={handleLeave}
                title={t('voicePanel.disconnect')}
                className="flex h-10 w-10 items-center justify-center rounded-lg bg-muted text-muted-foreground transition-colors hover:bg-destructive/20 hover:text-destructive"
              >
                <PhoneOff className="h-5 w-5" />
              </button>
            </div>
          </>
        ) : (
          <button onClick={() => { void onJoin?.() }} className="rounded-md bg-green-600 px-6 py-2 text-sm font-medium text-white transition-colors hover:bg-green-500">
            {t('channel.joinVoice')}
          </button>
        )}
      </div>
      <StartStreamDialog open={streamDialogOpen} isStarting={isStartingStream} onOpenChange={setStreamDialogOpen} onStart={handleStartStream} />
    </div>
  )
}
