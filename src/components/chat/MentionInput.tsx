import { useEffect, useRef, useState } from 'react'
import { useParams } from 'react-router-dom'
import { useQuery } from '@tanstack/react-query'
import { Hash, Shield, Paperclip } from 'lucide-react'
import { guildApi, rolesApi } from '@/api/client'
import { ChannelType } from '@/types'
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover'
import { Smile } from 'lucide-react'
import EmojiPicker from './EmojiPicker'
import { cn } from '@/lib/utils'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestionItem {
  type: 'user' | 'channel' | 'role'
  id: string
  display: string  // text shown in the chip in the editor
  token: string    // serialized token: <@id> <#id> <@&id>
  name: string     // name for the suggestion list
  color?: number   // role color (RGB integer, 0 = none)
}

// ── Helpers ───────────────────────────────────────────────────────────────────

/** Serialize a contenteditable div to a plain string with mention tokens. */
function serialize(el: HTMLElement): string {
  let result = ''
  for (const node of Array.from(el.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      // Replace non-breaking spaces inserted around chips with regular spaces
      result += (node.textContent ?? '').replace(/\u00A0/g, ' ')
    } else if (node instanceof HTMLElement) {
      if (node.dataset.token) {
        result += node.dataset.token
      } else if (node.tagName === 'BR') {
        result += '\n'
      } else if (node.tagName === 'DIV') {
        // Chrome wraps new lines in <div>
        result += '\n' + serialize(node)
      } else {
        result += serialize(node)
      }
    }
  }
  return result
}

/**
 * Find an incomplete mention trigger (@query or #query) immediately before
 * the cursor in the current text node.
 */
function getMentionQuery(
  el: HTMLElement,
): { trigger: '@' | '#'; query: string; triggerText: string } | null {
  const sel = window.getSelection()
  if (!sel?.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null

  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  // Make sure this text node is inside our editor
  if (!el.contains(node)) return null

  const textBefore = (node.textContent ?? '').slice(0, range.startOffset)
  // Match the last run of [@#] + non-whitespace from the end of textBefore
  const match = textBefore.match(/([@#][^\s@#]*)$/)
  if (!match) return null

  const triggerText = match[1] // e.g. "@foo" or "#bar"
  const posInText = textBefore.length - triggerText.length
  // Must be at start of text or preceded by whitespace
  if (posInText > 0 && !/\s/.test(textBefore[posInText - 1]!)) return null

  return {
    trigger: triggerText[0] as '@' | '#',
    query: triggerText.slice(1),
    triggerText,
  }
}

/** Insert a mention chip at the cursor, replacing the current trigger text. */
function insertChip(chip: SuggestionItem) {
  const sel = window.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent ?? ''
  const offset = range.startOffset
  const textBefore = text.slice(0, offset)

  const match = textBefore.match(/([@#][^\s@#]*)$/)
  if (!match) return

  const triggerStart = offset - match[1].length
  const beforeText = text.slice(0, triggerStart)
  const afterText = text.slice(offset)

  // Build chip span
  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.token = chip.token
  span.dataset.mention = 'true'
  span.dataset.type = chip.type
  span.className = 'mention-chip'
  span.textContent = chip.display

  // Text nodes flanking the chip
  const beforeNode = document.createTextNode(beforeText)
  // Non-breaking space after chip so cursor has a text node to land in
  const afterNode = document.createTextNode('\u00A0' + afterText)

  const parent = node.parentNode!
  parent.insertBefore(beforeNode, node)
  parent.insertBefore(span, node)
  parent.insertBefore(afterNode, node)
  parent.removeChild(node)

  // Place cursor after the non-breaking space
  const newRange = document.createRange()
  newRange.setStart(afterNode, 1)
  newRange.collapse(true)
  sel.removeAllRanges()
  sel.addRange(newRange)
}

/** Convert role RGB integer to css rgb() string, or null for "no color". */
function roleColor(color: number | undefined): string | null {
  if (!color) return null
  const r = (color >> 16) & 0xff
  const g = (color >> 8) & 0xff
  const b = color & 0xff
  return `rgb(${r},${g},${b})`
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  channelId: string
  channelName?: string
  onSend: (content: string) => void
  onTyping: () => void
  /** Called when the paperclip button is clicked — opens the file picker. */
  onAttachClick?: () => void
  /**
   * Called when files are dropped onto the input or pasted from the clipboard.
   * The parent component owns file state management.
   */
  onFileDrop?: (files: FileList) => void
  /**
   * Rendered above the text editor row, inside the input border.
   * Pass the <PendingAttachmentBar /> here.
   */
  attachmentBar?: React.ReactNode
  /**
   * When true, the Enter key will send even with empty text content
   * (so a message with only attachments can be submitted).
   */
  hasAttachments?: boolean
}

export default function MentionInput({
  channelId,
  channelName,
  onSend,
  onTyping,
  onAttachClick,
  onFileDrop,
  attachmentBar,
  hasAttachments,
}: Props) {
  const { serverId } = useParams<{ serverId?: string }>()

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  // Tracks drag-enter depth so dragleave on children doesn't hide the highlight
  const dragCounterRef = useRef(0)
  const [isDragging, setIsDragging] = useState(false)

  // Fetch guild data for suggestions — reuse cached queries from ServerLayout
  const { data: members } = useQuery({
    queryKey: ['members', serverId],
    queryFn: () =>
      guildApi.guildGuildIdMembersGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  const { data: channels } = useQuery({
    queryKey: ['channels', serverId],
    queryFn: () =>
      guildApi.guildGuildIdChannelGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 30_000,
  })

  const { data: roles } = useQuery({
    queryKey: ['roles', serverId],
    queryFn: () =>
      rolesApi.guildGuildIdRolesGet({ guildId: serverId! }).then((r) => r.data ?? []),
    enabled: !!serverId,
    staleTime: 60_000,
  })

  // Close suggestions when clicking outside the entire component (editor + popup)
  useEffect(() => {
    function onPointerDown(e: PointerEvent) {
      if (!containerRef.current?.contains(e.target as Node)) {
        setSuggestions([])
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  function computeSuggestions(q: { trigger: '@' | '#'; query: string }) {
    const query = q.query.toLowerCase()

    if (q.trigger === '#') {
      const items: SuggestionItem[] = (channels ?? [])
        .filter((c): c is typeof c & { name: string } => {
          if (!c.name) return false
          // exclude category channels
          if (c.type === ChannelType.ChannelTypeGuildCategory) return false
          return !query || c.name.toLowerCase().includes(query)
        })
        .sort((a, b) => {
          const as = a.name.toLowerCase().startsWith(query)
          const bs = b.name.toLowerCase().startsWith(query)
          if (as !== bs) return as ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .slice(0, 10)
        .map((c) => ({
          type: 'channel' as const,
          id: String(c.id),
          display: `#${c.name}`,
          token: `<#${String(c.id)}>`,
          name: c.name,
        }))
      setSuggestions(items)
    } else {
      const memberItems: SuggestionItem[] = (members ?? [])
        .filter((m) => {
          if (!m.user?.id) return false
          const name = (m.username ?? m.user.name ?? '').toLowerCase()
          return !query || name.includes(query)
        })
        .sort((a, b) => {
          const an = (a.username ?? a.user?.name ?? '').toLowerCase()
          const bn = (b.username ?? b.user?.name ?? '').toLowerCase()
          const as = an.startsWith(query)
          const bs = bn.startsWith(query)
          if (as !== bs) return as ? -1 : 1
          return an.localeCompare(bn)
        })
        .slice(0, 8)
        .map((m) => {
          const name = m.username ?? m.user?.name ?? 'Unknown'
          return {
            type: 'user' as const,
            id: String(m.user!.id),
            display: `@${name}`,
            token: `<@${String(m.user!.id)}>`,
            name,
          }
        })

      const roleItems: SuggestionItem[] = (roles ?? [])
        .filter((r) => {
          if (!r.name) return false
          return !query || r.name.toLowerCase().includes(query)
        })
        .sort((a, b) => {
          const an = (a.name ?? '').toLowerCase()
          const bn = (b.name ?? '').toLowerCase()
          const as = an.startsWith(query)
          const bs = bn.startsWith(query)
          if (as !== bs) return as ? -1 : 1
          return an.localeCompare(bn)
        })
        .slice(0, 5)
        .map((r) => ({
          type: 'role' as const,
          id: String(r.id),
          display: `@${r.name}`,
          token: `<@&${String(r.id)}>`,
          name: r.name!,
          color: r.color,
        }))

      setSuggestions([...memberItems, ...roleItems].slice(0, 10))
    }
    setActiveIdx(0)
  }

  function selectSuggestion(item: SuggestionItem) {
    const el = editorRef.current
    if (!el) return
    el.focus()
    insertChip(item)
    setSuggestions([])
  }

  function handleInput() {
    const el = editorRef.current
    if (!el) return
    const q = getMentionQuery(el)
    if (q) {
      computeSuggestions(q)
    } else {
      setSuggestions([])
    }
    onTyping()
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    // Suggestion navigation
    if (suggestions.length > 0) {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setActiveIdx((i) => Math.min(i + 1, suggestions.length - 1))
        return
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault()
        setActiveIdx((i) => Math.max(i - 1, 0))
        return
      }
      if (e.key === 'Enter' || e.key === 'Tab') {
        e.preventDefault()
        const item = suggestions[activeIdx]
        if (item) selectSuggestion(item)
        return
      }
      if (e.key === 'Escape') {
        setSuggestions([])
        return
      }
    }

    // Send on Enter (no shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      const el = editorRef.current
      if (!el) return
      const content = serialize(el).trim()
      // Allow send with empty text when there are pending attachments
      if (!content && !hasAttachments) return
      onSend(content)
      el.innerHTML = ''
      setSuggestions([])
      return
    }

    // Shift+Enter → insert <br>
    if (e.key === 'Enter' && e.shiftKey) {
      e.preventDefault()
      const sel = window.getSelection()
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        const br = document.createElement('br')
        range.insertNode(br)
        range.setStartAfter(br)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
      }
      return
    }
  }

  function handlePaste(e: React.ClipboardEvent<HTMLDivElement>) {
    // Files in clipboard (e.g. a screenshot via Ctrl+V)
    if (e.clipboardData.files.length > 0) {
      e.preventDefault()
      onFileDrop?.(e.clipboardData.files)
      return
    }
    // Plain-text fallback — strip rich HTML
    e.preventDefault()
    const text = e.clipboardData.getData('text/plain')
    document.execCommand('insertText', false, text)
  }

  function insertEmojiInEditor(emoji: string) {
    const el = editorRef.current
    if (!el) return
    el.focus()
    const sel = window.getSelection()
    if (sel?.rangeCount) {
      const range = sel.getRangeAt(0)
      range.deleteContents()
      const textNode = document.createTextNode(emoji)
      range.insertNode(textNode)
      range.setStartAfter(textNode)
      range.collapse(true)
      sel.removeAllRanges()
      sel.addRange(range)
    } else {
      // Fallback: append
      const textNode = document.createTextNode(emoji)
      el.appendChild(textNode)
    }
    setSuggestions([])
  }

  // ── Drag-and-drop ────────────────────────────────────────────────────────

  function handleDragEnter(e: React.DragEvent) {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current++
    setIsDragging(true)
  }

  function handleDragLeave() {
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  function handleDrop(e: React.DragEvent) {
    e.preventDefault()
    dragCounterRef.current = 0
    setIsDragging(false)
    if (e.dataTransfer.files.length > 0) {
      onFileDrop?.(e.dataTransfer.files)
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div
      ref={containerRef}
      className="relative"
      onDragEnter={handleDragEnter}
      onDragLeave={handleDragLeave}
      onDragOver={handleDragOver}
      onDrop={handleDrop}
    >
      {/* Suggestions popup — sits above the input */}
      {suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b border-border">
            {suggestions[0]?.type === 'channel' ? 'Channels' : 'Members & Roles'}
          </div>
          {suggestions.map((item, i) => (
            <button
              key={`${item.type}-${item.id}`}
              type="button"
              onMouseDown={(e) => {
                // prevent blur before click registers
                e.preventDefault()
                selectSuggestion(item)
              }}
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${
                i === activeIdx
                  ? 'bg-accent text-accent-foreground'
                  : 'text-foreground hover:bg-accent/50'
              }`}
            >
              {item.type === 'channel' && (
                <Hash className="w-4 h-4 shrink-0 text-muted-foreground" />
              )}
              {item.type === 'user' && (
                <div className="w-6 h-6 rounded-full bg-muted shrink-0 flex items-center justify-center text-[11px] font-semibold">
                  {item.name.charAt(0).toUpperCase()}
                </div>
              )}
              {item.type === 'role' && (
                <Shield
                  className="w-4 h-4 shrink-0"
                  style={{ color: roleColor(item.color) ?? 'var(--muted-foreground)' }}
                />
              )}
              <span className="font-medium truncate">{item.name}</span>
              {item.type === 'role' && (
                <span className="ml-auto text-xs text-muted-foreground shrink-0">Role</span>
              )}
            </button>
          ))}
        </div>
      )}

      {/* ── Input box ──────────────────────────────────────────────────────── */}
      <div
        className={cn(
          'rounded-md border border-input shadow-xs transition-[color,box-shadow] focus-within:border-ring focus-within:ring-[3px] focus-within:ring-ring/50',
          isDragging && 'border-primary ring-[3px] ring-primary/50',
        )}
      >
        {/* Attachment preview bar — rendered above the text row when present */}
        {attachmentBar && (
          <div className="px-2 pt-2">
            {attachmentBar}
          </div>
        )}

        {/* Drag-over overlay label */}
        {isDragging && (
          <div className="px-3 py-2 text-sm text-primary font-medium text-center select-none pointer-events-none">
            Drop files to attach
          </div>
        )}

        {/* Text editor row */}
        <div className="flex items-end gap-1 px-3 py-2">
          {/* Paperclip button */}
          {onAttachClick && (
            <button
              type="button"
              onClick={onAttachClick}
              aria-label="Attach file"
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          )}

          <div
            ref={editorRef}
            contentEditable
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            data-placeholder={`Message #${channelName ?? channelId}`}
            className="mention-editor flex-1 min-h-[28px] max-h-48 overflow-y-auto outline-none text-sm text-foreground leading-6 break-words"
          />

          {/* Emoji picker */}
          <Popover>
            <PopoverTrigger asChild>
              <button
                type="button"
                aria-label="Open emoji picker"
                className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
              >
                <Smile className="h-5 w-5" />
              </button>
            </PopoverTrigger>
            <PopoverContent
              side="top"
              align="end"
              className="w-auto p-0 border-0 bg-transparent shadow-none"
            >
              <EmojiPicker onSelect={insertEmojiInEditor} />
            </PopoverContent>
          </Popover>
        </div>
      </div>
    </div>
  )
}
