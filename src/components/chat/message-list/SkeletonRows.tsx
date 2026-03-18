function seededFraction(seed: number): number {
  return ((seed * 2654435761) >>> 0) / 0xFFFFFFFF
}

function skeletonWidth(seed: number, min: number, max: number): string {
  return `${Math.floor(min + seededFraction(seed) * (max - min))}%`
}

export function MessageSkeletonRow({ seed = 0 }: { seed?: number }) {
  const nameW = 60 + ((seed * 37) % 60)
  const bodyW = skeletonWidth(seed * 17, 40 + ((seed * 13) % 20), 60 + ((seed * 7) % 20))

  return (
    <div className="flex items-start gap-4 px-4 py-[0.3125rem]">
      <div className="mt-0.5 h-10 w-10 shrink-0 rounded-full bg-muted/60 animate-pulse" />
      <div className="min-w-0 flex-1 space-y-2 pt-0.5">
        <div className="flex items-center gap-2">
          <div
            className="h-3.5 rounded bg-muted/60 animate-pulse"
            style={{ width: `${nameW}px` }}
          />
          <div className="h-2.5 w-10 rounded bg-muted/40 animate-pulse" />
        </div>
        <div
          className="h-3.5 rounded bg-muted/40 animate-pulse"
          style={{ width: bodyW }}
        />
      </div>
    </div>
  )
}

export function GroupedMessageSkeletonRow({ seed = 0 }: { seed?: number }) {
  const bodyW = skeletonWidth(seed * 23, 30 + ((seed * 11) % 15), 55 + ((seed * 3) % 15))

  return (
    <div className="flex items-start gap-4 px-4 py-[0.125rem]">
      <div className="w-10 shrink-0" />
      <div className="min-w-0 flex-1 space-y-2">
        <div
          className="h-3.5 rounded bg-muted/40 animate-pulse"
          style={{ width: bodyW }}
        />
      </div>
    </div>
  )
}
