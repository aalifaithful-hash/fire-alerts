import type { NextConfig } from "next";

const nextConfig: NextConfig = {
  // Native / heavy server-only packages stay out of the bundle.
  serverExternalPackages: ["better-sqlite3", "unpdf", "pdf-lib", "docx"],
  poweredByHeader: false,
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [
          { key: "X-Content-Type-Options", value: "nosniff" },
          { key: "Referrer-Policy", value: "same-origin" },
          { key: "X-Frame-Options", value: "SAMEORIGIN" },
        ],
      },
    ];
  },
};

export default nextConfig;
