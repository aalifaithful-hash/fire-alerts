import type { Metadata, Viewport } from "next";
import { cookies } from "next/headers";
import { COOKIE, isAuthedCookie } from "@/lib/auth";
import Login from "@/components/Login";
import "./globals.css";

export const metadata: Metadata = {
  title: "Field Scope Assistant",
  description: "CompanyCam reports and field notes to room-by-room restoration scopes.",
  robots: { index: false, follow: false },
};
export const viewport: Viewport = { width: "device-width", initialScale: 1, themeColor: "#0f141c" };
export const dynamic = "force-dynamic";

export default async function RootLayout({ children }: { children: React.ReactNode }) {
  const authed = isAuthedCookie((await cookies()).get(COOKIE)?.value);
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        {/* eslint-disable-next-line @next/next/no-page-custom-font */}
        <link
          href="https://fonts.googleapis.com/css2?family=Barlow+Condensed:wght@500;600;700&family=IBM+Plex+Mono:wght@400;500&family=Inter:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body>{authed ? children : <Login />}</body>
    </html>
  );
}
