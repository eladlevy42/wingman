import { useEffect, useState } from "react";
import {
  subscribe,
  getActiveNotification,
  getBadgeCount,
  getNotifications,
  dismissNotification,
  clickNotification,
  markAllViewed,
  type ClientNotification,
} from "@wingman/shared";

interface NotificationStoreSnapshot {
  activeNotification: ClientNotification | null;
  badgeCount: number;
  notifications: ClientNotification[];
  dismissActive: () => void;
  clickActive: () => void;
  markAllViewed: () => void;
}

/**
 * Subscribes a component to the shared notification store.
 *
 * Identical to web's hook of the same name, and deliberately so — the store
 * itself moved to packages/shared in #439 precisely so the two clients could
 * not drift on the badge/queue rules. Only this five-line React binding is
 * duplicated, because it is the part that touches a renderer.
 */
export function useNotificationStore(): NotificationStoreSnapshot {
  const [activeNotification, setActiveNotification] = useState<ClientNotification | null>(
    getActiveNotification
  );
  const [badgeCount, setBadgeCount] = useState<number>(getBadgeCount);
  const [notifications, setNotifications] = useState<ClientNotification[]>(getNotifications);

  useEffect(() => {
    return subscribe(() => {
      setActiveNotification(getActiveNotification());
      setBadgeCount(getBadgeCount());
      setNotifications(getNotifications());
    });
  }, []);

  return {
    activeNotification,
    badgeCount,
    notifications,
    dismissActive: dismissNotification,
    clickActive: clickNotification,
    markAllViewed,
  };
}
