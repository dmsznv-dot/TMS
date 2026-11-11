import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page reads the session and live data, so the app renders on
  // request; the Cache Components model is not used.
  output: "standalone",
  serverExternalPackages: ["pg", "exceljs"],
  turbopack: {
    rules: {
      "*.css": {
        loaders: ["@tailwindcss/turbopack"],
        as: "*.css",
      },
    },
  },
};

export default nextConfig;
