import type { NextConfig } from "next";
const config: NextConfig = {
  output: "standalone",
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
  serverExternalPackages: ["spotify-url-info", "undici"],
  outputFileTracingIncludes: { "/api/*": [".server/**/*"] },
};
export default config;
