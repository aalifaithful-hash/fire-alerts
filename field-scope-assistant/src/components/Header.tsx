"use client";
import Link from "next/link";

export default function Header({ crumb, right }: { crumb?: string; right?: React.ReactNode }) {
  return (
    <header className="top">
      <Link href="/" className="brand" aria-label="All projects">
        F<b>S</b>A
      </Link>
      <div className="grow crumb">{crumb ?? "Field Scope Assistant"}</div>
      {right}
      <Link href="/settings" className="btn ghost sm" aria-label="Settings">
        ⚙
      </Link>
    </header>
  );
}
