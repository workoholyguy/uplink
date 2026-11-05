import { describe, expect, it } from "vitest";
import type { ExecResult, FixContext } from "../../types";
import { isFixPlugin } from "../index";
import { fixUnknown } from "./fix-unknown.plugin";

type Canned = Partial<ExecResult> | Array<Partial<ExecResult>>;

/** Fake exec: records calls; longest matching prefix wins; an array answers successive calls in order (last repeats). */
function fakeCtx(platform: FixContext["platform"], responses: Record<string, Canned> = {}, dryRun = false) {
  const calls: string[] = [];
  const seen: Record<string, number> = {};
  const ctx: FixContext = {
    platform,
    dryRun,
    async exec(cmd, args) {
      const line = [cmd, ...args].join(" ");
      calls.push(line);
      const key = Object.keys(responses)
        .filter((k) => line.startsWith(k))
        .sort((a, b) => b.length - a.length)[0];
      let canned: Partial<ExecResult> = {};
      if (key) {
        const r = responses[key];
        if (Array.isArray(r)) {
          const i = seen[key] ?? 0;
          seen[key] = i + 1;
          canned = r[Math.min(i, r.length - 1)];
        } else canned = r;
      }
      return { code: 0, stdout: "", stderr: "", ...canned };
    },
  };
  return { ctx, calls };
}

const pingOut = (avg: number, loss = 0) => ({
  stdout: `PING 10.200.0.1 (10.200.0.1): 56 data bytes\n\n--- 10.200.0.1 ping statistics ---\n5 packets transmitted, ${Math.round(5 * (1 - loss / 100))} packets received, ${loss.toFixed(1)}% packet loss\nround-trip min/avg/max/stddev = ${(avg * 0.9).toFixed(3)}/${avg}/${(avg * 1.1).toFixed(3)}/2.000 ms\n`,
});
const SLOW = pingOut(190.5);
const FAST = pingOut(4.2);

const DARWIN_PING = "ping -n -c 5 -i 0.2 -W 1000 -t 5 10.200.0.1";
const LINUX_PING = "ping -n -c 5 -i 0.2 -W 1 10.200.0.1";

const DARWIN = {
  "route -n get default": { stdout: "   route to: default\ndestination: default\n    gateway: 10.200.0.1\n  interface: en0\n" },
  "networksetup -listallhardwareports": { stdout: "\nHardware Port: Wi-Fi\nDevice: en0\nEthernet Address: aa\n" },
  "ifconfig awdl0": { stdout: "awdl0: flags=8943<UP,BROADCAST,RUNNING,PROMISC,SIMPLEX,MULTICAST> mtu 1484\n" },
};
const LINUX = {
  "ip route show default": { stdout: "default via 10.200.0.1 dev wlp2s0 proto dhcp metric 600\n" },
  "iw dev wlp2s0 get power_save": { stdout: "Power save: on\n" },
};

describe("fix-unknown", () => {
  it("is a valid plugin for UNKNOWN / SLOW_SPEED on darwin and linux", () => {
    expect(isFixPlugin(fixUnknown)).toBe(true);
    expect(fixUnknown.id).toBe("fix-unknown");
    expect(fixUnknown.handles).toEqual(["UNKNOWN", "SLOW_SPEED"]);
    expect(fixUnknown.platforms).toEqual(["darwin", "linux"]);
  });

  it("darwin: flushes DNS, turns off awdl0 and verifies the gateway is fast again", async () => {
    const { ctx, calls } = fakeCtx("darwin", { ...DARWIN, [DARWIN_PING]: [SLOW, FAST] });
    const r = await fixUnknown.run(ctx);
    expect(r).toMatchObject({ pluginId: "fix-unknown", ok: true });
    expect(calls).toEqual([
      "route -n get default",
      DARWIN_PING,
      "dscacheutil -flushcache",
      "killall -HUP mDNSResponder",
      "networksetup -listallhardwareports",
      "ifconfig awdl0",
      "ifconfig awdl0 down",
      DARWIN_PING,
    ]);
    expect(r.actions).toEqual([DARWIN_PING, "dscacheutil -flushcache", "killall -HUP mDNSResponder", "ifconfig awdl0 down", DARWIN_PING]);
    expect(r.detail).toContain("190.5 ms, 0% loss → 4.2 ms, 0% loss");
    expect(r.detail).toContain("awdl0");
  });

  it("darwin: re-joins Wi-Fi only when still slow, and skips awdl0 when already down", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN,
      "ifconfig awdl0": { stdout: "awdl0: flags=8902<BROADCAST,PROMISC,SIMPLEX,MULTICAST> mtu 1484\n" },
      [DARWIN_PING]: [SLOW, SLOW, FAST],
    });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain("ifconfig awdl0 down");
    expect(r.actions.slice(-4)).toEqual(["networksetup -setairportpower en0 off", "networksetup -setairportpower en0 on", "sleep 6", DARWIN_PING]);
    expect(r.detail).toContain("re-joined");
  });

  it("darwin: leaves Wi-Fi alone when the default route is wired", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN,
      "route -n get default": { stdout: "gateway: 10.200.0.1\ninterface: en7\n" },
      [DARWIN_PING]: SLOW,
    });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("still high");
    expect(calls.filter((c) => /ifconfig|setairportpower/.test(c))).toEqual([]);
  });

  it("linux: flushes DNS, turns off Wi-Fi power save and verifies", async () => {
    const { ctx, calls } = fakeCtx("linux", { ...LINUX, [LINUX_PING]: [SLOW, FAST] });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toEqual([
      "ip route show default",
      LINUX_PING,
      "resolvectl flush-caches",
      "iw dev wlp2s0 get power_save",
      "iw dev wlp2s0 set power_save off",
      LINUX_PING,
    ]);
    expect(r.detail).toContain("power save turned off on wlp2s0");
  });

  it("linux: DNS flush failure is not fatal; re-joins Wi-Fi via nmcli when still slow", async () => {
    const { ctx, calls } = fakeCtx("linux", {
      ...LINUX,
      "iw dev wlp2s0 get power_save": { stdout: "Power save: off\n" },
      resolvectl: { code: 1, stderr: "Failed to flush caches: Unit dbus-org.freedesktop.resolve1.service not found." },
      [LINUX_PING]: [SLOW, SLOW, FAST],
    });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain("iw dev wlp2s0 set power_save off");
    expect(calls).toContain("nmcli radio wifi off");
    expect(calls).toContain("nmcli radio wifi on");
    expect(r.detail).toContain("DNS cache flush skipped");
  });

  it("does nothing when the gateway is already fast", async () => {
    const { ctx, calls } = fakeCtx("darwin", { ...DARWIN, [DARWIN_PING]: FAST });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("not on the local link");
    expect(calls).toEqual(["route -n get default", DARWIN_PING]);
  });

  it("fails without a default gateway", async () => {
    const { ctx, calls } = fakeCtx("linux", { "ip route show default": { stdout: "" } });
    const r = await fixUnknown.run(ctx);
    expect(r).toEqual({ pluginId: "fix-unknown", ok: false, actions: [], detail: "No default gateway found; nothing to measure or repair" });
    expect(calls).toEqual(["ip route show default"]);
  });

  it("darwin: reports a failing command without throwing and stops", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN,
      [DARWIN_PING]: SLOW,
      "ifconfig awdl0 down": { code: 1, stderr: "ifconfig: down: permission denied\n" },
    });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("ifconfig awdl0 down failed (1): ifconfig: down: permission denied");
    expect(calls[calls.length - 1]).toBe("ifconfig awdl0 down");
  });

  it("linux: still turns the radio back on when turning it off failed", async () => {
    const { ctx, calls } = fakeCtx("linux", {
      ...LINUX,
      [LINUX_PING]: SLOW,
      "nmcli radio wifi off": { code: 8, stderr: "Error: NetworkManager is not running." },
    });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("nmcli radio wifi off failed (8)");
    expect(calls.slice(-2)).toEqual(["nmcli radio wifi off", "nmcli radio wifi on"]);
  });

  it("treats a ping with no replies as still broken", async () => {
    const { ctx } = fakeCtx("linux", { ...LINUX, [LINUX_PING]: [SLOW, { code: 1, stdout: "" }] });
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("100% loss");
  });

  it.each(["darwin", "linux"] as const)("%s dry run rehearses every step", async (platform) => {
    const { ctx, calls } = fakeCtx(platform, {}, true);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(r.detail).toContain("Dry run");
    expect(calls).toContain(platform === "darwin" ? "ifconfig awdl0 down" : "iw dev wlan0 set power_save off");
    expect(calls).toContain(platform === "darwin" ? "networksetup -setairportpower en0 on" : "nmcli radio wifi on");
  });

  it("rejects an unsupported platform", async () => {
    const { ctx, calls } = fakeCtx("linux");
    const r = await fixUnknown.run({ ...ctx, platform: "win32" } as unknown as FixContext);
    expect(r).toEqual({ pluginId: "fix-unknown", ok: false, actions: [], detail: "Unsupported platform: win32" });
    expect(calls).toEqual([]);
  });
});
