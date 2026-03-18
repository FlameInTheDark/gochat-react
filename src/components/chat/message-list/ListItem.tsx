import { memo, useLayoutEffect, useMemo, useRef, type ReactElement, type ReactNode } from 'react'
import { ListItemSizeObserver } from './ListItemSizeObserver'

interface Props<TItem> {
  item: TItem
  renderItem: (item: TItem, index: number) => ReactNode
  itemIndex: number
  itemId: string
  height: number
  width: number
  onHeightChange: (itemId: string, height: number, forceScrollCorrection: boolean) => void
}

const listItemSizeObserver = ListItemSizeObserver.getInstance()

function ListItemFn<TItem>({
  item,
  renderItem,
  itemIndex,
  itemId,
  height,
  width,
  onHeightChange,
}: Props<TItem>) {
  const rowRef = useRef<HTMLDivElement>(null)
  const heightRef = useRef(height)
  const widthRef = useRef(width)
  const onHeightChangeRef = useRef(onHeightChange)

  useLayoutEffect(() => {
    heightRef.current = height
    widthRef.current = width
  }, [height, width])

  useLayoutEffect(() => {
    onHeightChangeRef.current = onHeightChange
  }, [onHeightChange])

  useLayoutEffect(() => {
    const measuredHeight = Math.ceil(rowRef.current?.offsetHeight ?? 0)
    onHeightChangeRef.current(itemId, measuredHeight, false)
  }, [itemId])

  useLayoutEffect(() => {
    if (!rowRef.current) {
      return
    }

    const handleResize = (changedHeight: number) => {
      if (!rowRef.current) {
        return
      }

      const forceScrollCorrection = rowRef.current.offsetWidth !== widthRef.current
      if (changedHeight !== heightRef.current || forceScrollCorrection) {
        heightRef.current = changedHeight
        onHeightChangeRef.current(itemId, changedHeight, forceScrollCorrection)
      }
    }

    return listItemSizeObserver.observe(itemId, rowRef.current, handleResize)
  }, [itemId])

  // Memoize rendered content so that re-renders of the virtualizer (e.g. on every scroll
  // event) don't cascade into full subtree renders when the row data hasn't changed.
  // renderItem is stable (useCallback in MessageList), and item objects from the rows memo
  // keep their reference identity across renders unless the timeline actually changes.
  const content = useMemo(() => renderItem(item, itemIndex), [item, renderItem, itemIndex])

  return (
    <div
      ref={rowRef}
      role='listitem'
      className='message-list__item-measurer'
    >
      {content}
    </div>
  )
}

// memo + generic: assert the exported type so callers keep full generic inference.
export default memo(ListItemFn) as <TItem>(props: Props<TItem>) => ReactElement
