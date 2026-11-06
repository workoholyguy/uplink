import type { ExecResult, FixContext, FixPlugin, FixResult } from "../../types";

// Self-contained (type-only imports) so the runtime loader can import this file directly.

const id = "fix-unknown";

// Same thresholds the monitor uses to call the gateway ping "degraded".
const SLOW_GATEWAY_MS = 50;
const LOSS_DEGRADED_PCT = 10;

interface Gateway {
  ip: string;
  iface?: string;
}

interface PingStats {
  lossPct: number;
  avgMs?: number;
}

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

async function defaultGateway(ctx: FixContext): Promise<Gateway | undefined> {
  if (ctx.platform === "darwin") {
    const r = await ctx.exec("route", ["-n", "get", "default"]);
    const ip = r.code === 0 ? /^\s*gateway:\s*(\S+)/m.exec(r.stdout)?.[1] : undefined;
    return ip ? { ip, iface: /^\s*interface:\s*(\S+)/m.exec(r.stdout)?.[1] } : undefined;
  }
  const r = await ctx.exec("ip", ["route", "show", "default"]);
  const m = r.code === 0 ? /\bvia\s+(\S+)(?:.*?\bdev\s+(\S+))?/.exec(r.stdout) : null;
  return m ? { ip: m[1], iface: m[2] } : undefined;
}

function pingArgs(ctx: FixContext, host: string): string[] {
  // macOS: -W is per-reply wait in ms, -t the overall timeout in s. Linux: -W in s, -w the overall deadline.
  return ctx.platform === "darwin"
    ? ["-n", "-c", "5", "-i", "0.2", "-W", "1000", "-t", "5", host]
    : ["-n", "-c", "5", "-i", "0.2", "-W", "1", "-w", "5", host];
}

function parsePing(out: string): PingStats | null {
  const m = /(\d+) packets transmitted, (\d+) (?:packets )?received,.*?([\d.]+)% packet loss/.exec(out);
  if (!m) return null;
  const rtt = /(?:rtt|round-trip) [\w/]+ = [\d.]+\/([\d.]+)\//.exec(out);
  return { lossPct: Number(m[3]), avgMs: rtt ? Number(rtt[1]) : undefined };
}

function describe(stats: PingStats | null): string {
  if (!stats) return "no ping summary";
  const ms = stats.avgMs === undefined ? "no replies" : `${Math.round(stats.avgMs * 10) / 10} ms`;
  return `${ms}, ${stats.lossPct}% loss`;
}

/** Pings the gateway; healthy means under the monitor's degraded thresholds. In dryRun nothing is measured. */
async function probe(ctx: FixContext, gw: string, actions: string[]): Promise<{ healthy: boolean; stats: PingStats | null }> {
  const args = pingArgs(ctx, gw);
  actions.push(formatCommand("ping", args));
  const r = await ctx.exec("ping", args);
  const stats = parsePing(r.stdout);
  if (!stats) return { healthy: false, stats };
  return { healthy: stats.lossPct < LOSS_DEGRADED_PCT && (stats.avgMs ?? Infinity) < SLOW_GATEWAY_MS, stats };
}

/** A missing neighbour entry means there is nothing stale to clear: that is success, not failure. */
function alreadyClear(r: ExecResult): boolean {
  return /cannot locate|no entry|nothing to flush/i.test(`${r.stdout}\n${r.stderr}`);
}

function flushArgs(ctx: FixContext, gw: Gateway): [string, string[]] {
  if (ctx.platform === "darwin") return ["arp", ["-d", gw.ip]];
  return ["ip", ["neigh", "flush", "to", gw.ip, ...(gw.iface ? ["dev", gw.iface] : [])]];
}

/**
 * Unclassified fault whose only evidence is a short gateway latency spike (60 ms vs. the
 * 50 ms threshold) while every node reports ok. Re-probes the gateway first: if it is
 * healthy again the spike was transient and nothing is changed. Otherwise it clears the
 * gateway's cached ARP/neighbour entry (forcing a fresh MAC resolution, which fixes stale
 * or flapping entries) and re-probes to verify.
 */
export const fixUnknown: FixPlugin = {
  id,
  title: "Clear the gateway's stale ARP entry when gateway latency spikes",
  handles: ["UNKNOWN"],
  platforms: ["darwin", "linux"],
  async run(ctx): Promise<FixResult> {
    if (ctx.platform !== "darwin" && ctx.platform !== "linux") {
      return { pluginId: id, ok: false, actions: [], detail: `Unsupported platform: ${String(ctx.platform)}` };
    }

    const actions: string[] = [];
    const found = await defaultGateway(ctx);
    if (!found && !ctx.dryRun) {
      return { pluginId: id, ok: false, actions, detail: "No default gateway found; nothing to repair on the gateway link" };
    }
    const gw: Gateway = found ?? { ip: "<gateway>" };

    const before = await probe(ctx, gw.ip, actions);
    if (before.healthy) {
      return { pluginId: id, ok: true, actions, detail: `Gateway ${gw.ip} is healthy again (${describe(before.stats)}); the spike was transient, no change made` };
    }

    const [cmd, args] = flushArgs(ctx, gw);
    actions.push(formatCommand(cmd, args));
    const flush = await ctx.exec(cmd, args);
    if (flush.code !== 0 && !alreadyClear(flush)) {
      return { pluginId: id, ok: false, actions, detail: `${formatCommand(cmd, args)} failed (${flush.code}): ${flush.stderr.trim()}` };
    }

    const after = await probe(ctx, gw.ip, actions);
    if (after.healthy || ctx.dryRun) {
      return { pluginId: id, ok: true, actions, detail: `Cleared the ARP entry for gateway ${gw.ip}; gateway ping now ${describe(after.stats)}` };
    }
    return {
      pluginId: id,
      ok: false,
      actions,
      detail: `Cleared the ARP entry for gateway ${gw.ip}, but gateway ping is still degraded (${describe(after.stats)}); the router itself may be overloaded`,
    };
  },
};

export default fixUnknown;
