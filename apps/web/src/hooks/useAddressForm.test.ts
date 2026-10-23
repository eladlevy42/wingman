import { describe, expect, it } from "vitest";
import type { UserResponse } from "@wingman/shared";
import { addressFormFromStoredUser } from "./useAddressForm";

const USER: UserResponse = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Dana",
  email: "dana@example.com",
  gender: "female",
  createdAt: "2026-08-25T10:00:00.000Z",
};

describe("addressFormFromStoredUser (#566)", () => {
  it("returns feminine for a stored female user", () => {
    expect(addressFormFromStoredUser(JSON.stringify(USER))).toBe("feminine");
  });

  it("returns masculine for a stored male user", () => {
    expect(addressFormFromStoredUser(JSON.stringify({ ...USER, gender: "male" }))).toBe(
      "masculine"
    );
  });

  it('returns the neutral plural for gender "other"', () => {
    expect(addressFormFromStoredUser(JSON.stringify({ ...USER, gender: "other" }))).toBe("plural");
  });

  it("returns the neutral plural when nothing is stored", () => {
    expect(addressFormFromStoredUser(null)).toBe("plural");
  });

  it("returns the neutral plural for corrupt JSON", () => {
    expect(addressFormFromStoredUser("{not json")).toBe("plural");
  });

  it("returns the neutral plural for a value that no longer matches the schema", () => {
    expect(addressFormFromStoredUser(JSON.stringify({ id: "only-an-id" }))).toBe("plural");
  });
});
