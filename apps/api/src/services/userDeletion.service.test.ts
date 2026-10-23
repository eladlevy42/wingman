import { describe, it, expect, vi, beforeEach } from "vitest";
import { deleteUser } from "./userDeletion.service";
import { NotFoundError, InvalidCredentialsError } from "./user.service";

vi.mock("@wingman/database", () => ({
  prisma: {
    user: { findUnique: vi.fn() },
    match: { findMany: vi.fn() },
  },
  deleteUserAccount: vi.fn(),
}));
vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));
vi.mock("./auditRetention.service", () => ({ deleteAuditDataForUser: vi.fn() }));
vi.mock("./decision.service", () => ({ rejectMatch: vi.fn() }));
vi.mock("bcryptjs", () => ({ default: { compare: vi.fn() } }));

import bcrypt from "bcryptjs";
import { prisma, deleteUserAccount } from "@wingman/database";
import { recordEvent } from "./audit.service";
import { deleteAuditDataForUser } from "./auditRetention.service";
import { rejectMatch } from "./decision.service";

const USER_ID = "123e4567-e89b-12d3-a456-426614174000";
const PASSWORD = "correct horse battery";
const BODY = { password: PASSWORD };

beforeEach(() => {
  // clearAllMocks resets calls but keeps implementations, so every mock a test
  // reassigns is put back explicitly here — otherwise a rejection set by one
  // test leaks into the next.
  vi.clearAllMocks();
  vi.mocked(recordEvent).mockResolvedValue(undefined as never);
  vi.mocked(deleteAuditDataForUser).mockResolvedValue({ events: 0, calls: 0 });
  vi.mocked(rejectMatch).mockResolvedValue(undefined);
  vi.mocked(prisma.user.findUnique).mockResolvedValue({
    id: USER_ID,
    passwordHash: "hashed",
  } as never);
  vi.mocked(prisma.match.findMany).mockResolvedValue([]);
  vi.mocked(deleteUserAccount).mockResolvedValue(true);
  vi.mocked(bcrypt.compare).mockResolvedValue(true as never);
});

describe("deleteUser", () => {
  it("erases the domain rows and then the audit rows", async () => {
    await deleteUser(USER_ID, BODY);

    expect(deleteUserAccount).toHaveBeenCalledWith(prisma, USER_ID);
    expect(deleteAuditDataForUser).toHaveBeenCalledWith(USER_ID);
  });

  it("records USER_DELETED before erasing, so the erasure takes the event too", async () => {
    const order: string[] = [];
    vi.mocked(recordEvent).mockImplementation(async () => void order.push("record"));
    vi.mocked(deleteUserAccount).mockImplementation(async () => {
      order.push("delete-domain");
      return true;
    });
    vi.mocked(deleteAuditDataForUser).mockImplementation(async () => {
      order.push("delete-audit");
      return { events: 0, calls: 0 };
    });

    await deleteUser(USER_ID, BODY);

    expect(recordEvent).toHaveBeenCalledWith("USER_DELETED", {}, { userId: USER_ID });
    expect(order).toEqual(["record", "delete-domain", "delete-audit"]);
  });

  it("throws NotFoundError for an unknown id and erases nothing", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(deleteUser(USER_ID, BODY)).rejects.toThrow(NotFoundError);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(deleteUserAccount).not.toHaveBeenCalled();
    expect(deleteAuditDataForUser).not.toHaveBeenCalled();
  });

  it("throws NotFoundError when the row goes between the check and the delete", async () => {
    vi.mocked(deleteUserAccount).mockResolvedValue(false);

    await expect(deleteUser(USER_ID, BODY)).rejects.toThrow(NotFoundError);
    // The audit erasure still runs: a row that vanished concurrently is still a
    // user whose audit trail must go, and deleteMany no-ops when it matches
    // nothing.
    expect(deleteAuditDataForUser).toHaveBeenCalledWith(USER_ID);
  });

  it("surfaces a failed audit erasure instead of answering 204", async () => {
    vi.mocked(deleteAuditDataForUser).mockRejectedValue(new Error("db is gone"));
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});

    await expect(deleteUser(USER_ID, BODY)).rejects.toThrow("db is gone");
    // The domain rows are already gone, so the log has to name the id the manual
    // clean-up needs.
    expect(logged.mock.calls[0]?.[0]).toContain(USER_ID);
    logged.mockRestore();
  });
});

describe("the password gate", () => {
  it("erases nothing when the password is wrong", async () => {
    vi.mocked(bcrypt.compare).mockResolvedValue(false as never);

    await expect(deleteUser(USER_ID, BODY)).rejects.toThrow(InvalidCredentialsError);
    expect(recordEvent).not.toHaveBeenCalled();
    expect(deleteUserAccount).not.toHaveBeenCalled();
    expect(deleteAuditDataForUser).not.toHaveBeenCalled();
  });

  it("refuses an account with no password rather than letting bcrypt throw", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      id: USER_ID,
      passwordHash: null,
    } as never);

    await expect(deleteUser(USER_ID, BODY)).rejects.toThrow(InvalidCredentialsError);
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });

  it("rejects a request with no password at all", async () => {
    await expect(deleteUser(USER_ID, {})).rejects.toThrow();
    expect(deleteUserAccount).not.toHaveBeenCalled();
  });
});

describe("releasing the counterparty", () => {
  const upcoming = { id: "match-1", userAId: USER_ID, userBId: "user-b" };

  it("rejects a match whose date has not happened, so the other user is not stranded", async () => {
    vi.mocked(prisma.match.findMany).mockResolvedValue([upcoming] as never);

    await deleteUser(USER_ID, BODY);

    expect(rejectMatch).toHaveBeenCalledWith(upcoming);
  });

  it("asks only for MATCHED matches with no date or a future one", async () => {
    await deleteUser(USER_ID, BODY);

    const where = vi.mocked(prisma.match.findMany).mock.calls[0]?.[0]?.where as {
      status: string;
      AND: [{ OR: unknown[] }, { OR: [{ dateTime: null }, { dateTime: { gt: Date } }] }];
    };
    expect(where.status).toBe("MATCHED");
    expect(where.AND[0].OR).toEqual([{ userAId: USER_ID }, { userBId: USER_ID }]);
    // A date that already happened is the other participant's record of a real
    // date, and their debrief still has to be possible — so it is left alone.
    expect(where.AND[1].OR[0]).toEqual({ dateTime: null });
    expect(where.AND[1].OR[1].dateTime.gt).toBeInstanceOf(Date);
  });

  it("releases the counterparty before the user row goes", async () => {
    const order: string[] = [];
    vi.mocked(prisma.match.findMany).mockResolvedValue([upcoming] as never);
    vi.mocked(rejectMatch).mockImplementation(async () => void order.push("reject"));
    vi.mocked(deleteUserAccount).mockImplementation(async () => {
      order.push("delete");
      return true;
    });

    await deleteUser(USER_ID, BODY);

    // rejectMatch reads both participants; running it after the erasure would
    // hand it a tombstone in place of the departing user.
    expect(order).toEqual(["reject", "delete"]);
  });
});
