import { fileURLToPath } from "node:url";

/**
 * Kingdom Web Builders design tokens, ported from the kingdom-website repo's
 * tailwind.config.ts so Kingdom ID and kingdomwebbuilders.com stay one family.
 * Change them there first, then here.
 */
export const colors = {
  paper: "#FFFFFF",
  // Ink is a navy-indigo, and the grey ramp is tinted toward the brand blue.
  ink: {
    DEFAULT: "#0A0F24",
    800: "#121831",
    700: "#1C2340",
    600: "#3A4463",
    500: "#5C6685",
    400: "#8B94AE",
    300: "#B6BDCD",
    200: "#DDE2EC",
    100: "#EDF1F7",
    50: "#F6F8FC",
  },
  brand: {
    50: "#EAF1FF",
    100: "#D6E4FF",
    200: "#ADC7FF",
    300: "#7AA3FF",
    400: "#1079FF",
    500: "#0054EE", // primary electric blue
    600: "#0046C7",
    700: "#0039A3",
    800: "#082E7D",
    900: "#0B2559",
  },
  // Fills, glows and gradient tails only: too light to carry text.
  aqua: { 200: "#A5F3FC", 300: "#67E8F9", 400: "#22D3EE", 500: "#06B6D4", 600: "#0891B2" },
  // 600 is the only stop dark enough for text on paper.
  iris: { 200: "#DDD6FE", 300: "#B9A9FF", 400: "#9C87FF", 500: "#8B5CF6", 600: "#6E5BFF", 700: "#5433D6" },
} as const;

export const fonts = {
  sans: ["Inter", "system-ui", "sans-serif"],
  serif: ["Newsreader", "Georgia", "serif"],
  mono: ["JetBrains Mono", "ui-monospace", "monospace"],
} as const;

export const easing = { premium: "cubic-bezier(0.16, 1, 0.3, 1)" } as const;

export const productName = "Kingdom ID";
export const byline = "by Kingdom Web Builders";

export const assetsDir = fileURLToPath(new URL("../assets", import.meta.url));
export const tokensCssPath = fileURLToPath(new URL("../css/tokens.css", import.meta.url));
