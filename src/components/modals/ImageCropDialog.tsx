import { useState, useCallback, useEffect } from 'react'
import Cropper from 'react-easy-crop'
import type { Area, Point } from 'react-easy-crop'
import { Button } from '@/components/ui/button'

// ── Canvas helper ─────────────────────────────────────────────────────────────

async function getCroppedBlob(imageSrc: string, pixelCrop: Area): Promise<Blob> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => {
      const canvas = document.createElement('canvas')
      canvas.width  = pixelCrop.width
      canvas.height = pixelCrop.height
      const ctx = canvas.getContext('2d')
      if (!ctx) { reject(new Error('No canvas context')); return }
      // Canvas background is transparent by default — do NOT fill with a solid
      // colour so that PNG exports preserve the alpha channel correctly.
      ctx.drawImage(
        img,
        pixelCrop.x, pixelCrop.y, pixelCrop.width, pixelCrop.height,
        0,           0,           pixelCrop.width, pixelCrop.height,
      )
      // JPEG sources have no alpha channel — keep JPEG to avoid unnecessary bloat.
      // All other formats (PNG, WebP, GIF …) may carry transparency, so output
      // as PNG which supports an alpha channel.
      const isJpeg =
        imageSrc.startsWith('data:image/jpeg') ||
        imageSrc.startsWith('data:image/jpg')
      const mimeType = isJpeg ? 'image/jpeg' : 'image/png'
      const quality  = isJpeg ? 0.92 : undefined
      canvas.toBlob(
        (blob) => { blob ? resolve(blob) : reject(new Error('Canvas is empty')) },
        mimeType,
        quality,
      )
    }
    img.onerror = () => reject(new Error('Image load error'))
    img.src = imageSrc
  })
}

// ── Component ─────────────────────────────────────────────────────────────────

interface Props {
  open: boolean
  imageDataUrl: string
  onCancel: () => void
  onCrop: (blob: Blob) => void
}

export default function ImageCropDialog({ open, imageDataUrl, onCancel, onCrop }: Props) {
  const [crop, setCrop]                         = useState<Point>({ x: 0, y: 0 })
  const [zoom, setZoom]                         = useState(1)
  const [croppedAreaPixels, setCroppedAreaPixels] = useState<Area | null>(null)
  const [exporting, setExporting]               = useState(false)

  // Reset whenever a new image is opened
  useEffect(() => {
    if (open) {
      setCrop({ x: 0, y: 0 })
      setZoom(1)
      setCroppedAreaPixels(null)
    }
  }, [open, imageDataUrl])

  const handleCropComplete = useCallback((_area: Area, pixelArea: Area) => {
    setCroppedAreaPixels(pixelArea)
  }, [])

  async function handleAccept() {
    if (!croppedAreaPixels) return
    setExporting(true)
    try {
      const blob = await getCroppedBlob(imageDataUrl, croppedAreaPixels)
      onCrop(blob)
    } catch {
      // silently ignore — parent will handle errors after receiving blob
    } finally {
      setExporting(false)
    }
  }

  if (!open || !imageDataUrl) return null

  return (
    // Render above everything (including z-50 modals)
    <div className="fixed inset-0 z-[100] flex items-center justify-center bg-black/70">
      <div className="bg-popover rounded-lg shadow-2xl border border-border w-full max-w-md overflow-hidden mx-4">

        {/* Title */}
        <div className="px-6 pt-5 pb-3">
          <h3 className="text-base font-semibold">Crop Image</h3>
          <p className="text-xs text-muted-foreground mt-0.5">
            Drag to reposition · Scroll or use the slider to zoom
          </p>
        </div>

        {/* Crop area — react-easy-crop requires a positioned parent with explicit dimensions */}
        <div className="relative bg-black" style={{ height: 288 }}>
          <Cropper
            image={imageDataUrl}
            crop={crop}
            zoom={zoom}
            aspect={1}
            onCropChange={setCrop}
            onZoomChange={setZoom}
            onCropComplete={handleCropComplete}
          />
        </div>

        {/* Zoom slider */}
        <div className="px-6 py-4 flex items-center gap-3">
          <span className="text-xs text-muted-foreground shrink-0">Zoom</span>
          <input
            type="range"
            min={1}
            max={3}
            step={0.01}
            value={zoom}
            onChange={(e) => setZoom(Number(e.target.value))}
            className="flex-1 accent-primary"
          />
          <span className="text-xs text-muted-foreground shrink-0 w-10 text-right tabular-nums">
            {Math.round(zoom * 100)}%
          </span>
        </div>

        {/* Actions */}
        <div className="px-6 pb-5 flex justify-end gap-2">
          <Button
            variant="outline"
            onClick={onCancel}
            disabled={exporting}
          >
            Cancel
          </Button>
          <Button
            onClick={() => void handleAccept()}
            disabled={exporting || !croppedAreaPixels}
          >
            {exporting ? 'Processing…' : 'Apply'}
          </Button>
        </div>

      </div>
    </div>
  )
}
