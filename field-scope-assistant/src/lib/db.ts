import { neon } from "@neondatabase/serverless";

/**
 * Postgres access.
 *
 * Production: Neon serverless driver over HTTP (DATABASE_URL / POSTGRES_URL from
 * the Vercel–Neon integration).
 * Local tests/dev: DATABASE_URL=pglite://memory runs real Postgres in-process
 * (PGlite), so tests never touch the hosted database.
 *
 * The connection is resolved lazily: a missing connection string becomes a
 * DatabaseNotConfiguredError on first use (HTTP 503 with a clear message)
 * instead of crashing every route at import time.
 */

export class DatabaseNotConfiguredError extends Error {
  constructor() {
    super("Database is not configured on this deployment (DATABASE_URL / POSTGRES_URL is missing).");
  }
}

export function connectionString(): string | undefined {
  return (
    process.env.DATABASE_URL ||
    process.env.POSTGRES_URL ||
    process.env.DATABASE_URL_UNPOOLED ||
    process.env.POSTGRES_URL_NON_POOLING
  );
}

/** A compiled, not-yet-executed query (used for transactions). */
export interface SqlQuery {
  text: string;
  params: unknown[];
}

interface Driver {
  run(q: SqlQuery): Promise<Record<string, unknown>[]>;
  transaction(qs: SqlQuery[]): Promise<void>;
}

function compile(strings: readonly string[], values: unknown[]): SqlQuery {
  let text = strings[0];
  for (let i = 1; i < strings.length; i++) text += `$${i}` + strings[i];
  return { text, params: values };
}

function neonDriver(conn: string): Driver {
  const sql = neon(conn);
  return {
    run: async (q) => (await sql(q.text, q.params)) as Record<string, unknown>[],
    transaction: async (qs) => {
      await sql.transaction(qs.map((q) => sql(q.text, q.params)));
    },
  };
}

async function pgliteDriver(): Promise<Driver> {
  // Dev/test only. The variable specifier keeps it out of the production bundle.
  const mod = "@electric-sql/pglite";
  const { PGlite } = (await import(/* webpackIgnore: true */ /* turbopackIgnore: true */ mod)) as typeof import("@electric-sql/pglite");
  const db = new PGlite();
  // Single connection: serialize so transactions never interleave.
  let chain: Promise<unknown> = Promise.resolve();
  const serial = <T,>(fn: () => Promise<T>): Promise<T> => {
    const p = chain.then(fn, fn);
    chain = p.catch(() => undefined);
    return p;
  };
  return {
    run: (q) => serial(async () => (await db.query(q.text, q.params as unknown[])).rows as Record<string, unknown>[]),
    transaction: (qs) =>
      serial(async () => {
        await db.transaction(async (t) => {
          for (const q of qs) await t.query(q.text, q.params as unknown[]);
        });
      }),
  };
}

let driverPromise: Promise<Driver> | null = null;
function getDriver(): Promise<Driver> {
  if (!driverPromise) {
    const conn = connectionString();
    if (!conn) return Promise.reject(new DatabaseNotConfiguredError());
    driverPromise = conn.startsWith("pglite:") ? pgliteDriver() : Promise.resolve(neonDriver(conn));
  }
  return driverPromise;
}

/** Tests: start over with an empty in-memory database. Refuses anything but PGlite. */
export function resetLocalDbForTests() {
  if (!connectionString()?.startsWith("pglite:")) throw new Error("resetLocalDbForTests only runs against pglite://");
  driverPromise = null;
  schemaPromise = null;
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
  // --- additive migrations: safe to re-run, never drop or rewrite data ---
  `alter table visits add column if not exists text text not null default ''`,
  `alter table batches alter column created_at set default ''`,
  `alter table checklist_templates alter column created_at set default ''`,
  `alter table locations alter column created_at set default ''`,
  `alter table evidence alter column created_at set default ''`,
  // evidence detail lost in the Postgres port (photo/caption pairing, findings, flags)
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS photo_index INTEGER NOT NULL DEFAULT 0`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS caption TEXT`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS caption_source TEXT`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS materials TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS conditions TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS caption_statements TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS flags TEXT NOT NULL DEFAULT '[]'`,
  `ALTER TABLE evidence ADD COLUMN IF NOT EXISTS readable INTEGER NOT NULL DEFAULT 1`,
  // repo writes manual_conflicts.resolved, which the original CREATE TABLE lacked
  `ALTER TABLE manual_conflicts ADD COLUMN IF NOT EXISTS resolved INTEGER NOT NULL DEFAULT 0`,
  // --- FNOL intake: properties with many assignments (kind of work) over time ---
  `CREATE TABLE IF NOT EXISTS properties (
    id TEXT PRIMARY KEY,
    address_key TEXT NOT NULL UNIQUE,
    address TEXT NOT NULL,
    unit TEXT,
    year_built INTEGER,
    multi_unit INTEGER NOT NULL DEFAULT 0,
    adjacent_checks TEXT NOT NULL DEFAULT '{}',
    notes TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS assignments (
    id TEXT PRIMARY KEY,
    property_id TEXT NOT NULL REFERENCES properties(id) ON DELETE CASCADE,
    project_id TEXT REFERENCES projects(id) ON DELETE SET NULL,
    service_lines TEXT NOT NULL DEFAULT '[]',
    contents_only INTEGER NOT NULL DEFAULT 0,
    stage TEXT NOT NULL DEFAULT 'initial_walkthrough',
    special INTEGER NOT NULL DEFAULT 0,
    special_reason TEXT,
    program TEXT,
    claim_number TEXT,
    assignment_number TEXT,
    policy_number TEXT,
    carrier TEXT,
    insured TEXT,
    contact_phone TEXT,
    email TEXT,
    loss_date TEXT,
    loss_type TEXT,
    cause_of_loss TEXT,
    received_at TEXT NOT NULL,
    raw_text TEXT NOT NULL DEFAULT '',
    parsed TEXT NOT NULL DEFAULT '{}',
    status TEXT NOT NULL DEFAULT 'new',
    history TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_property ON assignments(property_id)`,
  `CREATE INDEX IF NOT EXISTS idx_assignments_project ON assignments(project_id)`,
  // --- editable rules (overrides of src/lib/defaults.ts, one row per section) ---
  `CREATE TABLE IF NOT EXISTS app_settings (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  // --- room-by-room scans (one per visit + room) ---
  `CREATE TABLE IF NOT EXISTS room_scans (
    id TEXT PRIMARY KEY,
    project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
    visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
    location_id TEXT NOT NULL REFERENCES locations(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    UNIQUE (visit_id, location_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_room_scans_visit ON room_scans(visit_id)`,
  // --- kind of visit (stage) separate from kind of work (service line) ---
  `ALTER TABLE visits ADD COLUMN IF NOT EXISTS stage TEXT`,
  `ALTER TABLE visits ADD COLUMN IF NOT EXISTS service_line TEXT`,
];

let schemaPromise: Promise<void> | null = null;
/** Create tables/indexes if missing and apply additive migrations. Once per instance. */
export function ensureSchema(): Promise<void> {
  if (!schemaPromise) {
    schemaPromise = (async () => {
      const d = await getDriver();
      for (const stmt of SCHEMA) await d.run({ text: stmt, params: [] });
    })().catch((e) => {
      schemaPromise = null;
      throw e;
    });
  }
  return schemaPromise;
}

/** Run a parameterized query (template-tag style). Ensures schema first. */
export async function query<T = Record<string, unknown>>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T[]> {
  await ensureSchema();
  return (await (await getDriver()).run(compile(strings, values))) as T[];
}

export async function queryOne<T>(strings: TemplateStringsArray, ...values: unknown[]): Promise<T | undefined> {
  return (await query<T>(strings, ...values))[0];
}

/** Build a query for tx() without running it. */
export function tag(strings: TemplateStringsArray, ...values: unknown[]): SqlQuery {
  return compile(strings, values);
}

/** Run several queries in one transaction. */
export async function tx(queries: SqlQuery[]): Promise<void> {
  await ensureSchema();
  if (queries.length) await (await getDriver()).transaction(queries);
}
