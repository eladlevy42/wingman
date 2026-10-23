import { describe, expect, it } from "vitest";
import {
  LoginInputSchema,
  RegisterInputSchema,
  StudentAuthInputSchema,
  UserResponseSchema,
  UserStateResponseSchema,
  PhotoUploadInputSchema,
  isUniversityEmail,
} from "./user";

// Sign-up takes any valid email (a personal account is fine); the university
// check lives on StudentAuthInputSchema instead (#275). The account password is
// set here (#277).
const validRegisterInput = {
  email: "alice@example.com",
  name: "Alice",
  phone: "+1-555-0100",
  gender: "female",
  password: "sup3rsecret",
};

const validStudentAuthInput = {
  universityEmail: "alice@mail.tau.ac.il",
  studentId: "20241138",
  password: "sup3rsecret",
};

const validUserResponse = {
  id: "550e8400-e29b-41d4-a716-446655440000",
  email: "alice@example.com",
  name: "Alice",
  gender: "female",
  createdAt: new Date().toISOString(),
};

describe("RegisterInputSchema", () => {
  it("parses valid input without error", () => {
    expect(() => RegisterInputSchema.parse(validRegisterInput)).not.toThrow();
  });

  it("throws ZodError on invalid email", () => {
    expect(() =>
      RegisterInputSchema.parse({ ...validRegisterInput, email: "not-an-email" })
    ).toThrow();
  });

  it("throws ZodError on invalid gender", () => {
    expect(() => RegisterInputSchema.parse({ ...validRegisterInput, gender: "robot" })).toThrow();
  });

  it("throws ZodError on whitespace-only name", () => {
    expect(() => RegisterInputSchema.parse({ ...validRegisterInput, name: "   " })).toThrow();
  });

  it("throws ZodError on whitespace-only phone", () => {
    expect(() => RegisterInputSchema.parse({ ...validRegisterInput, phone: "   " })).toThrow();
  });

  it("trims leading/trailing whitespace on a valid name", () => {
    const result = RegisterInputSchema.parse({ ...validRegisterInput, name: "  Alice  " });
    expect(result.name).toBe("Alice");
  });

  it("throws ZodError on a name over the max length", () => {
    expect(() =>
      RegisterInputSchema.parse({ ...validRegisterInput, name: "a".repeat(201) })
    ).toThrow();
  });

  it("throws ZodError on a phone over the max length", () => {
    expect(() =>
      RegisterInputSchema.parse({ ...validRegisterInput, phone: "1".repeat(33) })
    ).toThrow();
  });

  it("throws ZodError on an email over the max length (#227)", () => {
    const oversizedEmail = `${"a".repeat(250)}@example.com`;
    expect(() =>
      RegisterInputSchema.parse({ ...validRegisterInput, email: oversizedEmail })
    ).toThrow();
  });

  it("accepts any valid email — the university check is not on sign-up (#275)", () => {
    expect(() =>
      RegisterInputSchema.parse({ ...validRegisterInput, email: "dana@gmail.com" })
    ).not.toThrow();
  });

  it("throws ZodError on a password shorter than 8 characters (#277)", () => {
    expect(() => RegisterInputSchema.parse({ ...validRegisterInput, password: "short" })).toThrow();
  });

  it("throws ZodError when the password is missing (#277)", () => {
    const withoutPassword = {
      email: validRegisterInput.email,
      name: validRegisterInput.name,
      phone: validRegisterInput.phone,
      gender: validRegisterInput.gender,
    };
    expect(() => RegisterInputSchema.parse(withoutPassword)).toThrow();
  });
});

describe("StudentAuthInputSchema (#275)", () => {
  it("parses valid input without error", () => {
    expect(() => StudentAuthInputSchema.parse(validStudentAuthInput)).not.toThrow();
  });

  it("accepts a Tel Aviv University email and its student subdomain", () => {
    expect(() =>
      StudentAuthInputSchema.parse({ ...validStudentAuthInput, universityEmail: "dana@tau.ac.il" })
    ).not.toThrow();
    expect(() =>
      StudentAuthInputSchema.parse({
        ...validStudentAuthInput,
        universityEmail: "dana@mail.tau.ac.il",
      })
    ).not.toThrow();
  });

  it("rejects a non-university email with the university message", () => {
    const result = StudentAuthInputSchema.safeParse({
      ...validStudentAuthInput,
      universityEmail: "dana@gmail.com",
    });
    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((i) => i.path[0] === "universityEmail");
      expect(issue?.message).toContain("Tel Aviv University");
    }
  });

  it("shows the base 'Invalid email' message (not the university one) for a malformed email", () => {
    for (const universityEmail of ["", "not-an-email"]) {
      const result = StudentAuthInputSchema.safeParse({
        ...validStudentAuthInput,
        universityEmail,
      });
      expect(result.success).toBe(false);
      if (!result.success) {
        const messages = result.error.issues
          .filter((i) => i.path[0] === "universityEmail")
          .map((i) => i.message);
        expect(messages).toContain("Invalid email");
        expect(messages.some((m) => m.includes("Tel Aviv University"))).toBe(false);
      }
    }
  });

  it("rejects a look-alike domain that only ends with the allowed one", () => {
    expect(
      StudentAuthInputSchema.safeParse({
        ...validStudentAuthInput,
        universityEmail: "x@eviltau.ac.il",
      }).success
    ).toBe(false);
    expect(
      StudentAuthInputSchema.safeParse({
        ...validStudentAuthInput,
        universityEmail: "x@tau.ac.il.evil.com",
      }).success
    ).toBe(false);
  });

  it("requires a non-empty student id", () => {
    expect(
      StudentAuthInputSchema.safeParse({ ...validStudentAuthInput, studentId: "   " }).success
    ).toBe(false);
  });

  it("rejects a password shorter than 8 characters", () => {
    expect(
      StudentAuthInputSchema.safeParse({ ...validStudentAuthInput, password: "short" }).success
    ).toBe(false);
  });
});

describe("isUniversityEmail (#275)", () => {
  it("accepts the allowed university domain and its subdomains, case-insensitively", () => {
    expect(isUniversityEmail("dana@tau.ac.il")).toBe(true);
    expect(isUniversityEmail("dana@mail.tau.ac.il")).toBe(true);
    expect(isUniversityEmail("Dana@MAIL.TAU.AC.IL")).toBe(true);
  });

  it("rejects other domains, look-alikes, and malformed input", () => {
    expect(isUniversityEmail("dana@gmail.com")).toBe(false);
    expect(isUniversityEmail("dana@eviltau.ac.il")).toBe(false);
    expect(isUniversityEmail("dana@tau.ac.il.evil.com")).toBe(false);
    expect(isUniversityEmail("no-at-sign")).toBe(false);
  });
});

describe("LoginInputSchema", () => {
  it("parses valid input without error", () => {
    expect(() =>
      LoginInputSchema.parse({ email: "alice@example.com", password: "sup3rsecret" })
    ).not.toThrow();
  });

  it("throws ZodError on invalid email", () => {
    expect(() => LoginInputSchema.parse({ email: "nope", password: "sup3rsecret" })).toThrow();
  });

  it("throws ZodError when the password is missing (#277)", () => {
    expect(() => LoginInputSchema.parse({ email: "alice@example.com" })).toThrow();
  });

  it("throws ZodError when the password is empty (#277)", () => {
    expect(() => LoginInputSchema.parse({ email: "alice@example.com", password: "" })).toThrow();
  });
});

describe("UserResponseSchema", () => {
  it("parses valid input without error", () => {
    expect(() => UserResponseSchema.parse(validUserResponse)).not.toThrow();
  });

  it("throws ZodError when id is not a uuid", () => {
    expect(() => UserResponseSchema.parse({ ...validUserResponse, id: "not-a-uuid" })).toThrow();
  });
});

describe("UserStateResponseSchema", () => {
  it("parses a valid state response", () => {
    expect(() =>
      UserStateResponseSchema.parse({ matchingState: "WAITING", hasProfile: true })
    ).not.toThrow();
  });

  it("throws ZodError on an unknown matchingState", () => {
    expect(() =>
      UserStateResponseSchema.parse({ matchingState: "DATING", hasProfile: true })
    ).toThrow();
  });

  it("throws ZodError when hasProfile is missing", () => {
    expect(() => UserStateResponseSchema.parse({ matchingState: "IDLE" })).toThrow();
  });

  it("parses a state response with matchedWith", () => {
    expect(() =>
      UserStateResponseSchema.parse({
        matchingState: "MATCHED",
        hasProfile: true,
        matchedWith: "123e4567-e89b-12d3-a456-426614174001",
      })
    ).not.toThrow();
  });

  it("throws ZodError when matchedWith is not a uuid", () => {
    expect(() =>
      UserStateResponseSchema.parse({
        matchingState: "MATCHED",
        hasProfile: true,
        matchedWith: "not-a-uuid",
      })
    ).toThrow();
  });
});

describe("PhotoUploadInputSchema", () => {
  it("parses a valid PNG data URL", () => {
    expect(() =>
      PhotoUploadInputSchema.parse({ photoUrl: "data:image/png;base64,aGVsbG8=" })
    ).not.toThrow();
  });

  it("parses valid JPEG and WEBP data URLs", () => {
    expect(() =>
      PhotoUploadInputSchema.parse({ photoUrl: "data:image/jpeg;base64,aGVsbG8=" })
    ).not.toThrow();
    expect(() =>
      PhotoUploadInputSchema.parse({ photoUrl: "data:image/webp;base64,aGVsbG8=" })
    ).not.toThrow();
  });

  it("throws ZodError on a non-image mime type", () => {
    expect(() =>
      PhotoUploadInputSchema.parse({ photoUrl: "data:application/pdf;base64,aGVsbG8=" })
    ).toThrow();
  });

  it("throws ZodError on a plain (non-data-URL) string", () => {
    expect(() => PhotoUploadInputSchema.parse({ photoUrl: "https://example.com/a.png" })).toThrow();
  });

  it("throws ZodError on a data URL over the size cap", () => {
    const oversized = `data:image/png;base64,${"a".repeat(7_000_001)}`;
    expect(() => PhotoUploadInputSchema.parse({ photoUrl: oversized })).toThrow();
  });
});
