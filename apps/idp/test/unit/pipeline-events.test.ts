import { describe, expect, it } from "vitest";
import { networkOf } from "../../src/security/pipeline/events.js";

describe("networkOf", () => {
  it("groups IPv4 by /24, including IPv4-mapped IPv6", () => {
    expect(networkOf("203.0.113.57")).toBe("203.0.113.0/24");
    expect(networkOf("::ffff:203.0.113.57")).toBe("203.0.113.0/24");
  });

  it("groups IPv6 by /48, expanding compressed forms", () => {
    expect(networkOf("2001:db8:abcd:12::1")).toBe("2001:db8:abcd::/48");
    expect(networkOf("2001:db8::1")).toBe("2001:db8:0::/48");
    expect(networkOf("2001:0DB8:00ab:ffff::")).toBe("2001:db8:ab::/48");
  });

  it("ignores missing or malformed addresses", () => {
    expect(networkOf(undefined)).toBeUndefined();
    expect(networkOf("not-an-ip")).toBeUndefined();
  });
});
