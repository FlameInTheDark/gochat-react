import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { useParams } from 'react-router-dom'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Hash, Shield, Paperclip, SendHorizontal } from 'lucide-react'
import { guildApi, rolesApi } from '@/api/client'
import { ChannelType } from '@/types'
import type { DtoChannel, DtoGuild, DtoMember, DtoRole } from '@/client'
import { calculateEffectivePermissions, hasPermission, PermissionBits } from '@/lib/permissions'
import { useAuthStore } from '@/stores/authStore'
import { Smile, ImagePlay } from 'lucide-react'
import EmojiPicker from './EmojiPicker'
import GifPicker from './GifPicker'
import { cn } from '@/lib/utils'
import { useTranslation } from 'react-i18next'
import { useClientMode } from '@/hooks/useClientMode'
import { useEmojiStore } from '@/stores/emojiStore'
import { emojiUrl } from '@/lib/emoji'
import { allEmojis } from '@/lib/emojiData'

// ── Types ─────────────────────────────────────────────────────────────────────

interface SuggestionItem {
  type: 'user' | 'channel' | 'role' | 'special' | 'emoji' | 'slash'
  id: string
  display: string  // text shown in the chip in the editor
  token: string    // serialized token: <@id> <#id> <@&id> or <:name:id>
  name: string     // name for the suggestion list
  color?: number   // role color (RGB integer, 0 = none)
  emojiId?: string // emoji image ID (for custom emoji type)
  unicodeEmoji?: string // unicode emoji character (for unicode emoji type)
  serverName?: string  // server name for custom emoji
  description?: string // slash command result preview
}

// ── Slash commands ────────────────────────────────────────────────────────────

const SLASH_COMMAND_LIST: Array<{ name: string; description: string }> = [
  { name: 'tableflip', description: '(╯°□°)╯︵ ┻━┻' },
  { name: 'unflip', description: '┬─┬ノ( º _ ºノ)' },
]

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
 * Detect a slash command trigger when the entire editor content is `/word`
 * (no chips). Returns the query after `/`, or null if not a slash context.
 */
function getSlashQuery(el: HTMLElement): string | null {
  if (el.querySelector('[data-token]')) return null
  const content = serialize(el)
  const match = content.match(/^\/(\w*)$/)
  if (!match) return null
  return match[1]!
}

/**
 * Find an incomplete mention/emoji trigger (@query, #query, or :query) immediately
 * before the cursor in the current text node.
 */
function getMentionQuery(
  el: HTMLElement,
): { trigger: '@' | '#' | ':'; query: string; triggerText: string } | null {
  const sel = window.getSelection()
  if (!sel?.rangeCount) return null
  const range = sel.getRangeAt(0)
  if (!range.collapsed) return null

  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return null
  // Make sure this text node is inside our editor
  if (!el.contains(node)) return null

  const textBefore = (node.textContent ?? '').slice(0, range.startOffset)
  // Match the last run of [@#:] + non-whitespace from the end of textBefore
  const match = textBefore.match(/([@#:][^\s@#:]*)$/)
  if (!match) return null

  const triggerText = match[1] // e.g. "@foo", "#bar", ":smile"
  const posInText = textBefore.length - triggerText.length
  // Must be at start of text or preceded by whitespace
  if (posInText > 0 && !/\s/.test(textBefore[posInText - 1]!)) return null

  return {
    trigger: triggerText[0] as '@' | '#' | ':',
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

/**
 * Insert a custom emoji `<:name:id>` as a non-editable image chip at the cursor,
 * replacing the `:query` trigger text that preceded it (if any).
 * Works identically to insertChip but renders an <img> instead of text.
 */
function insertCustomEmojiChip(name: string, id: string) {
  const sel = window.getSelection()
  if (!sel?.rangeCount) return
  const range = sel.getRangeAt(0)
  const node = range.startContainer
  if (node.nodeType !== Node.TEXT_NODE) return

  const text = node.textContent ?? ''
  const offset = range.startOffset
  const textBefore = text.slice(0, offset)

  // Remove the `:query` trigger text if present
  const match = textBefore.match(/(:)([A-Za-z0-9-]*)$/)
  const triggerStart = match ? offset - match[0].length : offset
  const beforeText = text.slice(0, triggerStart)
  const afterText = text.slice(offset)

  const span = document.createElement('span')
  span.contentEditable = 'false'
  span.dataset.token = `<:${name}:${id}>`
  const img = document.createElement('img')
  img.src = emojiUrl(id, 44)
  img.alt = `:${name}:`
  img.title = `:${name}:`
  img.className = 'inline-block h-[1.375em] w-auto align-middle pointer-events-none select-none'
  span.appendChild(img)

  const beforeNode = document.createTextNode(beforeText)
  const afterNode = document.createTextNode('\u00A0' + afterText)
  const parent = node.parentNode!
  parent.insertBefore(beforeNode, node)
  parent.insertBefore(span, node)
  parent.insertBefore(afterNode, node)
  parent.removeChild(node)

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
  disabled?: boolean
  topBar?: React.ReactNode
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

export interface MentionInputHandle {
  focusEditor: () => void
}

const MentionInput = forwardRef<MentionInputHandle, Props>(function MentionInput({
  channelId,
  channelName,
  onSend,
  onTyping,
  disabled = false,
  topBar,
  onAttachClick,
  onFileDrop,
  attachmentBar,
  hasAttachments,
}: Props, ref) {
  const { serverId } = useParams<{ serverId?: string }>()
  const { t } = useTranslation()
  const isMobile = useClientMode() === 'mobile'
  const queryClient = useQueryClient()
  const currentUser = useAuthStore((s) => s.user)

  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<HTMLDivElement>(null)
  const [suggestions, setSuggestions] = useState<SuggestionItem[]>([])
  const [activeIdx, setActiveIdx] = useState(0)
  const [emojiOpen, setEmojiOpen] = useState(false)
  const [gifOpen, setGifOpen] = useState(false)
  const [pickerBottom, setPickerBottom] = useState(64)
  const [pickerRight, setPickerRight] = useState(0)

  function openPicker(which: 'emoji' | 'gif') {
    const rect = containerRef.current?.getBoundingClientRect()
    setPickerBottom(rect ? window.innerHeight - rect.top : 64)
    setPickerRight(rect ? window.innerWidth - rect.right : 0)
    setEmojiOpen(which === 'emoji')
    setGifOpen(which === 'gif')
  }
  // Tracks drag-enter depth so dragleave on children doesn't hide the highlight
  const dragCounterRef = useRef(0)
  const [isDragging, setIsDragging] = useState(false)

  // Custom emojis from the global store
  const guildEmojiMap = useEmojiStore((s) => s.guildEmojis)
  const guilds = queryClient.getQueryData<DtoGuild[]>(['guilds'])

  const customEmojiGroups = useMemo(() =>
    Object.entries(guildEmojiMap)
      .filter(([, emojis]) => emojis.length > 0)
      .map(([guildId, emojis]) => {
        const guild = guilds?.find((g) => String(g.id) === guildId)
        return {
          guildId,
          guildName: guild?.name ?? guildId,
          guildIconUrl: guild?.icon?.url,
          emojis,
        }
      }),
  [guildEmojiMap, guilds])

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

  // Channel visibility — mirrors ChannelSidebar logic
  const guild = queryClient.getQueryData<DtoGuild[]>(['guilds'])?.find((g) => String(g.id) === serverId)
  const isOwner = guild?.owner != null && currentUser?.id !== undefined && String(guild.owner) === String(currentUser.id)
  const currentMember = members?.find((m) => m.user?.id === currentUser?.id)
  const effectivePermissions = currentMember && roles
    ? calculateEffectivePermissions(currentMember as DtoMember, roles as DtoRole[])
    : 0
  const isAdmin = hasPermission(effectivePermissions, PermissionBits.ADMINISTRATOR)
  const memberRoleIds = new Set((currentMember?.roles ?? []).map(String))

  function canViewChannel(ch: DtoChannel): boolean {
    if (isOwner || isAdmin) return true
    if (!ch.private) return true
    return (ch.roles ?? []).some((r) => memberRoleIds.has(String(r)))
  }

  const allChannels = channels ?? []
  const categoryIds = new Set(
    allChannels.filter((c) => c.type === ChannelType.ChannelTypeGuildCategory).map((c) => String(c.id)),
  )
  const visibleCategoryIds = new Set(
    allChannels
      .filter((c) => c.type === ChannelType.ChannelTypeGuildCategory && canViewChannel(c))
      .map((c) => String(c.id)),
  )

  function isChannelVisible(ch: DtoChannel): boolean {
    if (!canViewChannel(ch)) return false
    const parentId = ch.parent_id ? String(ch.parent_id) : null
    if (parentId && categoryIds.has(parentId) && !visibleCategoryIds.has(parentId)) return false
    return true
  }

  const focusEditor = useCallback(() => {
    const el = editorRef.current
    if (!el || disabled) return

    el.focus()

    const selection = window.getSelection()
    if (!selection) return

    const range = document.createRange()
    range.selectNodeContents(el)
    range.collapse(false)
    selection.removeAllRanges()
    selection.addRange(range)
  }, [disabled])

  useImperativeHandle(ref, () => ({
    focusEditor,
  }), [focusEditor])

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

  // Initialize empty class on mount
  useEffect(() => {
    const el = editorRef.current
    if (el) {
      el.classList.add('is-empty')
    }
  }, [])

  function computeSlashSuggestions(query: string) {
    const q = query.toLowerCase()
    const items: SuggestionItem[] = SLASH_COMMAND_LIST
      .filter((cmd) => !q || cmd.name.startsWith(q))
      .map((cmd) => ({
        type: 'slash' as const,
        id: cmd.name,
        display: `/${cmd.name}`,
        token: `/${cmd.name}`,
        name: cmd.name,
        description: cmd.description,
      }))
    setSuggestions(items)
    setActiveIdx(0)
  }

  function computeSuggestions(q: { trigger: '@' | '#' | ':'; query: string }) {
    const query = q.query.toLowerCase()

    if (q.trigger === ':') {
      // Emoji completion — require at least 1 char to avoid showing all emojis
      if (!query) {
        setSuggestions([])
        return
      }
      const customItems: SuggestionItem[] = customEmojiGroups
        .flatMap((g) => g.emojis.map((e) => ({ ...e, guildName: g.guildName })))
        .filter((e) => e.name.toLowerCase().includes(query))
        .sort((a, b) => {
          const as = a.name.toLowerCase().startsWith(query)
          const bs = b.name.toLowerCase().startsWith(query)
          if (as !== bs) return as ? -1 : 1
          return a.name.localeCompare(b.name)
        })
        .slice(0, 5)
        .map((e) => ({
          type: 'emoji' as const,
          id: e.id,
          display: `:${e.name}:`,
          token: `<:${e.name}:${e.id}>`,
          name: e.name,
          emojiId: e.id,
          serverName: e.guildName,
        }))
      const unicodeItems: SuggestionItem[] = allEmojis
        .filter((e) => e.slug.includes(query) || e.name.toLowerCase().includes(query))
        .sort((a, b) => {
          const as = a.slug.startsWith(query)
          const bs = b.slug.startsWith(query)
          if (as !== bs) return as ? -1 : 1
          return a.slug.localeCompare(b.slug)
        })
        .slice(0, 10 - customItems.length)
        .map((e) => ({
          type: 'emoji' as const,
          id: e.slug,
          display: e.emoji,
          token: e.emoji,
          name: e.slug,
          unicodeEmoji: e.emoji,
        }))
      const items = [...customItems, ...unicodeItems]
      setSuggestions(items)
      setActiveIdx(0)
      return
    }

    if (q.trigger === '#') {
      const items: SuggestionItem[] = allChannels
        .filter((c): c is typeof c & { name: string } => {
          if (!c.name) return false
          // exclude category channels and channels the user cannot see
          if (c.type === ChannelType.ChannelTypeGuildCategory) return false
          if (!isChannelVisible(c)) return false
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
      const specialItems: SuggestionItem[] = (
        [
          { id: 'everyone', name: 'everyone', display: '@everyone', token: '@everyone' },
          { id: 'here', name: 'here', display: '@here', token: '@here' },
        ] as const
      )
        .filter((s) => !query || s.name.startsWith(query))
        .map((s) => ({ type: 'special' as const, ...s }))

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

      setSuggestions([...specialItems, ...memberItems, ...roleItems].slice(0, 10))
    }
    setActiveIdx(0)
  }

  function selectSuggestion(item: SuggestionItem) {
    const el = editorRef.current
    if (!el) return
    el.focus()
    if (item.type === 'slash') {
      // Clear the editor and fire onSend immediately — MessageInput.send() expands the command
      while (el.firstChild) el.removeChild(el.firstChild)
      el.classList.add('is-empty')
      setSuggestions([])
      onSend(`/${item.name}`)
      return
    }
    if (item.type === 'emoji') {
      if (item.unicodeEmoji) {
        insertEmojiInEditor(item.unicodeEmoji)
      } else {
        insertCustomEmojiChip(item.name, item.emojiId!)
      }
    } else {
      insertChip(item)
    }
    setSuggestions([])
    // Re-evaluate empty state
    const isEmpty = !el.textContent?.trim() && !el.querySelector('[data-token]')
    el.classList.toggle('is-empty', isEmpty)
  }

  function handleInput() {
    if (disabled) return
    const el = editorRef.current
    if (!el) return

    // Check if editor is truly empty (no visible text and no emoji chips)
    const isEmpty = !el.textContent?.trim() && !el.querySelector('[data-token]')
    el.classList.toggle('is-empty', isEmpty)
    
    const slashQuery = getSlashQuery(el)
    if (slashQuery !== null) {
      computeSlashSuggestions(slashQuery)
    } else {
      const q = getMentionQuery(el)
      if (q) {
        computeSuggestions(q)
      } else {
        setSuggestions([])
      }
    }
    onTyping()
  }

  function handleSend() {
    const el = editorRef.current
    if (!el) return
    const content = serialize(el).trim()
    if (!content && !hasAttachments) return
    onSend(content)
    while (el.firstChild) {
      el.removeChild(el.firstChild)
    }
    el.classList.add('is-empty')
    setSuggestions([])
  }

  function handleKeyDown(e: React.KeyboardEvent<HTMLDivElement>) {
    if (disabled) {
      e.preventDefault()
      return
    }

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

    // Backspace: delete adjacent emoji/mention chip in one keystroke
    if (e.key === 'Backspace') {
      const sel = window.getSelection()
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0)
        if (range.collapsed) {
          const node = range.startContainer
          const offset = range.startOffset
          let chip: HTMLElement | null = null

          if (node.nodeType === Node.TEXT_NODE && offset === 0) {
            // Cursor at start of a text node — previous sibling may be a chip
            const prev = (node as Text).previousSibling
            if (prev instanceof HTMLElement && prev.dataset.token) chip = prev
          } else if (node.nodeType === Node.ELEMENT_NODE && offset > 0) {
            // Cursor inside the editor element itself — child at offset-1 may be a chip
            const prev = (node as HTMLElement).childNodes[offset - 1]
            if (prev instanceof HTMLElement && prev.dataset.token) chip = prev
          }

          if (chip) {
            e.preventDefault()
            chip.remove()
            const el2 = editorRef.current!
            const isEmpty = !el2.textContent?.trim() && !el2.querySelector('[data-token]')
            el2.classList.toggle('is-empty', isEmpty)
            return
          }
        }
      }
    }

    // Send on Enter (no shift)
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      handleSend()
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
    if (disabled) {
      e.preventDefault()
      return
    }
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
    if (disabled) return
    const el = editorRef.current
    if (!el) return
    el.focus()

    // Custom emoji token <:name:id> → insert as image chip
    const customMatch = emoji.match(/^<:([A-Za-z0-9-]+):(\d+)>$/)
    if (customMatch) {
      const name = customMatch[1]!
      const id = customMatch[2]!
      const token = emoji
      const span = document.createElement('span')
      span.contentEditable = 'false'
      span.dataset.token = token
      const img = document.createElement('img')
      img.src = emojiUrl(id, 44)
      img.alt = `:${name}:`
      img.title = `:${name}:`
      img.className = 'inline-block h-[1.375em] w-auto align-middle pointer-events-none select-none'
      span.appendChild(img)

      const sel = window.getSelection()
      if (sel?.rangeCount) {
        const range = sel.getRangeAt(0)
        range.deleteContents()
        range.insertNode(span)
        const afterNode = document.createTextNode('\u00A0')
        span.after(afterNode)
        range.setStart(afterNode, 1)
        range.collapse(true)
        sel.removeAllRanges()
        sel.addRange(range)
      } else {
        el.appendChild(span)
      }
      setSuggestions([])
      el.classList.remove('is-empty')
      return
    }

    // Unicode emoji → insert as plain text
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
      el.appendChild(document.createTextNode(emoji))
    }
    setSuggestions([])
    el.classList.remove('is-empty')
  }

  // ── Drag-and-drop ────────────────────────────────────────────────────────

  function handleDragEnter(e: React.DragEvent) {
    if (disabled) return
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    dragCounterRef.current++
    setIsDragging(true)
  }

  function handleDragLeave() {
    if (disabled) return
    dragCounterRef.current--
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDragging(false)
    }
  }

  function handleDragOver(e: React.DragEvent) {
    if (disabled) return
    if (e.dataTransfer.types.includes('Files')) e.preventDefault()
  }

  function handleDrop(e: React.DragEvent) {
    if (disabled) return
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
      {!disabled && suggestions.length > 0 && (
        <div className="absolute bottom-full left-0 right-0 mb-1 rounded-lg border border-border bg-popover shadow-lg overflow-hidden">
          <div className="px-2 py-1 text-xs font-semibold text-muted-foreground uppercase tracking-wide border-b border-border">
            {suggestions[0]?.type === 'slash'
              ? t('chat.commands', 'Commands')
              : suggestions[0]?.type === 'channel'
                ? t('chat.channels')
                : suggestions[0]?.type === 'emoji'
                  ? 'Emoji'
                  : t('chat.membersAndRoles')}
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
              className={`w-full flex items-center gap-3 px-3 py-2 text-sm transition-colors ${i === activeIdx
                ? 'bg-accent text-accent-foreground'
                : 'text-foreground hover:bg-accent/50'
                }`}
            >
              {item.type === 'slash' && (
                <div className="w-6 h-6 rounded bg-muted shrink-0 flex items-center justify-center text-[13px] font-bold text-muted-foreground">
                  /
                </div>
              )}
              {item.type === 'emoji' && item.emojiId && (
                <img
                  src={emojiUrl(item.emojiId, 44)}
                  alt={item.name}
                  className="w-6 h-6 shrink-0 object-contain"
                />
              )}
              {item.type === 'emoji' && item.unicodeEmoji && (
                <span className="w-6 h-6 shrink-0 flex items-center justify-center text-xl leading-none">{item.unicodeEmoji}</span>
              )}
              {item.type === 'channel' && (
                <Hash className="w-4 h-4 shrink-0 text-muted-foreground" />
              )}
              {item.type === 'special' && (
                <div className="w-6 h-6 rounded-full bg-muted shrink-0 flex items-center justify-center text-[11px] font-semibold text-muted-foreground">
                  @
                </div>
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
              <span className="font-medium truncate">
                {item.type === 'slash' ? `/${item.name}` : item.name}
              </span>
              {item.type === 'slash' && item.description && (
                <span className="ml-auto text-xs text-muted-foreground shrink-0 pl-2">{item.description}</span>
              )}
              {item.type === 'emoji' && item.serverName && (
                <span className="ml-auto text-xs text-muted-foreground shrink-0 pl-2 truncate max-w-[120px]">{item.serverName}</span>
              )}
              {item.type === 'role' && (
                <span className="ml-auto text-xs text-muted-foreground shrink-0">{t('chat.role')}</span>
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
        {topBar}

        {/* Attachment preview bar — rendered above the text row when present */}
        {attachmentBar && (
          <div className="px-2 pt-2">
            {attachmentBar}
          </div>
        )}

        {/* Drag-over overlay label */}
        {isDragging && (
          <div className="px-3 py-2 text-sm text-primary font-medium text-center select-none pointer-events-none">
            {t('chat.dropFiles')}
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
              disabled={disabled}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-muted-foreground transition-colors hover:text-foreground"
            >
              <Paperclip className="h-5 w-5" />
            </button>
          )}

          <div
            ref={editorRef}
            contentEditable={!disabled}
            suppressContentEditableWarning
            onInput={handleInput}
            onKeyDown={handleKeyDown}
            onPaste={handlePaste}
            aria-disabled={disabled}
            data-placeholder={t('chat.messagePlaceholder', { name: channelName ?? channelId })}
            className={cn(
              'mention-editor flex-1 min-h-[28px] max-h-48 overflow-y-auto outline-none text-sm text-foreground leading-6 break-words',
              disabled && 'cursor-not-allowed text-muted-foreground',
            )}
          />

          {/* GIF picker */}
          <button
            type="button"
            aria-label="Open GIF picker"
            disabled={disabled}
            onClick={() => gifOpen ? setGifOpen(false) : openPicker('gif')}
            className={cn(
              'mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors',
              gifOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <ImagePlay className="h-5 w-5" />
          </button>
          {gifOpen && createPortal(
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => setGifOpen(false)} />
              <div
                className={cn('fixed z-[100] px-2 pb-2', isMobile && 'left-0 right-0')}
                style={{ bottom: pickerBottom, ...(isMobile ? {} : { right: pickerRight }) }}
              >
                <GifPicker onSelect={(url) => { onSend(url); setGifOpen(false) }} isMobile={isMobile} />
              </div>
            </>,
            document.body,
          )}

          {/* Emoji picker */}
          <button
            type="button"
            aria-label="Open emoji picker"
            disabled={disabled}
            onClick={() => emojiOpen ? setEmojiOpen(false) : openPicker('emoji')}
            className={cn(
              'mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded transition-colors',
              emojiOpen ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            <Smile className="h-5 w-5" />
          </button>
          {emojiOpen && createPortal(
            <>
              <div className="fixed inset-0 z-[99]" onClick={() => setEmojiOpen(false)} />
              <div
                className={cn('fixed z-[100] px-2 pb-2', isMobile && 'left-0 right-0')}
                style={{ bottom: pickerBottom, ...(isMobile ? {} : { right: pickerRight }) }}
              >
                <EmojiPicker
                  onSelect={(e) => { insertEmojiInEditor(e); if (isMobile) setEmojiOpen(false) }}
                  customEmojiGroups={customEmojiGroups}
                  isMobile={isMobile}
                />
              </div>
            </>,
            document.body,
          )}

          {/* Send button — mobile only */}
          {isMobile && (
            <button
              type="button"
              onMouseDown={(e) => e.preventDefault()}
              onClick={handleSend}
              disabled={disabled}
              aria-label={t('chat.send')}
              className="mb-0.5 flex h-7 w-7 shrink-0 items-center justify-center rounded text-primary transition-colors hover:text-primary/80 disabled:opacity-40"
            >
              <SendHorizontal className="h-5 w-5" />
            </button>
          )}
        </div>
      </div>
    </div>
  )
})

MentionInput.displayName = 'MentionInput'

export default MentionInput
