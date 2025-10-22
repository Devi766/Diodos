import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "relative inline-flex items-center justify-center whitespace-nowrap rounded-xl text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none disabled:opacity-60 overflow-hidden",
  {
    variants: {
      variant: {
        default:
          "bg-gradient-to-r from-sky-500 via-blue-500 to-indigo-500 text-white shadow-[0_20px_42px_-22px_rgba(56,189,248,0.7)] hover:brightness-105 hover:shadow-[0_24px_52px_-20px_rgba(56,189,248,0.75)]",
        primary:
          "bg-primary text-primary-foreground shadow-[0_18px_34px_-18px_rgba(59,130,246,0.55)] hover:brightness-[1.05] hover:shadow-[0_22px_42px_-18px_rgba(59,130,246,0.65)]",
        solid:
          "bg-blue-500 text-white shadow-[0_18px_34px_-18px_rgba(59,130,246,0.55)] hover:bg-blue-600 hover:shadow-[0_22px_42px_-18px_rgba(59,130,246,0.65)]",
        destructive:
          "bg-gradient-to-r from-rose-500 to-red-500 text-white shadow-[0_20px_42px_-22px_rgba(244,63,94,0.55)] hover:shadow-[0_24px_52px_-20px_rgba(248,113,113,0.6)]",
        outline:
          "border border-white/25 bg-white/20 text-foreground backdrop-blur-md hover:border-white/40 hover:bg-white/30 dark:border-white/10 dark:bg-white/8 dark:hover:bg-white/12",
        secondary:
          "bg-white/35 text-foreground shadow-[0_16px_36px_-24px_rgba(59,130,246,0.45)] hover:bg-white/45 dark:bg-white/10 dark:text-foreground dark:hover:bg-white/14",
        ghost:
          "text-foreground/80 hover:text-foreground hover:bg-white/25 dark:hover:bg-white/10",
        link: "text-primary underline-offset-4 hover:underline",
      },
      size: {
        default: "h-11 px-5",
        sm: "h-9 px-4",
        lg: "h-12 px-7 text-base",
        icon: "h-11 w-11",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

export interface ButtonProps
  extends React.ButtonHTMLAttributes<HTMLButtonElement>,
    VariantProps<typeof buttonVariants> {
  asChild?: boolean
}

const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, asChild = false, ...props }, ref) => {
    return (
      <button
        className={cn(buttonVariants({ variant, size, className }))}
        ref={ref}
        {...props}
      />
    )
  }
)
Button.displayName = "Button"

export { Button, buttonVariants } 
