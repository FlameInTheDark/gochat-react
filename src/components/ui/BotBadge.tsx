import { cn } from '@/lib/utils'

interface BotBadgeProps {
  className?: string
}

export default function BotBadge({ className }: BotBadgeProps) {
  return (
    <span
      className={cn(
        'inline-flex items-center text-[10px] font-semibold leading-none',
        'text-blue-400 bg-blue-400/10 px-1 py-0.5 rounded-[3px]',
        className,
      )}
    >
      APP
    </span>
  )
}
