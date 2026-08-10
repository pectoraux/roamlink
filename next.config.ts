import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Vercel builds Next.js natively; standalone output is for Docker/custom servers.
  // Removed `output: "standalone"` for Vercel compatibility.
  typescript: {
    ignoreBuildErrors: true,
  },
  eslint: {
    ignoreDuringBuilds: true,
  },
  reactStrictMode: false,
  allowedDevOrigins: ["*.space-z.ai", "*.chatglm.cn", "*.z.ai"],
};

export default nextConfig;
