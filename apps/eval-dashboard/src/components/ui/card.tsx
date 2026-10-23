import * as React from "react";
import { cn } from "@/lib/utils";

// Hand-rolled, not a `shadcn add` output — this repo has no ShadCN Card
// component yet in either app; apps/web's eval pages hand-roll the same
// `rounded-lg border border-border bg-card` shape inline. Mirrored here as a
// real component since this dashboard reuses it heavily.
export function Card({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("rounded-lg border border-border bg-card", className)} {...props} />;
}

export function CardHeader({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("border-b border-border p-4", className)} {...props} />;
}

export function CardContent({ className, ...props }: React.HTMLAttributes<HTMLDivElement>) {
  return <div className={cn("p-4", className)} {...props} />;
}
