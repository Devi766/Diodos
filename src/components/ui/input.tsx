import * as React from "react"
import { cn } from "@/lib/utils"

export interface InputProps
  extends React.InputHTMLAttributes<HTMLInputElement> {}

const Input = React.forwardRef<HTMLInputElement, InputProps>(
  ({ className, type, ...props }, ref) => {
    return (
      <input
        type={type}
        className={cn(
          "flex h-11 w-full rounded-xl border border-white/25 bg-white/20 px-4 py-2 text-sm shadow-[inset_0_1px_0_rgba(255,255,255,0.35)] transition-all placeholder:text-muted-foreground/80 backdrop-blur-md focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sky-400/60 focus-visible:ring-offset-1 disabled:cursor-not-allowed disabled:opacity-50 dark:border-white/10 dark:bg-white/8",
          className
        )}
        ref={ref}
        {...props}
      />
    )
  }
)
Input.displayName = "Input"

export { Input } 
