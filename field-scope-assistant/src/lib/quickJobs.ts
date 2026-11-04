// Client-safe constants for the quick-start form (no server imports).
export const QUICK_JOBS = ["water", "mold", "fire", "smoke", "sewage", "contents", "reconstruction"] as const;
export type QuickJob = (typeof QUICK_JOBS)[number];
export const QUICK_JOB_LABELS: Record<QuickJob, string> = {
  water: "Water",
  mold: "Mold",
  fire: "Fire",
  smoke: "Smoke",
  sewage: "Sewage",
  contents: "Contents",
  reconstruction: "Reconstruction",
};
