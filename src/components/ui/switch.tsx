import * as React from "react"
import * as SwitchPrimitives from "@radix-ui/react-switch"
import { cn } from "@/lib/utils"

const Switch = React.forwardRef<
  React.ElementRef<typeof SwitchPrimitives.Root>,
  React.ComponentPropsWithoutRef<typeof SwitchPrimitives.Root>
>(({ className, ...props }, ref) => (
  <SwitchPrimitives.Root
    className={cn(
      "peer inline-flex h-6 w-12 shrink-0 cursor-pointer items-center rounded-full border border-white/25 bg-white/25 p-0.5 transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-blue-500/60 focus-visible:ring-offset-2 focus-visible:ring-offset-transparent disabled:cursor-not-allowed disabled:opacity-50 data-[state=checked]:border-blue-500 data-[state=checked]:bg-blue-500 dark:border-white/10 dark:bg-white/10",
      className
    )}
    {...props}
    ref={ref}
  >
    <SwitchPrimitives.Thumb
      className={cn(
        "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-[0_6px_16px_-6px_rgba(59,130,246,0.55)] ring-0 transition-transform duration-200 ease-out data-[state=checked]:translate-x-6 data-[state=unchecked]:translate-x-0.5 dark:bg-white/90"
      )}
    />
  </SwitchPrimitives.Root>
))
Switch.displayName = SwitchPrimitives.Root.displayName

export { Switch } 
