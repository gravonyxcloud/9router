import crypto from "node:crypto";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import { stringifyJson } from "./helpers/jsonCol.js";

// Factory-default TXT proxy list sources: validated public lists seeded
// into FRESH databases so 9Router ships with list sync working out of the
// box ("padrǜo de fǭbrica"). One-time only (meta marker): user deletions
// and existing installs are never touched or reseeded.
export const SEED_MARKER_KEY = "proxyListsSeededV1";
export const SEED_MARKER_V2 = "proxyListsSeededV2";

export const DEFAULT_PROXY_LIST_SOURCES = [
  { name: "ProxyScrape HTTP", url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all", protocol: "http" },
  { name: "ProxyScrape SOCKS4", url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks4&timeout=10000&country=all&ssl=all&anonymity=all", protocol: "socks4" },
  { name: "ProxyScrape SOCKS5", url: "https://api.proxyscrape.com/v2/?request=displayproxies&protocol=socks5&timeout=10000&country=all&ssl=all&anonymity=all", protocol: "socks5" },
  { name: "GeoNode", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=1&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "TheSpeedX HTTP", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/http.txt", protocol: "http" },
  { name: "TheSpeedX SOCKS4", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks4.txt", protocol: "socks4" },
  { name: "TheSpeedX SOCKS5", url: "https://raw.githubusercontent.com/TheSpeedX/PROXY-List/master/socks5.txt", protocol: "socks5" },
  { name: "Monosans HTTP", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/http.txt", protocol: "http" },
  { name: "Monosans SOCKS4", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks4.txt", protocol: "socks4" },
  { name: "Monosans SOCKS5", url: "https://raw.githubusercontent.com/monosans/proxy-list/main/proxies/socks5.txt", protocol: "socks5" },
  { name: "OpenProxyList HTTP", url: "https://api.openproxylist.xyz/http.txt", protocol: "http" },
  { name: "OpenProxyList SOCKS4", url: "https://api.openproxylist.xyz/socks4.txt", protocol: "socks4" },
  { name: "OpenProxyList SOCKS5", url: "https://api.openproxylist.xyz/socks5.txt", protocol: "socks5" },
  { name: "JetKai HTTP", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-http.txt", protocol: "http" },
  { name: "JetKai SOCKS5", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-socks5.txt", protocol: "socks5" },
  { name: "Shifty HTTP", url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/http.txt", protocol: "http" },
  { name: "Shifty SOCKS4", url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks4.txt", protocol: "socks4" },
  { name: "Shifty SOCKS5", url: "https://raw.githubusercontent.com/ShiftyTR/Proxy-List/master/socks5.txt", protocol: "socks5" },
  { name: "Mmpx HTTP", url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/http.txt", protocol: "http" },
  { name: "Mmpx SOCKS4", url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks4.txt", protocol: "socks4" },
  { name: "Mmpx SOCKS5", url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/socks5.txt", protocol: "socks5" },
  { name: "ClarkeTM Raw", url: "https://raw.githubusercontent.com/clarketm/proxy-list/master/proxy-list-raw.txt", protocol: "http" },
  { name: "Sunny9577", url: "https://raw.githubusercontent.com/sunny9577/proxy-scraper/master/proxies.txt", protocol: "http" },
  { name: "Vakhov HTTP", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/http.txt", protocol: "http" },
  { name: "Vakhov SOCKS4", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks4.txt", protocol: "socks4" },
  { name: "Vakhov SOCKS5", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/socks5.txt", protocol: "socks5" },
  { name: "Anonym0us HTTP", url: "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/http_proxies.txt", protocol: "http" },
  { name: "Anonym0us SOCKS5", url: "https://raw.githubusercontent.com/Anonym0usWork1221/Free-Proxies/main/proxy_files/socks5_proxies.txt", protocol: "socks5" },
  { name: "Roosterkid HTTP", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/HTTPS_RAW.txt", protocol: "http" },
  { name: "Roosterkid SOCKS5", url: "https://raw.githubusercontent.com/roosterkid/openproxylist/main/SOCKS5_RAW.txt", protocol: "socks5" },
  { name: "Rdavydov HTTP", url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/http.txt", protocol: "http" },
  { name: "Rdavydov SOCKS5", url: "https://raw.githubusercontent.com/rdavydov/proxy-list/main/proxies/socks5.txt", protocol: "socks5" },
  { name: "Prxchk HTTP", url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/http.txt", protocol: "http" },
  { name: "Prxchk SOCKS4", url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks4.txt", protocol: "socks4" },
  { name: "Prxchk SOCKS5", url: "https://raw.githubusercontent.com/prxchk/proxy-list/main/socks5.txt", protocol: "socks5" },
  { name: "Proxy4Parsing HTTP", url: "https://raw.githubusercontent.com/proxy4parsing/proxy-list/main/http.txt", protocol: "http" },
  // V2 batch (2026-10-14, all fetch-validated live before seeding):
  { name: "ProxiFly All", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/all/data.txt", protocol: "auto" },
  { name: "ProxyScrapeV4 HTTP", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=http&timeout=1000&country=all&ssl=all&anonymity=all", protocol: "http" },
  { name: "ProxyScrapeV4 SOCKS4", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=socks4&timeout=1000&country=all&ssl=all&anonymity=all", protocol: "socks4" },
  { name: "ProxyScrapeV4 SOCKS5", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=socks5&timeout=1000&country=all&ssl=all&anonymity=all", protocol: "socks5" },
  { name: "GeoNode Page 2", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=2&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "GeoNode Page 3", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=3&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "hideip HTTP", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/http.txt", protocol: "http" },
  { name: "hideip SOCKS4", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks4.txt", protocol: "socks4" },
  { name: "hideip SOCKS5", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/socks5.txt", protocol: "socks5" },
];

export function seedDefaultProxyListSources(adapter) {
  try {
    if (getMetaSync(adapter, SEED_MARKER_KEY, null)) return { seeded: 0, skipped: "marked" };
    const existing = adapter.get(`SELECT COUNT(*) as c FROM proxyListSources`)?.c ?? 0;
    if (existing > 0) {
      setMetaSync(adapter, SEED_MARKER_KEY, "1");
      return { seeded: 0, skipped: "non-empty" };
    }
    const now = new Date().toISOString();
    let seeded = 0;
    adapter.transaction(() => {
      for (const entry of DEFAULT_PROXY_LIST_SOURCES) {
        const id = crypto.randomUUID();
        const data = {
          name: entry.name,
          url: entry.url,
          protocol: entry.protocol,
          autoUpdate: true,
          lastFetchedAt: null,
          lastStatus: null,
          lastError: null,
          totalFound: 0,
          totalNew: 0,
          totalFailed: 0,
          totalImported: 0,
        };
        adapter.run(
          `INSERT INTO proxyListSources(id, isActive, data, createdAt, updatedAt) VALUES(?, 1, ?, ?, ?)`,
          [id, stringifyJson(data), now, now]
        );
        seeded += 1;
      }
      setMetaSync(adapter, SEED_MARKER_KEY, "1");
    });
    console.log(`[DB][migrate] seeded ${seeded} factory-default proxy list sources`);
    seedV2ProxyListSources(adapter);
    return { seeded, skipped: null };
  } catch (err) {
    console.warn(`[DB][migrate] proxy list seed failed (continuing): ${err.message}`);
    return { seeded: 0, skipped: "error" };
  }
}

/**
 * V2 top-up (2026-10-14): insert factory sources added after V1 without
 * touching user data. URL-deduplicated: sources the user deleted ARE
 * re-inserted (indistinguishable from never-seeded); the V2 marker keeps
 * this one-time per database.
 */
export function seedV2ProxyListSources(adapter) {
  try {
    if (getMetaSync(adapter, SEED_MARKER_V2, null)) return { seeded: 0, skipped: "marked" };
    const rows = adapter.all(`SELECT data FROM proxyListSources`) || [];
    const haveUrls = new Set();
    for (const row of rows) {
      try {
        const parsed = JSON.parse(row?.data || "{}");
        if (parsed?.url) haveUrls.add(String(parsed.url));
      } catch {
        /* ignore malformed rows */
      }
    }
    const now = new Date().toISOString();
    let seeded = 0;
    adapter.transaction(() => {
      for (const entry of DEFAULT_PROXY_LIST_SOURCES) {
        if (haveUrls.has(entry.url)) continue;
        const id = crypto.randomUUID();
        const data = {
          name: entry.name,
          url: entry.url,
          protocol: entry.protocol,
          autoUpdate: true,
          lastFetchedAt: null,
          lastStatus: null,
          lastError: null,
          totalFound: 0,
          totalNew: 0,
          totalFailed: 0,
          totalImported: 0,
        };
        adapter.run(
          `INSERT INTO proxyListSources(id, isActive, data, createdAt, updatedAt) VALUES(?, 1, ?, ?, ?)`,
          [id, stringifyJson(data), now, now]
        );
        seeded += 1;
      }
      setMetaSync(adapter, SEED_MARKER_V2, "1");
    });
    if (seeded > 0) console.log(`[DB][migrate] seeded ${seeded} V2 factory proxy list sources`);
    return { seeded, skipped: null };
  } catch (err) {
    console.warn(`[DB][migrate] proxy list V2 seed failed (continuing): ${err.message}`);
    return { seeded: 0, skipped: "error" };
  }
}
