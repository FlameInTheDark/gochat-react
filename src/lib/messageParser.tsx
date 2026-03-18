import React from 'react'
import CodeBlock from '@/components/chat/CodeBlock'
import { emojiUrl } from '@/lib/emoji'
import AnimatedImage from '@/components/ui/AnimatedImage'

// ── Resolver ─────────────────────────────────────────────────────────────────

export interface MentionResolver {
  user?: (id: string) => string | undefined
  channel?: (id: string) => string | undefined
  role?: (id: string) => string | undefined
  onUserClick?: (userId: string, x: number, y: number) => void
  onChannelClick?: (channelId: string) => void
}


// ── Inline token regex ────────────────────────────────────────────────────────
// Groups:
//   1 = bold+italic  (***...***) — MUST come before bold and italic
//   2 = bold inner   (**...** )
//   3 = italic*      (*...*)
//   4 = italic_      (_..._)
//   5 = underline    (__...__)  — MUST come before italic_
//   6 = strike       (~~...~~)
//   7 = inline code  (`...`)
//   8 = roleId       (<@&id>)  — MUST come before user to avoid partial match
//   9 = userId       (<@id>)
//  10 = channelId    (<#id>)
//  11 = emoji name   (<:name:id>)
//  12 = emoji id     (<:name:id>)
// No groups: @everyone | @here | https://…
const INLINE_SOURCE =
  /\*\*\*(.+?)\*\*\*|\*\*(.+?)\*\*|\*(.+?)\*|__(.+?)__|_(.+?)_|~~(.+?)~~|`([^`\n]+)`|<@&(\d+)>|<@(\d+)>|<#(\d+)>|<:([A-Za-z0-9-]+):(\d+)>|@everyone|@here|https?:\/\/[^\s<>)]+/
    .source

const PILL_CLASS: Record<'user' | 'channel' | 'role', string> = {
  user:    'bg-blue-500/20 text-blue-400 hover:bg-blue-500/35',
  channel: 'bg-zinc-500/20 text-zinc-300 hover:bg-zinc-500/35',
  role:    'bg-violet-500/20 text-violet-400 hover:bg-violet-500/35',
}

function parseMentionPill(
  key: string,
  type: 'user' | 'channel' | 'role',
  id: string,
  resolver: MentionResolver | undefined,
) {
  let label: string
  if (type === 'user') {
    const name = resolver?.user?.(id)
    label = name ? `@${name}` : `@${id}`
  } else if (type === 'channel') {
    const name = resolver?.channel?.(id)
    label = name ? `#${name}` : `#${id}`
  } else {
    const name = resolver?.role?.(id)
    label = name ? `@${name}` : `@${id}`
  }

  const onClick =
    type === 'user' && resolver?.onUserClick
      ? (e: React.MouseEvent) => resolver.onUserClick!(id, e.clientX, e.clientY)
      : type === 'channel' && resolver?.onChannelClick
        ? () => resolver.onChannelClick!(id)
        : undefined

  return (
    <span
      key={key}
      onClick={onClick}
      data-message-interactive={onClick ? 'true' : undefined}
      className={`rounded px-0.5 font-medium transition-colors ${PILL_CLASS[type]} ${onClick ? 'cursor-pointer' : 'cursor-default'}`}
    >
      {label}
    </span>
  )
}

function parseInline(
  text: string,
  prefix: string,
  resolver: MentionResolver | undefined,
): React.ReactNode[] {
  const nodes: React.ReactNode[] = []
  let lastIdx = 0
  let count = 0
  const re = new RegExp(INLINE_SOURCE, 'g')
  let match: RegExpExecArray | null

  while ((match = re.exec(text)) !== null) {
    if (match.index > lastIdx) {
      nodes.push(text.slice(lastIdx, match.index))
    }

    const k = `${prefix}-${count++}`
    const full = match[0]

    if (match[1] !== undefined) {
      // bold + italic
      nodes.push(<strong key={k}><em>{parseInline(match[1], k, resolver)}</em></strong>)
    } else if (match[2] !== undefined) {
      // bold
      nodes.push(<strong key={k}>{parseInline(match[2], k, resolver)}</strong>)
    } else if (match[3] !== undefined) {
      // italic *
      nodes.push(<em key={k}>{parseInline(match[3], k, resolver)}</em>)
    } else if (match[4] !== undefined) {
      // underline __text__
      nodes.push(<span key={k} className="underline underline-offset-2">{parseInline(match[4], k, resolver)}</span>)
    } else if (match[5] !== undefined) {
      // italic _
      nodes.push(<em key={k}>{parseInline(match[5], k, resolver)}</em>)
    } else if (match[6] !== undefined) {
      // strikethrough
      nodes.push(<s key={k}>{parseInline(match[6], k, resolver)}</s>)
    } else if (match[7] !== undefined) {
      // inline code
      nodes.push(
        <code key={k} className="bg-muted/80 px-1 py-0.5 rounded text-[0.85em] font-mono">
          {match[7]}
        </code>,
      )
    } else if (match[8] !== undefined) {
      // <@&roleId>
      nodes.push(parseMentionPill(k, 'role', match[8], resolver))
    } else if (match[9] !== undefined) {
      // <@userId>
      nodes.push(parseMentionPill(k, 'user', match[9], resolver))
    } else if (match[10] !== undefined) {
      // <#channelId>
      nodes.push(parseMentionPill(k, 'channel', match[10], resolver))
    } else if (match[11] !== undefined && match[12] !== undefined) {
      // Custom emoji <:name:id>
      const emojiName = match[11]
      const emojiId = match[12]
      const emojiSrc = emojiUrl(emojiId, 44)
      nodes.push(
        <AnimatedImage
          key={k}
          src={emojiSrc}
          pauseFallback={emojiSrc}
          alt={`:${emojiName}:`}
          title={`:${emojiName}:`}
          className="inline-block h-[1.375em] w-auto align-middle mx-0.5"
        />,
      )
    } else if (full === '@everyone' || full === '@here') {
      nodes.push(
        <span key={k} className="bg-primary/20 text-primary rounded px-0.5 font-medium">
          {full}
        </span>,
      )
    } else {
      // URL
      nodes.push(
        <a
          key={k}
          href={full}
          target="_blank"
          rel="noopener noreferrer"
          data-message-interactive="true"
          className="text-primary underline underline-offset-2 hover:opacity-80 break-all"
        >
          {full}
        </a>,
      )
    }

    lastIdx = match.index + full.length
  }

  if (lastIdx < text.length) {
    nodes.push(text.slice(lastIdx))
  }

  return nodes
}

export function parseInlineMessageContent(
  content: string | null | undefined,
  resolver?: MentionResolver,
  prefix = 'inline-preview',
): React.ReactNode {
  if (!content) return null
  const normalized = content.replace(/\s+/g, ' ').trim()
  if (!normalized) return null
  return <>{parseInline(normalized, prefix, resolver)}</>
}

// ── Block-level parser ────────────────────────────────────────────────────────
//
// Handles (per line):
//   # / ## / ###  → headings
//   - item / * item  → <ul>
//   1. item          → <ol>
//   > text           → <blockquote>
//   (empty line)     → <br>
//   plain text       → inline parsing

function appendLines(
  out: React.ReactNode[],
  text: string,
  prefix: string,
  resolver: MentionResolver | undefined,
): void {
  const lines = text.split('\n')

  interface PendingList {
    kind: 'ul' | 'ol'
    items: React.ReactNode[]
  }
  let pending: PendingList | null = null
  let nodeCount = 0

  const flushList = () => {
    if (!pending) return
    const key = `${prefix}-list${nodeCount++}`
    out.push(
      pending.kind === 'ul' ? (
        <ul key={key} className="list-disc list-outside ml-5 my-0.5 space-y-0.5 text-sm">
          {pending.items}
        </ul>
      ) : (
        <ol key={key} className="list-decimal list-outside ml-5 my-0.5 space-y-0.5 text-sm">
          {pending.items}
        </ol>
      ),
    )
    pending = null
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!

    // ── Headings: # / ## / ### ───────────────────────────────────────────────
    const hm = line.match(/^(#{1,3}) (.+)$/)
    if (hm) {
      flushList()
      if (out.length > 0) out.push(<br key={`${prefix}-br${i}`} />)
      const level = hm[1].length as 1 | 2 | 3
      const Tag = (['h1', 'h2', 'h3'] as const)[level - 1]
      const cls = (
        ['text-xl font-bold leading-tight mt-0.5', 'text-lg font-semibold leading-tight mt-0.5', 'text-base font-semibold leading-tight'] as const
      )[level - 1]
      out.push(
        <Tag key={`${prefix}-h${i}`} className={cls}>
          {parseInline(hm[2], `${prefix}-h${i}`, resolver)}
        </Tag>,
      )
      continue
    }

    // ── Unordered list: - item  or  * item ──────────────────────────────────
    const um = line.match(/^[-*] (.+)$/)
    if (um) {
      if (pending?.kind !== 'ul') {
        flushList()
        // Add a spacer before the list if there's already content
        if (out.length > 0) out.push(<br key={`${prefix}-brpre${i}`} />)
        pending = { kind: 'ul', items: [] }
      }
      pending.items.push(
        <li key={pending.items.length}>
          {parseInline(um[1], `${prefix}-li${i}`, resolver)}
        </li>,
      )
      continue
    }

    // ── Ordered list: 1. item ─────────────────────────────────────────────
    const om = line.match(/^\d+\. (.+)$/)
    if (om) {
      if (pending?.kind !== 'ol') {
        flushList()
        if (out.length > 0) out.push(<br key={`${prefix}-brpre${i}`} />)
        pending = { kind: 'ol', items: [] }
      }
      pending.items.push(
        <li key={pending.items.length}>
          {parseInline(om[1], `${prefix}-oli${i}`, resolver)}
        </li>,
      )
      continue
    }

    // Non-list line: flush any pending list
    flushList()

    if (i > 0) out.push(<br key={`${prefix}-br${i}`} />)

    // ── Blockquote: > text ────────────────────────────────────────────────
    if (line.startsWith('> ')) {
      out.push(
        <blockquote
          key={`${prefix}-bq${i}`}
          className="border-l-2 border-muted-foreground/40 pl-2 my-0.5 text-muted-foreground/80 italic"
        >
          {parseInline(line.slice(2), `${prefix}-bq${i}`, resolver)}
        </blockquote>,
      )
    } else if (line) {
      out.push(...parseInline(line, `${prefix}-ln${i}`, resolver))
    }
    // empty line → the <br> already added above is the blank line
  }

  flushList()
}

// ── Emoji-only detection ──────────────────────────────────────────────────────

const CUSTOM_EMOJI_TOKEN_RE = /<:[A-Za-z0-9-]+:\d+>/g
// Extended_Pictographic covers emoji, symbols, and ZWJ sequences in modern V8/browsers
const EXTENDED_PICTOGRAPHIC_RE = /\p{Extended_Pictographic}[\uFE00-\uFE0F\u20E3]?(?:\u200D\p{Extended_Pictographic}[\uFE00-\uFE0F\u20E3]?)*/gu

/**
 * Returns true when `content` consists exclusively of emoji (custom and/or
 * unicode) and whitespace, with at most 9 total emoji. Used to render
 * emoji-only messages at a larger font size.
 */
export function isEmojiOnlyMessage(content: string): boolean {
  if (!content.trim()) return false
  const customCount = (content.match(CUSTOM_EMOJI_TOKEN_RE) ?? []).length
  const stripped = content.replace(CUSTOM_EMOJI_TOKEN_RE, '')
  const unicodeCount = (stripped.match(EXTENDED_PICTOGRAPHIC_RE) ?? []).length
  const remaining = stripped
    .replace(EXTENDED_PICTOGRAPHIC_RE, '')
    .replace(/[\uFE00-\uFE0F\u200D\u20E3\s]/g, '')
  const total = customCount + unicodeCount
  return remaining.length === 0 && total > 0 && total <= 9
}

// ── Main export ───────────────────────────────────────────────────────────────

/**
 * Parse a message content string into React nodes.
 *
 * Handled (in priority order):
 *   - Fenced code blocks  (```lang\ncode\n```)  — syntax-highlighted
 *   - Headings            (# / ## / ###)
 *   - Unordered lists     (- item  /  * item)
 *   - Ordered lists       (1. item)
 *   - Blockquotes         (> text)
 *   - Bold+italic         (***text***)
 *   - Bold                (**text**)
 *   - Italic              (*text*  /  _text_)
 *   - Underline           (__text__)
 *   - Strikethrough       (~~text~~)
 *   - Inline code         (`code`)
 *   - Role mentions       (<@&id>)
 *   - User mentions       (<@id>)
 *   - Channel refs        (<#id>)
 *   - @everyone / @here
 *   - Auto-linked URLs
 */
export function parseMessageContent(
  content: string | null | undefined,
  resolver?: MentionResolver,
): React.ReactNode {
  if (!content) return null

  const nodes: React.ReactNode[] = []
  let lastIdx = 0
  let blockIdx = 0

  // Fenced code blocks take highest priority
  const fenceRe = /```(\w*)\n?([\s\S]*?)```/g
  let match: RegExpExecArray | null

  while ((match = fenceRe.exec(content)) !== null) {
    if (match.index > lastIdx) {
      appendLines(nodes, content.slice(lastIdx, match.index), `t${blockIdx}`, resolver)
    }

    const lang = match[1]?.trim() || undefined
    const code = (match[2] ?? '').trimEnd()
    nodes.push(<CodeBlock key={`pre${blockIdx}`} code={code} lang={lang} />)

    lastIdx = match.index + match[0].length
    blockIdx++
  }

  if (lastIdx < content.length) {
    appendLines(nodes, content.slice(lastIdx), `t${blockIdx}`, resolver)
  }

  return nodes.length === 0 ? null : <>{nodes}</>
}
