import { render, waitFor } from "@testing-library/react-native";
import { Text } from "react-native";
import type { UserResponse } from "@wingman/shared";

const mockLoadUser = jest.fn<Promise<UserResponse | null>, []>();
jest.mock("~/lib/session", () => ({ loadUser: () => mockLoadUser() }));

import { useAddressForm } from "./useAddressForm";

const BASE_USER: UserResponse = {
  id: "3f2504e0-4f89-41d3-9a0c-0305e82c3301",
  name: "Dana",
  email: "dana@example.com",
  gender: "female",
  createdAt: "2026-08-25T10:00:00.000Z",
};

function Harness() {
  const address = useAddressForm();
  return <Text>{address}</Text>;
}

beforeEach(() => {
  jest.clearAllMocks();
});

describe("useAddressForm (#566)", () => {
  it("starts at the neutral plural before storage has been read", () => {
    mockLoadUser.mockReturnValue(new Promise(() => {})); // never resolves
    const { getByText } = render(<Harness />);
    expect(getByText("plural")).toBeOnTheScreen();
  });

  it("resolves feminine for a stored female user", async () => {
    mockLoadUser.mockResolvedValue({ ...BASE_USER, gender: "female" });
    const { getByText } = render(<Harness />);
    await waitFor(() => expect(getByText("feminine")).toBeOnTheScreen());
  });

  it("resolves masculine for a stored male user", async () => {
    mockLoadUser.mockResolvedValue({ ...BASE_USER, gender: "male" });
    const { getByText } = render(<Harness />);
    await waitFor(() => expect(getByText("masculine")).toBeOnTheScreen());
  });

  it('keeps the neutral plural for gender "other"', async () => {
    mockLoadUser.mockResolvedValue({ ...BASE_USER, gender: "other" });
    const { getByText } = render(<Harness />);
    await waitFor(() => expect(getByText("plural")).toBeOnTheScreen());
  });

  it("keeps the neutral plural when no user is stored", async () => {
    mockLoadUser.mockResolvedValue(null);
    const { getByText } = render(<Harness />);
    // Already the initial value, so this only proves the resolved `null` didn't
    // move it somewhere else once the effect settles.
    await waitFor(() => expect(mockLoadUser).toHaveBeenCalled());
    expect(getByText("plural")).toBeOnTheScreen();
  });
});
