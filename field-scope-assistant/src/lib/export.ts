import type { ScopeDoc } from "./schemas";
import { toPng, toSvg, type SketchModel } from "./sketch";

/** Printed after the scope: estimator line items, then the sketch of affected areas. */
export interface ExportAppendix {
  columns: string[];
  rows: { room: string; activity: string; item: string; quantity: string; unit: string; rate: string; total: string; notes: string }[];
  sketch: SketchModel;
  equipmentNote: string | null;
}

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

export async function toPdf(lines: Line[], appendix: ExportAppendix | null = null): Promise<Uint8Array> {
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
  if (appendix) {
    // ---- estimator line items ----
    page = pdf.addPage([W, H]);
    y = H - M;
    draw("ESTIMATOR LINE ITEMS", bold, 13, M, W - 2 * M);
    draw(appendix.columns.join(" | "), regular, 8.5, M, W - 2 * M, rgb(0.35, 0.37, 0.4));
    y -= 4;
    if (!appendix.rows.length) draw("No accepted line items yet.", regular, 10, M, W - 2 * M);
    let lastRoom = "";
    for (const r of appendix.rows) {
      if (r.room !== lastRoom) {
        y -= 4;
        draw(r.room, bold, 10.5, M, W - 2 * M);
        lastRoom = r.room;
      }
      const money = [r.rate, r.total].filter(Boolean).join(" / ");
      draw(`${r.activity} ${r.item} — ${r.quantity} ${r.unit}${money ? ` — ${money}` : ""}`, regular, 10, M + 10, W - 2 * M - 10);
      draw(r.notes, regular, 8.5, M + 22, W - 2 * M - 22, rgb(0.3, 0.32, 0.36));
    }
    if (appendix.equipmentNote) {
      y -= 6;
      draw(appendix.equipmentNote, regular, 9, M, W - 2 * M, rgb(0.3, 0.32, 0.36));
    }
    // ---- sketch ----
    page = pdf.addPage([W, H]);
    y = H - M;
    draw("SKETCH OF AFFECTED AREAS", bold, 13, M, W - 2 * M);
    const sk = appendix.sketch;
    const scale = Math.min((W - 2 * M) / sk.width, (y - M) / sk.height);
    const ox = M;
    const oy = y - 6; // top of drawing in PDF coordinates
    const P = (px: number, py: number) => ({ x: ox + px * scale, y: oy - py * scale });
    const col = (h: string) => rgb(parseInt(h.slice(1, 3), 16) / 255, parseInt(h.slice(3, 5), 16) / 255, parseInt(h.slice(5, 7), 16) / 255);
    for (const pr of sk.prims) {
      if (pr.t === "line")
        page.drawLine({ start: P(pr.x1, pr.y1), end: P(pr.x2, pr.y2), thickness: Math.max(0.4, pr.sw * scale), color: col(pr.stroke), dashArray: pr.dash?.map((d) => d * scale) });
      else if (pr.t === "rect") {
        const tl = P(pr.x, pr.y + pr.h);
        page.drawRectangle({ x: tl.x, y: tl.y, width: pr.w * scale, height: pr.h * scale, borderColor: col(pr.stroke), borderWidth: Math.max(0.4, pr.sw * scale), borderDashArray: pr.dash?.map((d) => d * scale), color: pr.fill ? col(pr.fill) : undefined, opacity: pr.fill ? (pr.opacity ?? 1) : undefined });
      } else if (pr.t === "circle") page.drawCircle({ ...P(pr.cx, pr.cy), size: pr.r * scale, color: col(pr.fill) });
      else if (pr.t === "text") {
        const f = pr.bold ? bold : regular;
        const size = Math.max(4, pr.size * scale);
        const txt = safe(f, pr.text.replace(/[′]/g, "'").replace(/[″]/g, '"'));
        const tw = f.widthOfTextAtSize(txt, size);
        const at = P(pr.x, pr.y);
        page.drawText(txt, { x: pr.anchor === "middle" ? at.x - tw / 2 : pr.anchor === "end" ? at.x - tw : at.x, y: at.y, size, font: f, color: col(pr.fill) });
      }
    }
  }
  return pdf.save();
}

export async function toDocx(lines: Line[], appendix: ExportAppendix | null = null): Promise<Buffer> {
  const { Document, Packer, Paragraph, TextRun, HeadingLevel, Table, TableRow, TableCell, WidthType, ImageRun, PageBreak } = await import("docx");
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
  const extra: (InstanceType<typeof Paragraph> | InstanceType<typeof Table>)[] = [];
  if (appendix) {
    extra.push(new Paragraph({ children: [new PageBreak()] }));
    extra.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Estimator line items")] }));
    const cell = (t: string, b = false) => new TableCell({ children: [new Paragraph({ children: [new TextRun({ text: t, bold: b, size: 18 })] })] });
    const header = new TableRow({ tableHeader: true, children: ["Room", ...appendix.columns].map((c) => cell(c, true)) });
    const body = appendix.rows.map((r) => new TableRow({ children: [r.room, r.activity, r.item, r.quantity, r.unit, r.rate, r.total, r.notes].map((v) => cell(v)) }));
    extra.push(appendix.rows.length ? new Table({ rows: [header, ...body], width: { size: 100, type: WidthType.PERCENTAGE } }) : new Paragraph({ children: [new TextRun("No accepted line items yet.")] }));
    if (appendix.equipmentNote) extra.push(new Paragraph({ children: [new TextRun({ text: appendix.equipmentNote, size: 18 })] }));
    extra.push(new Paragraph({ children: [new PageBreak()] }));
    extra.push(new Paragraph({ heading: HeadingLevel.HEADING_1, children: [new TextRun("Sketch of affected areas")] }));
    const sk = appendix.sketch;
    const wpx = 620;
    const hpx = Math.round((sk.height / sk.width) * wpx);
    extra.push(
      new Paragraph({
        children: [
          new ImageRun({
            type: "svg",
            data: Buffer.from(toSvg(sk)),
            transformation: { width: wpx, height: hpx },
            fallback: { type: "png", data: toPng(sk) },
          }),
        ],
      }),
    );
  }
  const doc = new Document({ sections: [{ children: [...children, ...extra] }] });
  return Packer.toBuffer(doc);
}
