import { Bell, BellOff, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
  ContextMenuLabel,
} from '@/components/ui/context-menu'
import { ModelNotificationsType } from '@/client'
import type { ModelUserSettingsNotifications } from '@/client'

interface Props {
  current: ModelUserSettingsNotifications | undefined
  onUpdate: (patch: Partial<ModelUserSettingsNotifications>) => void
}

function muteUntilIso(minutes: number): string {
  return new Date(Date.now() + minutes * 60 * 1000).toISOString()
}

export function NotificationsSubmenu({ current, onUpdate }: Props) {
  const { t } = useTranslation()
  const level = current?.notifications ?? ModelNotificationsType.NotificationsAll

  const mutedUntilDate = current?.muted_until ? new Date(current.muted_until) : null
  const isMuted = current?.muted === true && (!mutedUntilDate || mutedUntilDate > new Date())

  const mutedLabel = isMuted
    ? mutedUntilDate
      ? t('notifications.mutedUntil', {
          time: mutedUntilDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }),
        })
      : t('notifications.mutedIndefinite')
    : null

  return (
    <>
      <ContextMenuSub>
        <ContextMenuSubTrigger className="gap-2">
          <Bell className="w-4 h-4" />
          {t('notifications.title')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          <ContextMenuItem
            onClick={() => onUpdate({ notifications: ModelNotificationsType.NotificationsAll })}
            onSelect={(e) => e.preventDefault()}
            className="gap-2"
          >
            {level === ModelNotificationsType.NotificationsAll
              ? <Check className="w-4 h-4 text-primary" />
              : <span className="w-4 h-4" />}
            {t('notifications.allMessages')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ notifications: ModelNotificationsType.NotificationsMentions })}
            onSelect={(e) => e.preventDefault()}
            className="gap-2"
          >
            {level === ModelNotificationsType.NotificationsMentions
              ? <Check className="w-4 h-4 text-primary" />
              : <span className="w-4 h-4" />}
            {t('notifications.onlyMentions')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ notifications: ModelNotificationsType.NotificationsNone })}
            onSelect={(e) => e.preventDefault()}
            className="gap-2"
          >
            {level === ModelNotificationsType.NotificationsNone
              ? <Check className="w-4 h-4 text-primary" />
              : <span className="w-4 h-4" />}
            {t('notifications.nothing')}
          </ContextMenuItem>

          <ContextMenuSeparator />

          <ContextMenuCheckboxItem
            checked={current?.suppress_everyone_mentions ?? false}
            onCheckedChange={(v) => onUpdate({ suppress_everyone_mentions: v })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.suppressEveryone')}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={current?.suppress_here_mentions ?? false}
            onCheckedChange={(v) => onUpdate({ suppress_here_mentions: v })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.suppressHere')}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={current?.suppress_role_mentions ?? false}
            onCheckedChange={(v) => onUpdate({ suppress_role_mentions: v })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.suppressRole')}
          </ContextMenuCheckboxItem>
          <ContextMenuCheckboxItem
            checked={current?.suppress_user_mentions ?? false}
            onCheckedChange={(v) => onUpdate({ suppress_user_mentions: v })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.suppressUser')}
          </ContextMenuCheckboxItem>
        </ContextMenuSubContent>
      </ContextMenuSub>

      <ContextMenuSub>
        <ContextMenuSubTrigger className="gap-2">
          <BellOff className="w-4 h-4" />
          {t('notifications.mute')}
        </ContextMenuSubTrigger>
        <ContextMenuSubContent>
          {isMuted && (
            <>
              <ContextMenuLabel className="text-xs text-muted-foreground px-2 py-1">
                {mutedLabel}
              </ContextMenuLabel>
              <ContextMenuItem
                onClick={() => onUpdate({ muted: false, muted_until: undefined })}
                onSelect={(e) => e.preventDefault()}
                className="gap-2"
              >
                <Bell className="w-4 h-4" />
                {t('notifications.unmute')}
              </ContextMenuItem>
              <ContextMenuSeparator />
            </>
          )}
          <ContextMenuItem
            onClick={() => onUpdate({ muted: true, muted_until: muteUntilIso(15) })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.muteFor15min')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ muted: true, muted_until: muteUntilIso(60) })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.muteFor1hour')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ muted: true, muted_until: muteUntilIso(480) })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.muteFor8hours')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ muted: true, muted_until: muteUntilIso(1440) })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.muteFor24hours')}
          </ContextMenuItem>
          <ContextMenuItem
            onClick={() => onUpdate({ muted: true, muted_until: undefined })}
            onSelect={(e) => e.preventDefault()}
          >
            {t('notifications.muteIndefinite')}
          </ContextMenuItem>
        </ContextMenuSubContent>
      </ContextMenuSub>
    </>
  )
}
