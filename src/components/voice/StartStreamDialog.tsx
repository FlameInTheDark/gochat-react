import { useEffect, useState, type ReactNode } from 'react'
import { Monitor, Volume2, Layers3 } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Label } from '@/components/ui/label'
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/components/ui/select'
import { cn } from '@/lib/utils'
import { getSupportedStreamAudioModes } from '@/services/streamService'
import {
  DEFAULT_STREAM_QUALITY,
  STREAM_FRAME_RATE_OPTIONS,
  STREAM_RESOLUTION_OPTIONS,
  type StreamAudioMode,
  type StreamFrameRate,
  type StreamQualitySettings,
  type StreamResolution,
  type StreamSourceType,
} from '@/services/streamApi'

interface StartStreamDialogProps {
  open: boolean
  isStarting: boolean
  onOpenChange: (open: boolean) => void
  onStart: (sourceType: StreamSourceType, audioMode: StreamAudioMode, quality: StreamQualitySettings) => Promise<void> | void
}

const RESOLUTION_LABEL_KEYS: Record<StreamResolution, string> = {
  '720p': 'streams.resolution720p',
  '1080p': 'streams.resolution1080p',
  '1440p': 'streams.resolution1440p',
  '2160p': 'streams.resolution2160p',
}

export default function StartStreamDialog({
  open,
  isStarting,
  onOpenChange,
  onStart,
}: StartStreamDialogProps) {
  const { t } = useTranslation()
  const [sourceType, setSourceType] = useState<StreamSourceType>('screen')
  const [audioMode, setAudioMode] = useState<StreamAudioMode>('desktop')
  const [resolution, setResolution] = useState<StreamResolution>(DEFAULT_STREAM_QUALITY.resolution)
  const [frameRate, setFrameRate] = useState<StreamFrameRate>(DEFAULT_STREAM_QUALITY.frameRate)

  useEffect(() => {
    if (!open) return
    setSourceType('screen')
    setAudioMode('desktop')
    setResolution(DEFAULT_STREAM_QUALITY.resolution)
    setFrameRate(DEFAULT_STREAM_QUALITY.frameRate)
  }, [open])

  const audioModes = getSupportedStreamAudioModes(sourceType)
  const shareAudio = audioMode !== 'none'
  const preferredAudioMode = (audioModes.find((mode) => mode !== 'none') ?? 'none') as StreamAudioMode

  useEffect(() => {
    if (!audioModes.includes(audioMode)) {
      setAudioMode(audioModes[0] ?? 'none')
    }
  }, [audioMode, audioModes])

  function handleAudioToggle(nextEnabled: boolean) {
    setAudioMode(nextEnabled ? preferredAudioMode : 'none')
  }

  async function handleStart() {
    await onStart(sourceType, audioMode, { resolution, frameRate })
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-lg overflow-hidden border-border/70 bg-background p-0">
        <div className="border-b border-border/70 bg-background px-6 py-5">
          <DialogHeader className="gap-2 text-left">
            <DialogTitle>{t('streams.dialogTitle')}</DialogTitle>
            <DialogDescription>{t('streams.dialogDescription')}</DialogDescription>
          </DialogHeader>
        </div>

        <div className="space-y-4 px-6 py-5">
          <section className="space-y-2.5">
            <p className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
              {t('streams.sourceLabel')}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <StreamChoiceButton
                title={t('streams.sourceScreen')}
                description={t('streams.sourceScreenHint')}
                icon={<Monitor className="w-4 h-4" />}
                selected={sourceType === 'screen'}
                onClick={() => setSourceType('screen')}
              />
              <StreamChoiceButton
                title={t('streams.sourceApplication')}
                description={t('streams.sourceApplicationHint')}
                icon={<Layers3 className="w-4 h-4" />}
                selected={sourceType === 'application'}
                onClick={() => setSourceType('application')}
              />
            </div>
          </section>

          <section className="rounded-2xl border border-border/70 bg-muted/35 px-4 py-4">
            <div className="flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="text-sm font-medium text-foreground">{t('streams.shareAudio')}</p>
                <p className="truncate text-xs text-muted-foreground">
                  {shareAudio
                    ? t(preferredAudioMode === 'desktop' ? 'streams.audioDesktop' : 'streams.audioApplication')
                    : t('streams.audioNone')}
                </p>
              </div>
              <button
                type="button"
                role="switch"
                aria-checked={shareAudio}
                onClick={() => handleAudioToggle(!shareAudio)}
                className={cn(
                  'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full border transition-colors',
                  shareAudio
                    ? 'border-primary/60 bg-primary/20'
                    : 'border-border/70 bg-background',
                )}
              >
                <span
                  className={cn(
                    'pointer-events-none inline-flex h-5 w-5 items-center justify-center rounded-full bg-white text-slate-700 shadow-sm transition-transform',
                    shareAudio ? 'translate-x-5' : 'translate-x-0.5',
                  )}
                >
                  <Volume2 className="h-3 w-3" />
                </span>
              </button>
            </div>

            <div className="mt-4 grid gap-3 sm:grid-cols-2">
              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {t('streams.resolutionLabel')}
                </Label>
                <Select value={resolution} onValueChange={(value) => setResolution(value as StreamResolution)}>
                  <SelectTrigger className="w-full justify-between rounded-xl bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STREAM_RESOLUTION_OPTIONS.map((option) => (
                      <SelectItem key={option} value={option}>
                        {t(RESOLUTION_LABEL_KEYS[option])}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>

              <div className="space-y-1.5">
                <Label className="text-xs font-semibold uppercase tracking-[0.18em] text-muted-foreground">
                  {t('streams.frameRateLabel')}
                </Label>
                <Select value={String(frameRate)} onValueChange={(value) => setFrameRate(Number(value) as StreamFrameRate)}>
                  <SelectTrigger className="w-full justify-between rounded-xl bg-background">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent>
                    {STREAM_FRAME_RATE_OPTIONS.map((option) => (
                      <SelectItem key={option} value={String(option)}>
                        {t(
                          option === 15
                            ? 'streams.frameRate15'
                            : option === 30
                              ? 'streams.frameRate30'
                              : 'streams.frameRate60',
                        )}
                      </SelectItem>
                    ))}
                  </SelectContent>
                </Select>
              </div>
            </div>
          </section>

          <p className="text-xs text-muted-foreground">
            {t('streams.browserCaptureHint')}
          </p>
        </div>

        <DialogFooter className="border-t border-border/70 px-6 py-4">
          <Button variant="outline" onClick={() => onOpenChange(false)} disabled={isStarting}>
            {t('common.cancel')}
          </Button>
          <Button onClick={() => void handleStart()} disabled={isStarting}>
            {isStarting ? t('streams.starting') : t('streams.start')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function StreamChoiceButton({
  title,
  description,
  icon,
  selected,
  onClick,
}: {
  title: string
  description: string
  icon: ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        'rounded-2xl border px-4 py-3 text-left transition-all',
        selected
          ? 'border-primary/70 bg-primary/8 shadow-[0_0_0_1px_rgba(99,102,241,0.12)]'
          : 'border-border/70 bg-card/60 hover:border-primary/40 hover:bg-card',
      )}
    >
      <div className="flex items-center gap-2 text-sm font-medium text-foreground">
        <span className={cn(
          'flex h-6 w-6 items-center justify-center rounded-full',
          selected ? 'bg-primary/15 text-primary' : 'bg-muted text-muted-foreground',
        )}>
          {icon}
        </span>
        {title}
      </div>
      <p className="mt-1 text-xs leading-5 text-muted-foreground">{description}</p>
    </button>
  )
}
