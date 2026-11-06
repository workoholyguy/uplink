import type { ExecResult, FixContext, FixPlugin, FixResult } from "../../types";

// Self-contained (type-only imports) so the runtime loader can import this file directly.

const id = "fix-slow-speed";
/** A healthy local hop answers well under this; the diagnosis saw 161 ms against a normal < 50 ms. */
export const SLOW_GATEWAY_MS = 100;
const SETTLE_SECONDS = "5";

type Step = [string, string[]];

interface Route {
  iface?: string;
  gateway?: string;
}

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

/** Average RTT from darwin (`round-trip min/avg/max/stddev = …`) or linux (`rtt min/avg/max/mdev = …`) ping output. */
export function parseAvgLatency(stdout: string): number | undefined {
  const m = /=\s*[\d.]+\/([\d.]+)\/[\d.]+/.exec(stdout);
  return m ? Number(m[1]) : undefined;
}

async function darwinRoute(ctx: FixContext): Promise<Route> {
  const r = await ctx.exec("route", ["-n", "get", "default"]);
  if (r.code !== 0) return {};
  return { iface: /interface:\s*(\S+)/.exec(r.stdout)?.[1], gateway: /gateway:\s*(\S+)/.exec(r.stdout)?.[1] };
}

async function linuxRoute(ctx: FixContext): Promise<Route> {
  const r = await ctx.exec("ip", ["route", "show", "default"]);
  if (r.code !== 0) return {};
  return { iface: /\bdev\s+(\S+)/.exec(r.stdout)?.[1], gateway: /\bvia\s+(\S+)/.exec(r.stdout)?.[1] };
}

async function darwinWifiDevice(ctx: FixContext): Promise<string> {
  const r = await ctx.exec("networksetup", ["-listallhardwareports"]);
  return /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\nDevice:\s*(\S+)/.exec(r.stdout)?.[1] ?? "en0";
}

/** Wi-Fi devices on linux from `nmcli -t -f DEVICE,TYPE device` (lines like `wlp2s0:wifi`). */
async function linuxWifiDevices(ctx: FixContext): Promise<string[] | undefined> {
  const r = await ctx.exec("nmcli", ["-t", "-f", "DEVICE,TYPE", "device"]);
  if (r.code !== 0) return undefined;
  return r.stdout
    .split("\n")
    .map((l) => l.trim().split(":"))
    .filter(([, type]) => type === "wifi")
    .map(([dev]) => dev);
}

function pingArgs(ctx: FixContext, gateway: string): string[] {
  // darwin: -t is the overall timeout; linux: -w is the deadline.
  return ctx.platform === "darwin" ? ["-c", "3", "-t", "5", gateway] : ["-c", "3", "-w", "5", gateway];
}

function fail(actions: string[], detail: string): FixResult {
  return { pluginId: id, ok: false, actions, detail };
}

function stepFailed(line: string, r: ExecResult): string {
  return `${line} failed (${r.code}): ${r.stderr.trim()}`;
}

/**
 * Re-associates the Wi-Fi link (radio off → on) so the Mac/PC drops a congested or
 * degraded association and rejoins, then re-pings the gateway to confirm latency recovered.
 * Skips the reset when the gateway is already fast, so repeated runs are harmless.
 */
async function resetWifi(ctx: FixContext, route: Route, wifiDev: string, steps: Step[]): Promise<FixResult> {
  const actions: string[] = [];
  const ping = route.gateway ? pingArgs(ctx, route.gateway) : undefined;

  if (ping && !ctx.dryRun) {
    const before = await ctx.exec("ping", ping);
    const ms = before.code === 0 ? parseAvgLatency(before.stdout) : undefined;
    actions.push(formatCommand("ping", ping));
    if (ms !== undefined && ms < SLOW_GATEWAY_MS) {
      return { pluginId: id, ok: true, actions, detail: `Gateway ${route.gateway} already answers in ${ms} ms; no reset needed` };
    }
  }

  for (const [cmd, args] of steps) {
    const line = formatCommand(cmd, args);
    actions.push(line);
    const r = await ctx.exec(cmd, args);
    if (r.code !== 0) return fail(actions, stepFailed(line, r));
  }

  if (!ping) {
    return { pluginId: id, ok: true, actions, detail: `Reset Wi-Fi on ${wifiDev}; no default gateway found to re-probe` };
  }
  const line = formatCommand("ping", ping);
  actions.push(line);
  const after = await ctx.exec("ping", ping);
  if (after.code !== 0) {
    return fail(actions, `Reset Wi-Fi on ${wifiDev}, but gateway re-probe failed (${after.code}): ${after.stderr.trim()}`);
  }
  const ms = parseAvgLatency(after.stdout);
  if (ms === undefined) {
    return ctx.dryRun
      ? { pluginId: id, ok: true, actions, detail: `Reset Wi-Fi on ${wifiDev} (dry run)` }
      : fail(actions, `Reset Wi-Fi on ${wifiDev}, but could not read the gateway latency`);
  }
  if (ms >= SLOW_GATEWAY_MS) {
    return fail(actions, `Reset Wi-Fi on ${wifiDev}, but gateway ${route.gateway} still answers in ${ms} ms (want < ${SLOW_GATEWAY_MS} ms); the router itself may be overloaded`);
  }
  return { pluginId: id, ok: true, actions, detail: `Reset Wi-Fi on ${wifiDev}; gateway ${route.gateway} now answers in ${ms} ms` };
}

export const fixSlowSpeed: FixPlugin = {
  id,
  title: "Reset a degraded Wi-Fi link so the router answers quickly again",
  handles: ["SLOW_SPEED"],
  platforms: ["darwin", "linux"],
  async run(ctx) {
    if (ctx.platform === "darwin") {
      const route = await darwinRoute(ctx);
      const dev = await darwinWifiDevice(ctx);
      if (route.iface && route.iface !== dev) {
        return fail([], `Default route is on ${route.iface}, not Wi-Fi (${dev}); a Wi-Fi reset would not help`);
      }
      return resetWifi(ctx, route, dev, [
        ["networksetup", ["-setairportpower", dev, "off"]],
        ["networksetup", ["-setairportpower", dev, "on"]],
        ["sleep", [SETTLE_SECONDS]],
      ]);
    }
    if (ctx.platform === "linux") {
      const route = await linuxRoute(ctx);
      const wifi = await linuxWifiDevices(ctx);
      if (!wifi) return fail([], "nmcli is unavailable; cannot reset Wi-Fi");
      const dev = route.iface ?? wifi[0] ?? (ctx.dryRun ? "wlan0" : undefined);
      if (!dev) return fail([], "No Wi-Fi interface found");
      if (!ctx.dryRun && !wifi.includes(dev)) {
        return fail([], `Default route is on ${dev}, not Wi-Fi; a Wi-Fi reset would not help`);
      }
      return resetWifi(ctx, route, dev, [
        ["nmcli", ["device", "disconnect", dev]],
        ["nmcli", ["device", "connect", dev]],
        ["sleep", [SETTLE_SECONDS]],
      ]);
    }
    return { pluginId: id, ok: false, actions: [], detail: `Unsupported platform: ${String(ctx.platform)}` };
  },
};

export default fixSlowSpeed;
