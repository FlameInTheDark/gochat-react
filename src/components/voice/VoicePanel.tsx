import { Mic, MicOff, Headphones, HeadphoneOff, PhoneOff } from 'lucide-react'
import { useVoiceStore } from '@/stores/voiceStore'
import { leaveVoice, setMuted, setDeafened } from '@/services/voiceService'
import { cn } from '@/lib/utils'

export default function VoicePanel() {
  const channelId = useVoiceStore((s) => s.channelId)
  const channelName = useVoiceStore((s) => s.channelName)
  const localMuted = useVoiceStore((s) => s.localMuted)
  const localDeafened = useVoiceStore((s) => s.localDeafened)

  if (!channelId) return null

  function toggleMute() {
    setMuted(!localMuted)
  }

  function toggleDeafen() {
    setDeafened(!localDeafened)
  }

  return (
    <div className="px-2 py-2 bg-sidebar-accent border-t border-sidebar-border shrink-0">
      {/* Status line */}
      <div className="flex items-center gap-2 mb-1.5 px-1">
        <span className="w-2 h-2 rounded-full bg-green-500 shrink-0" />
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium text-green-400 leading-tight">Voice Connected</p>
          <p className="text-[10px] text-muted-foreground truncate leading-tight">
            {channelName ?? channelId}
          </p>
        </div>
      </div>

      {/* Controls */}
      <div className="flex gap-1">
        <button
          onClick={toggleMute}
          title={localMuted ? 'Unmute' : 'Mute'}
          className={cn(
            'flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors',
            localMuted
              ? 'bg-destructive/20 text-destructive hover:bg-destructive/30'
              : 'hover:bg-accent text-muted-foreground hover:text-foreground',
          )}
        >
          {localMuted ? <MicOff className="w-4 h-4" /> : <Mic className="w-4 h-4" />}
        </button>

        <button
          onClick={toggleDeafen}
          title={localDeafened ? 'Undeafen' : 'Deafen'}
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
          onClick={leaveVoice}
          title="Disconnect from voice"
          className="flex-1 flex items-center justify-center p-1.5 rounded text-sm transition-colors hover:bg-destructive/20 text-muted-foreground hover:text-destructive"
        >
          <PhoneOff className="w-4 h-4" />
        </button>
      </div>
    </div>
  )
}
