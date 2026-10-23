// Token values as literal colour strings.
//
// Everything that can take a className must use one (`text-muted-foreground`,
// `bg-primary`, …). This file exists only for the handful of React Native APIs
// that take a colour *prop* instead — `placeholderTextColor`, and the `color`
// prop on lucide-react-native icons — where a Tailwind class has nothing to
// attach to.
//
// These mirror global.css and must be changed together with it. Anything not
// listed here should be styled with a class, not added here.
export const COLORS = {
  background: "hsl(0, 0%, 100%)",
  foreground: "hsl(0, 0%, 7%)",
  mutedForeground: "hsl(0, 0%, 40%)",
  primaryForeground: "hsl(0, 0%, 100%)",
  brand: "hsl(184, 100%, 38%)",
  brandForeground: "hsl(0, 0%, 100%)",
} as const;
