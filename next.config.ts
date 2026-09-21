import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  transpilePackages: [
    "@myportal/myportal-api-client",
    "@myportal/api-contracts",
    "@ttoltori/api-client-core",
    "@ttoltori/database",
  ],
};

export default nextConfig;
