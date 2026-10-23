import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@wingman/database", () => ({
  prisma: {
    pushToken: {
      upsert: vi.fn(),
      deleteMany: vi.fn(),
      findMany: vi.fn(),
    },
  },
}));

import { prisma } from "@wingman/database";
import { pushTokenService } from "./pushToken.service";

const TOKEN = "ExponentPushToken[abc123]";

function row(overrides: Record<string, unknown> = {}) {
  return {
    id: "11111111-1111-4111-8111-111111111111",
    userId: "22222222-2222-4222-8222-222222222222",
    token: TOKEN,
    platform: "android",
    createdAt: new Date("2026-01-01T00:00:00.000Z"),
    updatedAt: new Date("2026-01-02T00:00:00.000Z"),
    ...overrides,
  };
}

afterEach(() => vi.clearAllMocks());

describe("pushTokenService.register", () => {
  it("upserts on the token, not on the user, so one device holds one row", async () => {
    vi.mocked(prisma.pushToken.upsert).mockResolvedValue(row() as never);

    await pushTokenService.register("user-a", TOKEN, "android");

    // The dedupe rule this whole model rests on: a handset that changes hands
    // must not accumulate a row per account, or a send to the old account
    // lands on the phone of whoever is signed in now.
    expect(prisma.pushToken.upsert).toHaveBeenCalledWith({
      where: { token: TOKEN },
      create: { userId: "user-a", token: TOKEN, platform: "android" },
      update: { userId: "user-a", platform: "android" },
    });
  });

  it("re-points an existing row at the newest user", async () => {
    vi.mocked(prisma.pushToken.upsert).mockResolvedValue(row({ userId: "user-b" }) as never);

    const result = await pushTokenService.register("user-b", TOKEN, "android");

    const call = vi.mocked(prisma.pushToken.upsert).mock.calls[0][0];
    expect(call.update).toEqual({ userId: "user-b", platform: "android" });
    expect(result.userId).toBe("user-b");
  });

  it("registering the same token twice stays one row", async () => {
    vi.mocked(prisma.pushToken.upsert).mockResolvedValue(row() as never);

    await pushTokenService.register("user-a", TOKEN, "android");
    await pushTokenService.register("user-a", TOKEN, "android");

    // Both calls are upserts against the same unique key. The client
    // re-registers on every launch, so this has to be free.
    expect(prisma.pushToken.upsert).toHaveBeenCalledTimes(2);
    const [first, second] = vi.mocked(prisma.pushToken.upsert).mock.calls;
    expect(first[0].where).toEqual(second[0].where);
  });

  it("serialises dates to ISO strings for the wire", async () => {
    vi.mocked(prisma.pushToken.upsert).mockResolvedValue(row() as never);

    const result = await pushTokenService.register("user-a", TOKEN, "android");

    expect(result.createdAt).toBe("2026-01-01T00:00:00.000Z");
    expect(result.updatedAt).toBe("2026-01-02T00:00:00.000Z");
    expect(result.platform).toBe("android");
  });

  it("stores ios rows the same way, despite iOS being unverified (#518)", async () => {
    vi.mocked(prisma.pushToken.upsert).mockResolvedValue(row({ platform: "ios" }) as never);

    const result = await pushTokenService.register("user-a", TOKEN, "ios");

    expect(result.platform).toBe("ios");
  });
});

describe("pushTokenService.unregister", () => {
  it("deletes by token alone", async () => {
    vi.mocked(prisma.pushToken.deleteMany).mockResolvedValue({ count: 1 } as never);

    await pushTokenService.unregister(TOKEN);

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({ where: { token: TOKEN } });
  });

  it("is idempotent — unregistering an absent token is not an error", async () => {
    vi.mocked(prisma.pushToken.deleteMany).mockResolvedValue({ count: 0 } as never);

    // Sign-out calls this. It must not fail the sign-out over a row that was
    // already gone.
    await expect(pushTokenService.unregister(TOKEN)).resolves.toBeUndefined();
  });
});

describe("pushTokenService.prune", () => {
  it("deletes every token Expo reported as dead", async () => {
    vi.mocked(prisma.pushToken.deleteMany).mockResolvedValue({ count: 2 } as never);

    const count = await pushTokenService.prune(["a", "b"]);

    expect(prisma.pushToken.deleteMany).toHaveBeenCalledWith({
      where: { token: { in: ["a", "b"] } },
    });
    expect(count).toBe(2);
  });

  it("does not issue a query for an empty list", async () => {
    // deleteMany with `in: []` would be a pointless round trip on every
    // successful send, which is the overwhelmingly common case.
    const count = await pushTokenService.prune([]);

    expect(prisma.pushToken.deleteMany).not.toHaveBeenCalled();
    expect(count).toBe(0);
  });
});

describe("pushTokenService.listForUser", () => {
  it("returns bare token strings", async () => {
    vi.mocked(prisma.pushToken.findMany).mockResolvedValue([
      { token: "t1" },
      { token: "t2" },
    ] as never);

    await expect(pushTokenService.listForUser("user-a")).resolves.toEqual(["t1", "t2"]);
  });
});
