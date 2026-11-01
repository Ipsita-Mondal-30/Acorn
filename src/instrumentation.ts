export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { assertConfig } = await import("./lib/startup-check");
    assertConfig();
  }
}
