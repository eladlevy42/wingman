import type { NotificationType } from "./schemas/notification";

// The in-session notification store, shared by both clients (CLAUDE.md §3).
//
// This lived in apps/web/src/lib until #439 needed the identical behaviour on
// mobile. The semantics it encodes are defined in CONTEXT.md — one active
// banner at a time, a badge that only decrements on a deliberate click, a
// history that clears the badge but not the queue — and two copies drifting
// apart would mean the two clients disagreeing about what a user has already
// seen. It imports no React and no platform API, which is the bar for living
// here rather than in an app.
export const NOTIFICATION_TEXT: Record<NotificationType, string> = {
  MATCH_FOUND: "You've got a match! Tap to meet them.",
  DATE_ASSIGNED: "Your date is set. Tap to see the details.",
  PRE_DATE_REMINDER: "Your date is coming up soon.",
  DEBRIEF_NUDGE: "Time to debrief — how did it go?",
  CHECKIN_PROMPT: "Barney wants to check in with you.",
};

export interface ClientNotification {
  id: string;
  userId: string;
  type: NotificationType;
  payload: Record<string, unknown>;
  receivedAt: Date;
}

interface StoreState {
  all: ClientNotification[];
  queue: ClientNotification[];
  badgeCount: number;
}

const state: StoreState = { all: [], queue: [], badgeCount: 0 };
const listeners = new Set<() => void>();

// Ids only have to be unique within one session — they are list keys and test
// handles, never persisted or sent anywhere. A counter is enough, and unlike
// `crypto.randomUUID()` (what web used before this moved) it exists on every
// runtime this package now runs on: Hermes has no global `crypto`, so calling
// it here would have crashed the mobile client on its first notification.
let nextId = 0;

function notifyListeners(): void {
  listeners.forEach((l) => l());
}

export function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function addNotification(n: Omit<ClientNotification, "id" | "receivedAt">): void {
  const notification: ClientNotification = {
    ...n,
    id: `notification-${++nextId}`,
    receivedAt: new Date(),
  };
  state.all.push(notification);
  state.queue.push(notification);
  state.badgeCount++;
  notifyListeners();
}

export function dismissNotification(): void {
  state.queue.shift();
  notifyListeners();
}

export function clickNotification(): void {
  state.queue.shift();
  state.badgeCount = Math.max(0, state.badgeCount - 1);
  notifyListeners();
}

export function getActiveNotification(): ClientNotification | null {
  return state.queue[0] ?? null;
}

export function getBadgeCount(): number {
  return state.badgeCount;
}

export function markAllViewed(): void {
  state.badgeCount = 0;
  notifyListeners();
}

// Returns the full session notification history, most-recent-last. Used by
// the notification history panel on both clients as well as by tests.
export function getNotifications(): ClientNotification[] {
  return [...state.all];
}

export function clearNotifications(): void {
  state.all.length = 0;
  state.queue.length = 0;
  state.badgeCount = 0;
  notifyListeners();
}
