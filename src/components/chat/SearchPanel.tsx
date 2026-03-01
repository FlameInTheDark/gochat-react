import { useState, useRef, useCallback, useEffect } from 'react'
import { useNavigate } from 'react-router-dom'
import { Search, X, Hash, ExternalLink, ChevronLeft, ChevronRight, AtSign } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { ScrollArea } from '@/components/ui/scroll-area'
import { Skeleton } from '@/components/ui/skeleton'
import { Avatar, AvatarFallback } from '@/components/ui/avatar'
import { searchApi } from '@/api/client'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import type { DtoChannel, DtoMember, DtoMessage } from '@/types'
import { cn } from '@/lib/utils'

type HasValue = SearchMessageSearchRequestHasEnum
type FilterType = 'from' | 'has' | 'in'

interface AppliedFilter {
  type: FilterType
  label: string
  apiValue: string
}

interface SearchPanelProps {
  serverId: string
  /** Current channel — used as the default channel_id the API requires */
  channelId: string
  channels: DtoChannel[]
  members?: DtoMember[]
  onClose: () => void
}

const HAS_OPTIONS: { label: string; value: HasValue }[] = [
  { label: 'Link', value: SearchMessageSearchRequestHasEnum.Url },
  { label: 'Image', value: SearchMessageSearchRequestHasEnum.Image },
  { label: 'Video', value: SearchMessageSearchRequestHasEnum.Video },
  { label: 'File', value: SearchMessageSearchRequestHasEnum.File },
]

function fmtTime(ts: string | undefined): string {
  if (!ts) return ''
  const d = new Date(ts)
  if (isNaN(d.getTime())) return ''
  const now = new Date()
  const diff = now.getTime() - d.getTime()
  if (diff < 86_400_000)
    return `Today at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  if (diff < 172_800_000)
    return `Yesterday at ${d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}`
  return d.toLocaleDateString()
}

// ── Filter chip ────────────────────────────────────────────────────────────────
function FilterChip({
  filter,
  onRemove,
}: {
  filter: AppliedFilter
  onRemove: () => void
}) {
  return (
    <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded text-xs font-medium bg-primary/15 text-primary border border-primary/20 shrink-0">
      <span className="text-primary/60">{filter.type}:</span>
      {filter.type === 'from' && <AtSign className="w-2.5 h-2.5" />}
      {filter.type === 'in' && <Hash className="w-2.5 h-2.5" />}
      {filter.label}
      <button
        onClick={(e) => { e.stopPropagation(); onRemove() }}
        className="ml-0.5 rounded hover:text-destructive transition-colors"
        aria-label="Remove filter"
      >
        <X className="w-3 h-3" />
      </button>
    </span>
  )
}

// ── Message result card ────────────────────────────────────────────────────────
function ResultCard({
  msg,
  channelName,
  onJump,
}: {
  msg: DtoMessage
  channelName: string | undefined
  onJump: () => void
}) {
  const authorName = msg.author?.name ?? 'Unknown'
  const initials = authorName.charAt(0).toUpperCase()

  return (
    <div
      className="group rounded-md px-3 py-2.5 hover:bg-accent/50 transition-colors cursor-pointer"
      onClick={onJump}
    >
      {/* Channel name + jump */}
      <div className="flex items-center justify-between mb-1.5">
        <span className="text-xs text-muted-foreground flex items-center gap-1">
          <Hash className="w-3 h-3 shrink-0" />
          <span className="truncate">{channelName ?? '…'}</span>
        </span>
        <button
          onClick={(e) => { e.stopPropagation(); onJump() }}
          className="opacity-0 group-hover:opacity-100 flex items-center gap-1 px-1.5 py-0.5 rounded text-xs font-medium text-primary hover:bg-primary/10 transition-all shrink-0 ml-2"
        >
          Jump <ExternalLink className="w-3 h-3" />
        </button>
      </div>

      {/* Author + timestamp */}
      <div className="flex items-center gap-2 mb-1">
        <Avatar className="w-5 h-5 shrink-0">
          <AvatarFallback className="text-[10px]">{initials}</AvatarFallback>
        </Avatar>
        <span className="text-xs font-semibold truncate">{authorName}</span>
        <span className="text-xs text-muted-foreground shrink-0">{fmtTime(msg.updated_at)}</span>
      </div>

      {/* Content */}
      <p className="text-sm leading-relaxed line-clamp-3 pl-7 text-foreground/85">
        {msg.content || <em className="text-muted-foreground text-xs">[attachment]</em>}
      </p>
    </div>
  )
}

// ── Main panel ─────────────────────────────────────────────────────────────────
export default function SearchPanel({ serverId, channelId, channels, members, onClose }: SearchPanelProps) {
  const navigate = useNavigate()

  const [inputValue, setInputValue] = useState('')
  const [filters, setFilters] = useState<AppliedFilter[]>([])
  const [pendingFilter, setPendingFilter] = useState<FilterType | null>(null)
  const [pendingValue, setPendingValue] = useState('')

  const [results, setResults] = useState<DtoMessage[]>([])
  const [totalPages, setTotalPages] = useState(0)
  const [page, setPage] = useState(0)
  const [isLoading, setIsLoading] = useState(false)
  const [hasSearched, setHasSearched] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const pendingInputRef = useRef<HTMLInputElement>(null)

  // Focus main input on mount
  useEffect(() => { inputRef.current?.focus() }, [])

  // Focus pending input when filter mode opens
  useEffect(() => {
    if (pendingFilter === 'from' || pendingFilter === 'in') {
      setTimeout(() => pendingInputRef.current?.focus(), 0)
    }
  }, [pendingFilter])

  // ── Filter helpers ─────────────────────────────────────────────────────────
  const removeFilter = useCallback((index: number) => {
    setFilters((prev) => prev.filter((_, i) => i !== index))
  }, [])

  const addFilter = useCallback((f: AppliedFilter) => {
    setFilters((prev) => {
      // 'from' and 'in' are single-value filters; 'has' can stack
      if (f.type === 'from' || f.type === 'in') {
        return [...prev.filter((x) => x.type !== f.type), f]
      }
      // Don't duplicate has values
      if (prev.some((x) => x.type === 'has' && x.apiValue === f.apiValue)) return prev
      return [...prev, f]
    })
    setPendingFilter(null)
    setPendingValue('')
    setTimeout(() => inputRef.current?.focus(), 0)
  }, [])

  // ── Input change — detect filter keyword triggers ──────────────────────────
  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    const val = e.target.value
    if (val.endsWith('from:')) {
      setInputValue(val.slice(0, -5))
      setPendingFilter('from')
      setPendingValue('')
      return
    }
    if (val.endsWith('has:')) {
      setInputValue(val.slice(0, -4))
      setPendingFilter('has')
      setPendingValue('')
      return
    }
    if (val.endsWith('in:')) {
      setInputValue(val.slice(0, -3))
      setPendingFilter('in')
      setPendingValue('')
      return
    }
    setInputValue(val)
  }

  const handleInputKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (e.key === 'Enter') { e.preventDefault(); void doSearch(0) }
    if (e.key === 'Backspace' && inputValue === '' && filters.length > 0 && !pendingFilter) {
      setFilters((prev) => prev.slice(0, -1))
    }
    if (e.key === 'Escape') onClose()
  }

  // ── Member / channel suggestions ───────────────────────────────────────────
  const memberSuggestions =
    pendingFilter === 'from' && pendingValue.trim().length > 0
      ? (members ?? [])
          .filter((m) => {
            const name = (m.username ?? m.user?.name ?? '').toLowerCase()
            return name.includes(pendingValue.toLowerCase())
          })
          .slice(0, 8)
      : []

  const channelSuggestions =
    pendingFilter === 'in' && pendingValue.trim().length > 0
      ? channels
          .filter((c) => c.name?.toLowerCase().includes(pendingValue.toLowerCase()))
          .slice(0, 8)
      : []

  // ── Search ─────────────────────────────────────────────────────────────────
  const doSearch = useCallback(
    async (pageNum: number) => {
      const content = inputValue.trim()
      const hasFilters = filters
        .filter((f) => f.type === 'has')
        .map((f) => f.apiValue as HasValue)
      const fromFilter = filters.find((f) => f.type === 'from')
      const inFilter = filters.find((f) => f.type === 'in')

      if (!content && !hasFilters.length && !fromFilter && !inFilter) return

      // The API requires channel_id; use the 'in:' filter value if set,
      // otherwise fall back to the currently viewed channel.
      const targetChannelId = inFilter?.apiValue ?? channelId

      setIsLoading(true)
      setHasSearched(true)
      try {
        const res = await searchApi.searchGuildIdMessagesPost({
          guildId: serverId,
          request: {
            content: content || undefined,
            // IDs are strings at runtime despite number type in generated client
            author_id: fromFilter ? (fromFilter.apiValue as unknown as number) : undefined,
            channel_id: targetChannelId as unknown as number,
            has: hasFilters.length ? hasFilters : undefined,
            page: pageNum,
          },
        })
        // API returns Array<SearchMessageSearchResponse>; take first element
        const raw = res.data
        const first = Array.isArray(raw) ? raw[0] : raw
        setResults((first as { messages?: DtoMessage[] })?.messages ?? [])
        setTotalPages((first as { pages?: number })?.pages ?? 1)
        setPage(pageNum)
      } catch {
        setResults([])
        setTotalPages(0)
      } finally {
        setIsLoading(false)
      }
    },
    [serverId, channelId, inputValue, filters],
  )

  // ── Jump to message ────────────────────────────────────────────────────────
  const jumpToMessage = useCallback(
    (msg: DtoMessage) => {
      const chanId = String(msg.channel_id)
      const msgId = String(msg.id)
      navigate(`/app/${serverId}/${chanId}`, { state: { jumpToMessageId: msgId } })
      onClose()
    },
    [navigate, serverId, onClose],
  )

  const getChannelName = (channelId: number | undefined) =>
    channelId !== undefined
      ? channels.find((c) => String(c.id) === String(channelId))?.name
      : undefined

  const hasActiveFilters = filters.length > 0
  const canSearch = inputValue.trim() || hasActiveFilters

  return (
    <div className="flex flex-col w-[360px] border-l border-sidebar-border bg-background shrink-0">

      {/* ── Header ─────────────────────────────────────────────────────────── */}
      <div className="h-12 flex items-center px-4 gap-2 border-b border-sidebar-border shrink-0">
        <Search className="w-4 h-4 text-muted-foreground shrink-0" />
        <span className="font-semibold flex-1">Search</span>
        <button
          onClick={onClose}
          title="Close search"
          className="w-7 h-7 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* ── Search input area ───────────────────────────────────────────────── */}
      <div className="p-3 border-b border-sidebar-border space-y-2">

        {/* Combined chip + text input */}
        <div
          className="flex flex-wrap gap-1.5 items-center min-h-9 px-3 py-1.5 rounded-md border border-input bg-muted/20 focus-within:border-primary focus-within:ring-1 focus-within:ring-primary transition-colors cursor-text"
          onClick={() => inputRef.current?.focus()}
        >
          {filters.map((f, i) => (
            <FilterChip key={i} filter={f} onRemove={() => removeFilter(i)} />
          ))}
          <input
            ref={inputRef}
            value={inputValue}
            onChange={handleInputChange}
            onKeyDown={handleInputKeyDown}
            placeholder={filters.length === 0 ? 'Search messages…' : ''}
            className="flex-1 min-w-[80px] bg-transparent outline-none text-sm placeholder:text-muted-foreground"
          />
        </div>

        {/* Pending filter: HAS options */}
        {pendingFilter === 'has' && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Filter by attachment type:</p>
            <div className="flex flex-wrap gap-1.5">
              {HAS_OPTIONS.map((opt) => (
                <button
                  key={opt.value}
                  onClick={() =>
                    addFilter({ type: 'has', label: opt.label, apiValue: opt.value })
                  }
                  disabled={filters.some(
                    (f) => f.type === 'has' && f.apiValue === opt.value,
                  )}
                  className="px-2.5 py-1 rounded-md text-xs font-medium border border-input hover:bg-accent hover:border-primary/40 disabled:opacity-40 disabled:cursor-not-allowed transition-colors"
                >
                  {opt.label}
                </button>
              ))}
              <button
                onClick={() => { setPendingFilter(null); inputRef.current?.focus() }}
                className="px-2 py-1 rounded-md text-xs text-muted-foreground hover:bg-accent transition-colors"
              >
                Cancel
              </button>
            </div>
          </div>
        )}

        {/* Pending filter: FROM — member lookup */}
        {pendingFilter === 'from' && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Filter by author:</p>
            <input
              ref={pendingInputRef}
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setPendingFilter(null); inputRef.current?.focus() }
                if (e.key === 'Enter' && memberSuggestions.length === 1) {
                  const m = memberSuggestions[0]
                  addFilter({
                    type: 'from',
                    label: m.username ?? m.user?.name ?? String(m.user?.id),
                    apiValue: String(m.user?.id),
                  })
                }
              }}
              placeholder="Type a member name…"
              className="w-full px-3 py-1.5 rounded-md border border-input bg-muted/20 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {memberSuggestions.length > 0 && (
              <div className="rounded-md border border-border bg-popover shadow-md overflow-hidden">
                {memberSuggestions.map((m) => {
                  const name = m.username ?? m.user?.name ?? String(m.user?.id)
                  const id = String(m.user?.id)
                  return (
                    <button
                      key={id}
                      onClick={() => addFilter({ type: 'from', label: name, apiValue: id })}
                      className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                    >
                      <Avatar className="w-5 h-5 shrink-0">
                        <AvatarFallback className="text-[10px]">
                          {name.charAt(0).toUpperCase()}
                        </AvatarFallback>
                      </Avatar>
                      <span className="truncate">{name}</span>
                    </button>
                  )
                })}
              </div>
            )}
          </div>
        )}

        {/* Pending filter: IN — channel lookup */}
        {pendingFilter === 'in' && (
          <div className="space-y-1.5">
            <p className="text-xs text-muted-foreground">Filter by channel:</p>
            <input
              ref={pendingInputRef}
              value={pendingValue}
              onChange={(e) => setPendingValue(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Escape') { setPendingFilter(null); inputRef.current?.focus() }
                if (e.key === 'Enter' && channelSuggestions.length === 1) {
                  const c = channelSuggestions[0]
                  addFilter({ type: 'in', label: c.name ?? '', apiValue: String(c.id) })
                }
              }}
              placeholder="Type a channel name…"
              className="w-full px-3 py-1.5 rounded-md border border-input bg-muted/20 text-sm outline-none focus:border-primary transition-colors placeholder:text-muted-foreground"
            />
            {channelSuggestions.length > 0 && (
              <div className="rounded-md border border-border bg-popover shadow-md overflow-hidden">
                {channelSuggestions.map((c) => (
                  <button
                    key={String(c.id)}
                    onClick={() =>
                      addFilter({ type: 'in', label: c.name ?? '', apiValue: String(c.id) })
                    }
                    className="w-full flex items-center gap-2 px-3 py-1.5 text-sm hover:bg-accent transition-colors text-left"
                  >
                    <Hash className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                    <span className="truncate">{c.name}</span>
                  </button>
                ))}
              </div>
            )}
          </div>
        )}

        {/* Quick filter shortcuts + search button (when no pending filter) */}
        {!pendingFilter && (
          <div className="flex items-center gap-1.5 flex-wrap">
            {!filters.some((f) => f.type === 'from') && (
              <button
                onClick={() => { setPendingFilter('from'); setPendingValue('') }}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground border border-dashed border-muted-foreground/30 hover:border-primary hover:text-primary transition-colors"
              >
                from:
              </button>
            )}
            {filters.filter((f) => f.type === 'has').length < HAS_OPTIONS.length && (
              <button
                onClick={() => { setPendingFilter('has'); setPendingValue('') }}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground border border-dashed border-muted-foreground/30 hover:border-primary hover:text-primary transition-colors"
              >
                has:
              </button>
            )}
            {!filters.some((f) => f.type === 'in') && (
              <button
                onClick={() => { setPendingFilter('in'); setPendingValue('') }}
                className="px-2 py-0.5 rounded text-xs text-muted-foreground border border-dashed border-muted-foreground/30 hover:border-primary hover:text-primary transition-colors"
              >
                in:
              </button>
            )}
            <button
              onClick={() => void doSearch(0)}
              disabled={!canSearch}
              className={cn(
                'ml-auto px-3 py-0.5 rounded text-xs font-medium transition-colors',
                canSearch
                  ? 'bg-primary text-primary-foreground hover:bg-primary/90'
                  : 'bg-muted text-muted-foreground cursor-not-allowed',
              )}
            >
              Search
            </button>
          </div>
        )}
      </div>

      {/* ── Results area ────────────────────────────────────────────────────── */}
      <div className="flex-1 flex flex-col min-h-0">
        {isLoading ? (
          <div className="p-3 space-y-4">
            {Array.from({ length: 4 }).map((_, i) => (
              <div key={i} className="space-y-1.5">
                <div className="flex items-center gap-2">
                  <Skeleton className="h-3 w-16" />
                  <Skeleton className="h-3 w-24 ml-auto" />
                </div>
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-4/5" />
              </div>
            ))}
          </div>
        ) : hasSearched && results.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <Search className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm font-semibold">No results found</p>
            <p className="text-xs mt-1 opacity-70">Try different keywords or filters</p>
          </div>
        ) : !hasSearched ? (
          <div className="flex-1 flex flex-col items-center justify-center text-muted-foreground p-8 text-center">
            <Search className="w-12 h-12 mb-3 opacity-20" />
            <p className="text-sm font-semibold">Search messages</p>
            <p className="text-xs mt-1.5 opacity-70 leading-relaxed">
              Use{' '}
              <code className="bg-muted px-1 py-0.5 rounded text-foreground/70">from:</code>
              ,{' '}
              <code className="bg-muted px-1 py-0.5 rounded text-foreground/70">has:</code>
              , or{' '}
              <code className="bg-muted px-1 py-0.5 rounded text-foreground/70">in:</code>
              {' '}to narrow results
            </p>
          </div>
        ) : (
          <>
            {/* Result count */}
            <div className="px-4 py-2 text-xs text-muted-foreground border-b border-border shrink-0 flex items-center justify-between">
              <span>
                {results.length} result{results.length !== 1 ? 's' : ''}
                {totalPages > 1 ? ' on this page' : ''}
              </span>
              {totalPages > 1 && (
                <span>
                  Page {page + 1} of {totalPages}
                </span>
              )}
            </div>

            {/* Message list */}
            <ScrollArea className="flex-1">
              <div className="py-1">
                {results.map((msg) => (
                  <ResultCard
                    key={String(msg.id)}
                    msg={msg}
                    channelName={getChannelName(msg.channel_id)}
                    onJump={() => jumpToMessage(msg)}
                  />
                ))}
              </div>
            </ScrollArea>

            {/* Pagination */}
            {totalPages > 1 && (
              <div className="px-3 py-2 border-t border-border shrink-0 flex items-center justify-between">
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void doSearch(page - 1)}
                  disabled={page === 0}
                >
                  <ChevronLeft className="w-4 h-4 mr-1" />
                  Prev
                </Button>
                <span className="text-xs text-muted-foreground">
                  {page + 1} / {totalPages}
                </span>
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={() => void doSearch(page + 1)}
                  disabled={page >= totalPages - 1}
                >
                  Next
                  <ChevronRight className="w-4 h-4 ml-1" />
                </Button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
