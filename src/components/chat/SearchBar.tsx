import { useState, useRef, useEffect, useImperativeHandle, useMemo, forwardRef } from 'react'
import { X, Hash, AtSign, Search } from 'lucide-react'
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar'
import { SearchMessageSearchRequestHasEnum } from '@/client'
import type { DtoChannel, DtoMember } from '@/types'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'

type HasValue = SearchMessageSearchRequestHasEnum
export type FilterType = 'from' | 'has' | 'in'

export interface AppliedFilter {
  type: FilterType
  label: string
  apiValue: string
}

export interface SearchBarHandle {
  focus: () => void
  clear: () => void
}

interface SearchBarProps {
  members?: DtoMember[]
  channels?: DtoChannel[]
  allowedFilters?: FilterType[]
  onSearch: (params: { chips: AppliedFilter[]; text: string }) => void
  onClear: () => void
  hasResults?: boolean
  className?: string
}

type DropdownItem =
  | { kind: 'keyword'; keyword: FilterType }
  | { kind: 'from'; member: DtoMember }
  | { kind: 'in'; channel: DtoChannel }
  | { kind: 'has'; label: string; value: HasValue }

const ALL_FILTERS: FilterType[] = ['from', 'has', 'in']

function computeSuggestions(
  input: string,
  allowedFilters: FilterType[],
): { kind: 'filter-keywords'; matches: FilterType[] } | { kind: 'from-values'; query: string } | { kind: 'in-values'; query: string } | { kind: 'has-values'; query: string } | null {
  const filterMatch = input.match(/(from|has|in):(\S*)$/i)
  if (filterMatch) {
    const type = filterMatch[1].toLowerCase() as FilterType
    if (!allowedFilters.includes(type)) return null
    const query = filterMatch[2]
    if (type === 'from') return { kind: 'from-values', query }
    if (type === 'in') return { kind: 'in-values', query }
    if (type === 'has') return { kind: 'has-values', query }
  }
  if (!input.trim()) return { kind: 'filter-keywords', matches: allowedFilters }
  const lastWord = input.match(/(\S+)$/)?.[1]?.toLowerCase() ?? ''
  if (lastWord) {
    const matches = allowedFilters.filter((k) => k.startsWith(lastWord))
    if (matches.length > 0) return { kind: 'filter-keywords', matches }
  }
  return null
}

function FilterChip({ filter, onRemove }: { filter: AppliedFilter; onRemove: () => void }) {
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

const SearchBar = forwardRef<SearchBarHandle, SearchBarProps>(function SearchBar(
  { members, channels = [], allowedFilters, onSearch, onClear, hasResults, className },
  ref,
) {
  const effectiveFilters = allowedFilters ?? ALL_FILTERS
  const { t } = useTranslation()

  const [inputValue, setInputValue] = useState('')
  const [chips, setChips] = useState<AppliedFilter[]>([])
  const [inputFocused, setInputFocused] = useState(false)
  const [suppressDropdown, setSuppressDropdown] = useState(false)
  const [highlightIdx, setHighlightIdx] = useState(0)
  const [hasValue, setHasValue] = useState(false)
  const [showLeftFade, setShowLeftFade] = useState(false)

  const inputRef = useRef<HTMLInputElement>(null)
  const scrollContainerRef = useRef<HTMLDivElement>(null)

  // Always show the end of the chips+input row (where the cursor is)
  useEffect(() => {
    const el = scrollContainerRef.current
    if (!el) return
    el.scrollLeft = el.scrollWidth
    setShowLeftFade(el.scrollLeft > 0)
  }, [chips.length, inputValue])

  function resetState() {
    setInputValue('')
    setChips([])
    setHasValue(false)
    setSuppressDropdown(true)
  }

  function clearAll() {
    resetState()
    onClear()
  }

  useImperativeHandle(ref, () => ({
    focus: () => inputRef.current?.focus(),
    clear: resetState,  // parent-driven clear: reset state only, don't call onClear back
  }))

  const hasOptions = useMemo(() => [
    { label: t('search.link'), value: SearchMessageSearchRequestHasEnum.Url },
    { label: t('search.image'), value: SearchMessageSearchRequestHasEnum.Image },
    { label: t('search.video'), value: SearchMessageSearchRequestHasEnum.Video },
    { label: t('search.file'), value: SearchMessageSearchRequestHasEnum.File },
  ], [t])

  const suggestionMode = useMemo(
    () => computeSuggestions(inputValue, effectiveFilters),
    [inputValue, effectiveFilters],
  )

  const dropdownItems = useMemo((): DropdownItem[] => {
    if (!suggestionMode) return []
    switch (suggestionMode.kind) {
      case 'filter-keywords':
        return suggestionMode.matches.map((k) => ({ kind: 'keyword' as const, keyword: k }))
      case 'from-values': {
        const q = suggestionMode.query.toLowerCase()
        return (members ?? [])
          .filter((m) => !q || (m.username ?? m.user?.name ?? '').toLowerCase().includes(q))
          .slice(0, 8)
          .map((m) => ({ kind: 'from' as const, member: m }))
      }
      case 'in-values': {
        const q = suggestionMode.query.toLowerCase()
        return channels
          .filter((c) => !q || (c.name ?? '').toLowerCase().includes(q))
          .slice(0, 8)
          .map((c) => ({ kind: 'in' as const, channel: c }))
      }
      case 'has-values':
        return hasOptions
          .filter((o) => !chips.some((ch) => ch.type === 'has' && ch.apiValue === o.value))
          .map((o) => ({ kind: 'has' as const, label: o.label, value: o.value }))
    }
  }, [suggestionMode, members, channels, chips, hasOptions])

  const showDropdown = inputFocused && !suppressDropdown && dropdownItems.length > 0

  function selectItem(item: DropdownItem) {
    if (item.kind === 'keyword') {
      const newVal = inputValue.replace(/\S+$/, '') + item.keyword + ':'
      setInputValue(newVal)
      setHighlightIdx(0)
      return
    }
    if (item.kind === 'from') {
      const name = item.member.username ?? item.member.user?.name ?? String(item.member.user?.id)
      const apiValue = String(item.member.user?.id)
      setInputValue(inputValue.replace(/(from):(\S*)$/i, '').trimEnd())
      setChips((prev) => [...prev.filter((c) => c.type !== 'from'), { type: 'from', label: name, apiValue }])
      setSuppressDropdown(true)
      return
    }
    if (item.kind === 'in') {
      const name = item.channel.name ?? ''
      const apiValue = String(item.channel.id)
      setInputValue(inputValue.replace(/(in):(\S*)$/i, '').trimEnd())
      setChips((prev) => [...prev.filter((c) => c.type !== 'in'), { type: 'in', label: name, apiValue }])
      setSuppressDropdown(true)
      return
    }
    if (item.kind === 'has') {
      setInputValue(inputValue.replace(/(has):(\S*)$/i, '').trimEnd())
      setChips((prev) => {
        if (prev.some((c) => c.type === 'has' && c.apiValue === item.value)) return prev
        return [...prev, { type: 'has', label: item.label, apiValue: item.value }]
      })
      setSuppressDropdown(true)
      return
    }
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLInputElement>) {
    if (e.key === 'Escape') {
      setSuppressDropdown(true)
      return
    }
    if (showDropdown) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlightIdx((i) => Math.min(i + 1, dropdownItems.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlightIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Tab' || e.key === 'Enter') {
        e.preventDefault()
        selectItem(dropdownItems[highlightIdx])
        return
      }
    }
    if (e.key === 'Enter') {
      e.preventDefault()
      setSuppressDropdown(true)
      onSearch({ chips, text: inputValue.trim() })
      setHasValue(chips.length > 0 || inputValue.trim().length > 0)
      return
    }
    if (e.key === 'Backspace' && inputValue === '' && chips.length > 0) {
      setChips((prev) => prev.slice(0, -1))
    }
  }

  function handleInputChange(e: React.ChangeEvent<HTMLInputElement>) {
    setInputValue(e.target.value)
    setSuppressDropdown(false)
    setHighlightIdx(0)
  }

  const filterDescriptions: Record<FilterType, string> = {
    from: t('search.filterByAuthor'),
    has: t('search.filterByAttachment'),
    in: t('search.filterByChannel'),
  }

  const showClear = hasResults || hasValue || inputValue !== '' || chips.length > 0

  return (
    <div className={cn('relative flex items-center', className)}>
      {/* Chips + input */}
      <div className="relative flex-1 min-w-0">
        {showLeftFade && (
          <div className="absolute left-0 top-0 bottom-0 w-8 bg-gradient-to-r from-background to-transparent pointer-events-none z-10" />
        )}
        <div
          ref={scrollContainerRef}
          className="flex items-center gap-1 overflow-x-auto [&::-webkit-scrollbar]:hidden [scrollbar-width:none] pl-1.5 pr-1"
          onClick={() => inputRef.current?.focus()}
          onScroll={() => setShowLeftFade((scrollContainerRef.current?.scrollLeft ?? 0) > 0)}
        >
        {chips.map((chip, i) => (
          <FilterChip
            key={i}
            filter={chip}
            onRemove={() => setChips((prev) => prev.filter((_, j) => j !== i))}
          />
        ))}
        <input
          ref={inputRef}
          value={inputValue}
          onChange={handleInputChange}
          onKeyDown={handleKeyDown}
          onFocus={() => {
            setInputFocused(true)
            setSuppressDropdown(false)
            const el = scrollContainerRef.current
            if (el) el.scrollLeft = el.scrollWidth
          }}
          onBlur={() => setTimeout(() => setInputFocused(false), 150)}
          placeholder={chips.length === 0 ? t('search.searchMessages') : ''}
          className="flex-1 min-w-[60px] bg-transparent outline-none text-xs placeholder:text-muted-foreground"
        />
        </div>
      </div>

      {/* Right icon: X when active, magnifying glass when idle */}
      {showClear ? (
        <button
          onMouseDown={(e) => { e.preventDefault(); clearAll() }}
          title={t('search.closeSearch')}
          className="shrink-0 w-5 h-5 flex items-center justify-center rounded hover:bg-accent text-muted-foreground hover:text-foreground transition-colors"
        >
          <X className="w-3 h-3" />
        </button>
      ) : (
        <Search className="w-3.5 h-3.5 text-muted-foreground shrink-0 pointer-events-none" />
      )}

      {/* Autocomplete dropdown */}
      {showDropdown && (
        <div className="absolute left-0 right-0 top-full mt-1 z-50 border border-border bg-popover shadow-lg overflow-hidden rounded-md max-h-60 overflow-y-auto">
          {dropdownItems.map((item, idx) => {
            const isHighlighted = idx === highlightIdx
            const base = cn(
              'w-full flex items-center gap-2 px-3 py-2 text-sm text-left transition-colors',
              isHighlighted ? 'bg-accent' : 'hover:bg-accent/70',
            )
            if (item.kind === 'keyword') {
              return (
                <button key={item.keyword} onMouseDown={() => selectItem(item)} className={base}>
                  <span className="font-medium text-primary min-w-[40px]">{item.keyword}:</span>
                  <span className="text-muted-foreground text-xs">{filterDescriptions[item.keyword]}</span>
                </button>
              )
            }
            if (item.kind === 'from') {
              const name = item.member.username ?? item.member.user?.name ?? String(item.member.user?.id)
              return (
                <button key={String(item.member.user?.id)} onMouseDown={() => selectItem(item)} className={base}>
                  <Avatar className="w-5 h-5 shrink-0">
                    <AvatarImage src={item.member.user?.avatar?.url} className="object-cover" />
                    <AvatarFallback className="text-[10px]">{name.charAt(0).toUpperCase()}</AvatarFallback>
                  </Avatar>
                  <span className="truncate">{name}</span>
                </button>
              )
            }
            if (item.kind === 'in') {
              return (
                <button key={String(item.channel.id)} onMouseDown={() => selectItem(item)} className={base}>
                  <Hash className="w-3.5 h-3.5 shrink-0 text-muted-foreground" />
                  <span className="truncate">{item.channel.name}</span>
                </button>
              )
            }
            if (item.kind === 'has') {
              return (
                <button key={item.value} onMouseDown={() => selectItem(item)} className={base}>
                  <span className="truncate">{item.label}</span>
                </button>
              )
            }
            return null
          })}
        </div>
      )}
    </div>
  )
})

export default SearchBar
