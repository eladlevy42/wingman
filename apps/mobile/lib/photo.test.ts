import { afterEach, describe, expect, it, vi } from "vitest";
import { buildPhotoDataUrl, photoValidationMessage, uploadPhoto } from "./photo";
import { ApiError, NetworkError } from "./api";

const USER_ID = "3f2504e0-4f89-41d3-9a0c-0305e82c3301";
// A 1x1 transparent PNG — the same fixture the web E2E spec uses.
const TINY_PNG =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==";

function mockFetch(response: Partial<Response> & { json?: () => Promise<unknown> }) {
  const fetchMock = vi.fn().mockResolvedValue({
    ok: true,
    status: 204,
    json: async () => {
      throw new Error("no body");
    },
    ...response,
  });
  vi.stubGlobal("fetch", fetchMock);
  return fetchMock;
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("photoValidationMessage", () => {
  it("accepts a well-formed data URL", () => {
    expect(photoValidationMessage(`data:image/png;base64,${TINY_PNG}`)).toBeNull();
  });

  it("rejects a URL that is not a data URL at all", () => {
    expect(photoValidationMessage("https://example.com/me.jpg")).toMatch(/JPG, PNG, or WEBP/);
  });

  it("rejects an image type the api does not store", () => {
    expect(photoValidationMessage(`data:image/gif;base64,${TINY_PNG}`)).toMatch(
      /JPG, PNG, or WEBP/
    );
  });

  it("surfaces the shared schema's own size message rather than a second limit", () => {
    // Over PhotoUploadInputSchema's 7,000,000-character cap. The message must be
    // the schema's, so this test fails if the two ever drift apart.
    const huge = `data:image/jpeg;base64,${"A".repeat(7_000_001)}`;
    expect(photoValidationMessage(huge)).toMatch(/too large/i);
  });
});

describe("buildPhotoDataUrl", () => {
  it("builds the data URL the api stores", () => {
    expect(buildPhotoDataUrl({ base64: TINY_PNG })).toEqual({
      ok: true,
      dataUrl: `data:image/jpeg;base64,${TINY_PNG}`,
    });
  });

  it("always labels the payload JPEG, whatever the source file was", () => {
    // expo-image-picker hands back the *JPEG* re-encode of whatever was picked,
    // so the source type is not what is in `base64`. Labelling by it would write
    // JPEG bytes under `data:image/png` for a PNG pick, or `data:image/heic` for
    // the ordinary iOS library pick — which the api's regex rejects outright.
    const result = buildPhotoDataUrl({ base64: TINY_PNG });
    expect(result).toEqual({ ok: true, dataUrl: `data:image/jpeg;base64,${TINY_PNG}` });
    expect(photoValidationMessage((result as { dataUrl: string }).dataUrl)).toBeNull();
  });

  it("reports a readable failure when the picker returned no base64", () => {
    // Reachable when the OS hands back an asset it then cannot read.
    expect(buildPhotoDataUrl({ base64: null })).toEqual({
      ok: false,
      message: "Could not read that photo — please try again.",
    });
    expect(buildPhotoDataUrl({ base64: "   " }).ok).toBe(false);
  });

  it("rejects an oversized photo before it is ever sent", () => {
    const result = buildPhotoDataUrl({ base64: "A".repeat(7_000_001) });
    expect(result.ok).toBe(false);
    // A round trip would tell the user the same thing several megabytes later.
    expect(result.ok === false && result.message).toMatch(/too large/i);
  });
});

describe("uploadPhoto", () => {
  it("posts the data URL to the user's photo endpoint", async () => {
    const fetchMock = mockFetch({});
    const dataUrl = `data:image/png;base64,${TINY_PNG}`;

    await uploadPhoto(USER_ID, dataUrl);

    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe(`http://192.168.1.42:3001/api/users/${USER_ID}/photo`);
    expect(init).toMatchObject({
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ photoUrl: dataUrl }),
    });
  });

  it("resolves on 204 rather than choking on the empty body", async () => {
    // The endpoint answers 204 No Content. Reading it as JSON — which apiRequest
    // always does — would make a successful upload look like contract drift.
    mockFetch({ ok: true, status: 204 });
    await expect(
      uploadPhoto(USER_ID, `data:image/png;base64,${TINY_PNG}`)
    ).resolves.toBeUndefined();
  });

  it("surfaces the api's own message when the upload is refused", async () => {
    mockFetch({ ok: false, status: 404, json: async () => ({ error: "User not found" }) });

    const error = await uploadPhoto(USER_ID, "data:image/png;base64,x").catch((e) => e);
    expect(error).toBeInstanceOf(ApiError);
    expect(error.message).toBe("User not found");
  });

  it("falls back to photo-specific copy when the api gives no usable message", async () => {
    // A 400 answers with a Zod issue array, which has no string to render.
    mockFetch({ ok: false, status: 400, json: async () => ({ error: [{ message: "Invalid" }] }) });

    const error = await uploadPhoto(USER_ID, "data:image/png;base64,x").catch((e) => e);
    expect(error.message).toBe("Could not upload your photo — please try again.");
  });

  it("reports an unreachable api as a network error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("Network request failed")));

    const error = await uploadPhoto(USER_ID, "data:image/png;base64,x").catch((e) => e);
    expect(error).toBeInstanceOf(NetworkError);
  });
});
