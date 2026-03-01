import { cn } from '@/lib/utils'
import { STATUS_META, type UserStatus } from '@/stores/presenceStore'

interface StatusDotProps {
  status: UserStatus
  /** Extra classes to position the dot (e.g. "absolute bottom-0 right-0") */
  className?: string
}

/**
 * A small coloured circle indicating a user's online status.
 * Renders nothing when status is "offline" so it can be unconditionally placed.
 */
export default function StatusDot({ status, className }: StatusDotProps) {
  if (status === 'offline') return null
  const { color } = STATUS_META[status]
  return (
    <span
      className={cn(
        'block w-3 h-3 rounded-full ring-2 ring-sidebar',
        color,
        className,
      )}
      aria-label={STATUS_META[status].label}
    />
  )
}
