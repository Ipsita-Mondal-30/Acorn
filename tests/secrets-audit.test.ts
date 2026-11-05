import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// The secret-exposure audit (scripts/audit-secrets.mjs) as a test: nothing git could commit holds a secret or a value from
// .env.local, and no source file that reads a secret variable is browser code. (The browser-bundle check runs when a build exists.)
describe("secret exposure audit", () => {
  const run = () => spawnSync(process.execPath, ["scripts/audit-secrets.mjs"], { cwd: process.cwd(), encoding: "utf8" });

  it("finds nothing, and never prints a value", () => {
    const r = run();
    expect(r.stdout, r.stdout).toContain("No secret exposure found");
    expect(r.status).toBe(0);
    expect(r.stdout).not.toMatch(/sk-[A-Za-z0-9_-]{20,}|postgres(?:ql)?:\/\/[^\s:@]+:[^\s@]+@|eyJ[A-Za-z0-9_-]{20,}/);
  });

  it("states which source files read each secret, and that they are all server code", () => {
    const r = run();
    expect(r.stdout).toMatch(/src\/lib\/supabase\/admin\.ts reads SUPABASE_SERVICE_ROLE_KEY \(server-only module\)/);
    expect(r.stdout).toMatch(/src\/app\/api\/cron\/tick\/route\.ts reads CRON_SECRET \(route handler\)/);
    expect(r.stdout).toMatch(/every one is server code/);
  });
});
