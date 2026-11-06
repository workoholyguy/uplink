import { describe, expect, it } from "vitest";
import type { FixContext } from "../../types";
import { isFixPlugin } from "../index";
import { fakeCtx } from "../test-helpers";
import { fixSlowSpeed, parsePing } from "./fix-slow-speed.plugin";

const GW = "172.20.10.1";
const DARWIN_ROUTE = { "route -n get default": { stdout: `   route to: default\ndestination: default\n    gateway: ${GW}\n  interface: en0\n` } };
const LINUX_ROUTE = { "ip route show default": { stdout: `default via ${GW} dev wlp2s0 proto dhcp metric 600\n` } };
const AWDL_UP = { "ifconfig awdl0": { stdout: "awdl0: flags=8943<UP,BROADCAST,RUNNING,PROMISC,SIMPLEX,MULTICAST> mtu 1484\n\tstatus: active\n" } };
const AWDL_DOWN = { "ifconfig awdl0": { stdout: "awdl0: flags=8902<BROADCAST,PROMISC,SIMPLEX,MULTICAST> mtu 1484\n\tstatus: inactive\n" } };
const AWDL_OFF_CMD = { "ifconfig awdl0 down": { stdout: "" } };
const PS_ON = { "iw dev wlp2s0 get power_save": { stdout: "Power save: on\n" } };

const DARWIN_PING = `ping -n -c 3 -i 0.2 -W 1000 -t 3 ${GW}`;
const LINUX_PING = `ping -n -c 3 -i 0.2 -W 1 ${GW}`;

const darwinPing = (avg: number, loss = 0) => ({
  [DARWIN_PING]: {
    code: loss >= 100 ? 2 : 0,
    stdout: `--- ${GW} ping statistics ---\n3 packets transmitted, 3 packets received, ${loss.toFixed(1)}% packet loss\nround-trip min/avg/max/stddev = 1.0/${avg}/9.0/0.5 ms\n`,
  },
});
const linuxPing = (avg: number, loss = 0) => ({
  [LINUX_PING]: {
    stdout: `--- ${GW} ping statistics ---\n3 packets transmitted, 3 received, ${loss}% packet loss, time 402ms\nrtt min/avg/max/mdev = 1.0/${avg}/9.0/0.5 ms\n`,
  },
});

describe("fix-slow-speed", () => {
  it("is a valid plugin for SLOW_SPEED on darwin and linux", () => {
    expect(isFixPlugin(fixSlowSpeed)).toBe(true);
    expect(fixSlowSpeed.id).toBe("fix-slow-speed");
    expect(fixSlowSpeed.handles).toEqual(["SLOW_SPEED"]);
    expect(fixSlowSpeed.platforms).toEqual(["darwin", "linux"]);
  });

  it("parses BSD and iputils ping summaries", () => {
    expect(parsePing(darwinPing(69.5)[DARWIN_PING].stdout)).toEqual({ avgMs: 69.5, lossPct: 0 });
    expect(parsePing(linuxPing(12.3, 33)[LINUX_PING].stdout)).toEqual({ avgMs: 12.3, lossPct: 33 });
    expect(parsePing("")).toEqual({ avgMs: undefined, lossPct: undefined });
  });

  it("darwin: brings AWDL down and verifies the gateway is fast again", async () => {
    const { ctx, calls } = fakeCtx("darwin", { ...DARWIN_ROUTE, ...AWDL_UP, ...AWDL_OFF_CMD, ...darwinPing(4.2) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r).toMatchObject({ pluginId: "fix-slow-speed", ok: true });
    expect(calls).toEqual(["route -n get default", "ifconfig awdl0", "ifconfig awdl0 down", DARWIN_PING]);
    expect(r.actions).toEqual(["ifconfig awdl0 down", DARWIN_PING]);
    expect(r.detail).toContain(`gateway ${GW} answers in 4.2 ms`);
  });

  it("darwin: is idempotent when AWDL is already down", async () => {
    const { ctx, calls } = fakeCtx("darwin", { ...DARWIN_ROUTE, ...AWDL_DOWN, ...darwinPing(4.2) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain("ifconfig awdl0 down");
    expect(r.actions).toEqual([DARWIN_PING]);
    expect(r.detail).toContain("AWDL already down");
  });

  it("darwin: reports a failing ifconfig without throwing and skips the re-probe", async () => {
    const { ctx, calls } = fakeCtx("darwin", {
      ...DARWIN_ROUTE,
      ...AWDL_UP,
      "ifconfig awdl0 down": { code: 1, stderr: "ifconfig: ioctl (SIOCSIFFLAGS): Operation not permitted\n" },
    });
    const r = await fixSlowSpeed.run(ctx);
    expect(r).toEqual({
      pluginId: "fix-slow-speed",
      ok: false,
      actions: ["ifconfig awdl0 down"],
      detail: "ifconfig awdl0 down failed (1): ifconfig: ioctl (SIOCSIFFLAGS): Operation not permitted",
    });
    expect(calls).not.toContain(DARWIN_PING);
  });

  it("darwin: fails when the gateway is still slow after the fix (the reported 69.5 ms)", async () => {
    const { ctx } = fakeCtx("darwin", { ...DARWIN_ROUTE, ...AWDL_UP, ...AWDL_OFF_CMD, ...darwinPing(69.5) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.actions).toEqual(["ifconfig awdl0 down", DARWIN_PING]);
    expect(r.detail).toContain(`gateway ${GW} still slow: 69.5 ms, 0% loss`);
  });

  it("darwin: fails when the gateway stops answering", async () => {
    const { ctx } = fakeCtx("darwin", { ...DARWIN_ROUTE, ...AWDL_UP, ...AWDL_OFF_CMD, ...darwinPing(0, 100) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("re-probe failed (2)");
  });

  it("linux: turns Wi-Fi power saving off on the default-route interface and re-probes", async () => {
    const { ctx, calls } = fakeCtx("linux", { ...LINUX_ROUTE, ...PS_ON, ...linuxPing(3.1) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r).toMatchObject({ pluginId: "fix-slow-speed", ok: true });
    expect(calls).toEqual(["ip route show default", "iw dev wlp2s0 get power_save", "iw dev wlp2s0 set power_save off", LINUX_PING]);
    expect(r.actions).toEqual(["iw dev wlp2s0 set power_save off", LINUX_PING]);
    expect(r.detail).toContain("power saving turned off on wlp2s0");
  });

  it("linux: skips the change when power saving is already off", async () => {
    const { ctx, calls } = fakeCtx("linux", { ...LINUX_ROUTE, "iw dev wlp2s0 get power_save": { stdout: "Power save: off\n" }, ...linuxPing(3.1) });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).not.toContain("iw dev wlp2s0 set power_save off");
  });

  it("linux: reports a permission failure from iw", async () => {
    const { ctx, calls } = fakeCtx("linux", {
      ...LINUX_ROUTE,
      ...PS_ON,
      "iw dev wlp2s0 set": { code: 255, stderr: "command failed: Operation not permitted (-1)" },
    });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("iw dev wlp2s0 set power_save off failed (255): command failed: Operation not permitted (-1)");
    expect(calls).not.toContain(LINUX_PING);
  });

  it("linux: fails without a default gateway to verify against", async () => {
    const { ctx } = fakeCtx("linux", { "ip route show default": { stdout: "" } });
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("no default gateway to re-probe");
  });

  it("dry run succeeds with the change rehearsed", async () => {
    const { ctx, calls } = fakeCtx("darwin", {}, true);
    const r = await fixSlowSpeed.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toContain("ifconfig awdl0 down");
  });

  it("rejects an unsupported platform", async () => {
    const { ctx, calls } = fakeCtx("linux");
    const r = await fixSlowSpeed.run({ ...ctx, platform: "win32" } as unknown as FixContext);
    expect(r).toEqual({ pluginId: "fix-slow-speed", ok: false, actions: [], detail: "Unsupported platform: win32" });
    expect(calls).toEqual([]);
  });
});
