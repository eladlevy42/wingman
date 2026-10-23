import { http, HttpResponse } from "msw";
import { addNotification, NotificationPayloadSchema } from "@wingman/shared";

export const notifyResolver: Parameters<typeof http.post>[1] = async ({ request }) => {
  const body = NotificationPayloadSchema.parse(await request.json());
  addNotification(body);
  return HttpResponse.json({ ok: true });
};

// Stateless readiness probe — lets e2e tests confirm MSW's Service Worker is
// actually dispatching to handlers (not just registered/controlling the page)
// before relying on it, without mutating notificationStore like /mock/notify.
export const pingResolver: Parameters<typeof http.get>[1] = () => {
  return HttpResponse.json({ ok: true });
};

export const handlers = [
  http.post("/mock/notify", notifyResolver),
  http.get("/mock/ping", pingResolver),
];
