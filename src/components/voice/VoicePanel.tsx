import { useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Radio, Video, VideoOff, ShieldCheck, ShieldOff, ShieldAlert, Copy, Check, Monitor, Volume2, VolumeX } from 'lucide-react'
import { useVoiceStore } from '@/stores/voiceStore'
import { useStreamStore } from '@/stores/streamStore'
import type { VoiceConnectionState } from '@/stores/voiceStore'
import { leaveVoice, setMuted, setDeafened, enableCamera, disableCamera } from '@/services/voiceService'
import { setPublishingStreamAudioEnabled, startScreenShare, stopScreenShare } from '@/services/streamService'
import type { StreamAudioMode, StreamQualitySettings, StreamSourceType } from '@/services/streamApi'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { toast } from 'sonner'
import { voiceApi } from '@/api/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import StartStreamDialog from './StartStreamDialog'

interface VoiceRegion {
  id?: string
  name?: string
}

interface VoicePanelProps {
  className?: string
}

function parseSfuHost(sfuUrl: string | null): string {
  if (!sfuUrl) return ''
  try {
    const url = new URL(sfuUrl)
    const hostname = url.hostname
    const parts = hostname.split('.')
    // IP address (all numeric parts) or single label → show as-is
    if (parts.length >= 3 && !/^\d+$/.test(parts[0])) {
      return parts[0]
    }
    return hostname
  } catch {
    // Not a valid URL — strip protocol manually
    return sfuUrl.replace(/^[a-z]+:\/\//i, '').split('/')[0]
  }
}

function getConnectionStatus(state: VoiceConnectionState, t: (key: string) => string) {
  switch (state) {
    case 'connecting':
      return { text: t('voicePanel.connecting'), color: 'text-yellow-500', dotColor: 'bg-yellow-500' }
    case 'routing':
      return { text: t('voicePanel.routing'), color: 'text-orange-500', dotColor: 'bg-orange-500' }
    case 'dtls':
      return { text: t('voicePanel.dtls'), color: 'text-blue-400', dotColor: 'bg-blue-400' }
    case 'connected':
      return { text: t('voicePanel.connected'), color: 'text-green-400', dotColor: 'bg-green-500' }
    default:
      return { text: t('voicePanel.disconnected'), color: 'text-muted-foreground', dotColor: 'bg-gray-500' }
  }
}

export default function VoicePanel({ className }: VoicePanelProps) {
  const { t } = useTranslation()
  const channelId = useVoiceStore((s) => s.channelId)
  const guildId = useVoiceStore((s) => s.guildId)
  const channelName = useVoiceStore((s) => s.channelName)
  const guildName = useVoiceStore((s) => s.guildName)
  const sfuUrl = useVoiceStore((s) => s.sfuUrl)
  const voiceRegion = useVoiceStore((s) => s.voiceRegion)
  const localMuted = useVoiceStore((s) => s.localMuted)
  const localDeafened = useVoiceStore((s) => s.localDeafened)
  const localSpeaking = useVoiceStore((s) => s.localSpeaking)
  const localCameraEnabled = useVoiceStore((s) => s.localCameraEnabled)
  const storePing = useVoiceStore((s) => s.ping)
  const connectionState = useVoiceStore((s) => s.connectionState)
  const daveEnabled = useVoiceStore((s) => s.daveEnabled)
  const daveProtocolVersion = useVoiceStore((s) => s.daveProtocolVersion)
  const daveTransitioning = useVoiceStore((s) => s.daveTransitioning)
  const daveEpoch = useVoiceStore((s) => s.daveEpoch)
  const davePrivacyCode = useVoiceStore((s) => s.davePrivacyCode)
  const publishing = useStreamStore((s) => s.publishing)
  const isStreamingHere = publishing?.channelId === channelId
  const streamQualityLabel = isStreamingHere && publishing
    ? t('streams.qualityBadge', { resolution: publishing.resolution, frameRate: publishing.frameRate })
    : null
  const streamSourceLabel = isStreamingHere && publishing
    ? publishing.sourceType === 'application'
      ? t('streams.sourceApplication')
      : t('streams.sourceScreen')
    : null
  const streamHasAudio = !!(isStreamingHere && publishing?.hasAudio)
  const streamAudioEnabled = !!(streamHasAudio && publishing?.audioEnabled)
  let streamAudioLabel: string | null = null
  if (isStreamingHere && publishing) {
    if (!streamHasAudio) {
      streamAudioLabel = t('streams.audioNone')
    } else if (!streamAudioEnabled) {
      streamAudioLabel = t('streams.audioOff')
    } else if (publishing.audioMode === 'application') {
      streamAudioLabel = t('streams.audioApplication')
    } else if (publishing.audioMode === 'desktop') {
      streamAudioLabel = t('streams.audioDesktop')
    } else {
      streamAudioLabel = t('streams.audioNone')
    }
  }

  const { data: voiceRegions = [] } = useQuery<VoiceRegion[]>({
    queryKey: ['voice-regions'],
    queryFn: () => voiceApi.voiceRegionsGet().then((r) => r.data?.regions ?? []),
    staleTime: 5 * 60_000,
    enabled: !!channelId,
  })

  const regionLabel = voiceRegion
    ? (voiceRegions.find((r) => r.id === voiceRegion)?.name ?? voiceRegion)
    : 'Automatic'
  const sfuHost = parseSfuHost(sfuUrl)

  const encryptionInfo = daveTransitioning
    ? { label: t('voicePanel.encryptionTransitioning'), Icon: ShieldAlert, color: 'text-yellow-400', detail: null }
    : daveProtocolVersion === 1
      ? { label: t('voicePanel.encryptionE2E'), Icon: ShieldCheck, color: 'text-green-400', detail: daveEpoch > 0 ? `epoch ${daveEpoch}` : null }
      : daveEnabled
        ? { label: t('voicePanel.encryptionWaiting'), Icon: ShieldAlert, color: 'text-yellow-500', detail: t('voicePanel.encryptionWaitingDetail') }
        : { label: t('voicePanel.encryptionTransport'), Icon: ShieldOff, color: 'text-muted-foreground', detail: null }
  const [displayPing, setDisplayPing] = useState(0)
  const [privacyCodeCopied, setPrivacyCodeCopied] = useState(false)
  const [streamDialogOpen, setStreamDialogOpen] = useState(false)
  const [isStartingStream, setIsStartingStream] = useState(false)
  const [isDetailsOpen, setIsDetailsOpen] = useState(false)
  const detailsRef = useRef<HTMLDivElement | null>(null)

  // Update display ping when store ping changes, but keep previous value if it drops to 0
  useEffect(() => {
    if (storePing > 0) {
      setDisplayPing(storePing)
    }
  }, [storePing])

  useEffect(() => {
    if (!isDetailsOpen) return undefined

    function handlePointerDown(event: PointerEvent) {
      if (detailsRef.current && !detailsRef.current.contains(event.target as Node)) {
        setIsDetailsOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setIsDetailsOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [isDetailsOpen])

  const privacyCodeChunks = davePrivacyCode ? (davePrivacyCode.match(/.{1,5}/g) ?? []) : []

  function handleCopyPrivacyCode() {
    if (!davePrivacyCode) return
    void navigator.clipboard.writeText(davePrivacyCode).then(() => {
      setPrivacyCodeCopied(true)
      setTimeout(() => setPrivacyCodeCopied(false), 2000)
    })
  }

  const status = getConnectionStatus(connectionState, t)
  const isTransient = connectionState === 'connecting' || connectionState === 'routing' || connectionState === 'dtls'
  const pingValue = connectionState === 'connected' && displayPing > 0 ? displayPing : null
  const pingLabel = pingValue !== null ? t('voicePanel.ping', { ping: pingValue }) : '--'
  const streamAudioToggleLabel = streamAudioEnabled ? t('streams.turnSoundOff') : t('streams.turnSoundOn')
  const disconnectLabel = t('voicePanel.disconnect')
  const cameraLabel = localCameraEnabled ? t('voicePanel.cameraOff') : t('voicePanel.cameraOn')
  const streamToggleLabel = isStreamingHere ? t('streams.stop') : t('streams.start')
  const muteLabel = localMuted ? t('voicePanel.unmute') : t('voicePanel.mute')
  const deafenLabel = localDeafened ? t('voicePanel.undeafen') : t('voicePanel.deafen')

  const navigate = useNavigate()
  const isDMCall = guildId === '@me'
  const connectionSubtitle = isDMCall
    ? (channelName ?? 'Direct call')
    : guildName
      ? `${channelName ?? channelId} / ${guildName}`
      : (channelName ?? channelId)
  const dtlsLabel = connectionState === 'connected'
    ? t('voicePanel.dtlsEnabled')
    : connectionState === 'dtls'
      ? t('voicePanel.dtlsHandshake')
      : t('voicePanel.dtlsDisabled')

  function handleChannelClick() {
    if (guildId && channelId) {
      void navigate(isDMCall ? `/app/@me/${channelId}` : `/app/${guildId}/${channelId}`)
    }
  }

  function toggleMute() {
    if (localMuted && localDeafened) {
      setDeafened(false)
      setMuted(false)
    } else {
      setMuted(!localMuted)
    }
  }

  function toggleDeafen() {
    setDeafened(!localDeafened)
  }

  function toggleCamera() {
    if (localCameraEnabled) {
      void disableCamera()
    } else {
      void enableCamera()
    }
  }

  async function handleStartStream(
    sourceType: StreamSourceType,
    audioMode: StreamAudioMode,
    quality: StreamQualitySettings,
  ) {
    if (!guildId || !channelId) return
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
    if (isStreamingHere) {
      await stopScreenShare()
      return
    }
    setStreamDialogOpen(true)
  }

  function handleToggleStreamAudio() {
    if (!streamHasAudio) return
    const changed = setPublishingStreamAudioEnabled(!streamAudioEnabled)
    if (!changed) {
      toast.message(t('streams.noStreamAudio'))
    }
  }

  if (!channelId) return null

  return (
        <div style={{ overflow: 'visible' }}>
          <div
            ref={detailsRef}
            className={cn('relative shrink-0 rounded-xl border border-white/[0.08] bg-white/[0.045] p-3', className)}
          >
            {isDetailsOpen && (
              <div className="absolute bottom-full left-0 z-50 mb-2 w-full select-text rounded-xl border border-white/[0.1] bg-[#15161b] p-3 text-xs text-zinc-400 ring-1 ring-black/20">
                <div className="space-y-2">
                  <div className="flex items-center justify-between gap-4">
                    <span>{t('voicePanel.region')}</span>
                    <span className="font-semibold text-zinc-100">{regionLabel}</span>
                  </div>
                  {sfuHost && (
                    <div className="flex items-center justify-between gap-4">
                      <span>{t('voicePanel.host')}</span>
                      <span className="font-mono font-semibold text-zinc-100">{sfuHost}</span>
                    </div>
                  )}
                  <div className="flex items-center justify-between gap-4">
                    <span>{t('voicePanel.dtlsLabel')}</span>
                    <span
                      className={cn(
                        'font-semibold',
                        connectionState === 'connected'
                          ? 'text-emerald-400'
                          : connectionState === 'dtls'
                            ? 'text-amber-300'
                            : 'text-zinc-500',
                      )}
                    >
                      {dtlsLabel}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span>{t('voicePanel.encryption')}</span>
                    <span className={cn('flex items-center gap-1 font-semibold', encryptionInfo.color)}>
                      <encryptionInfo.Icon className="h-3.5 w-3.5" />
                      {encryptionInfo.label}
                    </span>
                  </div>
                  <div className="flex items-center justify-between gap-4">
                    <span>Ping</span>
                    <span
                      className={cn(
                        'font-mono font-semibold',
                        pingValue === null
                          ? 'text-zinc-500'
                          : pingValue < 160
                            ? 'text-emerald-300'
                            : pingValue < 300
                              ? 'text-amber-300'
                              : 'text-red-300',
                      )}
                    >
                      {pingValue !== null ? t('voicePanel.ping', { ping: pingValue }) : '--'}
                    </span>
                  </div>
                </div>

                {encryptionInfo.detail && (
                  <div className="mt-3 border-t border-white/[0.08] pt-2 font-mono text-[11px] text-zinc-500">
                    {encryptionInfo.detail}
                  </div>
                )}

                {davePrivacyCode && (
                  <div className="mt-3 border-t border-white/[0.08] pt-2">
                    <div className="mb-1.5 flex items-center justify-between">
                      <p className="text-[10px] text-zinc-500">{t('voicePanel.privacyCode')}</p>
                      <button
                        onClick={handleCopyPrivacyCode}
                        className="text-zinc-500 transition-colors hover:text-zinc-100"
                      >
                        {privacyCodeCopied
                          ? <Check className="h-3 w-3 text-emerald-400" />
                          : <Copy className="h-3 w-3" />}
                      </button>
                    </div>
                    <div className="grid grid-cols-3 gap-1">
                      {privacyCodeChunks.map((chunk, index) => (
                        <span
                          key={index}
                          className="rounded bg-emerald-400/10 px-1.5 py-0.5 text-center font-mono text-[11px] font-medium tabular-nums text-emerald-400"
                        >
                          {chunk}
                        </span>
                      ))}
                    </div>
                  </div>
                )}
              </div>
            )}

            {isStreamingHere && publishing && (
              <div className="mb-3 rounded-xl border border-red-500/20 bg-red-500/10 px-2.5 py-2">
                <div className="flex min-w-0 items-center justify-between gap-2">
                  <div className="flex min-w-0 items-center gap-1.5">
                    <Monitor className="h-3.5 w-3.5 shrink-0 text-red-400" />
                    <span className="rounded-full bg-red-500/20 px-1.5 py-0.5 text-[9px] font-semibold uppercase tracking-[0.16em] text-red-300">
                      {t('streams.liveBadge')}
                    </span>
                    {streamSourceLabel && (
                      <span className="truncate text-[10px] font-medium text-foreground">
                        {streamSourceLabel}
                      </span>
                    )}
                  </div>
                  {streamQualityLabel && (
                    <span className="shrink-0 rounded-full bg-background/60 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
                      {streamQualityLabel}
                    </span>
                  )}
                </div>
                <div className="mt-1 flex min-w-0 items-center justify-between gap-2">
                  {streamAudioLabel && (
                    <div className="truncate text-[10px] text-muted-foreground">
                      {streamAudioLabel}
                    </div>
                  )}
                  {streamHasAudio && (
                    <Tooltip delayDuration={400}>
                      <TooltipTrigger asChild>
                        <button
                          type="button"
                          onClick={handleToggleStreamAudio}
                          aria-label={streamAudioToggleLabel}
                          className={cn(
                            'inline-flex shrink-0 items-center gap-1 rounded bg-background/60 px-1.5 py-0.5 text-[9px] font-medium transition-colors hover:bg-background',
                            streamAudioEnabled ? 'text-muted-foreground hover:text-foreground' : 'text-red-300',
                          )}
                        >
                          {streamAudioEnabled ? <Volume2 className="h-3 w-3" /> : <VolumeX className="h-3 w-3" />}
                          {streamAudioEnabled ? t('streams.soundOn') : t('streams.soundOff')}
                        </button>
                      </TooltipTrigger>
                      <TooltipContent side="top">{streamAudioToggleLabel}</TooltipContent>
                    </Tooltip>
                  )}
                </div>
              </div>
            )}

            <div className="flex items-start gap-3">
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <div className="grid h-9 w-9 shrink-0 place-items-center rounded-xl bg-emerald-500/10 text-emerald-400 ring-1 ring-emerald-400/10">
                    <Radio className={cn('h-4 w-4', isTransient && 'animate-pulse')} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="font-semibold text-emerald-300">
                  {pingLabel}
                </TooltipContent>
              </Tooltip>

              <div className="min-w-0 flex-1">
                <button
                  type="button"
                  onClick={() => setIsDetailsOpen((value) => !value)}
                  className="block max-w-full text-left"
                >
                  <div className={cn('truncate text-sm font-semibold hover:text-emerald-200', status.color)}>
                    {status.text}
                  </div>
                </button>
                <button
                  type="button"
                  onClick={handleChannelClick}
                  className="mt-0.5 block max-w-full truncate text-left text-xs text-zinc-500 transition-colors hover:text-zinc-300"
                >
                  {connectionSubtitle}
                </button>
              </div>

              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    onClick={leaveVoice}
                    aria-label={disconnectLabel}
                    className="rounded-xl p-2 text-zinc-400 transition-colors hover:bg-red-500/10 hover:text-red-300"
                  >
                    <PhoneOff className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{disconnectLabel}</TooltipContent>
              </Tooltip>
            </div>

            <div className="mt-3 grid grid-cols-4 gap-2">
              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleCamera}
                    aria-label={cameraLabel}
                    className={cn(
                      'grid h-9 place-items-center rounded-xl text-sm transition-colors',
                      localCameraEnabled
                        ? 'bg-primary/20 text-primary hover:bg-primary/30'
                        : 'bg-white/[0.055] text-zinc-300 hover:bg-white/[0.09] hover:text-zinc-100',
                    )}
                  >
                    {localCameraEnabled ? <Video className="h-4 w-4" /> : <VideoOff className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{cameraLabel}</TooltipContent>
              </Tooltip>

              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    onClick={() => { void handleToggleStream() }}
                    aria-label={streamToggleLabel}
                    className={cn(
                      'grid h-9 place-items-center rounded-xl text-sm transition-colors',
                      isStreamingHere
                        ? 'bg-red-500/15 text-red-400 hover:bg-red-500/25'
                        : 'bg-white/[0.055] text-zinc-300 hover:bg-white/[0.09] hover:text-zinc-100',
                    )}
                  >
                    <Monitor className="h-4 w-4" />
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{streamToggleLabel}</TooltipContent>
              </Tooltip>

              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleMute}
                    aria-label={muteLabel}
                    className={cn(
                      'grid h-9 place-items-center rounded-xl text-sm transition-colors',
                      localMuted
                        ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                        : localSpeaking
                          ? 'bg-emerald-500/20 text-emerald-400 hover:bg-emerald-500/30'
                          : 'bg-white/[0.055] text-zinc-300 hover:bg-white/[0.09] hover:text-zinc-100',
                    )}
                  >
                    {localMuted ? <MicOff className="h-4 w-4" /> : <Mic className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{muteLabel}</TooltipContent>
              </Tooltip>

              <Tooltip delayDuration={400}>
                <TooltipTrigger asChild>
                  <button
                    onClick={toggleDeafen}
                    aria-label={deafenLabel}
                    className={cn(
                      'grid h-9 place-items-center rounded-xl text-sm transition-colors',
                      localDeafened
                        ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                        : 'bg-white/[0.055] text-zinc-300 hover:bg-white/[0.09] hover:text-zinc-100',
                    )}
                  >
                    {localDeafened ? <HeadphoneOff className="h-4 w-4" /> : <Headphones className="h-4 w-4" />}
                  </button>
                </TooltipTrigger>
                <TooltipContent side="top">{deafenLabel}</TooltipContent>
              </Tooltip>
            </div>
          </div>
          <StartStreamDialog
            open={streamDialogOpen}
            isStarting={isStartingStream}
            onOpenChange={setStreamDialogOpen}
            onStart={handleStartStream}
          />
        </div>
  )
}
