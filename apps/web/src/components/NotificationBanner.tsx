import { useEffect } from "react";
import { useNavigate } from "react-router-dom";
import { X } from "lucide-react";
import { useNotificationStore } from "@/hooks/useNotificationStore";
import { NOTIFICATION_TEXT, type NotificationType } from "@wingman/shared";

const NAVIGATION_TARGET: Partial<Record<NotificationType, string>> = {
  MATCH_FOUND: "/pitch",
  DATE_ASSIGNED: "/blind-date",
};

const AUTO_DISMISS_MS = 5000;

export default function NotificationBanner() {
  const navigate = useNavigate();
  const { activeNotification, dismissActive, clickActive } = useNotificationStore();

  useEffect(() => {
    if (!activeNotification) return;
    const timer = setTimeout(dismissActive, AUTO_DISMISS_MS);
    return () => clearTimeout(timer);
  }, [activeNotification, dismissActive]);

  if (!activeNotification) return null;

  function handleClick() {
    if (!activeNotification) return;
    clickActive();
    const target = NAVIGATION_TARGET[activeNotification.type];
    if (target) navigate(target);
  }

  return (
    <div
      role="alert"
      aria-live="assertive"
      className="fixed top-0 left-0 right-0 z-50 flex items-center justify-between gap-3 border-b border-border bg-primary text-primary-foreground px-4 py-3"
    >
      <button
        onClick={handleClick}
        className="flex-1 text-left text-sm font-medium hover:opacity-90 transition-opacity duration-200 ease-out"
      >
        {NOTIFICATION_TEXT[activeNotification.type]}
      </button>
      <button
        onClick={dismissActive}
        aria-label="Dismiss notification"
        className="shrink-0 text-primary-foreground/70 hover:text-primary-foreground transition-colors duration-200 ease-out"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  );
}
