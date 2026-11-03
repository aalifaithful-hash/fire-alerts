import Link from "next/link";

export default function NotFound() {
  return (
    <main className="page" style={{ maxWidth: 520, paddingTop: 60 }}>
      <h1>Not found</h1>
      <p style={{ margin: "10px 0" }}>That page or project does not exist (it may have been deleted).</p>
      <Link className="btn primary" href="/">
        All projects
      </Link>
    </main>
  );
}
