"use client";
import { useCallback, useEffect, useState } from "react";
import Header from "./Header";
import SetupBanner from "./SetupBanner";
import ScopeTab from "./ScopeTab";
import PhotosTab from "./PhotosTab";
import ScanTab from "./ScanTab";
import RoomsTab from "./RoomsTab";
import HistoryTab from "./HistoryTab";
import InfoTab from "./InfoTab";
import EvidenceViewer from "./EvidenceViewer";
import { api } from "./api";
import { useStatus } from "./useStatus";
import type { WorkspaceData } from "./types";

const TABS = ["scope", "scan", "photos", "rooms", "history", "info"] as const;
type Tab = (typeof TABS)[number];

export default function Workspace({ projectId }: { projectId: string }) {
  const status = useStatus();
  const [ws, setWs] = useState<WorkspaceData | null>(null);
  const [err, setErr] = useState("");
  const [tab, setTab] = useState<Tab>("scope");
  const [visitId, setVisitId] = useState<string | null>(null);
  const [viewEvidence, setViewEvidence] = useState<string | null>(null);
  const [toast, setToast] = useState("");

  const reload = useCallback(async () => {
    try {
      const d = await api<WorkspaceData>(`/api/projects/${projectId}`);
      setWs(d);
      return d;
    } catch (e) {
      setErr((e as Error).message);
      return null;
    }
  }, [projectId]);

  useEffect(() => {
    reload().then((d) => {
      if (!d) return;
      const fromUrl = new URLSearchParams(window.location.search).get("visit");
      const latest = d.visits.at(-1)?.id ?? null;
      setVisitId(fromUrl && d.visits.some((v) => v.id === fromUrl) ? fromUrl : latest);
      try {
        const t = localStorage.getItem(`fsa-tab-${projectId}`) as Tab | null;
        if (t && TABS.includes(t)) setTab(t);
      } catch {
      /* storage blocked (private mode) — fine */
    }
    });
  }, [reload, projectId]);

  const pickTab = (t: Tab) => {
    setTab(t);
    try {
      localStorage.setItem(`fsa-tab-${projectId}`, t);
    } catch {
      /* storage blocked (private mode) — fine */
    }
    window.scrollTo({ top: 0 });
  };
  const openVisit = (id: string | null) => {
    setVisitId(id);
    const u = new URL(window.location.href);
    if (id) u.searchParams.set("visit", id);
    else u.searchParams.delete("visit");
    window.history.replaceState(null, "", u);
  };
  const flash = (m: string) => {
    setToast(m);
    setTimeout(() => setToast(""), 2600);
  };

  if (err) return (<><Header /><main className="page"><div className="card danger">{err}</div></main></>);
  if (!ws) return (<><Header /><main className="page muted">Loading…</main></>);

  const attention = ws.evidence.filter((e) => !e.locationId || e.flags.length || !e.readable).length;
  const common = { ws, projectId, reload, flash, openEvidence: setViewEvidence };

  return (
    <>
      {ws.project.isDemo && <div className="demo-banner">DEMO PROJECT — fictional sample data, not a real job</div>}
      <Header crumb={ws.project.address || ws.project.name} />
      <nav className="tabs" aria-label="Project sections">
        {TABS.map((t) => (
          <button key={t} className={tab === t ? "on" : ""} onClick={() => pickTab(t)}>
            {t}
            {t === "photos" && attention > 0 && <span className="n">{attention}</span>}
            {t === "history" && <span className="n">{ws.visits.length || ""}</span>}
          </button>
        ))}
      </nav>
      <main className="page">
        {status && !status.aiConfigured && tab !== "info" && <SetupBanner />}
        {tab === "scope" && <ScopeTab {...common} visitId={visitId} openVisit={openVisit} aiReady={!!status?.aiConfigured} goPhotos={() => pickTab("photos")} />}
        {tab === "scan" && <ScanTab {...common} visitId={visitId} />}
        {tab === "photos" && <PhotosTab {...common} aiReady={!!status?.aiConfigured} blobReady={status ? !!status.blobUploads : null} />}
        {tab === "rooms" && <RoomsTab {...common} />}
        {tab === "history" && <HistoryTab {...common} visitId={visitId} openVisit={(id) => { openVisit(id); pickTab("scope"); }} />}
        {tab === "info" && <InfoTab {...common} />}
      </main>
      {viewEvidence && <EvidenceViewer {...common} evidenceId={viewEvidence} onClose={() => setViewEvidence(null)} />}
      {toast && <div className="toast" role="status">{toast}</div>}
    </>
  );
}
