import { useState } from 'react'
import type { EmbedEmbed } from '@/client'
import { cn } from '@/lib/utils'
import AnimatedImage from '@/components/ui/AnimatedImage'

interface Props {
  embed: EmbedEmbed
}

function colorToHex(color: number): string {
  return `#${color.toString(16).padStart(6, '0')}`
}

type FieldGroup =
  | { inline: true; fields: NonNullable<EmbedEmbed['fields']> }
  | { inline: false; field: NonNullable<EmbedEmbed['fields']>[number] }

function groupFields(fields: EmbedEmbed['fields']): FieldGroup[] {
  if (!fields?.length) return []
  const groups: FieldGroup[] = []
  let run: NonNullable<EmbedEmbed['fields']> = []

  const flushRun = () => {
    if (run.length) {
      groups.push({ inline: true, fields: run })
      run = []
    }
  }

  for (const field of fields) {
    if (field.inline) {
      run.push(field)
      if (run.length === 3) flushRun()
    } else {
      flushRun()
      groups.push({ inline: false, field })
    }
  }
  flushRun()
  return groups
}

export default function MessageEmbed({ embed }: Props) {
  const [playing, setPlaying] = useState(false)
  const [videoFailed, setVideoFailed] = useState(false)

  const type = embed.type ?? 'rich'

  // image / gifv: bare image
  if (type === 'image' || type === 'gifv') {
    const imgUrl = embed.image?.url ?? embed.thumbnail?.url
    if (!imgUrl) return null
    const Img = type === 'gifv' ? AnimatedImage : 'img'
    return (
      <div className="mt-1 max-w-[400px]">
        <Img
          src={imgUrl}
          alt={embed.title ?? ''}
          className="rounded max-w-full object-contain"
          style={{ maxHeight: 300 }}
          loading="lazy"
          draggable={false}
        />
      </div>
    )
  }

  // rich / link / article / video
  // isVideoType: pure video embed (YouTube etc.) — suppress normal content, show only player
  const isVideoType = type === 'video'
  // hasVideoData: any embed that carries a video url (including rich+video)
  const videoUrl = embed.video?.url
  const hasVideoData = !!videoUrl
  const isDirectVideo = hasVideoData && (embed.video as { content_type?: string })?.content_type?.startsWith('video/')

  const fieldGroups = groupFields(embed.fields)
  // Suppress thumbnail when the embed has video (thumbnail = video poster, shown inside player)
  const hasThumbnail = !isVideoType && !hasVideoData && !!embed.thumbnail?.url
  const accentColor = embed.color != null ? colorToHex(embed.color) : undefined

  // For rich+video, thumbnail serves as the video poster
  const videoThumbnailUrl = hasVideoData ? embed.thumbnail?.url : undefined

  const thumb = embed.thumbnail
  const thumbAspect =
    thumb?.width && thumb?.height ? thumb.width / thumb.height : null
  const isWideThumbnail = thumbAspect !== null && thumbAspect > 1.5
  const hasSideThumbnail = hasThumbnail && !isWideThumbnail
  const hasWideThumbnail = hasThumbnail && isWideThumbnail

  return (
    <div
      className="mt-1 max-w-[432px] rounded overflow-hidden border border-border bg-card/60"
      style={{
        borderLeftWidth: '4px',
        borderLeftColor: accentColor ?? 'oklch(1 0 0 / 22%)',
      }}
    >
      <div className="px-3 py-2.5 space-y-1.5">
        {/* Provider */}
        {embed.provider?.name && (
          <p className="text-xs text-muted-foreground">
            {embed.provider.url ? (
              <a href={embed.provider.url} target="_blank" rel="noopener noreferrer" className="hover:underline">
                {embed.provider.name}
              </a>
            ) : embed.provider.name}
          </p>
        )}

        {!isVideoType && (
          <div className={cn('flex gap-3', hasSideThumbnail && 'items-start')}>
            <div className="flex-1 min-w-0 space-y-1">
              {/* Author */}
              {embed.author?.name && (
                <div className="flex items-center gap-1.5">
                  {embed.author.icon_url && (
                    <img
                      src={embed.author.icon_url}
                      alt=""
                      className="w-4 h-4 rounded-full object-cover shrink-0"
                      loading="lazy"
                    />
                  )}
                  {embed.author.url ? (
                    <a
                      href={embed.author.url}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="text-xs font-semibold hover:underline"
                    >
                      {embed.author.name}
                    </a>
                  ) : (
                    <span className="text-xs font-semibold">{embed.author.name}</span>
                  )}
                </div>
              )}

              {/* Title */}
              {embed.title && (
                embed.url ? (
                  <a
                    href={embed.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="block text-sm font-semibold text-primary hover:underline"
                  >
                    {embed.title}
                  </a>
                ) : (
                  <p className="text-sm font-semibold">{embed.title}</p>
                )
              )}

              {/* Description */}
              {embed.description && (
                <p className="text-xs text-muted-foreground whitespace-pre-wrap break-words line-clamp-10">
                  {embed.description}
                </p>
              )}
            </div>

            {/* Side thumbnail (square / small) */}
            {hasSideThumbnail && (
              <img
                src={thumb!.url}
                alt=""
                className="w-20 h-20 rounded object-cover shrink-0"
                loading="lazy"
                draggable={false}
              />
            )}
          </div>
        )}

        {/* Video title (pure video embeds only — rich+video already shows title above) */}
        {isVideoType && embed.title && (
          <a
            href={embed.url}
            target="_blank"
            rel="noopener noreferrer"
            className="block text-sm font-semibold text-primary hover:underline"
          >
            {embed.title}
          </a>
        )}

        {/* Video player — shown for type=video and for rich+video */}
        {hasVideoData && (videoUrl || videoThumbnailUrl) && (() => {
          const MAX_W = 400
          const MAX_H = 300
          const vw = embed.video?.width ?? 0
          const vh = embed.video?.height ?? 0
          // Compute display size respecting both max-width and max-height
          let dispW = MAX_W
          let dispH = vw && vh ? Math.round(MAX_W * vh / vw) : Math.round(MAX_W * 9 / 16)
          if (dispH > MAX_H) { dispH = MAX_H; dispW = vw && vh ? Math.round(MAX_H * vw / vh) : MAX_W }

          // Thumbnail-with-link fallback (CDN blocks cross-origin, e.g. Twitter)
          if (isDirectVideo && videoFailed) {
            return videoThumbnailUrl ? (
              <a
                href={embed.url ?? videoUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="mt-1 relative group block overflow-hidden rounded"
                style={{ width: dispW, height: dispH }}
              >
                <img
                  src={videoThumbnailUrl}
                  alt=""
                  className="w-full h-full object-cover"
                  loading="lazy"
                  draggable={false}
                />
                <span className="absolute inset-0 bg-black/30 transition group-hover:bg-black/45" />
                <span className="absolute inset-0 flex items-center justify-center">
                  <span className="flex h-12 w-12 items-center justify-center rounded-full bg-white/85 shadow-lg">
                    <svg className="h-5 w-5 translate-x-0.5 text-zinc-900" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                      <path d="M8 5v14l11-7z" />
                    </svg>
                  </span>
                </span>
              </a>
            ) : null
          }

          return (
            <div
              className="relative overflow-hidden rounded bg-black mt-1"
              style={{ width: dispW, height: dispH }}
            >
              {isDirectVideo ? (
                // Direct MP4/WebM/etc. — use <video> element
                <video
                  className="h-full w-full object-contain"
                  controls
                  preload="metadata"
                  poster={videoThumbnailUrl}
                  onError={() => setVideoFailed(true)}
                >
                  <source src={videoUrl} type={(embed.video as { content_type?: string })?.content_type} />
                </video>
              ) : playing && videoUrl ? (
                // Iframe-based embed (YouTube etc.)
                <iframe
                  className="h-full w-full"
                  src={`${videoUrl}?autoplay=1`}
                  title={embed.title ?? 'Video'}
                  allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture"
                  allowFullScreen
                />
              ) : videoThumbnailUrl ? (
                // Thumbnail + play button (click to play iframe)
                <button
                  type="button"
                  className="group relative flex h-full w-full items-center justify-center focus-visible:outline-none"
                  onClick={() => videoUrl ? setPlaying(true) : window.open(embed.url, '_blank')}
                  aria-label={embed.title ?? 'Play video'}
                >
                  <img
                    src={videoThumbnailUrl}
                    alt=""
                    className="absolute inset-0 h-full w-full object-cover"
                    loading="lazy"
                    draggable={false}
                  />
                  <span className="absolute inset-0 bg-black/30 transition group-hover:bg-black/45" />
                  {videoUrl && (
                    <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white/85 shadow-lg transition group-hover:bg-white group-hover:scale-110">
                      <svg className="h-6 w-6 translate-x-0.5 text-zinc-900" fill="currentColor" viewBox="0 0 24 24" aria-hidden>
                        <path d="M8 5v14l11-7z" />
                      </svg>
                    </span>
                  )}
                </button>
              ) : null}
            </div>
          )
        })()}

        {/* Fields (non-video only) */}
        {!isVideoType && fieldGroups.length > 0 && (
          <div className="space-y-1 pt-0.5">
            {fieldGroups.map((group, gi) =>
              group.inline ? (
                <div
                  key={gi}
                  className="grid gap-2"
                  style={{ gridTemplateColumns: `repeat(${group.fields.length}, 1fr)` }}
                >
                  {group.fields.map((f, fi) => (
                    <div key={fi}>
                      <p className="text-xs font-semibold">{f.name}</p>
                      <p className="text-xs text-muted-foreground whitespace-pre-wrap">{f.value}</p>
                    </div>
                  ))}
                </div>
              ) : (
                <div key={gi}>
                  <p className="text-xs font-semibold">{group.field.name}</p>
                  <p className="text-xs text-muted-foreground whitespace-pre-wrap">{group.field.value}</p>
                </div>
              )
            )}
          </div>
        )}

        {/* Full-size image (non-video only) */}
        {!isVideoType && embed.image?.url && (
          <img
            src={embed.image.url}
            alt=""
            className="rounded max-w-full object-contain mt-1"
            style={{ maxHeight: 300 }}
            loading="lazy"
            draggable={false}
          />
        )}

        {/* Wide thumbnail — rendered full-width below content */}
        {hasWideThumbnail && (
          <img
            src={thumb!.url}
            alt=""
            className="rounded w-full object-contain mt-1"
            style={thumbAspect ? { aspectRatio: String(thumbAspect) } : undefined}
            loading="lazy"
            draggable={false}
          />
        )}

        {/* Footer */}
        {(embed.footer?.text || embed.timestamp) && (
          <div className="flex items-center gap-1.5 pt-0.5">
            {embed.footer?.icon_url && (
              <img src={embed.footer.icon_url} alt="" className="w-4 h-4 rounded-full shrink-0" loading="lazy" />
            )}
            <span className="text-xs text-muted-foreground">
              {embed.footer?.text}
              {embed.footer?.text && embed.timestamp && ' • '}
              {embed.timestamp && new Date(embed.timestamp).toLocaleString()}
            </span>
          </div>
        )}
      </div>
    </div>
  )
}
