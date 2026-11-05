import { describe, expect, it } from "vitest";
import { assertPublicHost, isPrivateIp, parseSafeUrl, UrlError } from "@/lib/url";

describe("parseSafeUrl", () => {
  it.each(["file:///etc/passwd", "javascript:alert(1)", "ftp://example.com", "https://user:pw@example.com", "not a url", "", `https://example.com/${"a".repeat(2000)}`])(
    "rejects %s",
    (raw) => expect(() => parseSafeUrl(raw)).toThrow(UrlError),
  );
  it("accepts https and http", () => {
    expect(parseSafeUrl("  https://example.com/path?q=1 ").href).toBe("https://example.com/path?q=1");
    expect(parseSafeUrl("http://example.com").hostname).toBe("example.com");
  });
});

describe("assertPublicHost", () => {
  it.each([
    "http://127.0.0.1/",
    "http://10.1.2.3/",
    "http://172.20.0.1/",
    "http://192.168.1.1/",
    "http://169.254.169.254/latest/meta-data",
    "http://100.64.0.1/",
    "http://0.0.0.0/",
    "http://2130706433/", // 127.0.0.1 as an integer
    "http://[::1]/",
    "http://[::ffff:127.0.0.1]/",
    "http://[fd00::1]/",
    "http://[fe80::1]/",
    "http://localhost:3000/",
    "http://api.localhost/",
    "http://printer.local/",
    "http://metadata.google.internal/",
  ])("rejects %s", async (u) => {
    await expect(assertPublicHost(parseSafeUrl(u))).rejects.toThrow(UrlError);
  });

  it("allows public literal IPs", async () => {
    await expect(assertPublicHost(parseSafeUrl("http://93.184.216.34/"))).resolves.toBeUndefined();
    await expect(assertPublicHost(parseSafeUrl("http://[2606:4700::1111]/"))).resolves.toBeUndefined();
  });

  it("classifies edge IPs", () => {
    expect(isPrivateIp("172.15.0.1")).toBe(false);
    expect(isPrivateIp("172.32.0.1")).toBe(false);
    expect(isPrivateIp("100.128.0.1")).toBe(false);
    expect(isPrivateIp("::ffff:8.8.8.8")).toBe(false);
    expect(isPrivateIp("::ffff:10.0.0.1")).toBe(true);
    expect(isPrivateIp("64:ff9b::7f00:1")).toBe(true);
  });
});
