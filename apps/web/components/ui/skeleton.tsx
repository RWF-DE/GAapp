// shadcn/ui（new-york v4）の skeleton。元：https://github.com/shadcn-ui/ui/blob/96da9cc7f1aa10580a3741664e2a77c721206c00/apps/v4/registry/new-york-v4/ui/skeleton.tsx
// （MIT License, Copyright (c) 2023 shadcn）。import の別名だけを書き換えた。T09a（画面の設計 1.4）。
import { cn } from "@/lib/utils"

function Skeleton({ className, ...props }: React.ComponentProps<"div">) {
  return (
    <div
      data-slot="skeleton"
      className={cn("animate-pulse rounded-md bg-accent", className)}
      {...props}
    />
  )
}

export { Skeleton }
