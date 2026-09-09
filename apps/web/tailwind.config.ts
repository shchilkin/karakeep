import type { Config } from "tailwindcss";

import web from "@karakeep/tailwind-config/web";

const config = {
  content: [
    ...web.content,
    "../../packages/shared-react/components/**/*.{ts,tsx}",
    "../../node_modules/streamdown/dist/*.js",
    "../../node_modules/@streamdown/cjk/dist/*.js",
    "../../node_modules/@streamdown/code/dist/*.js",
    "../../node_modules/@streamdown/math/dist/*.js",
    "../../node_modules/@streamdown/mermaid/dist/*.js",
  ],
  presets: [web],
  theme: {
    extend: {
      keyframes: {
        "media-shimmer": {
          from: { transform: "translateX(-100%)" },
          to: { transform: "translateX(100%)" },
        },
      },
      animation: {
        "media-shimmer": "media-shimmer 1.3s ease infinite",
      },
    },
  },
} satisfies Config;

export default config;
