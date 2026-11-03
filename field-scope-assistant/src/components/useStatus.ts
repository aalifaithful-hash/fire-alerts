"use client";
import { useEffect, useState } from "react";
import { api } from "./api";

export interface Status {
  aiConfigured: boolean;
  model: string | null;
  aiProvider?: "none" | "anthropic" | "gemini";
  aiProblem?: string | null;
  passcodeEnabled: boolean;
  blobUploads?: boolean;
  databaseConfigured?: boolean;
}
export function useStatus() {
  const [s, setS] = useState<Status | null>(null);
  useEffect(() => {
    api<Status>("/api/status").then(setS).catch(() => {});
  }, []);
  return s;
}
