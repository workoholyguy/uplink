import type { ExecResult, FixContext, FixPlugin, FixResult } from "../../types";

// Self-contained (type-only imports) so the runtime loader can import this file directly.

const id = "fix-unknown";

/** Same gateway thresholds the monitor uses (SLOW_MS.router, LOSS_DEGRADED_PCT). */
const GATEWAY_SLOW_MS = 50;
const LOSS_DEGRADED_PCT = 10;
const REJOIN_WAIT_S = "6";

type Platform = FixContext["platform"];

interface PingStats {
  lossPct: number;
  avgMs?: number;
}

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

function parsePing(out: string): PingStats | null {
  const m = out.match(/(\d+) packets transmitted, (\d+) (?:packets )?received,.*?([\d.]+)% packet loss/);
  if (!m) return null;
  const rtt = out.match(/(?:rtt|round-trip) [\w/]+ = [\d.]+\/([\d.]+)\//);
  return { lossPct: Number(m[3]), avgMs: rtt ? Number(rtt[1]) : undefined };
}

const healthy = (s: PingStats | null): boolean =>
  !!s && s.avgMs !== undefined && s.lossPct < LOSS_DEGRADED_PCT && s.avgMs < GATEWAY_SLOW_MS;

const describePing = (s: PingStats | null): string =>
  !s ? "unmeasured" : s.avgMs === undefined ? `${s.lossPct}% loss` : `${Math.round(s.avgMs * 10) / 10} ms, ${s.lossPct}% loss`;

function pingArgs(platform: Platform, host: string): string[] {
  // macOS: -W per-reply wait in ms, -t overall timeout in s. Linux: -W in s.
  return platform === "darwin" ? ["-n", "-c", "5", "-i", "0.2", "-W", "1000", "-t", "5", host] : ["-n", "-c", "5", "-i", "0.2", "-W", "1", host];
}

interface Route {
  gateway?: string;
  iface?: string;
}

async function defaultRoute(ctx: FixContext): Promise<Route> {
  if (ctx.platform === "darwin") {
    const r = await ctx.exec("route", ["-n", "get", "default"]);
    if (r.code !== 0) return {};
    return { gateway: /^\s*gateway:\s*(\S+)/m.exec(r.stdout)?.[1], iface: /^\s*interface:\s*(\S+)/m.exec(r.stdout)?.[1] };
  }
  const r = await ctx.exec("ip", ["route", "show", "default"]);
  if (r.code !== 0) return {};
  return { gateway: /\bvia\s+(\S+)/.exec(r.stdout)?.[1], iface: /\bdev\s+(\S+)/.exec(r.stdout)?.[1] };
}

async function darwinWifiDevice(ctx: FixContext): Promise<string | undefined> {
  const r = await ctx.exec("networksetup", ["-listallhardwareports"]);
  return /Hardware Port:\s*(?:Wi-Fi|AirPort)\s*\nDevice:\s*(\S+)/.exec(r.stdout)?.[1];
}

class StepFailed extends Error {}

/**
 * Latency that starts at the first hop (gateway ping well above normal while Wi-Fi is
 * associated) is almost always the local Wi-Fi link. Least disruptive first:
 *  1. flush the DNS cache (DNS lookups were slow too),
 *  2. stop the radio's background scanning that adds latency on the link
 *     (darwin: AWDL/AirDrop interface awdl0; linux: Wi-Fi power save),
 *  3. re-ping the gateway; only if still slow, re-join Wi-Fi so it re-picks band/AP,
 *  4. re-ping the gateway to verify.
 */
export const fixUnknown: FixPlugin = {
  id,
  title: "Cut high Wi-Fi latency to the gateway (flush DNS, quiet the radio, re-join Wi-Fi)",
  handles: ["UNKNOWN", "SLOW_SPEED"],
  platforms: ["darwin", "linux"],
  async run(ctx) {
    if (ctx.platform !== "darwin" && ctx.platform !== "linux") {
      return { pluginId: id, ok: false, actions: [], detail: `Unsupported platform: ${String(ctx.platform)}` };
    }
    const actions: string[] = [];
    const notes: string[] = [];

    const run = async (cmd: string, args: string[]): Promise<ExecResult> => {
      actions.push(formatCommand(cmd, args));
      return ctx.exec(cmd, args);
    };
    const must = async (cmd: string, args: string[]): Promise<ExecResult> => {
      const r = await run(cmd, args);
      if (r.code !== 0) throw new StepFailed(`${formatCommand(cmd, args)} failed (${r.code}): ${r.stderr.trim()}`);
      return r;
    };
    const fail = (detail: string): FixResult => ({ pluginId: id, ok: false, actions, detail });

    const route = await defaultRoute(ctx);
    if (!route.gateway && !ctx.dryRun) return fail("No default gateway found; nothing to measure or repair");
    const pingGateway = async (): Promise<PingStats | null> => {
      if (!route.gateway) return null;
      const r = await run("ping", pingArgs(ctx.platform, route.gateway));
      return parsePing(r.stdout) ?? (r.code !== 0 ? { lossPct: 100 } : null);
    };

    try {
      const before = await pingGateway();
      if (healthy(before)) {
        return fail(`Gateway ${route.gateway} answers in ${describePing(before)}: the slowdown is not on the local link; nothing changed`);
      }

      // 1. DNS cache (best effort: a stale/slow cache isn't the root cause, so a failure doesn't stop the repair).
      const flush: Array<[string, string[]]> =
        ctx.platform === "darwin" ? [["dscacheutil", ["-flushcache"]], ["killall", ["-HUP", "mDNSResponder"]]] : [["resolvectl", ["flush-caches"]]];
      for (const [cmd, args] of flush) {
        const r = await run(cmd, args);
        if (r.code !== 0) {
          notes.push(`DNS cache flush skipped (${formatCommand(cmd, args)}: ${r.stderr.trim() || `exit ${r.code}`})`);
          break;
        }
      }

      // 2. Quiet the radio.
      let wifi: string | undefined;
      let rejoin: Array<[string, string[]]> = [];
      if (ctx.platform === "darwin") {
        const dev = (await darwinWifiDevice(ctx)) ?? (ctx.dryRun ? "en0" : undefined);
        wifi = dev && (!route.iface || route.iface === dev) ? dev : undefined;
        if (wifi) {
          const awdl = await ctx.exec("ifconfig", ["awdl0"]);
          const flags = /flags=\w+<([^>]*)>/.exec(awdl.stdout)?.[1]?.split(",");
          if (awdl.code === 0 && (!flags || flags.includes("UP"))) {
            await must("ifconfig", ["awdl0", "down"]);
            notes.push("AWDL (AirDrop) interface awdl0 turned off until next reboot");
          }
          rejoin = [["networksetup", ["-setairportpower", wifi, "off"]], ["networksetup", ["-setairportpower", wifi, "on"]]];
        }
      } else {
        const iface = route.iface ?? (ctx.dryRun ? "wlan0" : undefined);
        if (iface) {
          const ps = await ctx.exec("iw", ["dev", iface, "get", "power_save"]);
          if (ps.code === 0) {
            wifi = iface;
            if (!/Power save:\s*off/i.test(ps.stdout)) {
              await must("iw", ["dev", iface, "set", "power_save", "off"]);
              notes.push(`Wi-Fi power save turned off on ${iface}`);
            }
            rejoin = [["nmcli", ["radio", "wifi", "off"]], ["nmcli", ["radio", "wifi", "on"]]];
          }
        }
      }

      // 3. Re-probe; re-join Wi-Fi only if still slow.
      let after = await pingGateway();
      if (!healthy(after) && rejoin.length > 0) {
        const [[offCmd, offArgs], [onCmd, onArgs]] = rejoin;
        const off = await run(offCmd, offArgs);
        // Always try to bring the radio back, even if turning it off reported an error.
        const on = await run(onCmd, onArgs);
        if (on.code !== 0) throw new StepFailed(`${formatCommand(onCmd, onArgs)} failed (${on.code}): ${on.stderr.trim()}`);
        if (off.code !== 0) throw new StepFailed(`${formatCommand(offCmd, offArgs)} failed (${off.code}): ${off.stderr.trim()}`);
        notes.push(`Wi-Fi on ${wifi} re-joined`);
        await run("sleep", [REJOIN_WAIT_S]);
        after = await pingGateway();
      }

      // 4. Verify.
      const summary = [`gateway ${describePing(before)} → ${describePing(after)}`, ...notes].join("; ");
      if (ctx.dryRun) return { pluginId: id, ok: true, actions, detail: `Dry run: rehearsed repair; ${summary}` };
      if (!healthy(after)) {
        return fail(`Gateway latency still high (${summary}); likely router/LAN congestion — reboot the router or pause heavy uploads`);
      }
      return { pluginId: id, ok: true, actions, detail: `Gateway latency back to normal: ${summary}` };
    } catch (e) {
      if (e instanceof StepFailed) return fail(e.message);
      throw e;
    }
  },
};

export default fixUnknown;
