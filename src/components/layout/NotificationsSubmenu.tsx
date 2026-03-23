import { Bell, Check } from 'lucide-react'
import { useTranslation } from 'react-i18next'
import {
  ContextMenuSub,
  ContextMenuSubContent,
  ContextMenuSubTrigger,
  ContextMenuItem,
  ContextMenuCheckboxItem,
  ContextMenuSeparator,
} from '@/components/ui/context-menu'
import { ModelNotificationsType } from '@/client'
import type { ModelUserSettingsNotifications } from '@/client'

interface Props {
  current: ModelUserSettingsNotifications | undefined
  onUpdate: (patch: Partial<ModelUserSettingsNotifications>) => void
}

export function NotificationsSubmenu({ current, onUpdate }: Props) {
  const { t } = useTranslation()
  const level = current?.notifications ?? ModelNotificationsType.NotificationsAll

  return (
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
  )
}
