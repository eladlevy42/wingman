import { useEffect, useRef, useState } from "react";
import { useNotificationStore } from "@/hooks/useNotificationStore";
import { NOTIFICATION_TEXT } from "@wingman/shared";

export default function AppNav() {
  const { badgeCount, notifications, markAllViewed } = useNotificationStore();
  const [isOpen, setIsOpen] = useState(false);
  const containerRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!isOpen) return;

    function handleOutsideClick(event: MouseEvent) {
      if (containerRef.current && !containerRef.current.contains(event.target as Node)) {
        setIsOpen(false);
      }
    }

    document.addEventListener("mousedown", handleOutsideClick);
    return () => document.removeEventListener("mousedown", handleOutsideClick);
  }, [isOpen]);

  function handleToggle() {
    const willOpen = !isOpen;
    setIsOpen(willOpen);
    if (willOpen) markAllViewed();
  }

  return (
    <nav className="flex flex-wrap items-center justify-between gap-y-2 px-4 py-3 border-b border-border bg-background">
      <span className="flex items-center gap-2 text-lg font-semibold text-primary">
        <span className="h-2 w-2 rounded-full bg-brand" />
        Wingman
      </span>

      <div className="relative" ref={containerRef}>
        <button
          type="button"
          onClick={handleToggle}
          aria-haspopup="true"
          aria-expanded={isOpen}
          className="rounded-md px-1 py-0.5 text-sm text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background"
        >
          Notifications
        </button>
        {badgeCount > 0 && (
          <span
            aria-label={`${badgeCount} unread notification${badgeCount > 1 ? "s" : ""}`}
            className="absolute -top-2 -right-3 flex h-5 w-5 items-center justify-center rounded-full bg-destructive text-destructive-foreground text-xs font-bold"
          >
            {badgeCount > 9 ? "9+" : badgeCount}
          </span>
        )}
        {isOpen && (
          <div
            role="menu"
            aria-label="Notifications"
            className="animate-in fade-in duration-200 absolute right-0 top-full z-50 mt-2 w-72 rounded-lg border border-border bg-card p-2"
          >
            {notifications.length === 0 ? (
              <p className="px-2 py-3 text-sm text-muted-foreground">No notifications yet.</p>
            ) : (
              <ul className="max-h-80 space-y-1 overflow-y-auto">
                {[...notifications].reverse().map((notification) => (
                  <li
                    key={notification.id}
                    role="menuitem"
                    className="rounded-md px-2 py-2 text-sm text-foreground hover:bg-accent"
                  >
                    {NOTIFICATION_TEXT[notification.type]}
                  </li>
                ))}
              </ul>
            )}
          </div>
        )}
      </div>
    </nav>
  );
}
