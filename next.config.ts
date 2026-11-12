import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Every page reads the session and live data, so the app renders on
  // request; the Cache Components model is not used.
  output: "standalone",
  serverExternalPackages: ["pg", "exceljs"],
  experimental: {
    // Import files are uploaded through server actions.
    serverActions: { bodySizeLimit: "20mb" },
  },
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
