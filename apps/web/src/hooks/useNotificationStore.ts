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
