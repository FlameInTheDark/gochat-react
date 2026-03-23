import * as React from "react"
import { Tooltip as TooltipPrimitive } from "radix-ui"
import { motion, AnimatePresence } from "motion/react"

import { cn } from "@/lib/utils"

const TooltipOpenContext = React.createContext(false)

function TooltipProvider({
  delayDuration = 0,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return (
    <TooltipPrimitive.Provider
      data-slot="tooltip-provider"
      delayDuration={delayDuration}
      {...props}
    />
  )
}

function Tooltip({
  open: controlledOpen,
  onOpenChange,
  defaultOpen,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen ?? false)
  const isOpen = controlledOpen !== undefined ? controlledOpen : uncontrolledOpen

  return (
    <TooltipOpenContext.Provider value={isOpen}>
      <TooltipPrimitive.Root
        data-slot="tooltip"
        open={controlledOpen}
        defaultOpen={defaultOpen}
        onOpenChange={(o) => {
          setUncontrolledOpen(o)
          onOpenChange?.(o)
        }}
        {...props}
      />
    </TooltipOpenContext.Provider>
  )
}

function TooltipTrigger({
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Trigger>) {
  return <TooltipPrimitive.Trigger data-slot="tooltip-trigger" {...props} />
}

function TooltipContent({
  className,
  sideOffset = 0,
  children,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Content>) {
  const open = React.useContext(TooltipOpenContext)
  return (
    <TooltipPrimitive.Portal>
      <AnimatePresence>
        {open && (
          <TooltipPrimitive.Content
            forceMount
            data-slot="tooltip-content"
            sideOffset={sideOffset}
            className={cn(
              "bg-foreground text-background z-50 w-fit rounded-md px-3 py-1.5 text-xs text-balance",
              className
            )}
            {...props}
            asChild
          >
            <motion.div
              initial={{ opacity: 0, scale: 0.92, y: 4 }}
              animate={{ opacity: 1, scale: 1, y: 0 }}
              exit={{ opacity: 0, scale: 0.92, y: 4 }}
              transition={{ type: "spring", damping: 22, stiffness: 380 }}
              style={{ transformOrigin: 'var(--radix-tooltip-content-transform-origin)' }}
            >
              {children}
              <TooltipPrimitive.Arrow className="bg-foreground fill-foreground z-50 size-2.5 translate-y-[calc(-50%_-_2px)] rotate-45 rounded-[2px]" />
            </motion.div>
          </TooltipPrimitive.Content>
        )}
      </AnimatePresence>
    </TooltipPrimitive.Portal>
  )
}

export { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider }
