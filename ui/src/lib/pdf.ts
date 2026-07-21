// A minimal single-page PDF, written by hand — no libraries, works offline.
// Text is coerced to ASCII so byte offsets and the content stream stay exact.
// Ported verbatim from the prototype.
export function reportPdfBytes(text: string): string {
  const ascii = text
    .replace(/—/g, "--").replace(/·/g, "-").replace(/’/g, "'").replace(/[“”]/g, '"')
    .replace(/[^\x0a\x20-\x7e]/g, "?");
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/\(/g, "\\(").replace(/\)/g, "\\)");
  const lines = ascii.split("\n");
  const stream = ["BT /F1 9.5 Tf 1 0 0 1 56 800 Tm 14 TL", ...lines.map((l) => `(${esc(l)}) Tj T*`), "ET"].join("\n");
  const objs: string[] = [];
  objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
  objs[2] = "<< /Type /Pages /Kids [3 0 R] /Count 1 >>";
  objs[3] = "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595 842] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>";
  objs[4] = "<< /Type /Font /Subtype /Type1 /BaseFont /Courier >>";
  objs[5] = `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`;
  let pdf = "%PDF-1.4\n";
  const offsets: number[] = [0];
  for (let i = 1; i <= 5; i++) { offsets[i] = pdf.length; pdf += `${i} 0 obj\n${objs[i]}\nendobj\n`; }
  const xref = pdf.length;
  pdf += "xref\n0 6\n0000000000 65535 f \n";
  for (let i = 1; i <= 5; i++) pdf += String(offsets[i]).padStart(10, "0") + " 00000 n \n";
  pdf += `trailer\n<< /Size 6 /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF`;
  return pdf;
}
