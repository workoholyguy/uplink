import { describe, expect, it } from "vitest";
import type { FixContext } from "../../types";
import { isFixPlugin } from "../index";
import { fakeCtx } from "../test-helpers";
import { fixSlowSpeed, parseAvgLatency } from "./fix-slow-speed.plugin";

const DARWIN_ROUTE = {
  "route -n get default": { stdout: "   route to: default\ndestination: default\n    gateway: 172.20.10.1\n  interface: en0\n" },
  "networksetup -listallhardwareports": { stdout: "\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa\n" },
};
const LINUX_ROUTE = {
  "ip route show default": { stdout: "default via 192.168.1.1 dev wlp2s0 proto dhcp metric 600\n" },
  "nmcli -t -f DEVICE,TYPE device": { stdout: "wlp2s0:wifi\nenp3s0:ethernet\nlo:loopback\n" },
};
const darwinPing = (avg: number) => ({ stdout: `3 packets transmitted, 3 packets received, 0.0% packet loss\nround-trip min/avg/max/stddev = 1.0/${avg}/200.0/1.0 ms\n` });
const linuxPing = (avg: number) => ({ stdout: `3 packets transmitted, 3 received, 0% packet loss, time 2003ms\nrtt min/avg/max/mdev = 1.0/${avg}/200.0/1.0 ms\n` });

const D_PING = "ping -c 3 -t 5 172.20.10.1";
const L_PING = "ping -c 3 -w 5 192.168.1.1";
const D_RESET = ["networksetup -setairportpower en0 off", "networksetup -setairportpower en0 on", "sleep 5"];
const L_RESET = ["nmcli device disconnect wlp2s0", "nmcli device connect wlp2s0", "sleep 5"];

/** Responds to ping with each canned result in turn (before, then after the reset). */
function sequencedPing(ctx: FixContext, results: Array<{ code?: number; stdout?: string; stderr?: string }>): FixContext {
  let i = 0;
  return {
    ...ctx,
    async exec(cmd, args) {
      const r = await ctx.exec(cmd, args);
      if (cmd !== "ping") return r;
      return { code: 0, stdout: "", stderr: "", ...results[Math.min(i++, results.length - 1)] };
    },
  };
}

describe("fix-slow-speed", () => {
  it("is a valid plugin for SLOW_SPEED on darwin and linux", () => {
    expect(isFixPlugin(fixSlowSpeed)).toBe(true);
    expect(fixSlowSpeed.id).toBe("fix-slow-speed");
    expect(fixSlowSpeed.handles).toEqual(["SLOW_SPEED"]);
    expect(fixSlowSpeed.platforms).toEqual(["darwin", "linux"]);
  });

  it("parses darwin and linux ping averages", () => {
    expect(parseAvgLatency(darwinPing(161.9).stdout)).toBe(161.9);
    expect(parseAvgLatency(linuxPing(12.5).stdout)).toBe(12.5);
    expect(parseAvgLatency("Request timeout")).toBeUndefined();
  });

  it("darwin: resets Wi-Fi when the gateway is slow and verifies it recovered", async () => {
    const { ctx, calls } = fakeCtx("darwin", DARWIN_ROUTE);
    const r = await fixSlowSpeed.run(sequencedPing(ctx, [darwinPing(161.9), darwinPing(8.2)]));
    expect(r).toMatchObject({ pluginId: "fix-slow-speed", ok: true });
    expect(calls).toEqual(["route -n get default", "networksetup -listallhardwareports", D_PING, ...D_RESET, D_PING]);
    expect(r.actions).toEqual([D_PING, ...D_RESET, D_PING]);
    expect(r.detail).toBe("Reset Wi-Fi on en0; gateway 172.20.10.1 now answers in 8.2 ms");
  });

  it("darwin: does nothing when the gateway is already fast (idempotent)", async () => {
    const { ctx, calls } = fakeCtx("darwin", { ...DARWIN_ROUTE, ping: darwinPing(12) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain(D_RESET[0]);
    expect(r.detail).toContain("no reset needed");
  });

  it("darwin: refuses to reset Wi-Fi when the default route is on Ethernet", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN_ROUTE,
      "route -n get default": { stdout: "gateway: 192.168.1.1\ninterface: en7\n" },
    });
    const r = await fixSlowSpeed.run(ctx);
    expect(r).toMatchObject({ ok: false, actions: [] });
    expect(r.detail).toContain("en7, not Wi-Fi");
    expect(calls.some((c) => c.startsWith("networksetup -setairportpower"))).toBe(false);
  });

  it("darwin: reports a failing command without throwing and stops", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN_ROUTE,
      ping: darwinPing(161.9),
      "networksetup -setairportpower en0 off": { code: 10, stderr: "You cannot set Wi-Fi power.\n" },
    });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("networksetup -setairportpower en0 off failed (10): You cannot set Wi-Fi power.");
    expect(r.actions).toEqual([D_PING, D_RESET[0]]);
    expect(calls).not.toContain(D_RESET[1]);
  });

  it("darwin: fails when the gateway is still slow after the reset", async () => {
    const { ctx } = fakeCtx("darwin", { ...DARWIN_ROUTE, ping: darwinPing(170) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.actions).toEqual([D_PING, ...D_RESET, D_PING]);
    expect(r.detail).toContain("still answers in 170 ms");
  });

  it("linux: reconnects the Wi-Fi device and verifies it recovered", async () => {
    const { ctx, calls } = fakeCtx("linux", LINUX_ROUTE);
    const r = await fixSlowSpeed.run(sequencedPing(ctx, [linuxPing(150), linuxPing(4)]));
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["ip route show default", "nmcli -t -f DEVICE,TYPE device", L_PING, ...L_RESET, L_PING]);
    expect(r.actions).toEqual([L_PING, ...L_RESET, L_PING]);
  });

  it("linux: reports a failing nmcli reconnect", async () => {
    const { ctx } = fakeCtx("linux", {
      ...LINUX_ROUTE,
      ping: linuxPing(150),
      "nmcli device connect": { code: 4, stderr: "Error: Connection activation failed." },
    });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("nmcli device connect wlp2s0 failed (4): Error: Connection activation failed.");
  });

  it("linux: fails cleanly when nmcli is missing or the route is wired", async () => {
    const missing = fakeCtx("linux", { ...LINUX_ROUTE, "nmcli -t -f DEVICE,TYPE device": { code: 127, stderr: "nmcli: not found" } });
    expect((await fixSlowSpeed.run(missing.ctx)).detail).toBe("nmcli is unavailable; cannot reset Wi-Fi");

    const wired = fakeCtx("linux", { ...LINUX_ROUTE, "ip route show default": { stdout: "default via 10.0.0.1 dev enp3s0\n" } });
    const r = await fixSlowSpeed.run(wired.ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("enp3s0, not Wi-Fi");
  });

  it("linux: reports a failed gateway re-probe", async () => {
    const { ctx } = fakeCtx("linux", LINUX_ROUTE);
    const r = await fixSlowSpeed.run(sequencedPing(ctx, [linuxPing(150), { code: 1, stderr: "Network is unreachable" }]));
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("gateway re-probe failed (1): Network is unreachable");
  });

  it("dry run succeeds on both platforms with the reset recorded", async () => {
    const d = fakeCtx("darwin", {}, true);
    expect((await fixSlowSpeed.run(d.ctx)).ok).toBe(true);
    expect(d.calls).toEqual(["route -n get default", "networksetup -listallhardwareports", ...D_RESET]);

    const l = fakeCtx("linux", {}, true);
    expect((await fixSlowSpeed.run(l.ctx)).ok).toBe(true);
    expect(l.calls).toContain("nmcli device disconnect wlan0");
  });

  it("rejects an unsupported platform", async () => {
    const { ctx, calls } = fakeCtx("linux");
    const r = await fixSlowSpeed.run({ ...ctx, platform: "win32" } as unknown as FixContext);
    expect(r).toEqual({ pluginId: "fix-slow-speed", ok: false, actions: [], detail: "Unsupported platform: win32" });
    expect(calls).toEqual([]);
  });
});
