import type { ReactNode } from "react";
import AppNav from "./AppNav";
import NotificationBanner from "./NotificationBanner";
import { useNotificationPoll } from "@/hooks/useNotificationPoll";

interface AppLayoutProps {
  children: ReactNode;
}

export default function AppLayout({ children }: AppLayoutProps) {
  // Pulls persisted notifications into the banner store (#357) — mounted here
  // so every AppLayout screen receives them.
  useNotificationPoll();
  return (
    <div className="min-h-screen flex flex-col bg-background">
      <NotificationBanner />
      <AppNav />
      <main className="flex-1">{children}</main>
    </div>
  );
}
