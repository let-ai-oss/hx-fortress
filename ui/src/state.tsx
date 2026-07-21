import React, { createContext, useCallback, useContext, useMemo, useRef, useState } from "react";
import { FORT, fmtInt, TOTAL_SESSIONS } from "./data";
import { TRAIL_SEED, verifyStepsFor, verifyProofText } from "./render";
import { flashPanel, sleep } from "./lib/util";

export type ViewName =
  | "overview" | "sessions" | "adoption" | "residency" | "compliance"
  | "postgres" | "blob" | "embeddings" | "ops" | "logs"
  | "session-detail" | "person-detail";

type TrailRow = [string, string, string, string, string, string];

export interface VerifyStepState {
  name: string; sub: string; res: string; none?: boolean;
  shown: boolean; done: boolean;
}

interface AppState {
  view: ViewName;
  goto: (v: ViewName, then?: "gates" | "keys") => void;
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

export function AppProvider({ children, people }: { children: React.ReactNode; people: any[] }) {
  const [view, setView] = useState<ViewName>("overview");
  const [svcRunning, setSvcRunning] = useState(true);
  const [pid, setPid] = useState<number>(FORT.pid);
  const [ver, setVer] = useState<string>(FORT.version);
  const [trail, setTrail] = useState<TrailRow[]>(TRAIL_SEED as TrailRow[]);
  const [adFilter, setAdFilter] = useState<string | null>(null);
  const [currentSession, setCurrentSession] = useState<any>(null);
  const [currentPerson, setCurrentPerson] = useState<any>(null);

  const panels = useRef<Record<string, HTMLElement | null>>({});
  const registerPanel = useCallback((key: string, el: HTMLElement | null) => {
    panels.current[key] = el;
  }, []);

  const goto = useCallback((v: ViewName, then?: "gates" | "keys") => {
    setView(v);
    window.scrollTo(0, 0);
    if (then === "gates") setTimeout(() => flashPanel(panels.current.gates), 60);
    if (then === "keys") setTimeout(() => flashPanel(panels.current.keys), 60);
  }, []);

  const addTrail = useCallback((action: string, sub: string) => {
    setTrail(t => [["Just now", "dana.mandarin", action, sub, "off", "Action"], ...t]);
  }, []);

  const openSession = useCallback((s: any) => {
    setCurrentSession(s);
    goto("session-detail");
  }, [goto]);

  const openPerson = useCallback((id: string) => {
    const p = people.find(x => x.id === id);
    if (!p) return;
    setCurrentPerson(p);
    goto("person-detail");
  }, [goto, people]);

  // ── Verify-residency modal — same async chain + run token as the prototype.
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
    view, goto, registerPanel,
    svcRunning, pid, ver, setSvcRunning, setPid, setVer,
    trail, addTrail,
    adFilter, setAdFilter,
    currentSession, openSession, currentPerson, openPerson,
    verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget,
  }), [view, goto, registerPanel, svcRunning, pid, ver, trail, addTrail, adFilter,
       currentSession, openSession, currentPerson, openPerson,
       verifyOpen, verifySession, closeVerify, verifySteps, verifyStatus, verifyProof, verifyDone, verifyTarget]);

  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export const totalStr = () => fmtInt(TOTAL_SESSIONS);
