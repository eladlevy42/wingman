import { describe, it, expect, vi, beforeEach } from "vitest";
import bcrypt from "bcryptjs";
import {
  registerUser,
  loginUser,
  authenticateStudent,
  getUserById,
  getUserState,
  getMatchPhoto,
  savePhoto,
  NotFoundError,
  InvalidCredentialsError,
} from "./user.service";

const mockUser = {
  id: "123e4567-e89b-12d3-a456-426614174000",
  email: "test@example.com",
  name: "Test User",
  phone: "555-0101",
  gender: "male",
  matchingState: "IDLE",
  universityEmail: null,
  studentId: null,
  passwordHash: null,
  universityPasswordHash: null,
  expectedMatches: null,
  photoUrl: null,
  createdAt: new Date("2024-01-01T00:00:00.000Z"),
  enteredWaitingAt: new Date("2024-01-01T00:00:00.000Z"),
};

// getUserState queries with an include for profile and matched-status matches,
// so its resolved value carries relations the base findUnique return type does
// not. Cast through unknown to satisfy the mock without widening production types.
type FindUniqueResult = Awaited<ReturnType<typeof prisma.user.findUnique>>;
const asFindUniqueResult = (value: unknown) => value as FindUniqueResult;

vi.mock("@wingman/database", () => ({
  prisma: {
    user: {
      create: vi.fn(),
      findUnique: vi.fn(),
      update: vi.fn(),
    },
    followUp: {
      findUnique: vi.fn(),
    },
  },
}));

vi.mock("./audit.service", () => ({ recordEvent: vi.fn() }));

import { prisma } from "@wingman/database";
import { recordEvent } from "./audit.service";

beforeEach(() => {
  vi.clearAllMocks();
});

describe("registerUser", () => {
  it("creates a user and returns correct shape", async () => {
    vi.mocked(prisma.user.create).mockResolvedValue(mockUser);

    const result = await registerUser({
      email: "test@example.com",
      name: "Test User",
      phone: "555-0101",
      gender: "male",
      password: "sup3rsecret",
    });

    expect(prisma.user.create).toHaveBeenCalledTimes(1);
    const createArg = vi.mocked(prisma.user.create).mock.calls[0][0];
    expect(createArg.data).toMatchObject({
      email: "test@example.com",
      name: "Test User",
      phone: "555-0101",
      gender: "male",
    });
    // The plaintext password is never persisted — only a bcrypt hash, under
    // passwordHash (the account credential, #277).
    expect(createArg.data).not.toHaveProperty("password");
    const storedHash = createArg.data.passwordHash as string;
    expect(storedHash).not.toBe("sup3rsecret");
    expect(await bcrypt.compare("sup3rsecret", storedHash)).toBe(true);
    expect(result).toMatchObject({
      id: mockUser.id,
      email: mockUser.email,
      name: mockUser.name,
      gender: mockUser.gender,
      createdAt: mockUser.createdAt.toISOString(),
    });
    expect(result).not.toHaveProperty("phone");
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("throws ZodError for invalid input", async () => {
    await expect(registerUser({ email: "not-an-email" })).rejects.toThrow();
  });

  // #552: registration is an audit event — and its payload is empty by design,
  // since the row's own userId/createdAt say everything the trail may record.
  it("records a USER_REGISTERED audit event for the new user", async () => {
    vi.mocked(prisma.user.create).mockResolvedValue(mockUser);

    await registerUser({
      email: "test@example.com",
      name: "Test User",
      phone: "555-0101",
      gender: "male",
      password: "sup3rsecret",
    });

    expect(recordEvent).toHaveBeenCalledWith("USER_REGISTERED", {}, { userId: mockUser.id });
  });

  it("rejects a too-short password without persisting the user (#277)", async () => {
    await expect(
      registerUser({
        email: "test@example.com",
        name: "Test User",
        phone: "555-0101",
        gender: "male",
        password: "short",
      })
    ).rejects.toThrow();

    expect(prisma.user.create).not.toHaveBeenCalled();
  });

  it("rejects an oversized name without persisting it (#227)", async () => {
    await expect(
      registerUser({
        email: "test@example.com",
        name: "a".repeat(5_000_000),
        phone: "555-0101",
        gender: "male",
        password: "sup3rsecret",
      })
    ).rejects.toThrow();

    expect(prisma.user.create).not.toHaveBeenCalled();
  });
});

describe("authenticateStudent (#275)", () => {
  const validInput = {
    universityEmail: "dana@mail.tau.ac.il",
    studentId: "20241138",
    password: "sup3rsecret",
  };

  it("stores the university email, student id, and a bcrypt hash of the password", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
    vi.mocked(prisma.user.update).mockResolvedValue({
      ...mockUser,
      universityEmail: validInput.universityEmail,
      studentId: validInput.studentId,
      universityPasswordHash: "hashed",
    });

    const result = await authenticateStudent(mockUser.id, validInput);

    expect(prisma.user.update).toHaveBeenCalledTimes(1);
    const updateArg = vi.mocked(prisma.user.update).mock.calls[0][0];
    expect(updateArg.where).toEqual({ id: mockUser.id });
    expect(updateArg.data?.universityEmail).toBe(validInput.universityEmail);
    expect(updateArg.data?.studentId).toBe(validInput.studentId);
    // The university password is hashed into its own column, never stored as
    // plaintext, and kept separate from the account password (#277).
    const storedHash = updateArg.data?.universityPasswordHash as string;
    expect(storedHash).not.toBe(validInput.password);
    expect(await bcrypt.compare(validInput.password, storedHash)).toBe(true);
    // The public shape never leaks the sensitive fields.
    expect(result).not.toHaveProperty("universityPasswordHash");
    expect(result).not.toHaveProperty("studentId");
  });

  it("rejects a non-university email without updating the user", async () => {
    await expect(
      authenticateStudent(mockUser.id, { ...validInput, universityEmail: "dana@gmail.com" })
    ).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a too-short password without updating the user", async () => {
    await expect(
      authenticateStudent(mockUser.id, { ...validInput, password: "short" })
    ).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("throws NotFoundError for an unknown user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);
    await expect(authenticateStudent("nonexistent-id", validInput)).rejects.toThrow(NotFoundError);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("loginUser", () => {
  it("returns user when the email and password match (#277)", async () => {
    const passwordHash = await bcrypt.hash("sup3rsecret", 10);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, passwordHash });

    const result = await loginUser({ email: "test@example.com", password: "sup3rsecret" });

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { email: "test@example.com" },
    });
    expect(result.email).toBe("test@example.com");
    // The hash must never leak into the public user shape.
    expect(result).not.toHaveProperty("passwordHash");
  });

  it("throws InvalidCredentialsError when the password is wrong (#277)", async () => {
    const passwordHash = await bcrypt.hash("sup3rsecret", 10);
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, passwordHash });

    await expect(
      loginUser({ email: "test@example.com", password: "wrong-password" })
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("throws InvalidCredentialsError for a social account with no password (#277)", async () => {
    // Google/Microsoft accounts have no passwordHash and cannot use password login.
    vi.mocked(prisma.user.findUnique).mockResolvedValue({ ...mockUser, passwordHash: null });

    await expect(
      loginUser({ email: "test@example.com", password: "anything-goes" })
    ).rejects.toThrow(InvalidCredentialsError);
  });

  it("throws NotFoundError for unknown email", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(
      loginUser({ email: "unknown@example.com", password: "sup3rsecret" })
    ).rejects.toThrow(NotFoundError);
  });

  it("throws ZodError for invalid input", async () => {
    await expect(loginUser({ email: "not-an-email", password: "sup3rsecret" })).rejects.toThrow();
  });
});

describe("getUserById", () => {
  it("returns user for known id", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);

    const result = await getUserById(mockUser.id);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: mockUser.id },
    });
    expect(result.id).toBe(mockUser.id);
  });

  it("throws NotFoundError for unknown id", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(getUserById("nonexistent-id")).rejects.toThrow(NotFoundError);
  });
});

describe("getUserState", () => {
  it("returns hasProfile false and matchingState for a user without a profile", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "IDLE",
        profile: null,
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(prisma.user.findUnique).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      include: {
        profile: true,
        matchesAsA: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
        matchesAsB: { where: { status: "MATCHED" }, orderBy: { createdAt: "desc" } },
      },
    });
    expect(result).toEqual({
      matchingState: "IDLE",
      hasProfile: false,
      universityVerified: false,
      hasPhoto: false,
    });
  });

  it("returns hasProfile true when the profile is COMPLETED", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "WAITING",
        profile: {
          id: "p1",
          userId: mockUser.id,
          rawTranscript: "",
          structuredData: null,
          status: "COMPLETED",
        },
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "WAITING",
      hasProfile: true,
      universityVerified: false,
      hasPhoto: false,
    });
  });

  it("returns hasProfile false when the profile is still INCOMPLETE", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "IDLE",
        profile: {
          id: "p1",
          userId: mockUser.id,
          rawTranscript: "",
          structuredData: null,
          status: "INCOMPLETE",
        },
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "IDLE",
      hasProfile: false,
      universityVerified: false,
      hasPhoto: false,
    });
  });

  // #329: the login redirect needs to know whether the university-verification
  // step was completed — a stored universityEmail is what that step writes.
  it("returns universityVerified true once a universityEmail is stored", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        universityEmail: "dana@mail.tau.ac.il",
        matchingState: "IDLE",
        profile: null,
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "IDLE",
      hasProfile: false,
      universityVerified: true,
      hasPhoto: false,
    });
  });

  it("returns matchedWith as the other user's id when matched as userA", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "MATCHED",
        profile: null,
        matchesAsA: [
          {
            id: "123e4567-e89b-12d3-a456-426614174002",
            userAId: mockUser.id,
            userBId: "123e4567-e89b-12d3-a456-426614174001",
            status: "MATCHED",
            deliberationLog: null,
            rationale: null,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        ],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "MATCHED",
      hasProfile: false,
      universityVerified: false,
      hasPhoto: false,
      matchedWith: "123e4567-e89b-12d3-a456-426614174001",
      matchId: "123e4567-e89b-12d3-a456-426614174002",
    });
  });

  it("returns matchedWith as the other user's id when matched as userB", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "MATCHED",
        profile: null,
        matchesAsA: [],
        matchesAsB: [
          {
            id: "123e4567-e89b-12d3-a456-426614174002",
            userAId: "123e4567-e89b-12d3-a456-426614174001",
            userBId: mockUser.id,
            status: "MATCHED",
            deliberationLog: null,
            rationale: null,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        ],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "MATCHED",
      hasProfile: false,
      universityVerified: false,
      hasPhoto: false,
      matchedWith: "123e4567-e89b-12d3-a456-426614174001",
      matchId: "123e4567-e89b-12d3-a456-426614174002",
    });
  });

  it("throws NotFoundError for unknown id", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(getUserState("nonexistent-id")).rejects.toThrow(NotFoundError);
  });

  // #218 review: once a debriefed user re-enters matching (#77), their prior
  // MATCHED Match row is never retired, so a second matching cycle leaves them
  // with two MATCHED rows — one on each side of the userA/userB relation here.
  // getUserState must pick the most recently created one, not just whichever
  // side happens to be non-empty.
  it("picks the most recently created MATCHED match across both sides", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "MATCHED",
        profile: null,
        matchesAsA: [
          {
            id: "123e4567-e89b-12d3-a456-426614174002",
            userAId: mockUser.id,
            userBId: "123e4567-e89b-12d3-a456-426614174001",
            status: "MATCHED",
            deliberationLog: null,
            rationale: null,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        ],
        matchesAsB: [
          {
            id: "123e4567-e89b-12d3-a456-426614174004",
            userAId: "123e4567-e89b-12d3-a456-426614174003",
            userBId: mockUser.id,
            status: "MATCHED",
            deliberationLog: null,
            rationale: null,
            createdAt: new Date("2024-06-01T00:00:00.000Z"),
          },
        ],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result).toEqual({
      matchingState: "MATCHED",
      hasProfile: false,
      universityVerified: false,
      hasPhoto: false,
      matchedWith: "123e4567-e89b-12d3-a456-426614174003",
      matchId: "123e4567-e89b-12d3-a456-426614174004",
    });
  });

  // #77: Debrief.tsx needs followUpState to know when to auto-trigger a debrief.
  it("includes followUpState from the matched match's FollowUp row", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "DATE_ASSIGNED",
        profile: null,
        matchesAsA: [
          {
            id: "123e4567-e89b-12d3-a456-426614174002",
            userAId: mockUser.id,
            userBId: "123e4567-e89b-12d3-a456-426614174001",
            status: "MATCHED",
            deliberationLog: null,
            rationale: null,
            createdAt: new Date("2024-01-01T00:00:00.000Z"),
          },
        ],
        matchesAsB: [],
      })
    );
    vi.mocked(prisma.followUp.findUnique).mockResolvedValue({
      id: "f1",
      userId: mockUser.id,
      matchId: "123e4567-e89b-12d3-a456-426614174002",
      state: "DATE_PASSED",
    });

    const result = await getUserState(mockUser.id);

    expect(prisma.followUp.findUnique).toHaveBeenCalledWith({
      where: {
        userId_matchId: {
          userId: mockUser.id,
          matchId: "123e4567-e89b-12d3-a456-426614174002",
        },
      },
    });
    expect(result.followUpState).toBe("DATE_PASSED");
  });

  it("omits followUpState when there is no matched match", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "IDLE",
        profile: null,
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(prisma.followUp.findUnique).not.toHaveBeenCalled();
    expect(result.followUpState).toBeUndefined();
  });

  // Regression test for #197: decision.service.ts writes matchingState:
  // "DATE_ASSIGNED" once a Blind Date is assigned, but MatchingStateSchema
  // didn't include it, so UserStateResponseSchema.parse() threw a ZodError
  // (500) here instead of returning the state.
  it("does not throw for a user in DATE_ASSIGNED state", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(
      asFindUniqueResult({
        ...mockUser,
        matchingState: "DATE_ASSIGNED",
        profile: null,
        matchesAsA: [],
        matchesAsB: [],
      })
    );

    const result = await getUserState(mockUser.id);

    expect(result.matchingState).toBe("DATE_ASSIGNED");
  });

  describe("hasPhoto (#509)", () => {
    async function stateFor(photoUrl: string | null) {
      vi.mocked(prisma.user.findUnique).mockResolvedValue(
        asFindUniqueResult({
          ...mockUser,
          photoUrl,
          matchingState: "WAITING",
          profile: { status: "COMPLETED" },
          matchesAsA: [],
          matchesAsB: [],
        })
      );
      return getUserState(mockUser.id);
    }

    it("is false when the user has no photo", async () => {
      expect((await stateFor(null)).hasPhoto).toBe(false);
    });

    it("is true once a photo is stored", async () => {
      expect((await stateFor("data:image/jpeg;base64,abc")).hasPhoto).toBe(true);
    });

    it("reports presence without carrying the photo itself", async () => {
      // /state is polled frequently and photoUrl is a multi-MB base64 data URL.
      // The bytes belong on getMatchPhoto's endpoint, not in every poll.
      const result = await stateFor("data:image/jpeg;base64,abc");
      expect(JSON.stringify(result)).not.toContain("base64");
    });
  });
});

describe("getMatchPhoto", () => {
  const matchedUser = (matches: { asA?: unknown[]; asB?: unknown[] }) =>
    asFindUniqueResult({
      ...mockUser,
      matchesAsA: matches.asA ?? [],
      matchesAsB: matches.asB ?? [],
    });

  const matchRow = {
    id: "123e4567-e89b-12d3-a456-426614174002",
    userAId: mockUser.id,
    userBId: "123e4567-e89b-12d3-a456-426614174001",
    status: "MATCHED",
    deliberationLog: null,
    rationale: null,
    createdAt: new Date("2024-01-01T00:00:00.000Z"),
  };

  it("returns the matched partner's photoUrl", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(matchedUser({ asA: [matchRow] }))
      .mockResolvedValueOnce(
        asFindUniqueResult({
          ...mockUser,
          id: matchRow.userBId,
          photoUrl: "data:image/png;base64,abc",
        })
      );

    const result = await getMatchPhoto(mockUser.id);

    // partnerName rides along for the pitch reveal card (ADR-0022); education is
    // null here because the mocked partner has no profile.
    expect(result).toEqual({
      photoUrl: "data:image/png;base64,abc",
      partnerName: mockUser.name,
      education: null,
    });
    // The second lookup targets the partner, not the requesting user, and now
    // includes the profile so education can be read.
    expect(prisma.user.findUnique).toHaveBeenLastCalledWith({
      where: { id: matchRow.userBId },
      include: { profile: true },
    });
  });

  it("returns null photoUrl when there is no current match", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(matchedUser({}));

    const result = await getMatchPhoto(mockUser.id);

    expect(result).toEqual({ photoUrl: null, partnerName: null, education: null });
  });

  it("returns null photoUrl when the partner has no photo", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(matchedUser({ asA: [matchRow] }))
      .mockResolvedValueOnce(
        asFindUniqueResult({ ...mockUser, id: matchRow.userBId, photoUrl: null })
      );

    const result = await getMatchPhoto(mockUser.id);

    // photoUrl is null but the name still comes through for the reveal card.
    expect(result).toEqual({ photoUrl: null, partnerName: mockUser.name, education: null });
  });

  it("returns the partner's education from their structured profile (ADR-0022)", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(matchedUser({ asA: [matchRow] }))
      .mockResolvedValueOnce(
        asFindUniqueResult({
          ...mockUser,
          id: matchRow.userBId,
          photoUrl: null,
          profile: {
            // A minimal UserProfileSchema-valid payload — a partial one would
            // fail safeParse and (correctly) degrade education to null.
            structuredData: JSON.stringify({
              age: 28,
              city: "Tel Aviv",
              country: "Israel",
              height: null,
              job: null,
              hometown: null,
              education: "Tel Aviv University",
              conflict_style: null,
              emotional_openness: null,
              treatment_of_others: null,
              wants_kids: null,
              kids_timeline: null,
              faith: null,
              current_motivation: null,
              life_vision: null,
              hobbies: [],
              typical_weekend: null,
              social_energy: null,
              social_circle: null,
            }),
          },
        })
      );

    const result = await getMatchPhoto(mockUser.id);

    expect(result).toEqual({
      photoUrl: null,
      partnerName: mockUser.name,
      education: "Tel Aviv University",
    });
  });

  it("degrades education to null when structuredData is malformed JSON", async () => {
    vi.mocked(prisma.user.findUnique)
      .mockResolvedValueOnce(matchedUser({ asA: [matchRow] }))
      .mockResolvedValueOnce(
        asFindUniqueResult({
          ...mockUser,
          id: matchRow.userBId,
          photoUrl: null,
          profile: { structuredData: "not json {" },
        })
      );

    const result = await getMatchPhoto(mockUser.id);

    // A corrupted profile must never 500 the pitch — the reveal simply runs
    // without an education line.
    expect(result).toEqual({ photoUrl: null, partnerName: mockUser.name, education: null });
  });

  it("throws NotFoundError for an unknown user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValueOnce(null);

    await expect(getMatchPhoto("nonexistent-id")).rejects.toThrow(NotFoundError);
  });
});

describe("savePhoto", () => {
  const validPhotoUrl = "data:image/png;base64,aGVsbG8=";

  it("persists the photo on the user record", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(mockUser);
    vi.mocked(prisma.user.update).mockResolvedValue({ ...mockUser, photoUrl: validPhotoUrl });

    await savePhoto(mockUser.id, { photoUrl: validPhotoUrl });

    expect(prisma.user.update).toHaveBeenCalledWith({
      where: { id: mockUser.id },
      data: { photoUrl: validPhotoUrl },
    });
  });

  it("throws NotFoundError for an unknown user", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue(null);

    await expect(savePhoto("nonexistent-id", { photoUrl: validPhotoUrl })).rejects.toThrow(
      NotFoundError
    );
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects a non-image data URL", async () => {
    await expect(
      savePhoto(mockUser.id, { photoUrl: "data:application/pdf;base64,aGVsbG8=" })
    ).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it("rejects an oversized photo", async () => {
    const oversized = `data:image/png;base64,${"a".repeat(7_000_001)}`;

    await expect(savePhoto(mockUser.id, { photoUrl: oversized })).rejects.toThrow();
    expect(prisma.user.update).not.toHaveBeenCalled();
  });
});

describe("getUserById privacy", () => {
  it("never returns photoUrl even when present on the underlying user record", async () => {
    vi.mocked(prisma.user.findUnique).mockResolvedValue({
      ...mockUser,
      photoUrl: "data:image/png;base64,aGVsbG8=",
    });

    const result = await getUserById(mockUser.id);

    expect(result).not.toHaveProperty("photoUrl");
  });
});
