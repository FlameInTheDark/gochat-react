/* eslint-disable react-refresh/only-export-components */
import { Camera } from 'lucide-react'
import { cn } from '@/lib/utils'
import StatusDot from '@/components/ui/StatusDot'
import BotBadge from '@/components/ui/BotBadge'
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
  isBot?: boolean
  /** The user's "global" display name (shown below displayName if different) */
  globalName?: string
  discriminator?: string
  avatarUrl?: string
  bannerUrl?: string
  bannerCrop?: {
    x: number
    y: number
    width: number
    height: number
    sourceWidth: number
    sourceHeight: number
  }
  bio?: string
  /** Hex panel background, e.g. '#2b2d31'. null → caller sets bg via CSS. */
  panelColor: string | null
  /** Hex banner strip colour. null → accent + opacity. */
  bannerColor: string | null
  /** Fallback avatar / banner tint colour (e.g. from userColor()). */
  accent: string
  /** Online presence status — shows a dot badge on the avatar when set */
  status?: UserStatus
  /** Optional controls rendered in the banner's top-right corner. */
  headerActions?: React.ReactNode
  /** Optional handler that turns the avatar into an edit target. */
  onAvatarClick?: () => void
  /** Optional handler that turns the banner into an edit target. */
  onBannerClick?: () => void
  avatarBusy?: boolean
  bannerBusy?: boolean
  avatarActionLabel?: string
  bannerActionLabel?: string
  /** Optional editor rendered where the display name normally appears. */
  displayNameEditor?: React.ReactNode
  /** Optional editor rendered where the discriminator normally appears. */
  discriminatorEditor?: React.ReactNode
  /** Optional editor rendered exactly where the read-only bio normally appears. */
  bioEditor?: React.ReactNode
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
  isBot,
  globalName,
  discriminator,
  avatarUrl,
  bannerUrl,
  bannerCrop,
  bio,
  panelColor,
  bannerColor,
  accent,
  status,
  headerActions,
  onAvatarClick,
  onBannerClick,
  avatarBusy = false,
  bannerBusy = false,
  avatarActionLabel,
  bannerActionLabel,
  displayNameEditor,
  discriminatorEditor,
  bioEditor,
  children,
}: ProfileCardBodyProps) {
  const bannerBg = bannerColor ?? (accent + '44')
  const { textColor, mutedColor } = panelTextColors(panelColor)
  const croppedBannerStyle = bannerCrop
    ? {
        left: `${-(bannerCrop.x / bannerCrop.width) * 100}%`,
        top: `${-(bannerCrop.y / bannerCrop.height) * 100}%`,
        width: `${(bannerCrop.sourceWidth / bannerCrop.width) * 100}%`,
        height: `${(bannerCrop.sourceHeight / bannerCrop.height) * 100}%`,
      }
    : undefined
  const avatarMedia = (
    <>
      {avatarUrl ? (
        <img
          src={avatarUrl}
          alt={displayName}
          className="block w-16 h-16 rounded-full object-cover"
        />
      ) : (
        <div
          className="w-16 h-16 rounded-full flex items-center justify-center text-2xl font-bold text-white select-none"
          style={{ backgroundColor: accent }}
        >
          {displayName.charAt(0).toUpperCase()}
        </div>
      )}
      {onAvatarClick && (
        <span
          className={cn(
            'absolute inset-0 rounded-full bg-black/60 flex items-center justify-center text-white opacity-0 transition-opacity pointer-events-none',
            avatarBusy ? 'opacity-100' : 'group-hover/avatar:opacity-100 group-focus-visible/avatar:opacity-100',
          )}
        >
          {avatarBusy ? (
            <span className="w-5 h-5 rounded-full border-2 border-white border-t-transparent animate-spin" />
          ) : (
            <Camera className="w-5 h-5" />
          )}
        </span>
      )}
      {status && (
        <StatusDot
          status={status}
          className="absolute bottom-0.5 right-0.5 w-4 h-4 ring-popover"
          style={panelColor ? { '--tw-ring-color': panelColor } as React.CSSProperties : undefined}
        />
      )}
    </>
  )

  return (
    <>
      {/* Banner strip */}
      <div className="relative aspect-[17/6] shrink-0 overflow-hidden" style={{ backgroundColor: bannerBg }}>
        {bannerUrl && (
          <img
            src={bannerUrl}
            alt=""
            className={cn('absolute max-w-none', bannerCrop ? 'object-fill' : 'inset-0 h-full w-full object-cover')}
            style={croppedBannerStyle}
          />
        )}
        {onBannerClick && (
          <button
            type="button"
            aria-label={bannerActionLabel ?? 'Change banner'}
            onClick={onBannerClick}
            disabled={bannerBusy}
            className={cn(
              'group/banner absolute inset-0 z-10 flex items-center justify-center bg-black/0 text-white transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/80 focus-visible:ring-inset',
              bannerBusy ? 'bg-black/25' : 'hover:bg-black/35 focus-visible:bg-black/35',
            )}
          >
            <span
              className={cn(
                'flex h-8 w-8 items-center justify-center rounded-full bg-black/60 opacity-0 transition-opacity',
                bannerBusy ? 'opacity-100' : 'group-hover/banner:opacity-100 group-focus-visible/banner:opacity-100',
              )}
            >
              {bannerBusy ? (
                <span className="h-4 w-4 rounded-full border-2 border-white border-t-transparent animate-spin" />
              ) : (
                <Camera className="h-4 w-4" />
              )}
            </span>
          </button>
        )}
        {headerActions && (
          <div className="absolute right-3 top-3 z-30 flex items-center gap-2">
            {headerActions}
          </div>
        )}
      </div>

      {/* Avatar — overlaps the banner */}
      <div className="relative z-20 -mt-8 px-4 pb-0">
        {onAvatarClick ? (
          <button
            type="button"
            aria-label={avatarActionLabel ?? 'Change avatar'}
            onClick={onAvatarClick}
            disabled={avatarBusy}
            className="group/avatar relative inline-block rounded-full border-0 bg-transparent p-0 text-left outline-none focus-visible:ring-2 focus-visible:ring-primary"
          >
            {avatarMedia}
          </button>
        ) : (
          <div className="relative inline-block">
            {avatarMedia}
          </div>
        )}
      </div>

      {/* Content */}
      <div className="px-4 pb-4 pt-2 space-y-4">
        {/* Name block */}
        <div>
          {displayNameEditor ?? (
            <p className="font-bold text-base leading-snug inline-flex items-center gap-1.5" style={{ color: textColor }}>
              {displayName}{isBot && <BotBadge />}
            </p>
          )}
          {globalName && globalName !== displayName && (
            <p
              className={cn('text-xs', !mutedColor && 'text-muted-foreground')}
              style={{ color: mutedColor }}
            >
              {globalName}
            </p>
          )}
          {discriminatorEditor ?? (
            discriminator && (
              <p
                className={cn('text-xs', !mutedColor && 'text-muted-foreground')}
                style={{ color: mutedColor }}
              >
                @{discriminator}
              </p>
            )
          )}
        </div>

        {/* Bio */}
        {(bioEditor || bio) && (
          <div>
            {bioEditor ?? (
              <p
                className={cn('text-xs whitespace-pre-wrap break-words', !textColor && 'text-foreground')}
                style={{ color: textColor }}
              >
                {bio}
              </p>
            )}
          </div>
        )}

        {children}
      </div>
    </>
  )
}
