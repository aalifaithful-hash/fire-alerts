// Browser regression test — scan autosave never erases separately saved values, and failed saves are
// never dropped silently. Runs against a LOCAL production build with an in-memory TEST database only.
//
//   npm run build && npm run test:e2e
//
// Uses the Playwright + Chromium installed on the machine (require("playwright")); nothing is downloaded.
import { spawn } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright");
const PORT = Number(process.env.E2E_PORT || 3199);
const B = `http://localhost:${PORT}`;

let failed = 0;
const check = (name, ok, detail = "") => {
  console.log(`${ok ? "✓" : "✗"} ${name}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failed++;
};

const env = { ...process.env, PORT: String(PORT), DATABASE_URL: "pglite://memory", DATA_DIR: mkdtempSync(path.join(os.tmpdir(), "fsa-e2e-")) };
delete env.POSTGRES_URL;
delete env.BLOB_READ_WRITE_TOKEN;
delete env.APP_PASSCODE;
delete env.AI_PROVIDER;
const server = spawn(process.execPath, [require.resolve("next/dist/bin/next"), "start", "-p", String(PORT)], { env, stdio: "ignore" });
const stop = () => server.kill();
process.on("exit", stop);

async function waitUp() {
  for (let i = 0; i < 60; i++) {
    try {
      if ((await fetch(B + "/")).ok) return;
    } catch {
      /* not up yet */
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error("server did not start");
}

const scanOf = async (q) => (await (await fetch(`${B}/api/projects/${q.projectId}/visits/${q.visitId}/scans`)).json()).rooms.find((r) => r.locationId === q.locationId).data;

try {
  await waitUp();
  const j = async (u, body, method = "POST") => (await fetch(B + u, { method, headers: { "content-type": "application/json" }, body: JSON.stringify(body) })).json();
  const q = await j("/api/quickstart", { address: "1 E2E Test Lane, New York, NY 10001", job: "water", notes: "Kitchen leak, LVP wet" });
  await j(
    `/api/projects/${q.projectId}/visits/${q.visitId}/scans/${q.locationId}`,
    { data: { loss: { type: "water", category: "2", waterClass: "2" }, source: { where: "in_room", status: "repaired", waterSource: "clean_supply" }, materials: { flooring: { type: "LVP", affected: true, affectedPct: 100 } }, measurements: { lengthFt: 12, widthFt: 10, heightFt: 8, openings: [] } } },
    "PUT",
  );

  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 390, height: 844 } })).newPage();
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${B}/projects/${q.projectId}?visit=${q.visitId}&tab=scan`);
  await page.waitForSelector("[data-line='extract']");

  // 1. A quantity typed on a line, then a form edit (autosave) — the quantity must survive
  await page.fill("[data-line='extract'] input[aria-label^='Quantity for']", "99");
  await page.locator("[data-line='extract'] button", { hasText: /^Set$/ }).click();
  await page.waitForFunction(() => /99 SF/.test(document.querySelector("[data-line='extract']")?.textContent ?? ""));
  // 2. A run time on the air movers, too
  await page.fill("[data-line='equip.airmovers'] input[aria-label^='Run time hours']", "96");
  await page.locator("[data-line='equip.airmovers'] button", { hasText: "Set run time (h)" }).click();
  await page.waitForFunction(() => /96 h/.test(document.querySelector("[data-duration='equip.airmovers']")?.textContent ?? ""));
  const wet = page.locator("input[aria-label^='Wet height']").first();
  await wet.fill("6");
  await page.waitForFunction(() => /saved automatically/.test(document.querySelector("[data-testid=autosave]")?.textContent ?? ""), null, { timeout: 15000 });
  let s = await scanOf(q);
  check("autosave keeps the typed quantity", s.quantityOverrides.extract === 99, JSON.stringify(s.quantityOverrides));
  check("autosave keeps the typed run time", s.durationOverrides["equip.airmovers"] === 96, JSON.stringify(s.durationOverrides));
  check("autosave saved the form edit", s.materials.walls.wetHeightIn === 6);

  // 3. Edit and switch tab right away (no wait) — the edit is flushed, not lost
  await wet.fill("9");
  await page.click("nav >> text=Info");
  await page.waitForSelector("[aria-label='Visits — kind of work and stage']");
  await new Promise((r) => setTimeout(r, 800));
  s = await scanOf(q);
  check("tab switch flushes the edit", s.materials.walls.wetHeightIn === 9, String(s.materials.walls.wetHeightIn));
  check("…and still keeps the quantity / run time", s.quantityOverrides.extract === 99 && s.durationOverrides["equip.airmovers"] === 96);
  await page.click("nav >> text=Scan");
  await page.waitForSelector("[data-line='extract']");

  // 4. The server fails the autosave — shown, kept, retried
  let fail = true;
  await page.route(`**/scans/${q.locationId}`, (route) => (route.request().method() === "PUT" && fail ? route.fulfill({ status: 500, contentType: "application/json", body: '{"error":"test failure"}' }) : route.continue()));
  await page.locator("input[aria-label^='Wet height']").first().fill("12");
  await page.waitForFunction(() => /Not saved — retrying/.test(document.querySelector("[data-testid=autosave]")?.textContent ?? ""), null, { timeout: 15000 });
  check("a failed autosave is shown (not silent)", true);
  const kept = await page.evaluate(() => Object.keys(localStorage).some((k) => k.startsWith("fsa-scan-draft:")));
  check("the failed edit is kept on the device", kept);
  fail = false;
  await page.waitForFunction(() => /saved automatically/.test(document.querySelector("[data-testid=autosave]")?.textContent ?? ""), null, { timeout: 20000 });
  s = await scanOf(q);
  check("the retry saves it", s.materials.walls.wetHeightIn === 12, String(s.materials.walls.wetHeightIn));

  // 5. Leave with a failing save — the edit comes back and is saved when the room is opened again
  fail = true;
  await page.locator("input[aria-label^='Wet height']").first().fill("15");
  await page.click("nav >> text=Info");
  await page.waitForSelector("[aria-label='Visits — kind of work and stage']");
  await new Promise((r) => setTimeout(r, 800));
  s = await scanOf(q);
  check("the failed flush did not reach the server", s.materials.walls.wetHeightIn === 12);
  fail = false;
  await page.click("nav >> text=Scan");
  await page.waitForSelector("text=restored from this device", { timeout: 15000 });
  await page.waitForFunction(() => /saved automatically/.test(document.querySelector("[data-testid=autosave]")?.textContent ?? ""), null, { timeout: 20000 });
  s = await scanOf(q);
  check("the kept edit is restored and saved", s.materials.walls.wetHeightIn === 15, String(s.materials.walls.wetHeightIn));
  check("quantity and run time still intact at the end", s.quantityOverrides.extract === 99 && s.durationOverrides["equip.airmovers"] === 96);
  check("no page errors", errors.length === 0, errors.join(" | "));
  await browser.close();
} catch (e) {
  console.error(e);
  failed++;
} finally {
  stop();
}
console.log(failed ? `\n${failed} check(s) FAILED` : "\nAll browser checks passed");
process.exit(failed ? 1 : 0);
