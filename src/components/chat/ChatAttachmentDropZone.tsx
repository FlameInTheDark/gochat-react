import { useRef, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { cn } from '@/lib/utils'

interface Props {
  children: ReactNode
  disabled?: boolean
  onFileDrop: (files: FileList) => void
  className?: string
}

export default function ChatAttachmentDropZone({
  children,
  disabled = false,
  onFileDrop,
  className,
}: Props) {
  const { t } = useTranslation()
  const dragCounterRef = useRef(0)
  const [isDraggingFiles, setIsDraggingFiles] = useState(false)

  function hasFiles(event: React.DragEvent) {
    return event.dataTransfer.types.includes('Files')
  }

  function handleDragEnterCapture(event: React.DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current += 1
    setIsDraggingFiles(true)
  }

  function handleDragLeaveCapture(event: React.DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current -= 1
    if (dragCounterRef.current <= 0) {
      dragCounterRef.current = 0
      setIsDraggingFiles(false)
    }
  }

  function handleDragOverCapture(event: React.DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    if (!isDraggingFiles) {
      setIsDraggingFiles(true)
    }
  }

  function handleDropCapture(event: React.DragEvent<HTMLDivElement>) {
    if (disabled || !hasFiles(event)) return
    event.preventDefault()
    event.stopPropagation()
    dragCounterRef.current = 0
    setIsDraggingFiles(false)
    if (event.dataTransfer.files.length > 0) {
      onFileDrop(event.dataTransfer.files)
    }
  }

  return (
    <div
      className={cn('relative flex flex-col', className)}
      onDragEnterCapture={handleDragEnterCapture}
      onDragLeaveCapture={handleDragLeaveCapture}
      onDragOverCapture={handleDragOverCapture}
      onDropCapture={handleDropCapture}
    >
      {children}

      {isDraggingFiles && !disabled && (
        <div className="pointer-events-none absolute inset-0 z-20 flex items-center justify-center rounded-md border-2 border-dashed border-primary bg-background/75 backdrop-blur-[1px]">
          <div className="rounded-full border border-primary/40 bg-background/90 px-4 py-2 text-sm font-medium text-primary shadow-sm">
            {t('chat.dropFiles')}
          </div>
        </div>
      )}
    </div>
  )
}
