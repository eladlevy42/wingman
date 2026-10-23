import Svg, { ClipPath, Defs, G, Image, Line, Path, Rect } from "react-native-svg";

// The heart outline both photos are clipped into. Same path web's BlindDate
// uses, so the two clients draw an identical card.
const HEART =
  "M23.6,0c-3.4,0-6.3,2.7-7.6,5.6C14.7,2.7,11.8,0,8.4,0C3.8,0,0,3.8,0,8.4c0,9.4,9.5,11.9,16,21.2c6.1-9.3,16-12,16-21.2C32,3.8,28.2,0,23.6,0z";

// The placeholder behind the images: a flat wash, so a heart with no photos at
// all is still a heart rather than a hole in the card.
const EMPTY_FILL = "#eef0f2";

interface HeartPhotosProps {
  selfUrl: string;
  partnerUrl: string;
}

/**
 * You and your match, clipped into a single heart — the centrepiece of the date
 * card (#465).
 *
 * `react-native-svg` rather than an image-mask trick: the same primitives web
 * uses are already in the tree (lucide-react-native depends on them), so the
 * shape is one shared path string instead of two drawings that could drift.
 *
 * Degrades to whichever photo exists. The api returns an empty string rather
 * than failing when someone has no photo, and a half-empty heart is a worse
 * card than a single filled one.
 */
export default function HeartPhotos({ selfUrl, partnerUrl }: HeartPhotosProps) {
  const both = selfUrl !== "" && partnerUrl !== "";
  const only = partnerUrl !== "" ? partnerUrl : selfUrl;

  return (
    <Svg
      viewBox="0 0 32 29.6"
      width={144}
      height={144}
      accessibilityRole="image"
      accessibilityLabel="You and your match"
    >
      <Defs>
        <ClipPath id="date-heart">
          <Path d={HEART} />
        </ClipPath>
      </Defs>
      <G clipPath="url(#date-heart)">
        <Rect x="0" y="0" width="32" height="29.6" fill={EMPTY_FILL} />
        {both ? (
          <>
            <Image
              href={{ uri: selfUrl }}
              x="0"
              y="0"
              width="16"
              height="29.6"
              preserveAspectRatio="xMidYMid slice"
            />
            <Image
              href={{ uri: partnerUrl }}
              x="16"
              y="0"
              width="16"
              height="29.6"
              preserveAspectRatio="xMidYMid slice"
            />
            {/* The seam between the two halves, so the pairing reads as two
                people rather than one cropped photo. */}
            <Line x1="16" y1="0" x2="16" y2="29.6" stroke="white" strokeWidth="0.6" />
          </>
        ) : (
          only !== "" && (
            <Image
              href={{ uri: only }}
              x="0"
              y="0"
              width="32"
              height="29.6"
              preserveAspectRatio="xMidYMid slice"
            />
          )
        )}
      </G>
      <Path d={HEART} fill="none" stroke="white" strokeWidth="0.75" />
    </Svg>
  );
}
