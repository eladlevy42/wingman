import { renderHook, waitFor } from "@testing-library/react-native";
import { usePitchSession } from "~/hooks/usePitchSession";
import { apiRequest } from "~/lib/api";

jest.mock("~/lib/api", () => ({ apiRequest: jest.fn() }));

const mockApiRequest = apiRequest as jest.MockedFunction<typeof apiRequest>;

beforeEach(() => {
  mockApiRequest.mockReset();
});

describe("usePitchSession", () => {
  it("loads the reveal for the signed-in user", async () => {
    mockApiRequest.mockResolvedValue({
      photoUrl: "https://example.test/suzy.jpg",
      partnerName: "Suzy",
      education: "Design, Third year",
    });

    const { result } = renderHook(() => usePitchSession("u-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(mockApiRequest).toHaveBeenCalledWith(
      "/api/users/u-1/match-photo",
      expect.objectContaining({ schema: expect.anything() })
    );
    expect(result.current.partnerName).toBe("Suzy");
    expect(result.current.education).toBe("Design, Third year");
  });

  // Held for #464's decision screen rather than rendered here (ADR-0022), but
  // loaded now so that screen does not pay for a second round-trip.
  it("holds the match-gated photo without the card needing it", async () => {
    mockApiRequest.mockResolvedValue({
      photoUrl: "https://example.test/suzy.jpg",
      partnerName: "Suzy",
      education: null,
    });

    const { result } = renderHook(() => usePitchSession("u-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.matchPhotoUrl).toBe("https://example.test/suzy.jpg");
  });

  // The behaviour the whole hook exists to protect: a failed reveal must still
  // finish loading, so the screen shows the degraded card instead of stranding
  // a matched user behind a spinner or a retry button.
  it("finishes loading with nulls when the reveal cannot be fetched", async () => {
    mockApiRequest.mockRejectedValue(new Error("offline"));

    const { result } = renderHook(() => usePitchSession("u-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.partnerName).toBeNull();
    expect(result.current.education).toBeNull();
    expect(result.current.matchPhotoUrl).toBeNull();
  });

  it("carries a null-everything response through without treating it as a failure", async () => {
    mockApiRequest.mockResolvedValue({ photoUrl: null, partnerName: null, education: null });

    const { result } = renderHook(() => usePitchSession("u-1"));
    await waitFor(() => expect(result.current.loaded).toBe(true));

    expect(result.current.partnerName).toBeNull();
  });

  // The guard has not cleared yet; firing the request anyway would ask the api
  // about a user we do not have.
  it("does not fetch before the guard supplies a user id", () => {
    renderHook(() => usePitchSession(null));
    expect(mockApiRequest).not.toHaveBeenCalled();
  });
});
