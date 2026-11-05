#!/usr/bin/env node
// npm run demo            start the demo (dev server) with everything paid switched off
// npm run demo -- --prod  the same on a production build (run `npm run build` first)
// npm run demo:tick       run the reminder check once (what a scheduler would do), so due reminders reach the inbox
import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { demoEnv } from "./demo-env.mjs";

const args = process.argv.slice(2);
const port = args.includes("--port") ? args[args.indexOf("--port") + 1] : "3200";
const dataDir = ".demo-data";
const secretFile = path.resolve(process.cwd(), dataDir, ".cron-secret");

function secret() {
  if (existsSync(secretFile)) return readFileSync(secretFile, "utf8").trim();
  mkdirSync(path.dirname(secretFile), { recursive: true });
  const s = randomBytes(24).toString("hex"); // 48 characters, local to this demo folder, never printed
  writeFileSync(secretFile, s, { mode: 0o600 });
  return s;
}

if (args[0] === "tick") {
  if (!existsSync(secretFile)) {
    console.error("Start the demo first (npm run demo): there is no demo secret yet.");
    process.exit(1);
  }
  const res = await fetch(`http://localhost:${port}/api/cron/tick`, { method: "POST", headers: { Authorization: `Bearer ${readFileSync(secretFile, "utf8").trim()}` } }).catch(() => null);
  if (!res) {
    console.error(`Nothing is answering on port ${port}. Is the demo running?`);
    process.exit(1);
  }
  console.log(res.status, JSON.stringify(await res.json().catch(() => ({}))));
  process.exit(res.ok ? 0 : 1);
}

const { env, replay } = demoEnv({ secret: secret() });
console.log(`
Acorn demo on http://localhost:${port}
  Mode ............ demo: no model is called, nothing is sent anywhere, no account
  Your own data ... untouched (the demo uses ${dataDir}/)
  Muse Spark ...... ${replay ? "the saved REAL result is replayed for the built-in job-listing sample (labelled, no new request)" : "no saved real result found: every reading is the labelled mock"}
  Everything else . built-in rules, labelled "Demo" or "Sample" on screen
  Reminders ....... a due reminder shows on Home/Today; run "npm run demo:tick" to deliver it to the inbox
`);
const cmd = args.includes("--prod") ? ["start", "-p", port] : ["dev", "-p", port];
const child = spawn("npx", ["next", ...cmd], { stdio: "inherit", env: { ...process.env, ...env } });
child.on("exit", (code) => process.exit(code ?? 0));
for (const sig of ["SIGINT", "SIGTERM"]) process.on(sig, () => child.kill(sig));
