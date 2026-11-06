import { describe, expect, it } from "vitest";
import type { FixContext } from "../../types";
import { isFixPlugin } from "../index";
import { fakeCtx } from "../test-helpers";
import { fixUnknown } from "./fix-unknown.plugin";

const DARWIN_ROUTE = { "route -n get default": { stdout: "   route to: default\ndestination: default\n    gateway: 10.0.0.1\n  interface: en0\n" } };
const LINUX_ROUTE = { "ip route show default": { stdout: "default via 10.0.0.1 dev wlp2s0 proto dhcp metric 600\n" } };

const DARWIN_PING = "ping -n -c 5 -i 0.2 -W 1000 -t 5 10.0.0.1";
const LINUX_PING = "ping -n -c 5 -i 0.2 -W 1 -w 5 10.0.0.1";

const darwinPing = (avg: number, loss = 0) => ({
  stdout: `--- 10.0.0.1 ping statistics ---\n5 packets transmitted, 5 packets received, ${loss}.0% packet loss\nround-trip min/avg/max/stddev = 1.0/${avg}/90.0/3.0 ms\n`,
});
const linuxPing = (avg: number, loss = 0) => ({
  stdout: `--- 10.0.0.1 ping statistics ---\n5 packets transmitted, 5 received, ${loss}% packet loss, time 804ms\nrtt min/avg/max/mdev = 1.0/${avg}/90.0/3.0 ms\n`,
});

/** fakeCtx whose ping answers change per call (first probe, re-probe, ...). */
function sequenced(platform: "darwin" | "linux", base: Record<string, object>, pings: object[]) {
  const fake = fakeCtx(platform, base);
  let n = 0;
  const ctx: FixContext = {
    ...fake.ctx,
    async exec(cmd, args) {
      const r = await fake.ctx.exec(cmd, args);
      return cmd === "ping" ? { ...r, ...pings[Math.min(n++, pings.length - 1)] } : r;
    },
  };
  return { ctx, calls: fake.calls };
}

describe("fix-unknown", () => {
  it("is a valid plugin for UNKNOWN on darwin and linux", () => {
    expect(isFixPlugin(fixUnknown)).toBe(true);
    expect(fixUnknown.id).toBe("fix-unknown");
    expect(fixUnknown.handles).toEqual(["UNKNOWN"]);
    expect(fixUnknown.platforms).toEqual(["darwin", "linux"]);
  });

  it("darwin: makes no change when the gateway spike has already cleared", async () => {
    const { ctx, calls } = sequenced("darwin", DARWIN_ROUTE, [darwinPing(14.5)]);
    const r = await fixUnknown.run(ctx);
    expect(r).toMatchObject({ pluginId: "fix-unknown", ok: true });
    expect(calls).toEqual(["route -n get default", DARWIN_PING]);
    expect(r.actions).toEqual([DARWIN_PING]);
    expect(r.detail).toContain("transient");
  });

  it("darwin: clears the gateway ARP entry when latency is degraded and verifies", async () => {
    const { ctx, calls } = sequenced("darwin", DARWIN_ROUTE, [darwinPing(60), darwinPing(12)]);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["route -n get default", DARWIN_PING, "arp -d 10.0.0.1", DARWIN_PING]);
    expect(r.actions).toEqual([DARWIN_PING, "arp -d 10.0.0.1", DARWIN_PING]);
    expect(r.detail).toContain("12 ms");
  });

  it("darwin: treats a missing ARP entry as already clear (idempotent)", async () => {
    const { ctx } = sequenced(
      "darwin",
      { ...DARWIN_ROUTE, arp: { code: 1, stderr: "arp: 10.0.0.1: cannot locate 10.0.0.1\n" } },
      [darwinPing(70), darwinPing(10)],
    );
    expect((await fixUnknown.run(ctx)).ok).toBe(true);
  });

  it("linux: flushes the gateway neighbour entry on the route's interface and verifies", async () => {
    const { ctx, calls } = sequenced("linux", LINUX_ROUTE, [linuxPing(20, 40), linuxPing(8)]);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["ip route show default", LINUX_PING, "ip neigh flush to 10.0.0.1 dev wlp2s0", LINUX_PING]);
  });

  it("linux: makes no change when the gateway is healthy", async () => {
    const { ctx, calls } = sequenced("linux", LINUX_ROUTE, [linuxPing(3)]);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toEqual(["ip route show default", LINUX_PING]);
  });

  it("reports a failing flush command without throwing and skips the re-probe", async () => {
    const { ctx, calls } = sequenced(
      "darwin",
      { ...DARWIN_ROUTE, arp: { code: 1, stderr: "arp: must be root to delete an entry\n" } },
      [darwinPing(60)],
    );
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toBe("arp -d 10.0.0.1 failed (1): arp: must be root to delete an entry");
    expect(calls.filter((c) => c.startsWith("ping"))).toHaveLength(1);
  });

  it("linux: reports a permission failure from ip neigh", async () => {
    const { ctx } = sequenced("linux", { ...LINUX_ROUTE, "ip neigh": { code: 2, stderr: "RTNETLINK answers: Operation not permitted" } }, [linuxPing(80)]);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.detail).toContain("Operation not permitted");
  });

  it("reports when the gateway is still degraded after the flush", async () => {
    const { ctx } = sequenced("darwin", DARWIN_ROUTE, [darwinPing(60), darwinPing(65)]);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(false);
    expect(r.actions).toHaveLength(3);
    expect(r.detail).toContain("still degraded (65 ms, 0% loss)");
  });

  it("fails cleanly when there is no default gateway", async () => {
    const { ctx, calls } = fakeCtx("linux", { "ip route show default": { stdout: "" } });
    const r = await fixUnknown.run(ctx);
    expect(r).toMatchObject({ ok: false, actions: [] });
    expect(r.detail).toContain("No default gateway");
    expect(calls).toEqual(["ip route show default"]);
  });

  it("dry run rehearses the full repair", async () => {
    const { ctx, calls } = fakeCtx("darwin", {}, true);
    const r = await fixUnknown.run(ctx);
    expect(r.ok).toBe(true);
    expect(calls).toContain('arp -d "<gateway>"');
  });

  it("rejects an unsupported platform", async () => {
    const { ctx, calls } = fakeCtx("linux");
    const r = await fixUnknown.run({ ...ctx, platform: "win32" } as unknown as FixContext);
    expect(r).toEqual({ pluginId: "fix-unknown", ok: false, actions: [], detail: "Unsupported platform: win32" });
    expect(calls).toEqual([]);
  });
});
