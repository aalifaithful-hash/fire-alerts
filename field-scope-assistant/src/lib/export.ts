import type { ScopeDoc } from "./schemas";

type Line = { kind: "title" | "h1" | "h2" | "meta" | "bullet" | "text" | "gap"; text: string; label?: string };

export function docLines(doc: ScopeDoc): Line[] {
  const out: Line[] = [{ kind: "title", text: doc.title }];
  for (const h of doc.header) out.push({ kind: "meta", label: h.label, text: h.value });
  for (const s of doc.sections) {
    out.push({ kind: "gap", text: "" });
    out.push({ kind: s.level === 1 ? "h1" : "h2", text: s.heading });
    for (const b of s.bullets) out.push({ kind: "bullet", text: b.text });
  }
  if (doc.footer.length) {
    out.push({ kind: "gap", text: "" });
    for (const f of doc.footer) out.push(f.startsWith("• ") ? { kind: "bullet", text: f.slice(2) } : { kind: "text", text: f });
  }
  return out;
}

/** Free-text (PM-edited) scope → lines. */
export function textLines(text: string): Line[] {
  const raw = text.split(/\r?\n/);
  const out: Line[] = [];
  raw.forEach((l, i) => {
    const t = l.trimEnd();
    if (!t.trim()) out.push({ kind: "gap", text: "" });
    else if (i === 0) out.push({ kind: "title", text: t });
    else if (/^\s*[•\-*]\s+/.test(t)) out.push({ kind: "bullet", text: t.replace(/^\s*[•\-*]\s+/, "") });
    else if (/^[A-Z0-9 \-—/&'.,]+$/.test(t) && t.length < 80) out.push({ kind: "h1", text: t });
    else if (raw[i + 1] && /^\s*[•\-*]\s+/.test(raw[i + 1])) out.push({ kind: "h2", text: t });
    else out.push({ kind: "text", text: t });
  });
  return out;
}

export async function toPdf(lines: Line[]): Promise<Uint8Array> {
  const { PDFDocument, StandardFonts, rgb } = await import("pdf-lib");
  const pdf = await PDFDocument.create();
  const regular = await pdf.embedFont(StandardFonts.Helvetica);
  const bold = await pdf.embedFont(StandardFonts.HelveticaBold);
  const W = 612, H = 792, M = 54;
  let page = pdf.addPage([W, H]);
  let y = H - M;

  const safe = (font: typeof regular, s: string) =>
    [...s]
      .map((ch) => {
        try {
          font.encodeText(ch);
          return ch;
        } catch {
          return ch === "→" ? "->" : "?";
        }
      })
      .join("");
  const wrap = (font: typeof regular, s: string, size: number, width: number) => {
    const words = safe(font, s).split(/\s+/);
    const rows: string[] = [];
    let cur = "";
    for (const w of words) {
      const next = cur ? `${cur} ${w}` : w;
      if (font.widthOfTextAtSize(next, size) > width && cur) {
        rows.push(cur);
        cur = w;
      } else cur = next;
    }
    if (cur) rows.push(cur);
    return rows;
  };
  const draw = (s: string, font: typeof regular, size: number, x: number, width: number, color = rgb(0.1, 0.1, 0.12)) => {
    for (const row of wrap(font, s, size, width)) {
      if (y < M + size) {
        page = pdf.addPage([W, H]);
        y = H - M;
      }
      page.drawText(row, { x, y: y - size, size, font, color });
      y -= size * 1.35;
    }
  };

  for (const l of lines) {
    switch (l.kind) {
      case "title":
        draw(l.text, bold, 16, M, W - 2 * M);
        y -= 6;
        break;
      case "meta":
        draw(`${l.label}: ${l.text}`, regular, 10, M, W - 2 * M, rgb(0.25, 0.27, 0.3));
        break;
      case "h1":
        y -= 4;
        draw(l.text.toUpperCase(), bold, 12, M, W - 2 * M);
        break;
      case "h2":
        draw(l.text, bold, 11, M, W - 2 * M);
        break;
      case "bullet": {
        if (y < M + 12) {
          page = pdf.addPage([W, H]);
          y = H - M;
        }
        page.drawText("•", { x: M + 6, y: y - 10.5, size: 10.5, font: regular });
        draw(l.text, regular, 10.5, M + 18, W - 2 * M - 18);
        break;
      }
      case "text":
        draw(l.text, regular, 10.5, M, W - 2 * M);
        break;
      case "gap":
        y -= 6;
        break;
    }
  }
  return pdf.save();
}

export async function toDocx(lines: Line[]): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel } = await import("docx");
  const children = lines
    .filter((l) => l.kind !== "gap")
    .map((l) => {
      switch (l.kind) {
        case "title":
          return new Paragraph({ heading: HeadingLevel.TITLE, children: [new TextRun(l.text)] });
        case "meta":
          return new Paragraph({ children: [new TextRun({ text: `${l.label}: `, bold: true }), new TextRun(l.text)] });
        case "h1":
          return new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun(l.text)] });
        case "h2":
          return new Paragraph({ heading: HeadingLevel.HEADING_2, children: [new TextRun(l.text)] });
        case "bullet":
          return new Paragraph({ bullet: { level: 0 }, children: [new TextRun(l.text)] });
        default:
          return new Paragraph({ children: [new TextRun(l.text)] });
      }
    });
  const doc = new Document({ sections: [{ children }] });
  return Packer.toBuffer(doc);
}
