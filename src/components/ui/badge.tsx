import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const badgeVariants = cva(
  "inline-flex items-center rounded-full border px-3 py-1 text-xs font-semibold uppercase tracking-wide backdrop-blur-md transition-all focus:outline-none focus:ring-2 focus:ring-ring focus:ring-offset-2",
  {
    variants: {
      variant: {
        default:
          "border-white/20 bg-white/25 text-foreground hover:border-white/35 hover:bg-white/35 dark:border-white/10 dark:bg-white/10",
        secondary:
          "border-sky-400/40 bg-sky-400/15 text-sky-700 hover:bg-sky-400/25 dark:text-sky-200",
        destructive:
          "border-rose-500/40 bg-rose-500/20 text-white hover:bg-rose-500/30",
        outline: "border-white/30 text-foreground",
      },
    },
    defaultVariants: {
      variant: "default",
    },
  }
)

export interface BadgeProps
  extends React.HTMLAttributes<HTMLDivElement>,
    VariantProps<typeof badgeVariants> {}

function Badge({ className, variant, ...props }: BadgeProps) {
  return (
    <div className={cn(badgeVariants({ variant }), className)} {...props} />
  )
}

export { Badge, badgeVariants } 
