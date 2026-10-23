import { describe, it, expect, beforeEach } from "vitest";
import {
  addNotification,
  clearNotifications,
  clickNotification,
  dismissNotification,
  getActiveNotification,
  getBadgeCount,
  getNotifications,
  markAllViewed,
  subscribe,
  NOTIFICATION_TEXT,
} from "./notificationStore";

describe("notificationStore", () => {
  beforeEach(() => {
    clearNotifications();
  });

  it("markAllViewed clears the badge count without touching notification history", () => {
    addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
    addNotification({ userId: "u-1", type: "CHECKIN_PROMPT", payload: {} });
    expect(getBadgeCount()).toBe(2);

    markAllViewed();

    expect(getBadgeCount()).toBe(0);
    expect(getNotifications()).toHaveLength(2);
  });

  it("markAllViewed is a no-op when there are no notifications", () => {
    expect(getBadgeCount()).toBe(0);

    markAllViewed();

    expect(getBadgeCount()).toBe(0);
  });

  it("has display text for every notification type", () => {
    const types = Object.keys(NOTIFICATION_TEXT);
    expect(types).toEqual([
      "MATCH_FOUND",
      "DATE_ASSIGNED",
      "PRE_DATE_REMINDER",
      "DEBRIEF_NUDGE",
      "CHECKIN_PROMPT",
    ]);
    types.forEach((type) => {
      expect(NOTIFICATION_TEXT[type as keyof typeof NOTIFICATION_TEXT].length).toBeGreaterThan(0);
    });
  });

  // The semantics below are the ones CONTEXT.md defines, and the reason this
  // module is shared rather than copied: they are what the two clients have to
  // agree on. Before #439 only the two markAllViewed cases above were covered.
  describe("the queue (one banner at a time)", () => {
    it("shows the notifications in the order they arrived, one at a time", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      addNotification({ userId: "u-1", type: "DATE_ASSIGNED", payload: {} });

      expect(getActiveNotification()?.type).toBe("MATCH_FOUND");

      dismissNotification();

      expect(getActiveNotification()?.type).toBe("DATE_ASSIGNED");
    });

    it("has no active notification once the queue drains", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      dismissNotification();

      expect(getActiveNotification()).toBeNull();
    });

    it("dismissing an empty queue is harmless", () => {
      dismissNotification();
      clickNotification();

      expect(getActiveNotification()).toBeNull();
      expect(getBadgeCount()).toBe(0);
    });
  });

  describe("the badge (deliberate clicks only)", () => {
    it("increments on arrival", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });

      expect(getBadgeCount()).toBe(1);
    });

    // The distinction the whole design turns on: letting a banner time out is
    // not the same as reading it, so the count has to survive an auto-dismiss.
    it("does not decrement when a banner is dismissed rather than clicked", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });

      dismissNotification();

      expect(getBadgeCount()).toBe(1);
      expect(getActiveNotification()).toBeNull();
    });

    it("decrements on a click, and advances the queue at the same time", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      addNotification({ userId: "u-1", type: "DATE_ASSIGNED", payload: {} });

      clickNotification();

      expect(getBadgeCount()).toBe(1);
      expect(getActiveNotification()?.type).toBe("DATE_ASSIGNED");
    });

    // A user who lets three banners expire and then clicks the fourth would
    // otherwise drive the count below zero.
    it("never goes negative", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      markAllViewed();

      clickNotification();

      expect(getBadgeCount()).toBe(0);
    });
  });

  describe("the history", () => {
    it("keeps notifications that have already left the queue", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      dismissNotification();

      expect(getActiveNotification()).toBeNull();
      expect(getNotifications()).toHaveLength(1);
    });

    it("hands back a copy, so a caller cannot mutate the store through it", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });

      getNotifications().length = 0;

      expect(getNotifications()).toHaveLength(1);
    });

    it("gives every notification a distinct id for list keys", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });

      const [first, second] = getNotifications();
      expect(first.id).not.toBe(second.id);
    });

    it("carries the payload through untouched", () => {
      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: { matchId: "m-1" } });

      expect(getNotifications()[0].payload).toEqual({ matchId: "m-1" });
    });
  });

  describe("subscribers", () => {
    it("is notified on arrival, dismissal, click and markAllViewed", () => {
      let calls = 0;
      const unsubscribe = subscribe(() => calls++);

      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });
      dismissNotification();
      addNotification({ userId: "u-1", type: "DATE_ASSIGNED", payload: {} });
      clickNotification();
      markAllViewed();

      expect(calls).toBe(5);
      unsubscribe();
    });

    it("stops calling a listener that unsubscribed", () => {
      let calls = 0;
      const unsubscribe = subscribe(() => calls++);
      unsubscribe();

      addNotification({ userId: "u-1", type: "MATCH_FOUND", payload: {} });

      expect(calls).toBe(0);
    });
  });
});
