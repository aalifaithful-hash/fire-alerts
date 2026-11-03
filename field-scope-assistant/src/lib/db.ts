import { mkdirSync } from "node:fs";
import path from "node:path";
import { neon } from "@neondatabase/serverless";

const connectionString =
  process.env.DATABASE_URL ||
  process.env.POSTGRES_URL ||
  process.env.DATABASE_URL_UNPOOLED ||
  process.env.POSTGRES_URL_NON_POOLING;
if (!connectionString) {
  throw new Error(
    "Database connection string is not set. Expected DATABASE_URL (or POSTGRES_URL) from the Neon/Vercel Postgres integration."
  );
}

let neonClient: ReturnType<typeof neon> | null = null;
function getTag() {
  if (!neonClient) neonClient = neon(connectionString as string);
  return neonClient;
}

export const DATA_DIR =
  process.env.DATA_DIR || path.join(process.cwd(), ".data");
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");
try {
  mkdirSync(UPLOAD_DIR, { recursive: true });
} catch {
  // ignore — serverless filesystems may be read-only; uploads use Blob
}

const SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS projects (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    address TEXT NOT NULL DEFAULT '',
    notes TEXT NOT NULL DEFAULT '',
    data TEXT NOT NULL DEFAULT '{}',
    is_demo INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS locations (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    floor TEXT,
    unit TEXT,
    room TEXT NOT NULL,
    sort INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_locations_project ON locations(project_id)`,
  `CREATE TABLE IF NOT EXISTS documents (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    size INTEGER NOT NULL DEFAULT 0,
    page_count INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'uploaded',
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id)`,
  `CREATE TABLE IF NOT EXISTS doc_pages (
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    page INTEGER NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    char_count INTEGER NOT NULL DEFAULT 0,
    PRIMARY KEY (document_id, page)
  )`,
  `CREATE TABLE IF NOT EXISTS batches (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
    start_page INTEGER NOT NULL,
    end_page INTEGER NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    attempts INTEGER NOT NULL DEFAULT 0,
    error TEXT,
    claimed_at TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_batches_doc ON batches(document_id)`,
  `CREATE TABLE IF NOT EXISTS evidence (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    batch_id TEXT REFERENCES batches(id) ON DELETE SET NULL,
    document_id TEXT REFERENCES documents(id) ON DELETE SET NULL,
    page INTEGER,
    kind TEXT NOT NULL DEFAULT 'text',
    text TEXT NOT NULL DEFAULT '',
    location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
    location_text TEXT,
    location_confidence TEXT,
    location_basis TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id)`,
  `CREATE TABLE IF NOT EXISTS visits (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    type TEXT NOT NULL,
    visit_date TEXT NOT NULL,
    appointment_time TEXT,
    arrival_time TEXT,
    departure_time TEXT,
    access_outcome TEXT,
    field_notes TEXT NOT NULL DEFAULT '',
    facts TEXT NOT NULL DEFAULT '{}',
    doc TEXT,
    manual_text TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_visits_project ON visits(project_id)`,
  `CREATE TABLE IF NOT EXISTS drafts (
    id TEXT PRIMARY KEY,
    visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    version INTEGER NOT NULL,
    trigger TEXT NOT NULL,
    input TEXT,
    changes TEXT NOT NULL DEFAULT '[]',
    facts TEXT NOT NULL DEFAULT '{}',
    doc TEXT,
    manual_text TEXT,
    text TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_drafts_visit ON drafts(visit_id)`,
  `CREATE TABLE IF NOT EXISTS checklist_templates (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    visit_types TEXT NOT NULL DEFAULT '[]',
    items TEXT NOT NULL DEFAULT '[]',
    is_starter INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS manuals (
    id TEXT PRIMARY KEY,
    name TEXT NOT NULL,
    filename TEXT NOT NULL,
    stored_path TEXT NOT NULL,
    text TEXT NOT NULL DEFAULT '',
    rules TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'uploaded',
    error TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS manual_conflicts (
    id TEXT PRIMARY KEY,
    description TEXT NOT NULL,
    manual_ids TEXT NOT NULL DEFAULT '[]',
    status TEXT NOT NULL DEFAULT 'open',
    created_at TEXT NOT NULL
  )`,
    `alter table visits add column if not exists text text not null default ''`,
    `alter table batches alter column created_at set default ''`,
    `alter table checklist_templates alter column created_at set default ''`,
    `alter table locations alter column created_at set default ''`,
    `alter table evidence alter column created_at set default ''`,
];

let schemaPromise: Promise<void> | null = null;
/** Create tables/indexes if missing. Runs once per serverless instance. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const t = getTag();
      for (const stmt of SCHEMA) await t([stmt] as unknown as TemplateStringsArray);
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

/** Run a parameterized query (template-tag style). Ensures schema first. */
export async function query<T = Record<string, unknown>>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T[]> {
  await ensureSchema();
  return (await getTag()(strings, ...values)) as T[];
}

export async function queryOne<T>(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<T | undefined> {
  const rows = await query<T>(strings, ...values);
  return rows[0];
}

/**
 * Raw template tag (no schema check). Use only for building tx() queries —
 * tx() ensures the schema before running the transaction.
 */
export function tag(
  strings: TemplateStringsArray,
  ...values: unknown[]
): Promise<Record<string, unknown>[]> {
  return getTag()(strings, ...values) as Promise<Record<string, unknown>[]>;
}

/** Run several pending template-tag queries in a single transaction. */
export async function tx(queries: unknown[]): Promise<void> {
  await ensureSchema();
  const t = getTag() as unknown as {
    transaction: (qs: unknown[]) => Promise<unknown>;
  };
  await t.transaction(queries);
}
