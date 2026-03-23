import { useState, useEffect } from 'react'
import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff, Activity, Video, VideoOff } from 'lucide-react'
import { motion, AnimatePresence } from 'motion/react'
import { useVoiceStore } from '@/stores/voiceStore'
import type { VoiceConnectionState } from '@/stores/voiceStore'
import { leaveVoice, setMuted, setDeafened, enableCamera, disableCamera } from '@/services/voiceService'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

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
  const channelName = useVoiceStore((s) => s.channelName)
  const localMuted = useVoiceStore((s) => s.localMuted)
  const localDeafened = useVoiceStore((s) => s.localDeafened)
  const localSpeaking = useVoiceStore((s) => s.localSpeaking)
  const localCameraEnabled = useVoiceStore((s) => s.localCameraEnabled)
  const storePing = useVoiceStore((s) => s.ping)
  const connectionState = useVoiceStore((s) => s.connectionState)
  const [displayPing, setDisplayPing] = useState(0)

  // Update display ping when store ping changes, but keep previous value if it drops to 0
  useEffect(() => {
    if (storePing > 0) {
      setDisplayPing(storePing)
    }
  }, [storePing])

  const status = getConnectionStatus(connectionState, t)
  const isTransient = connectionState === 'connecting' || connectionState === 'routing'
  const pingValue = connectionState === 'connected' && displayPing > 0 ? displayPing : null

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
                <p className="text-[10px] text-muted-foreground truncate leading-tight">
                  {channelName ?? channelId}
                </p>
              </div>
              {/* Ping indicator */}
              <div
                className={cn(
                  'flex items-center gap-1 text-[10px] shrink-0',
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
