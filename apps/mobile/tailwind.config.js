/** @type {import('tailwindcss').Config} */
// Mirrors the token names in apps/web/tailwind.config.js so a className written
// for web means the same thing here. The values themselves live in global.css
// as CSS variables, exactly as they do in apps/web/src/index.css.
//
// Web-only tokens are deliberately omitted: `popover` (no RN equivalent yet)
// and the accordion keyframes/animation (Radix-specific). Fonts are left to
// the platform default until a real screen needs Geist loaded via expo-font.
module.exports = {
  // darkMode mirrors apps/web. No .dark token block exists yet, so the dark:
  // variants that ship inside the react-native-reusables components are inert
  // until a dark palette is defined — they compile, they just never match.
  darkMode: "class",
  // Scan every source file rather than enumerating today's directories. An
  // unscanned path fails silently — Tailwind simply never generates those
  // classes, so className resolves to nothing and the screen renders
  // unstyled with no error from Metro or Tailwind. Slice 1 (#437) adds
  // screens/ and hooks/ (the latter already promised by components.json),
  // and neither should need a config change to get styling.
  content: ["./**/*.{ts,tsx}", "!./node_modules/**"],
  presets: [require("nativewind/preset")],
  theme: {
    extend: {
      colors: {
        border: "hsl(var(--border))",
        input: "hsl(var(--input))",
        ring: "hsl(var(--ring))",
        background: "hsl(var(--background))",
        foreground: "hsl(var(--foreground))",
        primary: {
          DEFAULT: "hsl(var(--primary))",
          foreground: "hsl(var(--primary-foreground))",
        },
        brand: {
          DEFAULT: "hsl(var(--brand))",
          foreground: "hsl(var(--brand-foreground))",
        },
        secondary: {
          DEFAULT: "hsl(var(--secondary))",
          foreground: "hsl(var(--secondary-foreground))",
        },
        destructive: {
          DEFAULT: "hsl(var(--destructive))",
          foreground: "hsl(var(--destructive-foreground))",
        },
        muted: {
          DEFAULT: "hsl(var(--muted))",
          foreground: "hsl(var(--muted-foreground))",
        },
        accent: {
          DEFAULT: "hsl(var(--accent))",
          foreground: "hsl(var(--accent-foreground))",
        },
        success: {
          DEFAULT: "hsl(var(--success))",
          foreground: "hsl(var(--success-foreground))",
        },
        card: {
          DEFAULT: "hsl(var(--card))",
          foreground: "hsl(var(--card-foreground))",
        },
      },
      borderRadius: {
        lg: "var(--radius)",
        md: "calc(var(--radius) - 2px)",
        sm: "calc(var(--radius) - 4px)",
      },
    },
  },
  plugins: [require("tailwindcss-animate")],
};
