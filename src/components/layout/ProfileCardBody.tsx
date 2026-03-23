import { cn } from '@/lib/utils'
import StatusDot from '@/components/ui/StatusDot'
import type { UserStatus } from '@/stores/presenceStore'

// ── Shared helpers ─────────────────────────────────────────────────────────────

const AVATAR_PALETTE = [
  '#5865f2', '#57f287', '#fee75c', '#eb459e',
  '#ed4245', '#3ba55c', '#faa61a', '#00b0f4',
]

export function userColor(userId: string): string {
  let h = 0
  for (const ch of userId) h = (h * 31 + ch.charCodeAt(0)) & 0x7fffffff
  return AVATAR_PALETTE[h % AVATAR_PALETTE.length]
}

export function colorToHex(color: number): string {
  return `#${Math.max(0, color ?? 0).toString(16).padStart(6, '0')}`
}

export function isDark(hex: string): boolean {
  const r = parseInt(hex.slice(1, 3), 16)
  const g = parseInt(hex.slice(3, 5), 16)
  const b = parseInt(hex.slice(5, 7), 16)
  return (r * 299 + g * 587 + b * 114) / 1000 < 145
}

/** Compute adaptive text colours from a panel background hex (or null for default theme). */
export function panelTextColors(panelColor: string | null) {
  if (!panelColor) return { textColor: undefined, mutedColor: undefined, dividerColor: undefined }
  const dark = isDark(panelColor)
  return {
    textColor: dark ? '#ffffff' : '#111111',
    mutedColor: dark ? 'rgba(255,255,255,0.55)' : 'rgba(0,0,0,0.5)',
    dividerColor: dark ? 'rgba(255,255,255,0.12)' : 'rgba(0,0,0,0.12)',
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

export interface ProfileCardBodyProps {
  /** Used for avatar placeholder colour derivation */
  userId: string
  displayName: string
  /** The user's "global" display name (shown below displayName if different) */
  globalName?: string
  discriminator?: string
  avatarUrl?: string
  bio?: string
  /** Hex panel background, e.g. '#2b2d31'. null → caller sets bg via CSS. */
  panelColor: string | null
  /** Hex banner strip colour. null → accent + opacity. */
  bannerColor: string | null
  /** Fallback avatar / banner tint colour (e.g. from userColor()). */
  accent: string
  /** Online presence status — shows a dot badge on the avatar when set */
  status?: UserStatus
  /** Additional sections rendered inside the padded content area (member since, roles, actions…) */
  children?: React.ReactNode
}

/**
 * Pure-visual profile card body: banner strip, overlapping avatar, name/bio, and
 * optional extra children (member-since, roles, action buttons).
 *
 * Does NOT set background colour — the caller is responsible for the outer container bg.
 */
export default function ProfileCardBody({
  displayName,
  globalName,
  discriminator,
  avatarUrl,
  bio,
  panelColor,
  bannerColor,
  accent,
  status,
  children,
}: ProfileCardBodyProps) {
  const bannerBg = bannerColor ?? (accent + '44')
  const { textColor, mutedColor, dividerColor } = panelTextColors(panelColor)

  return (
    <>
      {/* Banner strip */}
      <div className="h-14 shrink-0" style={{ backgroundColor: bannerBg }} />

      {/* Avatar — overlaps the banner */}
      <div className="-mt-8 px-4 pb-0">
        <div className="relative inline-block">
          {avatarUrl ? (
            <img
              src={avatarUrl}
              alt={displayName}
              className="w-16 h-16 rounded-full object-cover"
            />
          ) : (
            <div
              className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white select-none"
              style={{ backgroundColor: accent }}
            >
              {displayName.charAt(0).toUpperCase()}
            </div>
          )}
          {status && (
            <StatusDot
              status={status}
              className="absolute bottom-0.5 right-0.5 w-4 h-4 ring-popover"
              style={panelColor ? { '--tw-ring-color': panelColor } as React.CSSProperties : undefined}
            />
          )}
        </div>
      </div>

      {/* Content */}
      <div className="px-4 pb-4 pt-2 space-y-4">
        {/* Name block */}
        <div>
          <p className="font-bold text-base leading-snug" style={{ color: textColor }}>
            {displayName}
          </p>
          {globalName && globalName !== displayName && (
            <p
              className={cn('text-xs', !mutedColor && 'text-muted-foreground')}
              style={{ color: mutedColor }}
            >
              {globalName}
            </p>
          )}
          {discriminator && (
            <p
              className={cn('text-xs', !mutedColor && 'text-muted-foreground')}
              style={{ color: mutedColor }}
            >
              @{discriminator}
            </p>
          )}
        </div>

        {/* Bio */}
        {bio && (
          <div>
            <p
              className={cn('text-xs whitespace-pre-wrap break-words', !textColor && 'text-foreground')}
              style={{ color: textColor }}
            >
              {bio}
            </p>
          </div>
        )}

        {children}
      </div>
    </>
  )
}
