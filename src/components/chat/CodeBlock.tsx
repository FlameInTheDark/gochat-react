/**
 * Syntax-highlighted code block using highlight.js.
 *
 * The atom-one-dark CSS theme is imported here as a side-effect; Vite bundles
 * it into the main CSS output so it's only included once regardless of how
 * many CodeBlock instances are on screen.  The `.hljs` background is overridden
 * to transparent in src/index.css so our explicit background color takes over.
 */
import { useMemo } from 'react'
import hljs from 'highlight.js/lib/common'
import 'highlight.js/styles/atom-one-dark.min.css'

interface Props {
  code: string
  lang?: string
}

export default function CodeBlock({ code, lang }: Props) {
  const highlighted = useMemo(() => {
    const normalized = lang?.trim().toLowerCase()
    if (normalized && hljs.getLanguage(normalized)) {
      try {
        return hljs.highlight(code, { language: normalized }).value
      } catch {
        // fall through to auto-detect
      }
    }
    return hljs.highlightAuto(code).value
  }, [code, lang])

  return (
    // atom-one-dark background: #282c34
    <pre
      className="rounded-md my-1 overflow-x-auto text-[13px] font-mono leading-5"
      style={{ backgroundColor: '#282c34' }}
    >
      {lang && (
        <div className="px-3 pt-2 pb-1 text-[10px] uppercase tracking-wider text-zinc-500 border-b border-zinc-700 font-sans select-none">
          {lang}
        </div>
      )}
      {/* .hljs sets token colours; background is transparent (overridden in index.css) */}
      <code
        className="hljs block px-3 py-2 whitespace-pre"
        dangerouslySetInnerHTML={{ __html: highlighted }}
      />
    </pre>
  )
}
