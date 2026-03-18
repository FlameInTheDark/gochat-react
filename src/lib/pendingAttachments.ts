export interface PendingUploadAttachment {
  localId: string
  file: File
  objectUrl: string | null
  progress: number
  processing?: boolean
  width?: number
  height?: number
}

export function revokePendingUploadAttachmentUrls(attachments: PendingUploadAttachment[]) {
  if (typeof URL === 'undefined') return

  const revokedUrls = new Set<string>()
  attachments.forEach((attachment) => {
    const { objectUrl } = attachment
    if (!objectUrl || revokedUrls.has(objectUrl)) return
    revokedUrls.add(objectUrl)
    URL.revokeObjectURL(objectUrl)
  })
}
