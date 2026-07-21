import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FORT, fmtInt, fmtMB, TOTAL_SESSIONS, TOTAL_OBJECTS, TOTAL_KB, SESSIONS, PEOPLE } from "./data";
import { TRAIL_SEED, verifyStepsFor, verifyProofText } from "./render";
import { flashPanel, sleep } from "./lib/util";
import { DEFAULT_ROUTE, formatPath, parsePath, Route, ViewName } from "./router";

export type { ViewName } from "./router";

type TrailRow = [string, string, string, string, string, string];

export interface VerifyStepState {
  name: string; sub: string; res: string; none?: boolean;
  shown: boolean; done: boolean;
}

/** Where transcripts rest. Changing any of this means a new, empty store —
 *  which is why switching asks what to do with what's already there. */
export interface StoreTarget {
  kind: "s3" | "gcs";
  bucket: string;
  region: string;          // S3 region / GCS location
  projectId?: string;      // GCS only
}
export interface StoreState extends StoreTarget {
  maskedKey: string;
  credRotated: boolean;
  objects: number;
  kb: number;
  /** Set when a switch left data behind — those sessions stop resolving here. */
  orphan: { objects: number; where: string } | null;
}
export interface MigrationRun {
  id: string;
  startedAt: string;
  finishedAt?: string;
  from: StoreTarget;
  to: StoreTarget;
  mode: "copy" | "fresh";
  status: "running" | "failed" | "complete";
  phase: string;
  copied: number;
  total: number;
  pct: number;
  log: string[];
  error?: string;
  resumeOf?: string;
}
export const storeUri = (t: StoreTarget) => `${t.kind === "gcs" ? "gs" : "s3"}://${t.bucket}`;

interface NavOpts { replace?: boolean; modal?: boolean }

interface AppState {
  route: Route;
  view: ViewName;
  /** Change any part of the route; the URL is written, then the UI follows. */
  navigate: (patch: Partial<Route>, opts?: NavOpts) => void;
  goto: (v: ViewName, then?: string) => void;
  registerPanel: (key: string, el: HTMLElement | null) => void;

  svcRunning: boolean; pid: number; ver: string;
  setSvcRunning: (on: boolean) => void; setPid: (pid: number) => void; setVer: (v: string) => void;

  trail: TrailRow[];
  addTrail: (action: string, sub: string) => void;

  adFilter: string | null;
  setAdFilter: (f: string | null) => void;

  currentSession: any; openSession: (s: any) => void;
  currentPerson: any; openPerson: (id: string) => void;

  verifyOpen: boolean; verifySession: (s: any) => void; closeVerify: () => void;
  verifySteps: VerifyStepState[]; verifyStatus: string; verifyProof: string; verifyDone: boolean;
  verifyTarget: any;

  shortcutsOpen: boolean; toggleShortcuts: () => void; closeShortcuts: () => void;
  anyDialogOpen: boolean; dismissDialog: () => void;

  store: StoreState;
  rotateStoreCredentials: (masked: string, label: string) => void;
  runs: MigrationRun[];
  startMigration: (to: StoreTarget, mode: "copy" | "fresh") => void;
  retryMigration: (id: string) => void;
}

const Ctx = createContext<AppState>(null as unknown as AppState);
export const useApp = () => useContext(Ctx);

export function AppProvider({ children }: { children: React.ReactNode }) {
  const [route, setRoute] = useState<Route>(() => parsePath(window.location.pathname));
  const routeRef = useRef(route);
  routeRef.current = route;

  // Back/forward are real navigations — the URL drives the console.
  useEffect(() => {
    const onPop = () => setRoute(parsePath(window.location.pathname));
    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);

  // Normalize the entry URL (an unknown or redundant path rewrites itself once).
  useEffect(() => {
    const canonical = formatPath(routeRef.current);
    if (canonical !== window.location.pathname) window.history.replaceState({}, "", canonical);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const navigate = useCallback((patch: Partial<Route>, opts?: NavOpts) => {
    const cur = routeRef.current;
    // Going somewhere else dismisses whatever dialog is open — otherwise an
    // overlay would ride along and pile up in every later URL.
    const leaving = patch.view !== undefined && patch.view !== cur.view;
    const cleared: Partial<Route> = leaving
      ? { shortcuts: false, verify: false, verifyFamily: undefined, verifySid: undefined }
      : {};
    const next: Route = { ...cur, ...cleared, ...patch };
    const path = formatPath(next);
    if (path !== window.location.pathname) {
      // Opening a dialog marks its history entry, so dismissing can simply go
      // back — no leftover entry that re-opens it on Back.
      const histState = opts?.modal ? { hxDialog: true } : {};
      window.history[opts?.replace ? "replaceState" : "pushState"](histState, "", path);
    }
    routeRef.current = next;
    setRoute(next);
  }, []);

  /** Close a dialog: rewind if we pushed it, otherwise (a cold-loaded dialog
   *  link) rewrite to the page underneath. */
  const dismiss = useCallback((patch: Partial<Route>) => {
    if ((window.history.state as any)?.hxDialog) window.history.back();
    else navigate(patch, { replace: true });
  }, [navigate]);

  const [svcRunning, setSvcRunning] = useState(true);
  const [pid, setPid] = useState<number>(FORT.pid);
  const [ver, setVer] = useState<string>(FORT.version);
  const [trail, setTrail] = useState<TrailRow[]>(TRAIL_SEED as TrailRow[]);

  // Forward handles: the storage engine below is declared before `addTrail`
  // and needs a stable way to reach it and the router.
  const addTrailRef = useRef<(action: string, sub: string) => void>(() => {});
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  // ── Blob storage: the live target, and the migration runs that change it ──
  const [store, setStore] = useState<StoreState>({
    kind: "s3", bucket: "orange-corp-hx-fortress", region: "eu-north-1",
    maskedKey: "AKIA••••••••3F7Q", credRotated: false, objects: TOTAL_OBJECTS, kb: TOTAL_KB + 4200, orphan: null,
  });
  const [runs, setRuns] = useState<MigrationRun[]>([]);
  const runSeq = useRef(0);
  const storeRef = useRef(store); storeRef.current = store;

  const rotateStoreCredentials = useCallback((masked: string, label: string) => {
    setStore(s => ({ ...s, maskedKey: masked, credRotated: true }));
    addTrailRef.current(`Rotated the ${label}`, "hx-fortress credentials set s3 · restart pending");
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nowT = () => {
    const d = new Date();
    return [d.getHours(), d.getMinutes(), d.getSeconds()].map(n => String(n).padStart(2, "0")).join(":");
  };

  /** Walk a migration: preflight → inventory → copy → verify → switch.
   *  A copy is idempotent, so a retry resumes from what already landed. */
  const execRun = useCallback(async (run: MigrationRun, fail: boolean, alreadyCopied: number) => {
    const id = run.id;
    const line = (lvl: string, msg: string) =>
      setRuns(rs => rs.map(r => (r.id === id ? { ...r, log: [...r.log, `${nowT()} [storage_migrate] ${lvl} ${msg}`] } : r)));
    const patch = (p: Partial<MigrationRun>) =>
      setRuns(rs => rs.map(r => (r.id === id ? { ...r, ...p } : r)));

    const src = storeUri(run.from), dst = storeUri(run.to);
    line("info", `run started runId="${id}"${run.resumeOf ? ` resumeOf="${run.resumeOf}"` : ""} from="${src}" to="${dst}" mode="${run.mode}"`);

    patch({ phase: "Checking the destination" });
    await sleep(600);
    line("info", `preflight: ${run.to.kind === "gcs" ? "GCS" : "S3"} credentials accepted`);
    await sleep(500);
    line("info", `preflight: write probe landed and read back bytes=2048 ms=${170 + Math.floor(Math.random() * 40)}`);

    if (run.mode === "fresh") {
      patch({ phase: "Switching" });
      await sleep(500);
      line("warn", `${fmtInt(run.total)} objects remain in ${src} and will no longer resolve from this fortress`);
      line("info", `credentials.json updated store="${run.to.kind}" bucket="${run.to.bucket}"`);
      line("warn", "restart required — the store is built once at module init");
      line("info", `run complete runId="${id}"`);
      patch({ status: "complete", phase: "Switched to an empty bucket", pct: 100, finishedAt: nowT() });
      setStore(s => ({ ...s, ...run.to, objects: 0, kb: 0, orphan: { objects: run.total, where: src } }));
      addTrailRef.current(`Switched blob storage to ${dst}`, `started fresh · ${fmtInt(run.total)} objects left in ${src}`);
      return;
    }

    patch({ phase: "Taking inventory" });
    await sleep(700);
    if (alreadyCopied > 0) {
      line("info", `inventory complete objects=${run.total} present=${alreadyCopied} remaining=${run.total - alreadyCopied}`);
    } else {
      line("info", `inventory complete objects=${run.total} bytes=${Math.round(storeRef.current.kb * 1024)}`);
    }
    patch({ phase: "Copying objects", copied: alreadyCopied, pct: Math.round((alreadyCopied / run.total) * 100) });
    line("info", `copy started concurrency=8${alreadyCopied ? " (resuming)" : ""}`);

    const failAt = Math.round(run.total * 0.617);
    const step = Math.max(1, Math.round(run.total / 14));
    for (let copied = alreadyCopied + step; ; copied += step) {
      const at = Math.min(copied, run.total);
      if (fail && at >= failAt) {
        const key = "u_9f27ab41/claude-cli/7c1d9f04-3ab2/log.jsonl";
        const why = run.to.kind === "gcs"
          ? `storage.objects.create denied on bucket ${run.to.bucket}`
          : `AccessDenied: s3:PutObject on arn:aws:s3:::${run.to.bucket}/*`;
        line("error", `copy failed key="${key}" error="${why}"`);
        line("error", `run failed runId="${id}" copied=${failAt} remaining=${run.total - failAt}`);
        patch({
          status: "failed", phase: "Copy failed", copied: failAt,
          pct: Math.round((failAt / run.total) * 100), finishedAt: nowT(),
          error: `The destination rejected a write — ${why}. The fortress is still writing to ${src}.`,
        });
        addTrailRef.current(`Storage migration failed (${id})`, `${fmtInt(failAt)} of ${fmtInt(run.total)} objects copied · destination denied a write`);
        return;
      }
      patch({ copied: at, pct: Math.round((at / run.total) * 100) });
      if (at % (step * 4) < step) line("info", `copy progress objects=${at} pct=${Math.round((at / run.total) * 100)}`);
      await sleep(260);
      if (at >= run.total) break;
    }

    line("info", `copy complete objects=${run.total} bytes=${Math.round(storeRef.current.kb * 1024)}`);
    patch({ phase: "Verifying", pct: 100 });
    await sleep(700);
    line("info", `verify: byte counts match on ${fmtInt(run.total)} objects`);
    line("info", `credentials.json updated store="${run.to.kind}" bucket="${run.to.bucket}"`);
    line("warn", "restart required — the store is built once at module init");
    line("info", `run complete runId="${id}"`);
    patch({ status: "complete", phase: "Copied and switched", finishedAt: nowT() });
    setStore(s => ({ ...s, ...run.to, orphan: null }));
    addTrailRef.current(`Migrated blob storage to ${dst}`, `${fmtInt(run.total)} objects copied and verified · ${fmtMB(storeRef.current.kb)}`);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startMigration = useCallback((to: StoreTarget, mode: "copy" | "fresh") => {
    const id = "mig_" + (0x7f3a + runSeq.current++).toString(16);
    const run: MigrationRun = {
      id, startedAt: nowT(), from: { ...storeRef.current }, to, mode,
      status: "running", phase: "Starting", copied: 0, total: storeRef.current.objects, pct: 0, log: [],
    };
    setRuns(rs => [run, ...rs]);
    navigateRef.current({ view: "blob", stEdit: undefined, runId: id });
    // The first copy hits a destination-permission wall on purpose: this is the
    // failure the operator must be able to see and retry.
    void execRun(run, mode === "copy", 0);
  }, [execRun]);

  const retryMigration = useCallback((prevId: string) => {
    const prev = runs.find(r => r.id === prevId);
    if (!prev) return;
    const id = "mig_" + (0x7f3a + runSeq.current++).toString(16);
    const run: MigrationRun = {
      id, startedAt: nowT(), from: prev.from, to: prev.to, mode: prev.mode,
      status: "running", phase: "Starting", copied: prev.copied, total: prev.total,
      pct: Math.round((prev.copied / prev.total) * 100), log: [], resumeOf: prev.id,
    };
    setRuns(rs => [run, ...rs]);
    navigateRef.current({ view: "blob", stEdit: undefined, runId: id });
    void execRun(run, false, prev.copied);
  }, [runs, execRun]);

  const panels = useRef<Record<string, HTMLElement | null>>({});
  const registerPanel = useCallback((key: string, el: HTMLElement | null) => {
    panels.current[key] = el;
  }, []);

  const goto = useCallback((v: ViewName, then?: string) => {
    navigate({ view: v, anchor: then });
    window.scrollTo(0, 0);
  }, [navigate]);

  // A panel anchor in the URL scrolls to that panel and flashes it — on click
  // and on a cold load of the deep link alike.
  useEffect(() => {
    if (!route.anchor) return;
    const t = setTimeout(() => flashPanel(panels.current[route.anchor!]), 60);
    return () => clearTimeout(t);
  }, [route.view, route.anchor]);

  const addTrail = useCallback((action: string, sub: string) => {
    setTrail(t => [["Just now", "dana.mandarin", action, sub, "off", "Action"], ...t]);
  }, []);
  addTrailRef.current = addTrail;

  const openSession = useCallback((s: any) => {
    navigate({ view: "session-detail", family: s.family, sid: s.sid, anchor: undefined, verify: false });
    window.scrollTo(0, 0);
  }, [navigate]);

  const openPerson = useCallback((id: string) => {
    navigate({ view: "person-detail", personId: id, anchor: undefined, verify: false });
    window.scrollTo(0, 0);
  }, [navigate]);

  const setAdFilter = useCallback((f: string | null) => navigate({ adFilter: f }), [navigate]);

  // Detail views resolve their subject FROM the URL, so a deep link works cold.
  const currentSession = useMemo(
    () => (route.family && route.sid ? SESSIONS.find((s: any) => s.family === route.family && s.sid === route.sid) ?? null : null),
    [route.family, route.sid]);
  const currentPerson = useMemo(
    () => (route.personId ? PEOPLE.find((p: any) => p.id === route.personId) ?? null : null),
    [route.personId]);

  // ── Verify-residency dialog — a proof about one session, so it has its own
  //    address and re-runs whenever that address is loaded.
  const verifyTarget = useMemo(
    () => (route.verifyFamily && route.verifySid
      ? SESSIONS.find((s: any) => s.family === route.verifyFamily && s.sid === route.verifySid) ?? null
      : null),
    [route.verifyFamily, route.verifySid]);
  const verifyOpen = route.verify && !!verifyTarget;

  const [verifySteps, setVerifySteps] = useState<VerifyStepState[]>([]);
  const [verifyStatus, setVerifyStatus] = useState("Running checks…");
  const [verifyProof, setVerifyProof] = useState("");
  const [verifyDone, setVerifyDone] = useState(false);

  useEffect(() => {
    if (!verifyOpen || !verifyTarget) return;
    let cancelled = false;
    const target = verifyTarget;
    const steps = verifyStepsFor(target).map((st: any) => ({ ...st, shown: false, done: false }));
    setVerifySteps(steps.map(st => ({ ...st })));
    setVerifyStatus("Running checks…");
    setVerifyProof("");
    setVerifyDone(false);
    (async () => {
      for (let i = 0; i < steps.length; i++) {
        await sleep(120);
        if (cancelled) return;
        setVerifySteps(prev => prev.map((st, j) => (j === i ? { ...st, shown: true } : st)));
        await sleep(steps[i].ms);
        if (cancelled) return;
        setVerifySteps(prev => prev.map((st, j) => (j === i ? { ...st, shown: true, done: true } : st)));
      }
      if (cancelled) return;
      setVerifyStatus("done");
      setVerifyProof(verifyProofText(target));
      setVerifyDone(true);
    })();
    return () => { cancelled = true; };
  }, [verifyOpen, verifyTarget]);

  const verifySession = useCallback((s: any) => {
    navigate({ verify: true, verifyFamily: s.family, verifySid: s.sid }, { modal: true });
  }, [navigate]);
  const closeVerify = useCallback(
    () => dismiss({ verify: false, verifyFamily: undefined, verifySid: undefined }),
    [dismiss]);

  // ── Keyboard-map dialog — overlays any page, so it nests under that page.
  const shortcutsOpen = route.shortcuts;
  const closeShortcuts = useCallback(() => dismiss({ shortcuts: false }), [dismiss]);
  const toggleShortcuts = useCallback(() => {
    if (routeRef.current.shortcuts) closeShortcuts();
    else navigate({ shortcuts: true }, { modal: true });
  }, [navigate, closeShortcuts]);

  const anyDialogOpen = verifyOpen || shortcutsOpen;
  const dismissDialog = useCallback(() => {
    if (routeRef.current.shortcuts) closeShortcuts();
    else closeVerify();
  }, [closeShortcuts, closeVerify]);

  const value = useMemo<AppState>(() => ({
    route, view: route.view, navigate, goto, registerPanel,
    svcRunning, pid, ver, setSvcRunning, setPid, setVer,
    trail, addTrail,
    adFilter: route.adFilter, setAdFilter,
    currentSession, openSession, currentPerson, openPerson,
    verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget,
    shortcutsOpen, toggleShortcuts, closeShortcuts, anyDialogOpen, dismissDialog,
    store, rotateStoreCredentials, runs, startMigration, retryMigration,
  }), [route, navigate, goto, registerPanel, svcRunning, pid, ver, trail, addTrail, setAdFilter,
       currentSession, openSession, currentPerson, openPerson,
       verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget,
       shortcutsOpen, toggleShortcuts, closeShortcuts, anyDialogOpen, dismissDialog,
       store, rotateStoreCredentials, runs, startMigration, retryMigration]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const totalStr = () => fmtInt(TOTAL_SESSIONS);
export { DEFAULT_ROUTE };
