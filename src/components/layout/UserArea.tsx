import { useEffect, useRef, useState, type ReactNode } from 'react'
import { Ban, Check, Circle, Moon, Pencil, Settings } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip'
import { useAuthStore } from '@/stores/authStore'
import { usePresenceStore, STATUS_META, type UserStatus } from '@/stores/presenceStore'
import { sendPresenceStatus } from '@/services/wsService'
import { useUiStore } from '@/stores/uiStore'
import type { ModelUserSettingsData } from '@/client'
import { saveSettings } from '@/lib/settingsApi'
import { queryClient } from '@/lib/queryClient'
import { cn } from '@/lib/utils'
import StatusDot from '@/components/ui/StatusDot'
import { useTranslation } from 'react-i18next'

const MAX_STATUS_LEN = 128

const STATUS_ICONS: Record<UserStatus, ReactNode> = {
  online: <span className="h-3.5 w-3.5 rounded-full bg-emerald-400" />,
  idle: <Moon className="h-4 w-4 text-amber-400" />,
  dnd: <Ban className="h-4 w-4 text-red-500" />,
  offline: <Circle className="h-4 w-4 text-zinc-500" />,
}

interface UserAreaProps {
  className?: string
}

function MenuRow({
  children,
  onClick,
}: {
  children: ReactNode
  onClick?: () => void
}) {
  return (
    <button type="button" onClick={onClick} className="block w-full px-2 py-0.5 text-left">
      <div className="flex h-8 items-center gap-3 rounded-md px-2 text-zinc-200 transition-colors hover:bg-white/[0.09]">
        {children}
      </div>
    </button>
  )
}

export default function UserArea({ className }: UserAreaProps) {
  const user = useAuthStore((s) => s.user)
  const ownStatus = usePresenceStore((s) => s.ownStatus)
  const setOwnStatus = usePresenceStore((s) => s.setOwnStatus)
  const customStatusText = usePresenceStore((s) => s.customStatusText)
  const setCustomStatusText = usePresenceStore((s) => s.setCustomStatusText)
  const openAppSettings = useUiStore((s) => s.openAppSettings)
  const { t } = useTranslation()

  const [dialogOpen, setDialogOpen] = useState(false)
  const [menuOpen, setMenuOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)
  const menuRef = useRef<HTMLDivElement | null>(null)

  useEffect(() => {
    if (!menuOpen) return undefined

    function handlePointerDown(event: PointerEvent) {
      if (menuRef.current && !menuRef.current.contains(event.target as Node)) {
        setMenuOpen(false)
      }
    }

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') setMenuOpen(false)
    }

    document.addEventListener('pointerdown', handlePointerDown)
    document.addEventListener('keydown', handleKeyDown)
    return () => {
      document.removeEventListener('pointerdown', handlePointerDown)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [menuOpen])

  function handleStatusChange(status: UserStatus) {
    setOwnStatus(status)
    sendPresenceStatus(status)
    setMenuOpen(false)
  }

  function openDialog() {
    setDraft(customStatusText)
    setMenuOpen(false)
    setDialogOpen(true)
  }

  // Fetch-then-merge settings and save custom status text.
  // Pass text='' to clear.
  async function saveCustomStatus(text: string) {
    setSaving(true)
    try {
      const existingStatus = queryClient.getQueryData<ModelUserSettingsData>(['user-settings'])?.status ?? {}
      await saveSettings({
        status: { ...existingStatus, status: ownStatus, custom_status_text: text || undefined },
      })
      setCustomStatusText(text)
      sendPresenceStatus(ownStatus, text)
      setDialogOpen(false)
      toast.success(text ? t('userArea.customStatusUpdated') : t('userArea.customStatusCleared'))
    } catch {
      toast.error(t('userArea.customStatusFailed'))
    } finally {
      setSaving(false)
    }
  }

  const initials = (user?.name ?? '?').charAt(0).toUpperCase()
  const statusLabel = STATUS_META[ownStatus].label
  const presenceLine = customStatusText
    ? `${statusLabel} · ${customStatusText}`
    : user?.discriminator
      ? `${statusLabel} · #${user.discriminator}`
      : statusLabel

  return (
    <>
      <div
        ref={menuRef}
        className={cn('relative flex h-[60px] rounded-xl border border-white/[0.08] bg-white/[0.035] p-1.5', className)}
      >
        {menuOpen && (
          <div className="absolute bottom-full left-0 z-50 mb-2 w-60 overflow-hidden rounded-xl border border-white/[0.1] bg-[#15161b] py-2 text-sm text-zinc-200 ring-1 ring-black/20">
            <MenuRow onClick={openDialog}>
              <Pencil className="h-4 w-4 text-zinc-400" />
              <span>{t('userArea.setCustomStatus')}</span>
            </MenuRow>

            <div className="my-2 h-px bg-white/[0.08]" />

            <div className="px-4 pb-1 text-[11px] font-semibold uppercase tracking-wide text-zinc-500">
              {t('userArea.setStatus')}
            </div>

            {(Object.keys(STATUS_META) as UserStatus[]).map((status) => (
              <MenuRow key={status} onClick={() => handleStatusChange(status)}>
                {STATUS_ICONS[status]}
                <span className="flex-1">{STATUS_META[status].label}</span>
                {ownStatus === status && <Check className="h-4 w-4 text-zinc-400" />}
              </MenuRow>
            ))}
          </div>
        )}

        <div className="flex flex-1 items-center gap-2">
          <button
            type="button"
            onClick={() => setMenuOpen((value) => !value)}
            className="flex min-w-0 flex-1 items-center gap-2.5 rounded-lg p-1 text-left transition-colors hover:bg-white/[0.055] focus:outline-none"
          >
            <div className="relative shrink-0">
              <Avatar className="h-8 w-8">
                <AvatarImage src={user?.avatar?.url} alt={user?.name ?? ''} className="object-cover" />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <StatusDot
                status={ownStatus}
                className="absolute -bottom-0.5 -right-0.5 h-3 w-3 border-[#0b0c11]"
              />
            </div>

            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-semibold leading-tight text-foreground">{user?.name ?? '...'}</p>
              <p
                className={cn(
                  'truncate text-xs leading-tight',
                  ownStatus === 'online' ? 'text-emerald-400'
                    : ownStatus === 'idle' ? 'text-amber-300'
                      : ownStatus === 'dnd' ? 'text-red-400'
                        : 'text-muted-foreground',
                )}
              >
                {presenceLine}
              </p>
            </div>
          </button>

          <Tooltip delayDuration={400}>
            <TooltipTrigger asChild>
              <button
                type="button"
                onClick={openAppSettings}
                aria-label={t('userArea.settings')}
                className="grid h-9 w-9 shrink-0 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-white/[0.06] hover:text-foreground"
              >
                <Settings className="h-4 w-4" />
              </button>
            </TooltipTrigger>
            <TooltipContent side="top">{t('userArea.settings')}</TooltipContent>
          </Tooltip>
        </div>
      </div>

      <Dialog open={dialogOpen} onOpenChange={(open) => !open && setDialogOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>{t('userArea.customStatusDialogTitle')}</DialogTitle>
          </DialogHeader>

          <div className="py-1">
            <div className="relative">
              <Input
                placeholder={t('userArea.customStatusPlaceholder')}
                value={draft}
                maxLength={MAX_STATUS_LEN}
                onChange={(e) => setDraft(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' && !e.shiftKey) void saveCustomStatus(draft.trim())
                  if (e.key === 'Escape') setDialogOpen(false)
                }}
                disabled={saving}
                autoFocus
                className="pr-14"
              />
              <span
                className={cn(
                  'absolute right-3 top-1/2 -translate-y-1/2 text-[10px] tabular-nums pointer-events-none',
                  draft.length >= MAX_STATUS_LEN ? 'text-destructive' : 'text-muted-foreground',
                )}
              >
                {draft.length}/{MAX_STATUS_LEN}
              </span>
            </div>
          </div>

          <DialogFooter className="gap-2 sm:justify-between">
            {customStatusText && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void saveCustomStatus('')}
                disabled={saving}
              >
                {t('userArea.clearStatus')}
              </Button>
            )}
            <div className="flex gap-2 ml-auto">
              <Button
                type="button"
                variant="outline"
                size="sm"
                onClick={() => setDialogOpen(false)}
                disabled={saving}
              >
                {t('userArea.cancel')}
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void saveCustomStatus(draft.trim())}
                disabled={saving}
              >
                {t('userArea.save')}
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
