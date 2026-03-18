"use client"

import * as React from "react"

import { cn } from "@/lib/utils"

const ScrollArea = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, children, ...props }, ref) => (
    <div
      ref={ref}
      data-slot="scroll-area"
      className={cn("relative min-h-0 overflow-auto", className)}
      {...props}
    >
      {children}
    </div>
  ),
)

ScrollArea.displayName = "ScrollArea"

const ScrollBar = React.forwardRef<HTMLDivElement, React.HTMLAttributes<HTMLDivElement>>(
  ({ className, ...props }, ref) => (
    <div
      ref={ref}
      aria-hidden="true"
      data-slot="scroll-area-scrollbar"
      className={cn("hidden", className)}
      {...props}
    />
  ),
)

ScrollBar.displayName = "ScrollBar"

export { ScrollArea, ScrollBar }
