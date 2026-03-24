import { useState, useRef, useEffect } from 'react'
import { useTranslation } from 'react-i18next'
import { createPortal } from 'react-dom'
import { emojiUrl } from '@/lib/emoji'
import { emojiApi } from '@/api/client'
import AnimatedImage from '@/components/ui/AnimatedImage'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import type { DtoEmojiInfo } from '@/client'

interface CustomEmojiImageProps {
  emojiId: string
  emojiName: string
  className?: string
}

interface DetailPanel {
  rect: DOMRect
  info: DtoEmojiInfo | null
  loading: boolean
  error: boolean
}

export default function CustomEmojiImage({ emojiId, emojiName, className }: CustomEmojiImageProps) {
  const { t } = useTranslation()
  const [panel, setPanel] = useState<DetailPanel | null>(null)
  const imgRef = useRef<HTMLSpanElement>(null)

  // Close panel when clicking outside
  useEffect(() => {
    if (!panel) return
    function onPointerDown(e: PointerEvent) {
      const el = document.getElementById('emoji-inline-detail-panel')
      if (el && !el.contains(e.target as Node)) setPanel(null)
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [!!panel])

  async function handleClick() {
    const rect = imgRef.current?.getBoundingClientRect()
    if (!rect) return

    // Toggle
    if (panel) {
      setPanel(null)
      return
    }

    setPanel({ rect, info: null, loading: true, error: false })

    try {
      const res = await emojiApi.infoEmojiEmojiIdGet({ emojiId: emojiId as unknown as number })
      setPanel((prev) => prev ? { ...prev, info: res.data, loading: false } : prev)
    } catch {
      setPanel((prev) => prev ? { ...prev, loading: false, error: true } : prev)
    }
  }

  const src = emojiUrl(emojiId, 44)

  return (
    <TooltipProvider>
      <Tooltip delayDuration={500}>
        <TooltipTrigger asChild>
          <span
            ref={imgRef}
            role="button"
            tabIndex={0}
            onClick={() => void handleClick()}
            onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') void handleClick() }}
            className="inline-block cursor-pointer"
            data-message-interactive="true"
          >
            <AnimatedImage
              src={src}
              pauseFallback={src}
              alt={`:${emojiName}:`}
              className={className}
            />
          </span>
        </TooltipTrigger>
        <TooltipContent side="top" className="flex flex-col items-center gap-1.5 px-3 py-2.5">
          <img
            src={emojiUrl(emojiId, 96)}
            alt={emojiName}
            className="h-10 w-10 object-contain"
            draggable={false}
          />
          <span className="text-xs font-semibold">:{emojiName}:</span>
          <span className="text-[10px] opacity-60">{t('emojiDetail.clickToSeeDetails')}</span>
        </TooltipContent>
      </Tooltip>

      {panel && createPortal(
        <div
          id="emoji-inline-detail-panel"
          className="fixed z-[110] w-56 rounded-lg border border-border bg-popover p-4 shadow-xl"
          style={(() => {
            const r = panel.rect
            const panelW = 224
            const panelH = 172
            let left = r.right + 8
            if (left + panelW > window.innerWidth - 8) left = r.left - panelW - 8
            let top = r.top
            if (top + panelH > window.innerHeight - 8) top = window.innerHeight - panelH - 8
            return { top: Math.max(8, top), left: Math.max(8, left) }
          })()}
        >
          {panel.loading ? (
            <div className="flex items-center justify-center py-6">
              <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-foreground" />
            </div>
          ) : panel.error ? (
            <p className="text-center text-xs text-muted-foreground">{t('emojiDetail.loadFailed')}</p>
          ) : panel.info ? (
            <div className="flex flex-col gap-3">
              <div className="flex items-center gap-3">
                <img
                  src={emojiUrl(emojiId, 96)}
                  alt={panel.info.name ?? emojiName}
                  className="h-12 w-12 shrink-0 object-contain"
                  draggable={false}
                />
                <p className="font-semibold text-sm leading-tight">:{panel.info.name ?? emojiName}:</p>
              </div>
              {panel.info.server_name ? (
                <>
                  <p className="text-[11px] font-semibold uppercase tracking-wide text-muted-foreground">
                    {t('emojiDetail.emojiIsFrom')}
                  </p>
                  <div className="flex items-center gap-2.5 min-w-0">
                    {panel.info.icon?.url ? (
                      <img
                        src={panel.info.icon.url}
                        alt={panel.info.server_name}
                        className="h-10 w-10 shrink-0 rounded-xl object-cover"
                      />
                    ) : (
                      <div className="flex h-10 w-10 shrink-0 items-center justify-center rounded-xl bg-muted text-sm font-bold text-foreground">
                        {panel.info.server_name.charAt(0).toUpperCase()}
                      </div>
                    )}
                    <span className="truncate text-sm font-semibold text-foreground">
                      {panel.info.server_name}
                    </span>
                  </div>
                </>
              ) : (
                <p className="text-xs text-muted-foreground">{t('emojiDetail.serverPrivate')}</p>
              )}
            </div>
          ) : null}
        </div>,
        document.body,
      )}
    </TooltipProvider>
  )
}
