#!/usr/bin/env node
// Records the browser demo (demo/browser) as the README loop, and the hero:
// names for the sample app, a few picked as favorites, three chosen as finalists and checked. The hero is the favorites picker.
// Usage: npm run media:capture. Needs agent-browser (with its browser installed) and FFmpeg on the PATH.
import { execFile, spawn } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import { promisify } from "node:util";
import { record } from "@soleone/showcase/capture";

const exec = promisify(execFile);
const media = path.resolve("demo/media");
// Tall enough for the picker's ten rows and its key help.
const viewport = { width: 1280, height: 920 };
// The terminal, below the title and the hint buttons.
const crop = "iw*1088/1280:ih*662/920:iw*96/1280:ih*179/920";
const click = (hint) => `[...document.querySelectorAll('#hints button')].find((button) => button.textContent === ${JSON.stringify(hint)}).click()`;
const shows = (text) => `window.terminalText().includes(${JSON.stringify(text)})`;

await exec("node", ["demo/browser/build.mjs"]);
const out = await mkdtemp(path.join(os.tmpdir(), "pi-brand-demo-"));
const port = String(4400 + (process.pid % 500));
const server = spawn("node_modules/.bin/showcase", ["terminal", "demo/browser", "--out", path.join(out, "browser"), "--serve", "--port", port], {
  stdio: ["ignore", "pipe", "inherit"],
});
await new Promise((resolve, reject) => {
  createInterface({ input: server.stdout }).on("line", (line) => line.startsWith("Serving at") && resolve());
  server.once("exit", (code) => reject(new Error(`showcase terminal exited with status ${code}`)));
});
const heroShot = path.join(out, "hero.png");
try {
  const { frames, durationMs, grid } = await record({
    url: `http://127.0.0.1:${port}/`,
    out: path.join(media, "demo.webp"),
    viewport,
    width: 1088,
    crop,
    attempts: 3,
    async start(page) {
      await page.waitFor("window.demoReady === true", { timeoutMs: 120_000 });
      // The recipe starts pi by itself.
      await page.waitFor(shows("scripted • "), { timeoutMs: 60_000 });
      await page.sleep(1500);
    },
    async drive(page) {
      const keys = async (...presses) => {
        for (const press of presses) {
          await page.run("press", press);
          await page.sleep(450);
        }
      };
      const focus = () => page.run("eval", "document.querySelector('.xterm-helper-textarea').focus()");
      await page.sleep(1200);
      await page.run("eval", click("/brand a reminder app that tells you when to water each plant"));
      await page.waitFor(shows("Pick favorites"), { timeoutMs: 20_000 });
      await focus();
      await page.sleep(1500);
      // Space picks a name and moves down: Sprig, Sipling, Thirsty, Greenhour.
      await keys("Space", "Space", "ArrowDown", "Space", "ArrowDown", "ArrowDown", "ArrowDown", "Space");
      await page.run("screenshot", heroShot);
      await page.sleep(1000);
      await keys("Enter");
      await page.waitFor(shows("Brand overview"), { timeoutMs: 10_000 });
      await page.sleep(1500);
      await page.run("type", ".xterm-helper-textarea", "check");
      await page.sleep(800);
      await keys("Enter");
      await page.waitFor(shows("Choose finalists"), { timeoutMs: 10_000 });
      await page.sleep(1000);
      await keys("Space", "Space", "Space");
      await page.sleep(600);
      await keys("Enter");
      await page.waitFor(shows("Deep check (cache first)"), { timeoutMs: 10_000 });
      await page.sleep(800);
      await keys("Enter");
      await page.waitFor(shows("comes out best"), { timeoutMs: 60_000 });
      await page.sleep(4000);
    },
  });
  await exec("ffmpeg", ["-hide_banner", "-loglevel", "error", "-y", "-i", heroShot, "-vf", `crop=${crop}`, path.join(media, "hero.png")]);
  console.log(`Wrote demo/media/demo.webp (${frames} frames, ${(durationMs / 1000).toFixed(1)} s) and demo/media/hero.png. Check the frames in ${grid}.`);
} finally {
  server.kill();
  await rm(out, { recursive: true, force: true });
}
