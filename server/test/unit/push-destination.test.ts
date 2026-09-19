import { describe, expect, it } from "vitest";
import { isPermittedDestination, selectPermittedAddress } from "../../src/push/destination.js";

const deniedV4 = [
  "0.0.0.1", "10.0.0.1", "100.64.0.1", "127.0.0.1", "169.254.0.1", "172.16.0.1",
  "192.0.0.1", "192.0.2.1", "192.88.99.1", "192.168.0.1", "198.18.0.1",
  "198.51.100.1", "203.0.113.1", "224.0.0.1", "240.0.0.1",
];

const deniedV6 = [
  "2001::1", "2001:2::1", "2001:10::1", "2001:20::1", "2001:db8::1", "2002::1", "3fff::1",
  "::", "::1", "::ffff:8.8.8.8", "64:ff9b::808:808", "64:ff9b:1::808:808",
  "fe80::1", "fc00::1", "ff00::1",
];

describe("Push DNS destination policy", () => {
  it("rejects every fixed IPv4/IPv6 range and accepts public unicast", () => {
    for (const address of [...deniedV4, ...deniedV6]) expect(isPermittedDestination(address), address).toBe(false);
    for (const address of ["8.8.8.8", "1.1.1.1", "2001:4860:4860::8888", "2606:4700:4700::1111"]) {
      expect(isPermittedDestination(address), address).toBe(true);
    }
  });

  it("covers the inside and each existing classification-changing side of every IPv4 exclusion", () => {
    const ranges = [
      ["0.0.0.0", "0.255.255.255", null, "1.0.0.0"],
      ["10.0.0.0", "10.255.255.255", "9.255.255.255", "11.0.0.0"],
      ["100.64.0.0", "100.127.255.255", "100.63.255.255", "100.128.0.0"],
      ["127.0.0.0", "127.255.255.255", "126.255.255.255", "128.0.0.0"],
      ["169.254.0.0", "169.254.255.255", "169.253.255.255", "169.255.0.0"],
      ["172.16.0.0", "172.31.255.255", "172.15.255.255", "172.32.0.0"],
      ["192.0.0.0", "192.0.0.255", "191.255.255.255", "192.0.1.0"],
      ["192.0.2.0", "192.0.2.255", "192.0.1.255", "192.0.3.0"],
      ["192.88.99.0", "192.88.99.255", "192.88.98.255", "192.88.100.0"],
      ["192.168.0.0", "192.168.255.255", "192.167.255.255", "192.169.0.0"],
      ["198.18.0.0", "198.19.255.255", "198.17.255.255", "198.20.0.0"],
      ["198.51.100.0", "198.51.100.255", "198.51.99.255", "198.51.101.0"],
      ["203.0.113.0", "203.0.113.255", "203.0.112.255", "203.0.114.0"],
      ["224.0.0.0", "239.255.255.255", "223.255.255.255", null],
      ["240.0.0.0", "255.255.255.255", null, null],
    ] as const;
    for (const [first, last, below, above] of ranges) {
      expect(isPermittedDestination(first), first).toBe(false);
      expect(isPermittedDestination(last), last).toBe(false);
      if (below) expect(isPermittedDestination(below), below).toBe(true);
      if (above) expect(isPermittedDestination(above), above).toBe(true);
    }
  });

  it("covers both differing sides of every added IPv6 exclusion", () => {
    const boundaries = [
      ["2001:1:ffff:ffff:ffff:ffff:ffff:ffff", "2001:2::", "2001:2:0:ffff:ffff:ffff:ffff:ffff", "2001:2:1::"],
      ["2001:f:ffff:ffff:ffff:ffff:ffff:ffff", "2001:10::", "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff", "2001:20::"],
      ["2001:1f:ffff:ffff:ffff:ffff:ffff:ffff", "2001:20::", "2001:2f:ffff:ffff:ffff:ffff:ffff:ffff", "2001:30::"],
    ] as const;
    for (const [below, first, last, above] of boundaries) {
      // The 2001:10::/28 and 2001:20::/28 exclusions are adjacent at
      // their tested sides, so only sides that differ are required.
      if (below !== "2001:1f:ffff:ffff:ffff:ffff:ffff:ffff") {
        expect(isPermittedDestination(below), below).toBe(true);
      }
      expect(isPermittedDestination(first), first).toBe(false);
      expect(isPermittedDestination(last), last).toBe(false);
      // Adjacent added ranges may touch; only assert an actually differing side.
      if (above !== "2001:20::") expect(isPermittedDestination(above), above).toBe(true);
    }
    expect(isPermittedDestination("3ffe:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isPermittedDestination("3fff::")).toBe(false);
    expect(isPermittedDestination("3fff:fff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isPermittedDestination("3fff:1000::")).toBe(true);
    expect(isPermittedDestination("4000::")).toBe(false); // outside the required 2000::/3 base gate
  });

  it("covers the global IPv6 gate and every classification-changing side of the remaining in-gate exclusions", () => {
    expect(isPermittedDestination("1fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(false);
    expect(isPermittedDestination("2000::")).toBe(true);
    expect(isPermittedDestination("3fff:ffff:ffff:ffff:ffff:ffff:ffff:ffff")).toBe(true);
    expect(isPermittedDestination("4000::")).toBe(false);

    const ranges = [
      ["2000:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2001::", "2001:0:ffff:ffff:ffff:ffff:ffff:ffff", "2001:1::"],
      ["2001:db7:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db8::", "2001:db8:ffff:ffff:ffff:ffff:ffff:ffff", "2001:db9::"],
      ["2001:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2002::", "2002:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "2003::"],
    ] as const;
    for (const [below, first, last, above] of ranges) {
      expect(isPermittedDestination(below), below).toBe(true);
      expect(isPermittedDestination(first), first).toBe(false);
      expect(isPermittedDestination(last), last).toBe(false);
      expect(isPermittedDestination(above), above).toBe(true);
    }

    // These explicit translation/local/multicast ranges are already outside
    // 2000::/3; boundaries remain denied by the base gate on both sides.
    for (const address of [
      "::", "::ffff:ffff", "::1", "::ffff:0:0", "::ffff:ffff:ffff",
      "64:ff9a:ffff:ffff:ffff:ffff:ffff:ffff", "64:ff9b::", "64:ff9b::ffff:ffff",
      "64:ff9b:1::", "64:ff9b:1:ffff:ffff:ffff:ffff:ffff",
      "fe7f:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fe80::", "febf:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "fbff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "fc00::", "fdff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
      "feff:ffff:ffff:ffff:ffff:ffff:ffff:ffff", "ff00::", "ffff:ffff:ffff:ffff:ffff:ffff:ffff:ffff",
    ]) expect(isPermittedDestination(address), address).toBe(false);
    expect(isPermittedDestination("2001:4860::192.168.1.1")).toBe(false);
    expect(isPermittedDestination("2001:4860::8.8.8.8")).toBe(true);
  });

  it("rejects invalid/no/mixed answer sets and selects the first resolver-order answer only after whole-set validation", () => {
    expect(selectPermittedAddress([])).toBeNull();
    expect(selectPermittedAddress(["8.8.8.8", "127.0.0.1"])).toBeNull();
    expect(selectPermittedAddress(["not-an-ip"])).toBeNull();
    expect(selectPermittedAddress(["8.8.8.8", "1.1.1.1"])).toBe("8.8.8.8");
  });
});
