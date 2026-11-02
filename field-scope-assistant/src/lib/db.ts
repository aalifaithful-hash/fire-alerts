import Database from "better-sqlite3";
import { mkdirSync } from "node:fs";
import path from "node:path";

// DATA_DIR wins; on Railway the attached volume's mount path is used automatically.
export const DATA_DIR = path.resolve(
  /*turbopackIgnore: true*/ process.env.DATA_DIR || process.env.RAILWAY_VOLUME_MOUNT_PATH || "./data",
);
export const UPLOAD_DIR = path.join(DATA_DIR, "uploads");

const SCHEMA = `
CREATE TABLE IF NOT EXISTS projects (
  id TEXT PRIMARY KEY,
  data TEXT NOT NULL,
  is_demo INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS locations (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  floor TEXT, unit TEXT, room TEXT NOT NULL,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_locations_project ON locations(project_id);
CREATE TABLE IF NOT EXISTS documents (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  size INTEGER NOT NULL,
  page_count INTEGER NOT NULL DEFAULT 0,
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_documents_project ON documents(project_id);
CREATE TABLE IF NOT EXISTS doc_pages (
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  page INTEGER NOT NULL,
  text TEXT NOT NULL,
  char_count INTEGER NOT NULL,
  PRIMARY KEY (document_id, page)
);
CREATE TABLE IF NOT EXISTS batches (
  id TEXT PRIMARY KEY,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  start_page INTEGER NOT NULL,
  end_page INTEGER NOT NULL,
  status TEXT NOT NULL,
  attempts INTEGER NOT NULL DEFAULT 0,
  error TEXT,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_batches_doc ON batches(document_id);
CREATE TABLE IF NOT EXISTS evidence (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  document_id TEXT NOT NULL REFERENCES documents(id) ON DELETE CASCADE,
  batch_id TEXT,
  page INTEGER NOT NULL,
  photo_index INTEGER NOT NULL,
  caption TEXT,
  caption_source TEXT,
  location_id TEXT REFERENCES locations(id) ON DELETE SET NULL,
  location_text TEXT,
  location_confidence TEXT,
  location_basis TEXT,
  materials TEXT NOT NULL DEFAULT '[]',
  conditions TEXT NOT NULL DEFAULT '[]',
  caption_statements TEXT NOT NULL DEFAULT '[]',
  flags TEXT NOT NULL DEFAULT '[]',
  readable INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_evidence_project ON evidence(project_id);
CREATE TABLE IF NOT EXISTS visits (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  visit_date TEXT NOT NULL,
  appointment_time TEXT,
  arrival_time TEXT,
  departure_time TEXT,
  access_outcome TEXT,
  field_notes TEXT NOT NULL DEFAULT '',
  facts TEXT NOT NULL,
  doc TEXT,
  manual_text TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_visits_project ON visits(project_id);
CREATE TABLE IF NOT EXISTS drafts (
  id TEXT PRIMARY KEY,
  visit_id TEXT NOT NULL REFERENCES visits(id) ON DELETE CASCADE,
  project_id TEXT NOT NULL,
  version INTEGER NOT NULL,
  trigger TEXT NOT NULL,
  input TEXT,
  changes TEXT NOT NULL DEFAULT '[]',
  facts TEXT NOT NULL,
  doc TEXT,
  manual_text TEXT,
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_drafts_visit ON drafts(visit_id);
CREATE TABLE IF NOT EXISTS checklist_templates (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  visit_types TEXT NOT NULL,
  items TEXT NOT NULL,
  is_starter INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manuals (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  filename TEXT NOT NULL,
  stored_path TEXT NOT NULL,
  text TEXT NOT NULL,
  rules TEXT NOT NULL DEFAULT '[]',
  status TEXT NOT NULL,
  error TEXT,
  created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS manual_conflicts (
  id TEXT PRIMARY KEY,
  description TEXT NOT NULL,
  manual_ids TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'open',
  created_at TEXT NOT NULL
);
`;

let db: Database.Database | null = null;

export function getDb(): Database.Database {
  if (db) return db;
  mkdirSync(UPLOAD_DIR, { recursive: true });
  db = new Database(path.join(DATA_DIR, "field-scope.db"));
  init(db);
  return db;
}

function init(d: Database.Database) {
  d.pragma("journal_mode = WAL");
  d.pragma("foreign_keys = ON");
  d.exec(SCHEMA);
}

/** Tests use an in-memory database. */
export function useMemoryDb(): Database.Database {
  db = new Database(":memory:");
  init(db);
  return db;
}
