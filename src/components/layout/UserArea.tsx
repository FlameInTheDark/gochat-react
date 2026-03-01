import { useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { Circle, CircleDot, MinusCircle, Moon, Pencil, Settings, X } from 'lucide-react'
import { toast } from 'sonner'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import {
  Dialog,
  DialogContent,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
  DropdownMenuLabel,
} from '@/components/ui/dropdown-menu'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { useAuthStore } from '@/stores/authStore'
import { usePresenceStore, STATUS_META, type UserStatus } from '@/stores/presenceStore'
import { sendPresenceStatus } from '@/services/wsService'
import { useUiStore } from '@/stores/uiStore'
import { userApi } from '@/api/client'
import type { ModelUserSettingsData } from '@/client'
import { cn } from '@/lib/utils'
import StatusDot from '@/components/ui/StatusDot'

const MAX_STATUS_LEN = 128

const STATUS_ICONS: Record<UserStatus, React.ReactNode> = {
  online: <Circle className="w-3.5 h-3.5 fill-green-500 text-green-500" />,
  idle: <Moon className="w-3.5 h-3.5 text-yellow-500" />,
  dnd: <MinusCircle className="w-3.5 h-3.5 text-red-500" />,
  offline: <CircleDot className="w-3.5 h-3.5 text-gray-500" />,
}

export default function UserArea() {
  const queryClient = useQueryClient()
  const user = useAuthStore((s) => s.user)
  const ownStatus = usePresenceStore((s) => s.ownStatus)
  const setOwnStatus = usePresenceStore((s) => s.setOwnStatus)
  const customStatusText = usePresenceStore((s) => s.customStatusText)
  const setCustomStatusText = usePresenceStore((s) => s.setCustomStatusText)
  const openAppSettings = useUiStore((s) => s.openAppSettings)

  const [dialogOpen, setDialogOpen] = useState(false)
  const [draft, setDraft] = useState('')
  const [saving, setSaving] = useState(false)

  function handleStatusChange(status: UserStatus) {
    setOwnStatus(status)
    sendPresenceStatus(status)
  }

  function openDialog() {
    setDraft(customStatusText)
    setDialogOpen(true)
  }

  // Fetch-then-merge settings and save custom status text.
  // Pass text='' to clear.
  async function saveCustomStatus(text: string) {
    setSaving(true)
    try {
      const settingsRes = await userApi.userMeSettingsGet()
      const existing: ModelUserSettingsData = settingsRes.data?.settings ?? {}
      await userApi.userMeSettingsPost({
        request: {
          ...existing,
          status: {
            ...existing.status,
            status: ownStatus,
            custom_status_text: text || undefined,
          },
        },
      })
      // Update local state and WS
      setCustomStatusText(text)
      sendPresenceStatus(ownStatus, text)
      await queryClient.invalidateQueries({ queryKey: ['user-settings'] })
      setDialogOpen(false)
      toast.success(text ? 'Custom status updated' : 'Custom status cleared')
    } catch {
      toast.error('Failed to save custom status')
    } finally {
      setSaving(false)
    }
  }

  const initials = (user?.name ?? '?').charAt(0).toUpperCase()

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button className="flex items-center gap-2 w-full px-1 py-1.5 rounded hover:bg-accent transition-colors focus:outline-none">
            {/* Avatar with status dot */}
            <div className="relative shrink-0">
              <Avatar className="w-8 h-8">
                <AvatarImage src={user?.avatar?.url} alt={user?.name ?? ''} className="object-cover" />
                <AvatarFallback className="text-xs">{initials}</AvatarFallback>
              </Avatar>
              <StatusDot
                status={ownStatus}
                className="absolute -bottom-0.5 -right-0.5 w-3 h-3"
              />
            </div>

            <div className="flex-1 min-w-0 text-left">
              <p className="text-xs font-semibold truncate leading-tight">{user?.name ?? '…'}</p>
              {customStatusText ? (
                /* Custom status replaces discriminator when set */
                <p className="text-[10px] text-muted-foreground truncate leading-tight italic">
                  {customStatusText}
                </p>
              ) : user?.discriminator ? (
                <p className="text-[10px] text-muted-foreground truncate leading-tight">
                  #{user.discriminator}
                </p>
              ) : null}
            </div>
          </button>
        </DropdownMenuTrigger>

        <DropdownMenuContent side="top" align="start" className="w-56">
          <DropdownMenuLabel className="text-xs font-normal opacity-60">
            Signed in as {user?.name}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {/* Custom status row */}
          <DropdownMenuItem onClick={openDialog} className="gap-2">
            <Pencil className="w-4 h-4 shrink-0" />
            <span className={cn('flex-1 truncate', !customStatusText && 'text-muted-foreground')}>
              {customStatusText || 'Set Custom Status'}
            </span>
            {customStatusText && (
              /* X clears status without opening the dialog */
              <span
                role="button"
                aria-label="Clear custom status"
                className="text-muted-foreground hover:text-foreground transition-colors shrink-0"
                onClick={(e) => {
                  e.stopPropagation()
                  void saveCustomStatus('')
                }}
              >
                <X className="w-3.5 h-3.5" />
              </span>
            )}
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          {/* Status selector */}
          <DropdownMenuLabel className="text-xs font-semibold uppercase tracking-wide text-muted-foreground pb-0.5">
            Set Status
          </DropdownMenuLabel>
          {(Object.keys(STATUS_META) as UserStatus[]).map((status) => (
            <DropdownMenuItem
              key={status}
              onClick={() => handleStatusChange(status)}
              className="gap-2"
            >
              {STATUS_ICONS[status]}
              <span>{STATUS_META[status].label}</span>
              {ownStatus === status && (
                <span className="ml-auto text-muted-foreground text-xs">✓</span>
              )}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
          <DropdownMenuItem onClick={openAppSettings} className="gap-2">
            <Settings className="w-4 h-4" />
            Settings
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      {/* ── Custom Status Dialog ────────────────────────────────────────────── */}
      <Dialog open={dialogOpen} onOpenChange={(open) => !open && setDialogOpen(false)}>
        <DialogContent className="sm:max-w-sm">
          <DialogHeader>
            <DialogTitle>Set Custom Status</DialogTitle>
          </DialogHeader>

          <div className="py-1">
            <div className="relative">
              <Input
                placeholder="What's on your mind?"
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
            {/* "Clear Status" shown only when a status is currently set */}
            {customStatusText && (
              <Button
                type="button"
                variant="ghost"
                size="sm"
                onClick={() => void saveCustomStatus('')}
                disabled={saving}
              >
                Clear Status
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
                Cancel
              </Button>
              <Button
                type="button"
                size="sm"
                onClick={() => void saveCustomStatus(draft.trim())}
                disabled={saving}
              >
                Save
              </Button>
            </div>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
