import type { NextConfig } from "next";
const config: NextConfig = {
  output: "export",
  allowedDevOrigins: ["127.0.0.1"],
  devIndicators: false,
  poweredByHeader: false,
  reactStrictMode: true,
  images: { unoptimized: true },
};
export default config;
