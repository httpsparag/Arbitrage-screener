import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  cacheComponents: true,
  partialPrefetching: true,
  // The shared calculation engine is TypeScript source in the monorepo.
  transpilePackages: ["@arb/core"],
  // Let a phone on the same home network open the dev server by the PC's IP address.
  // 127.0.0.1 too: without it the dev server blocks the app's scripts there and the page stays on "Loading…".
  allowedDevOrigins: ["127.0.0.1", "192.168.*.*", "10.*.*.*"],
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
