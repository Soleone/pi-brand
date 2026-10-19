// Runs once when the sandbox starts: marks project/ as a git checkout on main and records its files,
// so the git stand-in can tell when the agent changes something.
const { createHash } = require("node:crypto");
const { copyFileSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } = require("node:fs");
const path = require("node:path");

const home = path.join(__dirname, "..");
const project = path.join(home, "project");
const runs = path.join(home, ".local/share/apps/pi-brand/runs");
mkdirSync(runs, { recursive: true });
copyFileSync(path.join(__dirname, "brand-run.json"), path.join(runs, "demo.json"));
mkdirSync(path.join(project, ".git"), { recursive: true });
writeFileSync(path.join(project, ".git/HEAD"), "ref: refs/heads/main\n");

function files(dir) {
  return readdirSync(dir).flatMap((name) => {
    if (name === ".git") return [];
    const file = path.join(dir, name);
    return statSync(file).isDirectory() ? files(file) : [file];
  });
}
const baseline = Object.fromEntries(files(project).map((file) => [path.relative(project, file), createHash("sha1").update(readFileSync(file)).digest("hex")]));
writeFileSync(path.join(__dirname, "baseline.json"), JSON.stringify(baseline));
