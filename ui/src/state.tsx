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

interface AppState {
  route: Route;
  view: ViewName;
  /** Change any part of the route; the URL is written, then the UI follows. */
  navigate: (patch: Partial<Route>, opts?: { replace?: boolean }) => void;
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

  const navigate = useCallback((patch: Partial<Route>, opts?: { replace?: boolean }) => {
    const next: Route = { ...routeRef.current, ...patch };
    const path = formatPath(next);
    if (path !== window.location.pathname) {
      window.history[opts?.replace ? "replaceState" : "pushState"]({}, "", path);
    }
    routeRef.current = next;
    setRoute(next);
  }, []);

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
    navigate({ view: "session-detail", family: s.family, sid: s.sid, anchor: undefined });
    window.scrollTo(0, 0);
  }, [navigate]);

  const openPerson = useCallback((id: string) => {
    navigate({ view: "person-detail", personId: id, anchor: undefined });
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

  // ── Verify-residency modal — transient, so it stays out of the URL.
  const [verifyOpen, setVerifyOpen] = useState(false);
  const [verifyTarget, setVerifyTarget] = useState<any>(null);
  const [verifySteps, setVerifySteps] = useState<VerifyStepState[]>([]);
  const [verifyStatus, setVerifyStatus] = useState("Running checks…");
  const [verifyProof, setVerifyProof] = useState("");
  const [verifyDone, setVerifyDone] = useState(false);
  const verifyRun = useRef(0);
  const verifyOpenRef = useRef(false);

  const closeVerify = useCallback(() => {
    verifyOpenRef.current = false;
    setVerifyOpen(false);
  }, []);

  const verifySession = useCallback(async (s: any) => {
    const run = ++verifyRun.current;
    verifyOpenRef.current = true;
    setVerifyOpen(true);
    setVerifyTarget(s);
    setVerifyStatus("Running checks…");
    setVerifyProof("");
    setVerifyDone(false);
    const steps = verifyStepsFor(s).map((st: any) => ({ ...st, shown: false, done: false }));
    setVerifySteps(steps.map(st => ({ ...st })));
    for (let i = 0; i < steps.length; i++) {
      await sleep(120);
      if (run !== verifyRun.current || !verifyOpenRef.current) return;
      setVerifySteps(prev => prev.map((st, j) => (j === i ? { ...st, shown: true } : st)));
      await sleep(steps[i].ms);
      if (run !== verifyRun.current || !verifyOpenRef.current) return;
      setVerifySteps(prev => prev.map((st, j) => (j === i ? { ...st, shown: true, done: true } : st)));
    }
    setVerifyStatus("done");
    setVerifyProof(verifyProofText(s));
    setVerifyDone(true);
  }, []);

  const value = useMemo<AppState>(() => ({
    route, view: route.view, navigate, goto, registerPanel,
    svcRunning, pid, ver, setSvcRunning, setPid, setVer,
    trail, addTrail,
    adFilter: route.adFilter, setAdFilter,
    currentSession, openSession, currentPerson, openPerson,
    verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget,
  }), [route, navigate, goto, registerPanel, svcRunning, pid, ver, trail, addTrail, setAdFilter,
       currentSession, openSession, currentPerson, openPerson,
       verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const totalStr = () => fmtInt(TOTAL_SESSIONS);
export { DEFAULT_ROUTE };
