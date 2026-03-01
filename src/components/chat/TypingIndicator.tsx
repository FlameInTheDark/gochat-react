import { useTypingStore } from '@/stores/typingStore'

interface Props {
  channelId: string
}

export default function TypingIndicator({ channelId }: Props) {
  // Subscribe to the typing entry for this channel specifically
  const typingEntry = useTypingStore((s) => s.typing[channelId])
  const names = typingEntry ? Object.values(typingEntry).map((u) => u.name) : []

  if (names.length === 0) return null

  let label: string
  if (names.length === 1) {
    label = `${names[0]} is typing`
  } else if (names.length === 2) {
    label = `${names[0]} and ${names[1]} are typing`
  } else {
    label = 'Several people are typing'
  }

  return (
    <div className="flex items-center gap-1.5 px-4 pb-1 h-5 shrink-0">
      {/* Animated bouncing dots */}
      <div className="flex gap-[3px] items-end h-3">
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:0ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:150ms]" />
        <span className="w-1.5 h-1.5 rounded-full bg-muted-foreground/70 animate-bounce [animation-delay:300ms]" />
      </div>
      <span className="text-xs text-muted-foreground italic">{label}…</span>
    </div>
  )
}
