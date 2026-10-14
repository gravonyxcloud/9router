import { describe, it, expect } from "vitest";
import {
  parseProxyLine,
  parseProxyList,
  proxyIdentityKey,
  poolProxyIdentity,
  normalizeListProtocol,
} from "../../src/lib/network/proxyListParser.js";

describe("proxy list protocol", () => {
  it("normalizes auto/http/socks4/socks5 and rejects unknown", () => {
    expect(normalizeListProtocol("auto")).toBe("auto");
    expect(normalizeListProtocol("SOCKS5")).toBe("socks5");
    expect(normalizeListProtocol("socks4")).toBe("socks4");
    expect(normalizeListProtocol("http")).toBe("http");
    expect(normalizeListProtocol("bogus")).toBeNull();
    expect(normalizeListProtocol(undefined)).toBe("auto");
  });
});

describe("parseProxyLine", () => {
  it("parses bare host:port with default protocol", () => {
    expect(parseProxyLine("1.2.3.4:8080", "http")).toEqual({
      protocol: "http",
      host: "1.2.3.4",
      port: 8080,
      username: "",
      password: "",
      proxyUrl: "http://1.2.3.4:8080",
    });
  });

  it("keeps explicit socks schemes regardless of default", () => {
    expect(parseProxyLine("socks5://1.2.3.4:1080", "http")?.protocol).toBe("socks5");
    expect(parseProxyLine("socks5h://1.2.3.4:1080", "http")?.protocol).toBe("socks5");
    expect(parseProxyLine("socks4://1.2.3.4:1080", "http")?.protocol).toBe("socks4");
    expect(parseProxyLine("socks4a://1.2.3.4:1080", "http")?.protocol).toBe("socks4");
    expect(parseProxyLine("https://1.2.3.4:8080", "socks5")?.protocol).toBe("http");
  });

  it("parses host:port:country labels (hideip.me shape), dropping the label", () => {
    expect(parseProxyLine("170.245.132.85:999:Paraguay", "http")).toEqual({
      protocol: "http",
      host: "170.245.132.85",
      port: 999,
      username: "",
      password: "",
      proxyUrl: "http://170.245.132.85:999",
    });
    expect(parseProxyLine("1.2.3.4:1080:Germany", "socks5")?.proxyUrl).toBe("socks5://1.2.3.4:1080");
    expect(parseProxyLine("1.2.3.4:notaport:Brazil", "http")).toBeNull();
  });

  it("parses credentials in scheme and bare forms", () => {
    const viaScheme = parseProxyLine("socks5://user:p@ss@1.2.3.4:1080", "auto");
    expect(viaScheme?.username).toBe("user");
    expect(viaScheme?.password).toBe("p@ss");
    expect(viaScheme?.proxyUrl).toBe("socks5://user:p%40ss@1.2.3.4:1080");

    const viaAt = parseProxyLine("bob:secret@example.com:3128", "http");
    expect(viaAt).toMatchObject({ username: "bob", password: "secret", host: "example.com", port: 3128 });

    const hostPortUserPass = parseProxyLine("1.2.3.4:8080:alice:wonder", "socks4");
    expect(hostPortUserPass).toMatchObject({ protocol: "socks4", username: "alice", password: "wonder" });

    const userPassHostPort = parseProxyLine("alice:wonder:1.2.3.4:8080", "http");
    expect(userPassHostPort).toMatchObject({ username: "alice", password: "wonder", host: "1.2.3.4" });
  });

  it("applies the source protocol to scheme-less lines", () => {
    expect(parseProxyLine("1.2.3.4:1080", "socks5")?.proxyUrl).toBe("socks5://1.2.3.4:1080");
    expect(parseProxyLine("1.2.3.4:1080", "auto")?.proxyUrl).toBe("http://1.2.3.4:1080");
  });

  it("rejects garbage, bad ports, bad hosts and unknown schemes", () => {
    expect(parseProxyLine("", "http")).toBeNull();
    expect(parseProxyLine("# comment", "http")).toBeNull();
    expect(parseProxyLine("// comment", "http")).toBeNull();
    expect(parseProxyLine("not a proxy", "http")).toBeNull();
    expect(parseProxyLine("1.2.3.4:99999", "http")).toBeNull();
    expect(parseProxyLine("1.2.3.4:0", "http")).toBeNull();
    expect(parseProxyLine("999.999.999.999:8080", "http")).toBeNull();
    expect(parseProxyLine("gopher://1.2.3.4:70", "http")).toBeNull();
    expect(parseProxyLine("http://1.2.3.4", "http")).toBeNull();
  });

  it("rejects non-routable targets from public lists", () => {
    expect(parseProxyLine("0.0.0.0:80", "http")).toBeNull();
    expect(parseProxyLine("127.0.0.1:8080", "socks5")).toBeNull();
    expect(parseProxyLine("10.1.2.3:3128", "http")).toBeNull();
    expect(parseProxyLine("192.168.1.10:8080", "http")).toBeNull();
    expect(parseProxyLine("8.8.8.8:53", "http")?.host).toBe("8.8.8.8");
  });
});

describe("parseProxyList", () => {
  it("parses a mixed list, dedupes and counts skipped", () => {
    const text = [
      "# ProxyScrape-style list",
      "1.2.3.4:8080",
      "socks5://5.6.7.8:1080",
      "1.2.3.4:8080",
      "socks5://5.6.7.8:1080",
      "garbage line",
      "",
      "9.9.9.9:3128:user:pw",
    ].join("\n");
    const { entries, skipped } = parseProxyList(text, "http");
    expect(entries).toHaveLength(3);
    expect(skipped).toBe(1);
    expect(entries.map((e) => e.proxyUrl)).toEqual([
      "http://1.2.3.4:8080",
      "socks5://5.6.7.8:1080",
      "http://user:pw@9.9.9.9:3128",
    ]);
  });

  it("treats same host:port with different protocols as distinct", () => {
    const { entries } = parseProxyList("1.2.3.4:8080\nsocks5://1.2.3.4:8080", "http");
    expect(entries).toHaveLength(2);
  });
});

describe("proxy identity", () => {
  it("builds stable lowercase identity keys", () => {
    expect(proxyIdentityKey({ protocol: "SOCKS5", host: "Example.COM", port: "1080" }))
      .toBe("socks5://example.com:1080");
  });

  it("derives pool identities for smart-sync matching", () => {
    expect(poolProxyIdentity({ proxyUrl: "socks5://1.2.3.4:1080" })).toBe("socks5://1.2.3.4:1080");
    expect(poolProxyIdentity({ proxyUrl: "1.2.3.4:8080" })).toBe("http://1.2.3.4:8080");
    expect(poolProxyIdentity({ proxyUrl: "http://user:pw@1.2.3.4:8080" })).toBe("http://1.2.3.4:8080");
    expect(poolProxyIdentity({})).toBeNull();
    expect(poolProxyIdentity({ proxyUrl: "not a url at all !!!" })).toBe("raw:not a url at all !!!");
  });
});
