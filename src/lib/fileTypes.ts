const SVG_EXTENSION = 'svg'
const SVG_MIME_TYPE = 'image/svg+xml'

function normalizeMimeType(contentType?: string | null): string {
  const [normalized = ''] = (contentType ?? '').trim().toLowerCase().split(';')
  return normalized
}

export function getFileExtension(filename?: string | null): string {
  const parts = (filename ?? '').trim().toLowerCase().split('.')
  return parts.length > 1 ? parts.pop() ?? '' : ''
}

export function isSvgFileLike(params: {
  contentType?: string | null
  filename?: string | null
}): boolean {
  return (
    normalizeMimeType(params.contentType) === SVG_MIME_TYPE ||
    getFileExtension(params.filename) === SVG_EXTENSION
  )
}
