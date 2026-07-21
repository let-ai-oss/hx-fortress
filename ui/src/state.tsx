import React, { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from "react";
import { FORT, fmtInt, TOTAL_SESSIONS, SESSIONS, PEOPLE } from "./data";
import { TRAIL_SEED, verifyStepsFor, verifyProofText } from "./render";
import { flashPanel, sleep } from "./lib/util";
import { DEFAULT_ROUTE, formatPath, parsePath, Route, ViewName } from "./router";

export type { ViewName } from "./router";

type TrailRow = [string, string, string, string, string, string];

export interface VerifyStepState {
  name: string; sub: string; res: string; none?: boolean;
  shown: boolean; done: boolean;
}

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
  }), [route, navigate, goto, registerPanel, svcRunning, pid, ver, trail, addTrail, setAdFilter,
       currentSession, openSession, currentPerson, openPerson,
       verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget,
       shortcutsOpen, toggleShortcuts, closeShortcuts, anyDialogOpen, dismissDialog]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const totalStr = () => fmtInt(TOTAL_SESSIONS);
export { DEFAULT_ROUTE };
