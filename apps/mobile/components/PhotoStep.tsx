import { useCallback, useState } from "react";
import { Image, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import * as ImagePicker from "expo-image-picker";
import { Camera, ImageIcon } from "lucide-react-native";
import { Button } from "~/components/ui/button";
import { Text } from "~/components/ui/text";
import { COLORS } from "~/lib/colors";
import { isServerAuthoredError } from "~/lib/api";
import { buildPhotoDataUrl, uploadPhoto } from "~/lib/photo";

// Passed to both pickers. `base64` is the whole point — the api stores the photo
// as a data URL on User.photoUrl (docs/adr/0016), so we never touch the file
// itself.
//
// `allowsEditing` + a 1:1 `aspect` crop the photo to the shape it is finally
// shown in (a circle at the Reveal), so the user frames it rather than
// discovering later that it was cropped for them. Together with `quality` that
// crop is also what keeps the payload well inside PhotoUploadInputSchema's
// ~5MB cap: both force a JPEG re-encode of a square region, so even a 100MP
// sensor lands far below it. 0.6 rather than 0.9 because the photo is only ever
// displayed small, and being refused at the end of onboarding — where the step
// cannot be skipped — is a far worse outcome than a slightly softer image.
const PICKER_OPTIONS: ImagePicker.ImagePickerOptions = {
  mediaTypes: ["images"],
  allowsEditing: true,
  aspect: [1, 1],
  quality: 0.6,
  base64: true,
};

const CAMERA_DENIED_MESSAGE =
  "Wingman needs camera access to take your photo. You can enable it in Settings, or choose one from your library instead.";
const PICKER_FAILED_MESSAGE = "Could not open that — please try again.";

interface PhotoStepProps {
  userId: string;
  // Fires once, after the photo is persisted. The screen owns what happens next.
  onUploaded: () => void;
}

/**
 * The scripted match-photo request that follows Phase 2 (#200, docs/adr/0016).
 *
 * Renders below the chat, the same way the web client's file-input row does —
 * the difference is that a phone can use the real camera, which is the native
 * capability this slice exists to prove. Both sources produce the same base64
 * data URL, so everything downstream of `buildPhotoDataUrl` is shared.
 *
 * The photo is required: there is no skip. That gate is client-side only, and
 * deliberately so — the backend already started matching the moment Phase 2
 * persisted, and the photo is not read until the Reveal, many steps later.
 */
export default function PhotoStep({ userId, onUploaded }: PhotoStepProps) {
  const [dataUrl, setDataUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState(false);
  // The screen's SafeAreaView deliberately excludes the bottom edge (the chat
  // composer manages its own), so this row has to clear the home indicator
  // itself or the Upload button sits under it.
  const insets = useSafeAreaInsets();

  // One handler for both sources: request the right permission, launch the right
  // picker, then run the identical result handling. Splitting them would mean
  // two copies of the cancel/validate/set path.
  const pick = useCallback(async (source: "camera" | "library") => {
    setError(null);

    // Only the camera needs an up-front grant. The library deliberately does
    // not ask: launchImageLibraryAsync goes through the OS photo picker, which
    // hands back just the chosen image and needs no permission at all. Gating
    // on requestMediaLibraryPermissionsAsync would send an Android 14 user who
    // granted partial ("Select photos") access to Settings for a flow that
    // would have worked — `granted` is false for partial access.
    if (source === "camera") {
      const permission = await ImagePicker.requestCameraPermissionsAsync();
      if (!permission.granted) {
        setError(CAMERA_DENIED_MESSAGE);
        return;
      }
    }

    let result: ImagePicker.ImagePickerResult;
    try {
      result =
        source === "camera"
          ? await ImagePicker.launchCameraAsync(PICKER_OPTIONS)
          : await ImagePicker.launchImageLibraryAsync(PICKER_OPTIONS);
    } catch {
      setError(PICKER_FAILED_MESSAGE);
      return;
    }

    // Backing out of the camera is not an error — say nothing and leave whatever
    // was already picked in place.
    if (result.canceled) return;

    const asset = result.assets[0];
    if (!asset) {
      setError(PICKER_FAILED_MESSAGE);
      return;
    }

    const built = buildPhotoDataUrl(asset);
    if (!built.ok) {
      setError(built.message);
      return;
    }
    setDataUrl(built.dataUrl);
  }, []);

  const upload = useCallback(async () => {
    if (!dataUrl || uploading) return;
    setUploading(true);
    setError(null);
    try {
      await uploadPhoto(userId, dataUrl);
      setUploaded(true);
      // Settled before the hand-off, not after: onUploaded() schedules the
      // navigation away from this screen, so anything set afterwards is set on
      // a component that is on its way out. Harmless under React 18, but the
      // ordering is what makes it harmless rather than anything here.
      setUploading(false);
      onUploaded();
    } catch (err) {
      // Prefer the server's or the transport's own words — "Could not reach the
      // server at …" tells someone testing over the LAN exactly what to fix.
      setError(isServerAuthoredError(err) ? err.message : PICKER_FAILED_MESSAGE);
      setUploading(false);
    }
  }, [dataUrl, uploading, userId, onUploaded]);

  if (uploaded) {
    return (
      <View
        className="border-border items-center border-t px-4 pt-4"
        style={{ paddingBottom: insets.bottom + 16 }}
      >
        <Text className="text-foreground text-sm" testID="photo-saved">
          Photo saved!
        </Text>
      </View>
    );
  }

  return (
    <View
      className="border-border items-center gap-3 border-t px-4 pt-4"
      style={{ paddingBottom: insets.bottom + 16 }}
    >
      {dataUrl && (
        <Image
          source={{ uri: dataUrl }}
          accessibilityLabel="Your selected photo"
          className="border-border h-20 w-20 rounded-full border"
          resizeMode="cover"
        />
      )}
      <View className="flex-row gap-3">
        <Button
          variant="outline"
          disabled={uploading}
          onPress={() => void pick("camera")}
          accessibilityLabel="Take a photo"
        >
          <Camera size={16} color={COLORS.foreground} />
          <Text className="text-sm font-medium">{dataUrl ? "Retake" : "Take photo"}</Text>
        </Button>
        <Button
          variant="outline"
          disabled={uploading}
          onPress={() => void pick("library")}
          testID="photo-choose"
          accessibilityLabel="Choose a photo from your library"
        >
          <ImageIcon size={16} color={COLORS.foreground} />
          <Text className="text-sm font-medium">Choose photo</Text>
        </Button>
      </View>
      {dataUrl && (
        <Button
          className="w-full"
          disabled={uploading}
          onPress={() => void upload()}
          testID="photo-upload"
        >
          <Text className="text-sm font-semibold">{uploading ? "Uploading…" : "Upload"}</Text>
        </Button>
      )}
      {error && <Text className="text-destructive text-center text-sm">{error}</Text>}
    </View>
  );
}
