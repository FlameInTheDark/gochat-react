import { memo, useEffect, useRef, useState } from 'react'
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
import { emojiUrl } from '@/lib/emoji'

// ── Types ────────────────────────────────────────────────────────────────────

interface EmojiEntry {
  emoji: string
  name: string
  slug: string
  skin_tone_support: boolean
  group?: string
}

export interface CustomEmojiGroup {
  guildId: string
  guildName: string
  guildIconUrl?: string
  emojis: { id: string; name: string; animated?: boolean }[]
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

// ── Preview types ─────────────────────────────────────────────────────────────

type PreviewItem =
  | { kind: 'unicode'; entry: EmojiEntry }
  | { kind: 'custom'; id: string; name: string }

// ── LazySection ───────────────────────────────────────────────────────────────
// Defers rendering children until the section enters the scroll viewport.
// Receives the *ref object* (not .current) so that the effect can read the
// DOM node after it is committed — avoiding the null-on-first-render problem.

interface LazySectionProps {
  slug: string
  scrollRef: React.RefObject<HTMLDivElement | null>
  registerSection: (node: HTMLElement | null, slug: string) => void
  children: React.ReactNode
  className?: string
  estimatedRows?: number
}

function LazySection({
  slug,
  scrollRef,
  registerSection,
  children,
  className,
  estimatedRows = 4,
}: LazySectionProps) {
  const sectionRef = useRef<HTMLElement | null>(null)
  const [visible, setVisible] = useState(false)

  useEffect(() => {
    // By the time effects run the DOM is committed and all refs are set.
    const root = scrollRef.current
    const node = sectionRef.current
    if (!node) return

    // If the section is already inside the visible area on mount, show it
    // immediately (no observer needed — this covers the first categories).
    if (root) {
      const rect = node.getBoundingClientRect()
      const rootRect = root.getBoundingClientRect()
      if (rect.top < rootRect.bottom + 300) {
        setVisible(true)
        return
      }
    } else {
      // Fallback: no scroll container yet — reveal immediately so content
      // is never permanently hidden.
      setVisible(true)
      return
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting) {
          setVisible(true)
          observer.disconnect()
        }
      },
      { root, rootMargin: '300px 0px', threshold: 0 },
    )
    observer.observe(node)
    return () => observer.disconnect()
    // scrollRef is a stable ref object — safe to use without re-running
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const setRef = (node: HTMLElement | null) => {
    sectionRef.current = node
    registerSection(node, slug)
  }

  const minH = `${estimatedRows * 36}px`

  return (
    <section
      ref={setRef}
      data-slug={slug}
      className={className}
      style={visible ? undefined : { minHeight: minH }}
    >
      {visible ? children : null}
    </section>
  )
}

// ── Component ─────────────────────────────────────────────────────────────────

interface EmojiPickerProps {
  onSelect: (emoji: string) => void
  customEmojiGroups?: CustomEmojiGroup[]
  isMobile?: boolean
}

// How long (ms) to suppress the scroll-observer's category update after a
// programmatic nav-click scroll, to prevent it from clobbering the selection.
const PROGRAMMATIC_SCROLL_GRACE_MS = 600

export default function EmojiPicker({ onSelect, customEmojiGroups, isMobile = false }: EmojiPickerProps) {
  const [recent, setRecent] = useState<string[]>(() => loadRecent())
  const [search, setSearch] = useState('')
  const [activeCategory, setActiveCategory] = useState<string>(categories[0]?.slug ?? '')
  const [previewItem, setPreviewItem] = useState<PreviewItem | null>(null)

  const scrollRef = useRef<HTMLDivElement>(null)
  const searchRef = useRef<HTMLInputElement>(null)
  const sectionRefsMap = useRef(new Map<string, HTMLElement>())
  const observerRef = useRef<IntersectionObserver | null>(null)
  const prevSearchRef = useRef('')
  // Set to true while a programmatic scrollToCategory scroll is in flight
  const programmaticScrollRef = useRef(false)

  // Persist recent to localStorage
  useEffect(() => {
    localStorage.setItem(RECENT_KEY, JSON.stringify(recent.slice(0, RECENT_MAX)))
  }, [recent])

  // Focus search on mount
  useEffect(() => {
    searchRef.current?.focus()
  }, [])

  // Reset scroll / category when search changes
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

  // IntersectionObserver to track active category while the user scrolls
  useEffect(() => {
    const root = scrollRef.current
    if (!root) return

    observerRef.current = new IntersectionObserver(
      (entries) => {
        // Ignore observer firings during/after a programmatic nav-click scroll
        if (programmaticScrollRef.current) return
        if (search.trim()) return

        const visible = entries
          .filter((e) => e.isIntersecting && e.intersectionRatio > 0)
          .sort((a, b) => a.boundingClientRect.top - b.boundingClientRect.top)

        if (visible.length > 0) {
          const slug = visible[0].target.getAttribute('data-slug')
          if (slug) setActiveCategory(slug)
        }
      },
      { root, threshold: 0.1 },
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
    if (!node) return

    // Mark as programmatic so the IntersectionObserver doesn't fight us
    programmaticScrollRef.current = true
    clearTimeout((scrollToCategory as unknown as { _tid?: ReturnType<typeof setTimeout> })._tid)
    ;(scrollToCategory as unknown as { _tid?: ReturnType<typeof setTimeout> })._tid = setTimeout(() => {
      programmaticScrollRef.current = false
    }, PROGRAMMATIC_SCROLL_GRACE_MS)

    node.scrollIntoView({ block: 'start' })
    setActiveCategory(slug)
  }

  function handleSelect(entry: EmojiEntry) {
    onSelect(entry.emoji)
    setRecent((prev) => [entry.emoji, ...prev.filter((e) => e !== entry.emoji)].slice(0, RECENT_MAX))
  }

  function handleCustomSelect(emoji: { id: string; name: string }) {
    onSelect(`<:${emoji.name}:${emoji.id}>`)
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
    if (!previewItem) {
      const fallback =
        recent.length > 0
          ? (emojiIndex.get(recent[0]) ?? categories[0]?.emojis[0])
          : categories[0]?.emojis[0]
      if (fallback) setPreviewItem({ kind: 'unicode', entry: fallback })
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const trimmedSearch = search.trim().toLowerCase()

  const unicodeSearchResults = trimmedSearch
    ? allEmojis.filter(
        (em) =>
          em.name.toLowerCase().includes(trimmedSearch) ||
          em.slug.toLowerCase().includes(trimmedSearch),
      )
    : []

  const customSearchResults = trimmedSearch
    ? (customEmojiGroups ?? []).flatMap((g) =>
        g.emojis.filter((e) => e.name.toLowerCase().includes(trimmedSearch)),
      )
    : []

  const recentEntries = recent
    .map((v) => emojiIndex.get(v) ?? { emoji: v, name: v, slug: v, skin_tone_support: false })
    .filter(Boolean) as EmojiEntry[]

  // Left sidebar nav
  type NavItem =
    | { kind: 'icon'; slug: string; name: string; Icon: LucideIcon }
    | { kind: 'guild'; slug: string; name: string; initial: string; iconUrl?: string }

  const navItems: NavItem[] = [
    ...(customEmojiGroups ?? [])
      .filter((g) => g.emojis.length > 0)
      .map((g): NavItem => ({
        kind: 'guild',
        slug: `guild-${g.guildId}`,
        name: g.guildName,
        initial: g.guildName.charAt(0).toUpperCase(),
        iconUrl: g.guildIconUrl,
      })),
    ...(recent.length > 0
      ? [{ kind: 'icon' as const, slug: 'recent', name: 'Frequently Used', Icon: Clock }]
      : []),
    ...categories.map((cat): NavItem => ({ kind: 'icon', slug: cat.slug, name: cat.name, Icon: cat.icon })),
  ]

  // Shared emoji grid content (used in both desktop and mobile)
  const emojiGrid = (
    <div ref={scrollRef} className="flex-1 overflow-y-auto px-2">
      {trimmedSearch ? (
        <>
          {customSearchResults.length > 0 && (
            <>
              <div className="py-3 text-xs uppercase tracking-wide text-muted-foreground">
                Custom Emoji
              </div>
              <div className="grid grid-cols-8 gap-0.5 pb-4">
                {customSearchResults.map((em) => (
                  <CustomEmojiButton
                    key={em.id}
                    emoji={em}
                    onSelect={handleCustomSelect}
                    onHover={(e) => setPreviewItem({ kind: 'custom', id: e.id, name: e.name })}
                  />
                ))}
              </div>
            </>
          )}
          <div className="py-3 text-xs uppercase tracking-wide text-muted-foreground">
            {customSearchResults.length > 0 ? 'Standard Emoji' : 'Search Results'}
          </div>
          {unicodeSearchResults.length === 0 && customSearchResults.length === 0 ? (
            <div className="pb-6 text-sm text-muted-foreground">
              No emoji found for &ldquo;{search}&rdquo;.
            </div>
          ) : unicodeSearchResults.length > 0 ? (
            <div className="grid grid-cols-8 gap-0.5 pb-4">
              {unicodeSearchResults.map((em) => (
                <EmojiButton
                  key={em.emoji}
                  entry={em}
                  onSelect={handleSelect}
                  onHover={(e) => setPreviewItem({ kind: 'unicode', entry: e })}
                />
              ))}
            </div>
          ) : null}
        </>
      ) : (
        <>
          {(customEmojiGroups ?? []).map(({ guildId, guildName, emojis }) =>
            emojis.length > 0 ? (
              <LazySection
                key={guildId}
                slug={`guild-${guildId}`}
                scrollRef={scrollRef}
                registerSection={registerSection}
                className="pt-3"
                estimatedRows={Math.ceil(emojis.length / 8)}
              >
                <div className="pb-2 text-xs uppercase tracking-wide text-muted-foreground">
                  {guildName}
                </div>
                <div className="grid grid-cols-8 gap-0.5 pb-4">
                  {emojis.map((em) => (
                    <CustomEmojiButton
                      key={em.id}
                      emoji={em}
                      onSelect={handleCustomSelect}
                      onHover={(e) => setPreviewItem({ kind: 'custom', id: e.id, name: e.name })}
                    />
                  ))}
                </div>
              </LazySection>
            ) : null,
          )}

          {recentEntries.length > 0 && (
            <LazySection
              slug="recent"
              scrollRef={scrollRef}
              registerSection={registerSection}
              className="pt-3"
              estimatedRows={Math.ceil(recentEntries.length / 8)}
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
                  <EmojiButton
                    key={em.emoji}
                    entry={em}
                    onSelect={handleSelect}
                    onHover={(e) => setPreviewItem({ kind: 'unicode', entry: e })}
                  />
                ))}
              </div>
            </LazySection>
          )}

          {categories.map((cat) => (
            <LazySection
              key={cat.slug}
              slug={cat.slug}
              scrollRef={scrollRef}
              registerSection={registerSection}
              className="pt-3"
              estimatedRows={Math.ceil(cat.emojis.length / 8)}
            >
              <div className="pb-2 text-xs uppercase tracking-wide text-muted-foreground">
                {cat.name}
              </div>
              <div className="grid grid-cols-8 gap-0.5 pb-4">
                {cat.emojis.map((em) => (
                  <EmojiButton
                    key={em.emoji}
                    entry={em}
                    onSelect={handleSelect}
                    onHover={(e) => setPreviewItem({ kind: 'unicode', entry: e })}
                  />
                ))}
              </div>
            </LazySection>
          ))}
        </>
      )}
    </div>
  )

  // Shared category nav buttons
  const categoryNavButtons = navItems.map((item) => {
    const isActive = activeCategory === item.slug && !trimmedSearch
    return (
      <button
        key={item.slug}
        type="button"
        title={item.name}
        onClick={() => {
          setSearch('')
          scrollToCategory(item.slug)
        }}
        className={`grid shrink-0 h-9 w-9 place-items-center rounded-lg text-muted-foreground transition-colors hover:bg-muted hover:text-foreground ${
          isActive ? 'bg-muted text-foreground' : ''
        }`}
      >
        {item.kind === 'icon' ? (
          <item.Icon className="h-4 w-4" strokeWidth={2} />
        ) : item.iconUrl ? (
          <img src={item.iconUrl} alt={item.name} className="h-6 w-6 rounded-md object-cover" />
        ) : (
          <div className="h-5 w-5 rounded-full bg-primary/20 text-primary text-[11px] font-bold flex items-center justify-center">
            {item.initial}
          </div>
        )}
      </button>
    )
  })

  if (isMobile) {
    return (
      <div className="w-full rounded-xl border border-border bg-popover text-popover-foreground shadow-xl flex flex-col">
        {/* Search */}
        <div className="border-b border-border px-3 py-2 shrink-0">
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

        {/* Emoji grid */}
        <div className="flex" style={{ height: 280 }}>
          {emojiGrid}
        </div>

        {/* Horizontal category nav */}
        <div className="border-t border-border shrink-0">
          <div className="flex gap-0.5 overflow-x-auto p-1.5 scrollbar-none">
            {categoryNavButtons}
          </div>
        </div>
      </div>
    )
  }

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
        {/* Left category sidebar */}
        <div className="flex flex-col gap-0.5 overflow-y-auto scrollbar-none border-r border-border p-1.5 shrink-0">
          {categoryNavButtons}
        </div>

        {/* Right emoji grid — scrollable */}
        {emojiGrid}
      </div>

      {/* Preview strip */}
      <div className="border-t border-border px-3 py-3">
        <div className="flex min-h-[56px] items-center gap-3">
          {previewItem ? (
            previewItem.kind === 'custom' ? (
              <>
                <img
                  src={emojiUrl(previewItem.id, 44)}
                  alt={previewItem.name}
                  className="h-10 w-10 object-contain shrink-0"
                />
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {previewItem.name}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">:{previewItem.name}:</div>
                </div>
              </>
            ) : (
              <>
                <div className="emoji-preview text-4xl leading-none">{previewItem.entry.emoji}</div>
                <div className="min-w-0">
                  <div className="truncate text-sm font-medium text-foreground">
                    {formatName(previewItem.entry.name ?? previewItem.entry.emoji)}
                  </div>
                  <div className="truncate text-xs text-muted-foreground">
                    :{previewItem.entry.slug.replace(/\s+/g, '_')}:
                  </div>
                </div>
              </>
            )
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

const EmojiButton = memo(function EmojiButton({ entry, onSelect, onHover }: EmojiButtonProps) {
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
})

// ── CustomEmojiButton ─────────────────────────────────────────────────────────

interface CustomEmojiButtonProps {
  emoji: { id: string; name: string; animated?: boolean }
  onSelect: (emoji: { id: string; name: string }) => void
  onHover: (emoji: { id: string; name: string }) => void
}

const CustomEmojiButton = memo(function CustomEmojiButton({
  emoji,
  onSelect,
  onHover,
}: CustomEmojiButtonProps) {
  return (
    <button
      type="button"
      title={`:${emoji.name}:`}
      onPointerEnter={() => onHover(emoji)}
      onClick={() => onSelect(emoji)}
      className="emoji-button grid h-9 w-9 place-items-center rounded-md transition-colors hover:bg-muted"
    >
      <img src={emojiUrl(emoji.id, 44)} alt={emoji.name} className="h-6 w-6 object-contain" />
    </button>
  )
})
