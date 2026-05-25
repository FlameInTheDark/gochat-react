import { useCallback, useState } from 'react'
import Cropper from 'react-easy-crop'
import type { Area, Point } from 'react-easy-crop'
import { Image as ImageIcon, X } from 'lucide-react'
import { Button } from '@/components/ui/button'

export interface BannerCropArea {
  x: number
  y: number
  width: number
  height: number
}

interface Props {
  open: boolean
  mediaUrl: string
  sourceWidth: number
  sourceHeight: number
  onCancel: () => void
  onApply: (crop: BannerCropArea) => void
}

const BANNER_ASPECT = 17 / 6

function normalizeCrop(area: Area, sourceWidth: number, sourceHeight: number): BannerCropArea {
  const x = Math.max(0, Math.min(sourceWidth - 1, Math.round(area.x)))
  const y = Math.max(0, Math.min(sourceHeight - 1, Math.round(area.y)))
  const width = Math.max(1, Math.min(sourceWidth - x, Math.round(area.width)))
  const height = Math.max(1, Math.min(sourceHeight - y, Math.round(area.height)))
  return { x, y, width, height }
}

export default function BannerCropDialog(props: Props) {
  if (!props.open || !props.mediaUrl) return null

  return <BannerCropDialogContent key={props.mediaUrl} {...props} />
}

function BannerCropDialogContent({ mediaUrl, sourceWidth, sourceHeight, onCancel, onApply }: Props) {
  const [crop, setCrop] = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom] = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)

  const handleCropComplete = useCallback((_area: Area, pixelArea: Area) => {
    setCroppedAreaPixels(pixelArea)
  }, [])

  function handleApply() {
    if (!croppedAreaPixels) return
    onApply(normalizeCrop(croppedAreaPixels, sourceWidth, sourceHeight))
  }

  return (
    <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/70 px-4">
      <div className="w-full max-w-[480px] overflow-hidden rounded-lg border border-border bg-popover shadow-2xl">
        <div className="flex items-center justify-between px-6 pb-4 pt-5">
          <h3 className="text-lg font-bold">Edit Image</h3>
          <button
            type="button"
            onClick={onCancel}
            className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            aria-label="Close"
          >
            <X className="h-5 w-5" />
          </button>
        </div>

        <div className="px-6">
          <div className="relative h-[350px] overflow-hidden rounded-md bg-black">
            <Cropper
              image={mediaUrl}
              crop={crop}
              zoom={zoom}
              aspect={BANNER_ASPECT}
              showGrid={false}
              onCropChange={setCrop}
              onZoomChange={setZoom}
              onCropComplete={handleCropComplete}
            />
          </div>
        </div>

        <div className="flex items-center gap-3 px-6 py-5">
          <ImageIcon className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(event) => setZoom(Number(event.target.value))}
            className="min-w-0 flex-1 accent-primary"
            aria-label="Zoom"
          />
          <ImageIcon className="h-6 w-6 shrink-0 text-muted-foreground" />
        </div>

        <div className="flex items-center justify-between gap-3 px-6 pb-6 pt-1">
          <button
            type="button"
            onClick={() => {
              setCrop({ x: 0, y: 0 })
              setZoom(1)
            }}
            className="text-sm text-primary/80 transition-colors hover:text-primary"
          >
            Reset
          </button>
          <div className="flex items-center gap-2">
            <Button variant="outline" onClick={onCancel}>
              Cancel
            </Button>
            <Button onClick={handleApply} disabled={!croppedAreaPixels}>
              Apply
            </Button>
          </div>
        </div>
      </div>
    </div>
  )
}
