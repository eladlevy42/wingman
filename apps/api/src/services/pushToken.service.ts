import { prisma } from "@wingman/database";
import type { PushPlatform, PushTokenRecord } from "@wingman/shared";

// Device registry for push delivery (#477). Deliberately thin: it owns which
// devices belong to which user and nothing about what gets sent — that is
// push.service.ts.
export const pushTokenService = {
  // Registering is an upsert keyed on the token, not on (userId, token).
  //
  // A handset hands the same Expo token to whoever signs in on it. If two
  // accounts registered the same token, every send to either would land on the
  // device currently signed in as the other — a stranger reading "You've got a
  // match!" meant for someone else. Re-pointing the row at the newest user
  // instead means the previous account simply stops receiving push on a device
  // it is no longer signed into, which is the correct outcome.
  //
  // The same upsert covers the ordinary case of one user re-registering on
  // every launch: same token, same user, only updatedAt moves.
  async register(userId: string, token: string, platform: PushPlatform): Promise<PushTokenRecord> {
    const row = await prisma.pushToken.upsert({
      where: { token },
      create: { userId, token, platform },
      update: { userId, platform },
    });
    return {
      id: row.id,
      userId: row.userId,
      token: row.token,
      platform: row.platform as PushPlatform,
      createdAt: row.createdAt.toISOString(),
      updatedAt: row.updatedAt.toISOString(),
    };
  },

  // Sign-out, and the only way a user deliberately stops push on a device.
  // Idempotent: unregistering a token that is already gone is a success, not a
  // 404 — the client calls this while signing out and must not be left with a
  // failed sign-out over a row that was already deleted.
  async unregister(token: string): Promise<void> {
    await prisma.pushToken.deleteMany({ where: { token } });
  },

  async listForUser(userId: string): Promise<string[]> {
    const rows = await prisma.pushToken.findMany({
      where: { userId },
      select: { token: true },
    });
    return rows.map((r) => r.token);
  },

  // Called with the tokens Expo reported as DeviceNotRegistered — the app was
  // uninstalled, or the token was rotated. Expo asks senders to stop using
  // these; left in place they are sent to forever.
  async prune(tokens: string[]): Promise<number> {
    if (tokens.length === 0) return 0;
    const { count } = await prisma.pushToken.deleteMany({
      where: { token: { in: tokens } },
    });
    return count;
  },
};
