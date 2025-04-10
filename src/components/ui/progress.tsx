import * as React from "react"
import * as ProgressPrimitive from "@radix-ui/react-progress"

import { cn } from "@/lib/utils"

const Progress = React.forwardRef<
  React.ElementRef<typeof ProgressPrimitive.Root>,
  React.ComponentPropsWithoutRef<typeof ProgressPrimitive.Root> & {
    indicatorColor?: "green" | "blue" | "purple"
  }
>(({ className, value, indicatorColor = "blue", ...props }, ref) => {
  // 根据indicatorColor选择不同的颜色类
  const getIndicatorClass = () => {
    switch (indicatorColor) {
      case "green":
        return "bg-green-500 dark:bg-green-600";
      case "purple":
        return "bg-purple-500 dark:bg-purple-600";
      case "blue":
      default:
        return "bg-blue-500 dark:bg-blue-600";
    }
  };

  return (
    <ProgressPrimitive.Root
      ref={ref}
      className={cn(
        "relative h-2 w-full overflow-hidden rounded-full bg-gray-100 dark:bg-gray-800",
        className
      )}
      {...props}
    >
      <ProgressPrimitive.Indicator
        className={cn(
          "h-full w-full flex-1 transition-all",
          getIndicatorClass()
        )}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
})
Progress.displayName = ProgressPrimitive.Root.displayName

export { Progress } 