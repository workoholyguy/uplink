import type { ExecResult, FixContext, FixPlugin } from "../../types";

// Self-contained (type-only imports) so the runtime loader can import this file directly.

const id = "fix-slow-speed";
/** Same threshold the diagnoser uses for a slow router hop. */
export const ROUTER_SLOW_MS = 50;
const LOSS_LIMIT_PCT = 10;

function formatCommand(cmd: string, args: string[]): string {
  return [cmd, ...args].map((a) => (/^[\w@%+=:,./-]+$/.test(a) ? a : JSON.stringify(a))).join(" ");
}

/** Same ping shape as the monitor's gateway probe (macOS: -W ms / -t s, Linux: -W s). */
function pingArgs(platform: FixContext["platform"], host: string): string[] {
  return platform === "darwin" ? ["-n", "-c", "3", "-i", "0.2", "-W", "1000", "-t", "3", host] : ["-n", "-c", "3", "-i", "0.2", "-W", "1", host];
}

/** Parses avg latency and loss from BSD (`round-trip`) or iputils (`rtt`) ping output. */
export function parsePing(stdout: string): { avgMs?: number; lossPct?: number } {
  const loss = /([\d.]+)% packet loss/.exec(stdout);
  const rtt = /(?:round-trip|rtt) min\/avg\/max\/(?:stddev|mdev) = [\d.]+\/([\d.]+)\//.exec(stdout);
  return { lossPct: loss ? Number(loss[1]) : undefined, avgMs: rtt ? Number(rtt[1]) : undefined };
}

interface Step {
  cmd: string;
  args: string[];
}

/** What the platform-specific tuning found and changed. */
interface Tuning {
  failed?: string;
  changed: string[];
  skipped: string[];
}

async function runStep(ctx: FixContext, step: Step, actions: string[]): Promise<ExecResult> {
  actions.push(formatCommand(step.cmd, step.args));
  return ctx.exec(step.cmd, step.args);
}

function failure(step: Step, r: ExecResult): string {
  return `${formatCommand(step.cmd, step.args)} failed (${r.code}): ${r.stderr.trim()}`;
}

/**
 * macOS: AWDL (awdl0, used by AirDrop/AirPlay/Sidecar) hops the Wi-Fi radio off the
 * router's channel several times a second, which shows up as exactly this kind of
 * latency at the first hop. Bring it down if it is up (idempotent).
 */
async function tuneDarwin(ctx: FixContext, actions: string[]): Promise<Tuning> {
  const t: Tuning = { changed: [], skipped: [] };
  const awdl = await ctx.exec("ifconfig", ["awdl0"]);
  if (awdl.code !== 0) {
    t.skipped.push("no awdl0 interface");
  } else if (/flags=[0-9a-f]+<(?:[A-Z_]+,)*UP[,>]/i.test(awdl.stdout) || !awdl.stdout.trim()) {
    // Empty stdout only happens in dry run: rehearse the change.
    const step = { cmd: "ifconfig", args: ["awdl0", "down"] };
    const r = await runStep(ctx, step, actions);
    if (r.code !== 0) return { ...t, failed: failure(step, r) };
    t.changed.push("AWDL (awdl0) brought down; it comes back with AirDrop/AirPlay or a reboot");
  } else {
    t.skipped.push("AWDL already down");
  }
  return t;
}

/** Linux: Wi-Fi power saving parks the radio between beacons, adding tens of ms per hop. */
async function tuneLinux(ctx: FixContext, iface: string | undefined, actions: string[]): Promise<Tuning> {
  const t: Tuning = { changed: [], skipped: [] };
  if (!iface) return { ...t, skipped: ["no default-route interface"] };
  const get = await ctx.exec("iw", ["dev", iface, "get", "power_save"]);
  if (get.code !== 0) {
    t.skipped.push(`${iface} is not a Wi-Fi interface (or iw is missing)`);
  } else if (/power save:\s*off/i.test(get.stdout)) {
    t.skipped.push(`Wi-Fi power saving already off on ${iface}`);
  } else {
    const step = { cmd: "iw", args: ["dev", iface, "set", "power_save", "off"] };
    const r = await runStep(ctx, step, actions);
    if (r.code !== 0) return { ...t, failed: failure(step, r) };
    t.changed.push(`Wi-Fi power saving turned off on ${iface}`);
  }
  return t;
}

async function defaultRoute(ctx: FixContext): Promise<{ gateway?: string; iface?: string }> {
  if (ctx.platform === "darwin") {
    const r = await ctx.exec("route", ["-n", "get", "default"]);
    if (r.code !== 0) return {};
    return { gateway: /gateway:\s*(\S+)/.exec(r.stdout)?.[1], iface: /interface:\s*(\S+)/.exec(r.stdout)?.[1] };
  }
  const r = await ctx.exec("ip", ["route", "show", "default"]);
  if (r.code !== 0) return {};
  return { gateway: /\bvia\s+(\S+)/.exec(r.stdout)?.[1], iface: /\bdev\s+(\S+)/.exec(r.stdout)?.[1] };
}

/**
 * Everything is slow from the first hop (the router), so the delay is on this machine's
 * link. Removes the usual local causes of Wi-Fi latency, then re-pings the gateway.
 */
export const fixSlowSpeed: FixPlugin = {
  id,
  title: "Cut local Wi-Fi latency to the router (AWDL off on macOS, power saving off on Linux)",
  handles: ["SLOW_SPEED"],
  platforms: ["darwin", "linux"],
  async run(ctx) {
    if (ctx.platform !== "darwin" && ctx.platform !== "linux") {
      return { pluginId: id, ok: false, actions: [], detail: `Unsupported platform: ${String(ctx.platform)}` };
    }
    const actions: string[] = [];
    const route = await defaultRoute(ctx);
    const tuning = ctx.platform === "darwin" ? await tuneDarwin(ctx, actions) : await tuneLinux(ctx, route.iface, actions);
    if (tuning.failed) return { pluginId: id, ok: false, actions, detail: tuning.failed };

    const did = [...tuning.changed, ...tuning.skipped].join("; ") || "nothing to change";
    if (!route.gateway) {
      return ctx.dryRun
        ? { pluginId: id, ok: true, actions, detail: `${did}; gateway re-probe skipped in dry run` }
        : { pluginId: id, ok: false, actions, detail: `${did}; no default gateway to re-probe` };
    }

    const ping = await runStep(ctx, { cmd: "ping", args: pingArgs(ctx.platform, route.gateway) }, actions);
    const { avgMs, lossPct } = parsePing(ping.stdout);
    if (ping.code !== 0 && !(lossPct !== undefined && lossPct < 100)) {
      return { pluginId: id, ok: false, actions, detail: `${did}; gateway ${route.gateway} re-probe failed (${ping.code}): ${ping.stderr.trim()}` };
    }
    if ((avgMs ?? 0) >= ROUTER_SLOW_MS || (lossPct ?? 0) >= LOSS_LIMIT_PCT) {
      return {
        pluginId: id,
        ok: false,
        actions,
        detail: `${did}; gateway ${route.gateway} still slow: ${avgMs ?? "?"} ms, ${lossPct ?? "?"}% loss (target under ${ROUTER_SLOW_MS} ms). Move closer to the router or reduce load on it.`,
      };
    }
    const measured = avgMs === undefined ? "re-probe answered" : `answers in ${avgMs} ms, ${lossPct ?? 0}% loss`;
    return { pluginId: id, ok: true, actions, detail: `${did}; gateway ${route.gateway} ${measured}` };
  },
};

export default fixSlowSpeed;
