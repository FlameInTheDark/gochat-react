import { useState } from 'react'

interface Props {
  videoId: string
  url: string
}

export default function YoutubeEmbed({ videoId, url }: Props) {
  const [playing, setPlaying] = useState(false)

  const thumbnailUrl = `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`
  const embedUrl = `https://www.youtube.com/embed/${videoId}?autoplay=1`

  return (
    // 16:9 aspect ratio, max-width matches Discord's embed width
    <div
      className="relative mt-1 w-full max-w-[480px] overflow-hidden rounded-lg border border-border bg-black"
      style={{ aspectRatio: '16 / 9' }}
    >
      {playing ? (
        <iframe
          className="h-full w-full"
          src={embedUrl}
          title="YouTube video"
          allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture; web-share"
          allowFullScreen
        />
      ) : (
        <button
          type="button"
          className="group relative flex h-full w-full items-center justify-center focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          onClick={() => setPlaying(true)}
          aria-label="Play YouTube video"
        >
          {/* Thumbnail */}
          <img
            src={thumbnailUrl}
            alt="YouTube video thumbnail"
            className="absolute inset-0 h-full w-full object-cover"
            loading="lazy"
            draggable={false}
          />
          {/* Dim overlay */}
          <span className="absolute inset-0 bg-black/30 transition group-hover:bg-black/45" />
          {/* Play button — matches YouTube's red-and-white look */}
          <span className="relative flex h-14 w-14 items-center justify-center rounded-full bg-white/85 shadow-lg transition group-hover:bg-white group-hover:scale-110">
            {/* YouTube play triangle */}
            <svg
              className="h-6 w-6 translate-x-0.5 text-zinc-900"
              fill="currentColor"
              viewBox="0 0 24 24"
              aria-hidden="true"
            >
              <path d="M8 5v14l11-7z" />
            </svg>
          </span>
          {/* Fallback link shown without JS */}
          <noscript>
            <a
              href={url}
              target="_blank"
              rel="noopener noreferrer"
              className="absolute inset-0"
            />
          </noscript>
        </button>
      )}
    </div>
  )
}
