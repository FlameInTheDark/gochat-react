import { useState, useEffect } from 'react'
import { useNavigate } from 'react-router'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Activity, Video, VideoOff, ShieldCheck, ShieldOff, ShieldAlert, Copy, Check } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useVoiceStore } from '@/stores/voiceStore'
import type { VoiceConnectionState } from '@/stores/voiceStore'
import { leaveVoice, setMuted, setDeafened, enableCamera, disableCamera } from '@/services/voiceService'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useQuery } from '@tanstack/react-query'
import { voiceApi } from '@/api/client'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'

interface VoiceRegion {
  id?: string
  name?: string
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
    case 'connected':
      return { text: t('voicePanel.connected'), color: 'text-green-400', dotColor: 'bg-green-500' }
    default:
      return { text: t('voicePanel.disconnected'), color: 'text-muted-foreground', dotColor: 'bg-gray-500' }
  }
}

export default function VoicePanel() {
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

  // Update display ping when store ping changes, but keep previous value if it drops to 0
  useEffect(() => {
    if (storePing > 0) {
      setDisplayPing(storePing)
    }
  }, [storePing])

  const privacyCodeChunks = davePrivacyCode ? (davePrivacyCode.match(/.{1,5}/g) ?? []) : []

  function handleCopyPrivacyCode() {
    if (!davePrivacyCode) return
    void navigator.clipboard.writeText(davePrivacyCode).then(() => {
      setPrivacyCodeCopied(true)
      setTimeout(() => setPrivacyCodeCopied(false), 2000)
    })
  }

  const status = getConnectionStatus(connectionState, t)
  const isTransient = connectionState === 'connecting' || connectionState === 'routing'
  const pingValue = connectionState === 'connected' && displayPing > 0 ? displayPing : null

  const navigate = useNavigate()

  function handleChannelClick() {
    if (guildId && channelId) {
      void navigate(`/app/${guildId}/${channelId}`)
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

  return (
    <AnimatePresence>
      {channelId && (
        <motion.div
          initial={{ height: 0, opacity: 0 }}
          animate={{ height: 'auto', opacity: 1 }}
          exit={{ height: 0, opacity: 0 }}
          transition={{ type: 'spring', stiffness: 320, damping: 28 }}
          style={{ overflow: 'hidden' }}
        >
          <div className="px-2 py-2 bg-sidebar-accent border-t border-sidebar-border shrink-0">
            {/* Status line */}
            <div className="flex items-center gap-2 mb-1.5 px-1">
              <span
                className={cn(
                  'w-2 h-2 rounded-full shrink-0',
                  status.dotColor,
                  isTransient && 'animate-pulse',
                )}
              />
              <div className="flex-1 min-w-0">
                <p className={cn('text-xs font-medium leading-tight', status.color)}>{status.text}</p>
                <button
                  onClick={handleChannelClick}
                  className="text-[10px] text-muted-foreground truncate leading-tight hover:text-foreground hover:underline transition-colors text-left w-full block"
                >
                  {guildName ? `${guildName} / ${channelName ?? channelId}` : (channelName ?? channelId)}
                </button>
              </div>
              {/* Ping indicator with tooltip */}
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className="flex items-center gap-1.5 shrink-0 cursor-default">
                    <div
                      className={cn(
                        'flex items-center gap-1 text-[10px]',
                        pingValue === null
                          ? 'text-muted-foreground'
                          : pingValue < 160
                            ? 'text-green-500'
                            : pingValue < 300
                              ? 'text-orange-500'
                              : 'text-red-500',
                      )}
                    >
                      <Activity className="w-3 h-3" />
                      <span>{pingValue !== null ? t('voicePanel.ping', { ping: pingValue }) : '--'}</span>
                    </div>
                    <encryptionInfo.Icon className={cn('w-3 h-3', encryptionInfo.color)} />
                  </div>
                </TooltipTrigger>
                <TooltipContent side="top" className="p-0">
                  <div className="px-3 py-2.5 space-y-1.5 min-w-[180px]">
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-[11px] text-muted-foreground">{t('voicePanel.region')}</span>
                      <span className="text-[11px] font-medium">{regionLabel}</span>
                    </div>
                    {sfuHost && (
                      <div className="flex items-center justify-between gap-4">
                        <span className="text-[11px] text-muted-foreground">{t('voicePanel.host')}</span>
                        <span className="text-[11px] font-medium font-mono">{sfuHost}</span>
                      </div>
                    )}
                    <div className="flex items-center justify-between gap-4">
                      <span className="text-[11px] text-muted-foreground">{t('voicePanel.encryption')}</span>
                      <span className={cn('text-[11px] font-medium flex items-center gap-1', encryptionInfo.color)}>
                        <encryptionInfo.Icon className="w-3 h-3" />
                        {encryptionInfo.label}
                      </span>
                    </div>
                    {encryptionInfo.detail && (
                      <div className="flex items-center justify-end">
                        <span className="text-[10px] text-muted-foreground font-mono">{encryptionInfo.detail}</span>
                      </div>
                    )}
                    {davePrivacyCode && (
                      <div className="pt-1 border-t border-border/50 mt-0.5">
                        <div className="flex items-center justify-between mb-1.5">
                          <p className="text-[10px] text-muted-foreground">{t('voicePanel.privacyCode')}</p>
                          <button
                            onClick={handleCopyPrivacyCode}
                            className="text-muted-foreground hover:text-foreground transition-colors"
                          >
                            {privacyCodeCopied
                              ? <Check className="w-3 h-3 text-green-400" />
                              : <Copy className="w-3 h-3" />}
                          </button>
                        </div>
                        <div className="grid grid-cols-3 gap-1">
                          {privacyCodeChunks.map((chunk, i) => (
                            <span
                              key={i}
                              className="text-[11px] font-mono font-medium text-green-400 bg-green-400/10 rounded px-1.5 py-0.5 tabular-nums text-center"
                            >
                              {chunk}
                            </span>
                          ))}
                        </div>
                        <p className="text-[9px] text-muted-foreground mt-1.5 text-center">{t('voicePanel.privacyCodeHint')}</p>
                      </div>
                    )}
                  </div>
                </TooltipContent>
              </Tooltip>
            </div>

            {/* Controls */}
            <div className="flex gap-1">
              <button
                onClick={toggleMute}
                title={localMuted ? t('voicePanel.unmute') : t('voicePanel.mute')}
                aria-label={localMuted ? t('voicePanel.unmute') : t('voicePanel.mute')}
                className={cn(
                  'flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors',
                  localMuted
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : localSpeaking
                      ? 'bg-green-500/20 text-green-400 hover:bg-green-500/30'
                      : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
              </button>

              <button
                onClick={toggleDeafen}
                title={localDeafened ? t('voicePanel.undeafen') : t('voicePanel.deafen')}
                aria-label={localDeafened ? t('voicePanel.undeafen') : t('voicePanel.deafen')}
                className={cn(
                  'flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors',
                  localDeafened
                    ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
                    : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localDeafened ? (
                  <HeadphoneOff className="w-4 h-4" />
                ) : (
                  <Headphones className="w-4 h-4" />
                )}
              </button>

              <button
                onClick={toggleCamera}
                title={localCameraEnabled ? t('voicePanel.cameraOff') : t('voicePanel.cameraOn')}
                aria-label={localCameraEnabled ? t('voicePanel.cameraOff') : t('voicePanel.cameraOn')}
                className={cn(
                  'flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors',
                  localCameraEnabled
                    ? 'bg-primary/20 text-primary hover:bg-primary/30'
                    : 'hover:bg-accent text-muted-foreground hover:text-foreground',
                )}
              >
                {localCameraEnabled ? <Video className="w-4 h-4" /> : <VideoOff className="w-4 h-4" />}
              </button>

              <button
                onClick={leaveVoice}
                title={t('voicePanel.disconnect')}
                aria-label={t('voicePanel.disconnect')}
                className="flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
              >
                <PhoneOff className="w-4 h-4" />
              </button>
            </div>
          </div>
        </motion.div>
      )}
    </AnimatePresence>
  )
}
