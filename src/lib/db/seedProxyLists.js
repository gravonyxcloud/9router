import crypto from "node:crypto";
import { getMetaSync, setMetaSync } from "./helpers/metaStore.js";
import { stringifyJson } from "./helpers/jsonCol.js";

// Factory-default TXT proxy list sources: validated public lists seeded
// into FRESH databases so 9Router ships with list sync working out of the
// box ("padrǜo de fǭbrica"). One-time only (meta marker): user deletions
// and existing installs are never touched or reseeded.
export const SEED_MARKER_KEY = "proxyListsSeededV1";
export const SEED_MARKER_V2 = "proxyListsSeededV2";
export const SEED_MARKER_V3 = "proxyListsSeededV3";
export const SEED_MARKER_V4 = "proxyListsSeededV4";

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
  // V3 batch (2026-10-15, all fetch-validated live before seeding):
  { name: "ProxyScrape jsDelivr All", url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/all/data.txt", protocol: "http" },
  { name: "ProxyScrape jsDelivr HTTP", url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/http/data.txt", protocol: "http" },
  { name: "ProxyScrape jsDelivr HTTPS", url: "https://cdn.jsdelivr.net/gh/proxyscrape/free-proxy-list@main/proxies/protocols/https/data.txt", protocol: "http" },
  { name: "ProxyScrape V4 Full", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&proxy_format=protocolipport&format=text&limit=2000", protocol: "http" },
  { name: "ProxyScrape V4 HTTPS", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=https&timeout=10000&country=all&ssl=all&anonymity=all&skip=0&proxy_format=protocolipport&format=text&limit=2000", protocol: "http" },
  { name: "ProxyScrape V2 Get", url: "https://api.proxyscrape.com/v2/?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all", protocol: "http" },
  { name: "ProxyScrape V3", url: "https://api.proxyscrape.com/v3/free-proxy-list/get?request=getproxies&protocol=http&timeout=10000&country=all&ssl=all&anonymity=all", protocol: "http" },
  { name: "ProxyScrape V4 US", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=http&timeout=10000&country=US&ssl=all&anonymity=all&skip=0&proxy_format=protocolipport&format=text&limit=2000", protocol: "http" },
  { name: "ProxyScrape V4 IN", url: "https://api.proxyscrape.com/v4/free-proxy-list/get?request=getproxies&protocol=http&timeout=10000&country=IN&ssl=all&anonymity=all&skip=0&proxy_format=protocolipport&format=text&limit=2000", protocol: "http" },
  { name: "ProxiFly jsDelivr All", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/all/data.txt", protocol: "auto" },
  { name: "ProxiFly jsDelivr HTTP", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/http/data.txt", protocol: "http" },
  { name: "ProxiFly jsDelivr HTTPS", url: "https://cdn.jsdelivr.net/gh/proxifly/free-proxy-list@main/proxies/protocols/https/data.txt", protocol: "http" },
  { name: "ProxiFly Raw HTTP", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/http/data.txt", protocol: "http" },
  { name: "ProxiFly Raw HTTPS", url: "https://raw.githubusercontent.com/proxifly/free-proxy-list/main/proxies/protocols/https/data.txt", protocol: "http" },
  { name: "HProxy HTTP", url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/http.txt", protocol: "http" },
  { name: "HProxy HTTPS", url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/https.txt", protocol: "http" },
  { name: "HProxy All", url: "https://raw.githubusercontent.com/hproxy-com/free-proxy-list/main/all.txt", protocol: "auto" },
  { name: "Proxio Raw All", url: "https://raw.githubusercontent.com/proxio-io/proxy-list/main/all.txt", protocol: "auto" },
  { name: "Proxio Raw HTTP", url: "https://raw.githubusercontent.com/proxio-io/proxy-list/main/http.txt", protocol: "http" },
  { name: "Proxio Raw HTTPS", url: "https://raw.githubusercontent.com/proxio-io/proxy-list/main/https.txt", protocol: "http" },
  { name: "Proxio Download HTTP", url: "https://proxio.io/download?type=http&limit=2000", protocol: "http" },
  { name: "Proxio Download HTTPS", url: "https://proxio.io/download?type=https&limit=2000", protocol: "http" },
  { name: "GeoNode Page 4", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=4&sort_by=lastChecked&sort_type=desc&protocols=http,https", protocol: "auto" },
  { name: "GeoNode Page 5", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=5&sort_by=lastChecked&sort_type=desc&protocols=http,https", protocol: "auto" },
  { name: "Vakhov ProxyList", url: "https://raw.githubusercontent.com/vakhov/fresh-proxy-list/master/proxylist.txt", protocol: "http" },
  { name: "Mmpx HTTPS", url: "https://raw.githubusercontent.com/mmpx12/proxy-list/master/https.txt", protocol: "http" },
  { name: "JetKai HTTPS", url: "https://raw.githubusercontent.com/jetkai/proxy-list/main/online-proxies/txt/proxies-https.txt", protocol: "http" },
  { name: "MuRongPIG", url: "https://raw.githubusercontent.com/MuRongPIG/Proxy-Master/main/http.txt", protocol: "auto" },
  { name: "Stormsia HTTP", url: "https://raw.githubusercontent.com/stormsia/proxy-list/main/http.txt", protocol: "http" },
  { name: "Stormsia Working", url: "https://raw.githubusercontent.com/stormsia/proxy-list/main/working_proxies.txt", protocol: "http" },
  { name: "OpenProxyList HTTPS", url: "https://api.openproxylist.xyz/https.txt", protocol: "http" },
  { name: "ProxySpace HTTP", url: "https://proxyspace.pro/http.txt", protocol: "http" },
  { name: "ProxySpace HTTPS", url: "https://proxyspace.pro/https.txt", protocol: "http" },
  // V4 batch (2026-10-16, all fetch-validated live; needs the HTML-table and
  // space-suffix parser support added alongside):
  { name: "Spys HTTP", url: "https://spys.me/proxy.txt", protocol: "http" },
  { name: "Spys SOCKS", url: "https://spys.me/socks.txt", protocol: "socks5" },
  { name: "SSLProxies", url: "https://www.sslproxies.org/", protocol: "http" },
  { name: "FreeProxyList", url: "https://free-proxy-list.net/", protocol: "http" },
  { name: "USProxy", url: "https://www.us-proxy.org/", protocol: "http" },
  { name: "UKProxy", url: "https://free-proxy-list.net/uk-proxy.html", protocol: "http" },
  { name: "AnonymousProxy", url: "https://free-proxy-list.net/anonymous-proxy.html", protocol: "http" },
  { name: "SSLProxyHtml", url: "https://free-proxy-list.net/ssl-proxy.html", protocol: "http" },
  { name: "FreeProxyWorld HTTP", url: "https://www.freeproxy.world/?type=http&anonymity=&country=&speed=&port=&page=1", protocol: "http" },
  { name: "FreeProxyWorld HTTPS", url: "https://www.freeproxy.world/?type=https&anonymity=&country=&speed=&port=&page=1", protocol: "http" },
  { name: "GeoNode Page 6", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=6&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "GeoNode Page 7", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=7&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "GeoNode Page 8", url: "https://proxylist.geonode.com/api/proxy-list?limit=500&page=8&sort_by=lastChecked&sort_type=desc", protocol: "auto" },
  { name: "hideip HTTPS", url: "https://raw.githubusercontent.com/zloi-user/hideip.me/main/https.txt", protocol: "http" },
];

export function seedDefaultProxyListSources(adapter) {
  try {
    // Top-ups run on EVERY boot (URL-deduplicated, one-time per marker):
    // factory sources added after V1 must reach existing installs too —
    // placing them after the V1 early-returns below would skip them forever.
    seedV2ProxyListSources(adapter);
    seedV3ProxyListSources(adapter);
    seedV4ProxyListSources(adapter);
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
    return { seeded, skipped: null };
  } catch (err) {
    console.warn(`[DB][migrate] proxy list seed failed (continuing): ${err.message}`);
    return { seeded: 0, skipped: "error" };
  }
}

/**
 * Shared top-up worker: insert factory sources added after a previous batch
 * without touching user data. URL-deduplicated; the marker keeps each batch
 * one-time per database.
 */
function seedMissingFactorySources(adapter, markerKey, label) {
  try {
    if (getMetaSync(adapter, markerKey, null)) return { seeded: 0, skipped: "marked" };
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
      setMetaSync(adapter, markerKey, "1");
    });
    if (seeded > 0) console.log(`[DB][migrate] seeded ${seeded} ${label} factory proxy list sources`);
    return { seeded, skipped: null };
  } catch (err) {
    console.warn(`[DB][migrate] proxy list ${label} seed failed (continuing): ${err.message}`);
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
  return seedMissingFactorySources(adapter, SEED_MARKER_V2, "V2");
}

/**
 * V3 top-up (2026-10-15, +33 sources): same merge semantics as V2.
 */
export function seedV3ProxyListSources(adapter) {
  return seedMissingFactorySources(adapter, SEED_MARKER_V3, "V3");
}

/**
 * V4 top-up (2026-10-16, +14 sources): same merge semantics as V2.
 */
export function seedV4ProxyListSources(adapter) {
  return seedMissingFactorySources(adapter, SEED_MARKER_V4, "V4");
}
