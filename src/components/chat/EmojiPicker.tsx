import { useEffect, useRef, useState } from 'react'
import emojiGroupsData from 'unicode-emoji-json/data-by-group.json'
import {
  Clock,
  Gamepad2,
  Heart,
  Lamp,
  PawPrint,
  Plane,
  Smile,
  UserRound,
  UtensilsCrossed,
  Flag,
  type LucideIcon,
} from 'lucide-react'

// ── Types ────────────────────────────────────────────────────────────────────

interface EmojiEntry {
  emoji: string
  name: string
  slug: string
  skin_tone_support: boolean
  group?: string
}

// ── Data setup ───────────────────────────────────────────────────────────────

const iconMap: Record<string, LucideIcon> = {
  smileys_emotion: Smile,
  people_body: UserRound,
  animals_nature: PawPrint,
  food_drink: UtensilsCrossed,
  travel_places: Plane,
  activities: Gamepad2,
  objects: Lamp,
  symbols: Heart,
  flags: Flag,
}

const emojiGroups = emojiGroupsData.map((group) => ({
  ...group,
  emojis: group.emojis.map((emoji) => ({ ...emoji, group: group.slug })),
}))

const allEmojis: EmojiEntry[] = emojiGroups.flatMap((g) => g.emojis)
const emojiIndex = new Map<string, EmojiEntry>(allEmojis.map((e) => [e.emoji, e]))

interface CategoryMeta {
  slug: string
  name: string
  icon: LucideIcon
  emojis: EmojiEntry[]
}

const categories: CategoryMeta[] = emojiGroups.map((group) => ({
  slug: group.slug,
  name: group.name,
  icon: iconMap[group.slug] ?? Smile,
  emojis: group.emojis,
}))

// ── Constants ─────────────────────────────────────────────────────────────────

const RECENT_KEY = 'gochat_recent_emojis'
const RECENT_MAX = 54

// ── Helpers ──────────────────────────────────────────────────────────────────

function formatName(name: string): string {
  return name
    .split(' ')
    .map((w) => w.charAt(0).toUpperCase() + w.slice(1))
    .join(' ')
}

function loadRecent(): string[] {
  try {
    const stored = localStorage.getItem(RECENT_KEY)
    if (stored) {
      const parsed: unknown = JSON.parse(stored)
      if (Array.isArray(parsed)) return parsed.filter((v): v is string => typeof v === 'string')
    }
  } catch {
    // ignore
  }
  return []
}

// ── Component ─────────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
}

export default function EmojiPicker({ onSelect }: EmojiPickerProps) {
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>(categories[0]?.slug ?? '')
  const [previewEmoji, setPreviewEmoji] = useState<EmojiEntry | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sectionRefsMap = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const prevSearchRef = useRef('')

  // Persist recent to localStorage
  useEffect(() => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)))
  }, [recent])

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Reset scroll to top when search term changes; update activeCategory
  useEffect(() => {
    const trimmed = search.trim()
    if (trimmed !== prevSearchRef.current && scrollRef.current) {
      scrollRef.current.scrollTop = 0
    }
    prevSearchRef.current = trimmed

    if (trimmed) {
      setActiveCategory('search')
    } else if (activeCategory === 'search') {
      setActiveCategory(recent.length > 0 ? 'recent' : (categories[0]?.slug ?? ''))
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search])

  // IntersectionObserver to track active category while scrolling
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        if (search.trim()) return
        const visible = entries
          .filter((e) => e.isIntersecting && e.intersectionRatio > 0)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)
        if (visible.length > 0) {
          const slug = visible[0].target.getAttribute('data-slug')
          if (slug) setActiveCategory(slug)
        }
      },
      { root, threshold: 0.4 },
    )

    sectionRefsMap.current.forEach((node) => {
      observerRef.current!.observe(node)
    })

    return () => {
      observerRef.current?.disconnect()
      observerRef.current = null
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function registerSection(node: HTMLElement | null, slug: string) {
    if (node) {
      sectionRefsMap.current.set(slug, node)
      observerRef.current?.observe(node)
    } else {
      const prev = sectionRefsMap.current.get(slug)
      if (prev) observerRef.current?.unobserve(prev)
      sectionRefsMap.current.delete(slug)
    }
  }

  function scrollToCategory(slug: string) {
    const node = sectionRefsMap.current.get(slug)
    if (node) {
      node.scrollIntoView({ block: 'start' })
      setActiveCategory(slug)
    }
  }

  function handleSelect(entry: EmojiEntry) {
    onSelect(entry.emoji)
    setRecent((prev) => [entry.emoji, ...prev.filter((e) => e !== entry.emoji)].slice(0, RECENT_MAX))
  }

  function handlePointerEnter(entry: EmojiEntry) {
    setPreviewEmoji(entry)
  }

  function handleSearchKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key !== 'Enter') return
    e.preventDefault()
    const trimmed = search.trim().toLowerCase()
    const result = trimmed
      ? allEmojis.find(
          (em) => em.name.toLowerCase().includes(trimmed) || em.slug.toLowerCase().includes(trimmed),
        )
      : recent.length > 0
        ? (emojiIndex.get(recent[0]) ?? categories[0]?.emojis[0])
        : categories[0]?.emojis[0]
    if (result) handleSelect(result)
  }

  // Set initial preview once on mount
  useEffect(() => {
    if (!previewEmoji) {
      const fallback =
        recent.length > 0
          ? (emojiIndex.get(recent[0]) ?? categories[0]?.emojis[0])
          : categories[0]?.emojis[0]
      if (fallback) setPreviewEmoji(fallback)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trimmedSearch = search.trim().toLowerCase()

  const searchResults = trimmedSearch
    ? allEmojis.filter(
        (em) =>
          em.name.toLowerCase().includes(trimmedSearch) ||
          em.slug.toLowerCase().includes(trimmedSearch),
      )
    : []

  const recentEntries = recent
    .map((v) => emojiIndex.get(v) ?? { emoji: v, name: v, slug: v, skin_tone_support: false })
    .filter(Boolean) as EmojiEntry[]

  // Left sidebar nav: recent (if any) + all categories
  const navCategories: Array<{ slug: string; name: string; icon: LucideIcon }> = [
    ...(recent.length > 0 ? [{ slug: 'recent', name: 'Frequently Used', icon: Clock }] : []),
    ...categories,
  ]

  return (
    <div className="w-[420px] rounded-xl border border-border bg-popover text-popover-foreground shadow-xl">
      {/* Search */}
      <div className="border-b border-border px-3 py-2">
        <input
          ref={searchRef}
          type="search"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder="Search emoji"
          aria-label="Search emoji"
          className="h-9 w-full rounded-md border border-transparent bg-muted px-3 text-sm text-foreground placeholder:text-muted-foreground focus:border-border focus:outline-none"
        />
      </div>

      {/* Body: left category sidebar + right emoji grid */}
      <div className="flex" style={{ height: 320 }}>
        {/* Left category sidebar — scrollable */}
        <div className="flex flex-col gap-0.5 overflow-y-auto border-r border-border p-1.5 shrink-0">
          {navCategories.map((cat) => {
            const Icon = cat.icon
            const isActive = activeCategory === cat.slug && !trimmedSearch
            return (
              <button
                key={cat.slug}
                type="button"
                title={cat.name}
                onClick={() => {
                  setSearch('')
                  scrollToCategory(cat.slug)
                }}
                className={`grid h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
                  isActive ? 'bg-muted text-foreground' : ''
                }`}
              >
                <Icon className="h-4 w-4" strokeWidth={2} />
              </button>
            )
          })}
        </div>

        {/* Right emoji grid — scrollable */}
        <div ref={scrollRef} className="flex-1 overflow-y-auto px-2">
          {trimmedSearch ? (
            <>
              <div className="py-3 text-xs uppercase tracking-wide text-muted-foreground">
                Search Results
              </div>
              {searchResults.length === 0 ? (
                <div className="pb-6 text-sm text-muted-foreground">
                  No emoji found for &ldquo;{search}&rdquo;.
                </div>
              ) : (
                <div className="grid grid-cols-8 gap-0.5 pb-4">
                  {searchResults.map((em) => (
                    <EmojiButton key={em.emoji} entry={em} onSelect={handleSelect} onHover={handlePointerEnter} />
                  ))}
                </div>
              )}
            </>
          ) : (
            <>
              {recentEntries.length > 0 && (
                <section
                  ref={(node) => registerSection(node, 'recent')}
                  data-slug="recent"
                  className="pt-3"
                >
                  <div className="flex items-center justify-between pb-2">
                    <span className="text-xs uppercase tracking-wide text-muted-foreground">
                      Frequently Used
                    </span>
                    <button
                      type="button"
                      onClick={() => setRecent([])}
                      className="text-xs text-muted-foreground hover:text-foreground transition-colors"
                    >
                      Clear
                    </button>
                  </div>
                  <div className="grid grid-cols-8 gap-0.5 pb-4">
                    {recentEntries.map((em) => (
                      <EmojiButton key={em.emoji} entry={em} onSelect={handleSelect} onHover={handlePointerEnter} />
                    ))}
                  </div>
                </section>
              )}
              {categories.map((cat) => (
                <section
                  key={cat.slug}
                  ref={(node) => registerSection(node, cat.slug)}
                  data-slug={cat.slug}
                  className="pt-3"
                >
                  <div className="pb-2 text-xs uppercase tracking-wide text-muted-foreground">
                    {cat.name}
                  </div>
                  <div className="grid grid-cols-8 gap-0.5 pb-4">
                    {cat.emojis.map((em) => (
                      <EmojiButton key={em.emoji} entry={em} onSelect={handleSelect} onHover={handlePointerEnter} />
                    ))}
                  </div>
                </section>
              ))}
            </>
          )}
        </div>
      </div>

      {/* Preview strip */}
      <div className="border-t border-border px-3 py-3">
        <div className="flex min-h-[56px] items-center gap-3">
          {previewEmoji ? (
            <>
              <div className="emoji-preview text-4xl leading-none">{previewEmoji.emoji}</div>
              <div className="min-w-0">
                <div className="truncate text-sm font-medium text-foreground">
                  {formatName(previewEmoji.name ?? previewEmoji.emoji)}
                </div>
                <div className="truncate text-xs text-muted-foreground">
                  :{previewEmoji.slug.replace(/\s+/g, '_')}:
                </div>
              </div>
            </>
          ) : (
            <div className="text-xs text-muted-foreground">Hover an emoji to preview it here.</div>
          )}
        </div>
      </div>
    </div>
  )
}

// ── EmojiButton ───────────────────────────────────────────────────────────────

interface EmojiButtonProps {
  entry: EmojiEntry
  onSelect: (entry: EmojiEntry) => void
  onHover: (entry: EmojiEntry) => void
}

function EmojiButton({ entry, onSelect, onHover }: EmojiButtonProps) {
  return (
    <button
      type="button"
      title={formatName(entry.name ?? entry.emoji)}
      onPointerEnter={() => onHover(entry)}
      onClick={() => onSelect(entry)}
      className="emoji-button grid h-9 w-9 place-items-center rounded-md text-2xl transition-colors hover:bg-muted"
    >
      {entry.emoji}
    </button>
  )
}
