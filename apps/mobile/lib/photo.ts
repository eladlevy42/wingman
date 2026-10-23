import { PhotoUploadInputSchema } from "@wingman/shared";
import { apiRequestNoContent } from "./api";

// Every payload is labelled JPEG, whatever the source file was.
//
// Not a shortcut — it is what the bytes actually are. expo-image-picker
// documents its `base64` field as "a Base64-encoded string of the selected
// image's JPEG data", and PICKER_OPTIONS passes both `quality` and
// `allowsEditing`, either of which forces that re-encode. `asset.mimeType`
// describes the *source* asset, so trusting it would mean writing
// `data:image/png;base64,<JPEG bytes>` for a PNG pick (a mislabel that only
// survives because readers sniff content) or `data:image/heic;…` for the
// ordinary iOS library pick, which the api's format regex rejects outright.
const PHOTO_MIME_TYPE = "image/jpeg";

const UNREADABLE_PHOTO_MESSAGE = "Could not read that photo — please try again.";

// The subset of expo-image-picker's ImagePickerAsset this module needs.
// Structural on purpose: expo-image-picker is a native module that cannot load
// under Vitest, so depending on its type here (even as a type-only import) would
// tie this file — the one piece of the photo step worth testing off-device — to
// a package Node cannot resolve.
export interface PickedPhoto {
  base64?: string | null;
}

// Result of turning a picked asset into something uploadable. A discriminated
// union rather than a throw: every failure here is a message for the user, not
// an exception, and the screen renders one or the other.
export type PhotoDataUrlResult = { ok: true; dataUrl: string } | { ok: false; message: string };

// Validates a data URL against the shared schema, returning the message to show
// or null when it is fine. The schema owns both rules (format and size) and its
// messages are already user-facing — "Photo is too large — please use one under
// 5MB" — so re-stating either limit here would be a second source of truth that
// could drift from the one the api enforces.
export function photoValidationMessage(dataUrl: string): string | null {
  const parsed = PhotoUploadInputSchema.safeParse({ photoUrl: dataUrl });
  if (parsed.success) return null;
  return parsed.error.errors[0]?.message ?? UNREADABLE_PHOTO_MESSAGE;
}

// Turns a picked asset into the base64 data URL the api stores on User.photoUrl.
// Validation happens here rather than at upload time so an oversized photo is
// caught before it is sent — the round trip would only tell the user the same
// thing several megabytes later.
export function buildPhotoDataUrl(asset: PickedPhoto): PhotoDataUrlResult {
  const base64 = asset.base64?.trim();
  // Only when the picker was asked for base64 and could not produce it — a
  // corrupt file, or an asset the OS would not hand over.
  if (!base64) return { ok: false, message: UNREADABLE_PHOTO_MESSAGE };

  const dataUrl = `data:${PHOTO_MIME_TYPE};base64,${base64}`;
  const message = photoValidationMessage(dataUrl);
  return message === null ? { ok: true, dataUrl } : { ok: false, message };
}

// Persists the Match Photo on the user (#200, docs/adr/0016). The endpoint
// answers 204, so there is no response body to parse.
export async function uploadPhoto(userId: string, dataUrl: string): Promise<void> {
  await apiRequestNoContent(`/api/users/${userId}/photo`, {
    method: "POST",
    body: { photoUrl: dataUrl },
    fallbackErrorMessage: "Could not upload your photo — please try again.",
  });
}
