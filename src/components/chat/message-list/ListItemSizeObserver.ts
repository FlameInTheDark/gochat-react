type TrackedItemCallback = (changedHeight: number) => void
type TrackedItemData = { element: Element; callback: TrackedItemCallback }

export class ListItemSizeObserver {
  private observer: ResizeObserver
  private trackedItems = new Map<string, TrackedItemData>()
  private trackedElements = new WeakMap<Element, string>()
  private static instance: ListItemSizeObserver | null = null

  private constructor() {
    this.observer = new ResizeObserver(this.handleResizeObserver)
  }

  public static getInstance(): ListItemSizeObserver {
    if (!ListItemSizeObserver.instance) {
      ListItemSizeObserver.instance = new ListItemSizeObserver()
    }
    return ListItemSizeObserver.instance
  }

  private handleResizeObserver = (entries: ResizeObserverEntry[]) => {
    entries.forEach((entry) => {
      const resizedElement = entry.target
      const itemId = this.trackedElements.get(resizedElement)
      const trackedItem = itemId ? this.trackedItems.get(itemId) : undefined

      if (!trackedItem) {
        return
      }

      const borderBoxSize = Array.isArray(entry.borderBoxSize)
        ? entry.borderBoxSize[0]
        : entry.borderBoxSize
      const measuredHeight = Math.ceil(
        borderBoxSize?.blockSize ??
          entry.contentRect.height ??
          (resizedElement as HTMLElement).offsetHeight,
      )

      trackedItem.callback(measuredHeight)
    })
  }

  public observe(itemId: string, element: Element, callback: TrackedItemCallback): () => void {
    const previousItem = this.trackedItems.get(itemId)
    if (previousItem && previousItem.element !== element) {
      this.observer.unobserve(previousItem.element)
      this.trackedElements.delete(previousItem.element)
    }

    this.trackedItems.set(itemId, { element, callback })
    this.trackedElements.set(element, itemId)
    this.observer.observe(element)
    return () => this.unobserve(itemId)
  }

  private unobserve(itemId: string) {
    const trackedItem = this.trackedItems.get(itemId)
    if (!trackedItem) {
      return
    }

    this.observer.unobserve(trackedItem.element)
    this.trackedElements.delete(trackedItem.element)
    this.trackedItems.delete(itemId)
  }
}
