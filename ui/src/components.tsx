import React, { useEffect, useRef, useState } from "react";
import { MENU_CLOSE_EVENT } from "./lib/util";

// ── Custom dropdown menu (gpill + menu) — closes on pick, outside click, Esc.
export interface MenuItem { key: string; label: string; }
export function MenuPill(props: {
  pillId: string; menuId: string; valueId: string;
  label?: string; value: string; mini?: boolean; right?: boolean;
  items: MenuItem[]; selKey: string; dataAttr: string;
  onPick: (key: string) => void; style?: React.CSSProperties;
}) {
  const [open, setOpen] = useState(false);
  const pillRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const onDoc = (e: MouseEvent) => {
      if (pillRef.current && !pillRef.current.contains(e.target as Node)) setOpen(false);
    };
    const onClose = () => setOpen(false);
    document.addEventListener("click", onDoc);
    window.addEventListener(MENU_CLOSE_EVENT, onClose);
    return () => { document.removeEventListener("click", onDoc); window.removeEventListener(MENU_CLOSE_EVENT, onClose); };
  }, []);
  return (
    <div className={props.mini ? "gpill mini" : "gpill"} id={props.pillId} ref={pillRef} style={props.style}
      onClick={e => { if (!(e.target as HTMLElement).closest(".menu")) setOpen(o => !o); }}>
      {props.label ? <><span className="lbl">{props.label}</span>{" "}</> : null}
      <span id={props.valueId}>{props.value}</span> <span className="caret"></span>
      <div className={open ? "menu openm" : "menu"} id={props.menuId}>
        {props.items.map(it => (
          <button key={it.key} {...{ [props.dataAttr]: it.key }}
            className={it.key === props.selKey ? "sel" : undefined}
            onClick={() => { setOpen(false); props.onPick(it.key); }}>
            {it.label}
          </button>
        ))}
      </div>
    </div>
  );
}

// ── Search field (toolbar) ──────────────────────────────
export function SearchBox(props: {
  id: string; placeholder: string; value: string; onInput: (v: string) => void;
  compact?: boolean; style?: React.CSSProperties;
}) {
  return (
    <div className={props.compact ? "search compact" : "search"} style={props.style}>
      <svg className="ic s" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" style={{ color: "var(--text-subtle)" }}><circle cx="11" cy="11" r="7" /><path d="M20 20l-3.5-3.5" /></svg>
      <input id={props.id} placeholder={props.placeholder} value={props.value} onChange={e => props.onInput(e.target.value)} />
    </div>
  );
}

// ── Inline terminal output (.term) ──────────────────────
export function Term({ id, html }: { id: string; html: string }) {
  return <div className={html ? "term on" : "term"} id={id} dangerouslySetInnerHTML={{ __html: html }} />;
}

// ── Result line with the 6s auto-clear (flashResult) ────
export function useResultLine(): [{ text: string; on: boolean; warn: boolean }, (msg: string, warn?: boolean) => void] {
  const [state, setState] = useState({ text: "", on: false, warn: false });
  const timer = useRef<number | undefined>(undefined);
  const show = (msg: string, warn?: boolean) => {
    setState({ text: msg, on: true, warn: !!warn });
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState(s => ({ ...s, on: false })), 6000);
  };
  return [state, show];
}
export function ResultLine({ id, state }: { id: string; state: { text: string; on: boolean; warn: boolean } }) {
  return <div className={"resultline" + (state.warn ? " warnr" : "") + (state.on ? " on" : "")} id={id}>{state.text}</div>;
}

// ── Sub-line flash (subFlash): 4s highlighted class, text persists ──────────
export function useSubFlash(initialHtml: string) {
  const [html, setHtml] = useState(initialHtml);
  const [cls, setCls] = useState("");
  const timer = useRef<number | undefined>(undefined);
  const flash = (nextHtml: string, klass = "okv") => {
    setHtml(nextHtml);
    setCls(klass);
    window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setCls(""), 4000);
  };
  return { html, cls, flash, setHtml };
}
