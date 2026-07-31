// Small helpers, matching the prototype's semantics exactly.

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

// Clipboard via a throwaway textarea — the prototype's mechanism, kept verbatim
// (works without permissions prompts in every browser the console targets).
export function copyText(text: string, btn?: HTMLElement | null, doneLabel?: string) {
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand("copy");
    ta.remove();
    if (btn) {
      const old = btn.textContent;
      btn.textContent = doneLabel || "Copied";
      setTimeout(() => (btn.textContent = old), 1200);
    }
  } catch {}
}

// Golden attention flash — remove → reflow → add, exactly like the prototype.
export function flashPanel(el: HTMLElement | null) {
  if (!el) return;
  el.scrollIntoView({ behavior: "smooth", block: "center" });
  el.classList.remove("flash");
  void el.offsetWidth;
  el.classList.add("flash");
}

export function downloadBlob(content: BlobPart, type: string, filename: string) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([content], { type }));
  a.download = filename;
  a.click();
  URL.revokeObjectURL(a.href);
}

// Close every open custom menu — the document-level Esc behavior.
export const MENU_CLOSE_EVENT = "hx-close-menus";
export function closeAllMenus() {
  window.dispatchEvent(new CustomEvent(MENU_CLOSE_EVENT));
}
