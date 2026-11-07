"use client";
import ErrorScreen from "@/components/ErrorScreen";
import "./globals.css";

// Replaces the root layout when the layout itself fails, so it renders <html>/<body>.
export default function GlobalError({ error }: { error: Error & { digest?: string } }) {
  return (
    <html lang="en">
      <body>
        <ErrorScreen error={error} />
      </body>
    </html>
  );
}
