import type { Config } from "tailwindcss";

export default {
  content: ["./index.html", "./src/**/*.{ts,tsx}"],
  theme: {
    extend: {
      colors: {
        bg:              "#09090B",
        surface:         "#18181B",
        "surface-el":    "#27272A",
        border:          "#3F3F46",
        primary:         "#FAFAFA",
        secondary:       "#A1A1AA",
        muted:           "#71717A",
        accent:          "#E63946",
        success:         "#00D4AA",
        warning:         "#F59E0B",
        info:            "#3B82F6",
      },
      fontFamily: {
        sans:  ["Inter", "sans-serif"],
        head:  ["Outfit", "sans-serif"],
        mono:  ["JetBrains Mono", "monospace"],
      },
      keyframes: {
        shimmer: {
          "0%":   { backgroundPosition: "-200% 0" },
          "100%": { backgroundPosition:  "200% 0" },
        },
        pulse2: {
          "0%, 100%": { opacity: "1" },
          "50%":      { opacity: "0.4" },
        },
      },
      animation: {
        shimmer: "shimmer 2s linear infinite",
        pulse2:  "pulse2 2s ease-in-out infinite",
      },
    },
  },
  plugins: [],
} satisfies Config;
