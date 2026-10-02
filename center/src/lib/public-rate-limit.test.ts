import { describe, expect, it } from "vitest";
import { isPrivateAddress, requestClientAddress } from "./public-rate-limit";

const headers = (values: Record<string, string>) => new Headers(values);

describe("requestClientAddress", () => {
  it("believes Cloudflare's client address only when the tunnel is the peer", () => {
    expect(requestClientAddress(headers({ "x-real-ip": "127.0.0.1", "cf-connecting-ip": "203.0.113.7" })))
      .toBe("203.0.113.7");
    expect(requestClientAddress(headers({ "x-real-ip": "172.24.4.1", "cf-connecting-ip": "203.0.113.7" })))
      .toBe("203.0.113.7");
  });

  it("ignores a forged Cloudflare header from a caller that reached :443 directly", () => {
    expect(requestClientAddress(headers({ "x-real-ip": "198.51.100.9", "cf-connecting-ip": "203.0.113.7" })))
      .toBe("198.51.100.9");
  });

  it("uses the peer Traefik recorded, and says so when nothing names one", () => {
    expect(requestClientAddress(headers({ "x-forwarded-for": "198.51.100.9" }))).toBe("198.51.100.9");
    expect(requestClientAddress(headers({ "cf-connecting-ip": "203.0.113.7" }))).toBe("unidentified");
    expect(requestClientAddress(headers({}))).toBe("unidentified");
  });
});

describe("isPrivateAddress", () => {
  it("recognises loopback, RFC 1918, link-local and unique-local addresses", () => {
    for (const address of ["127.0.0.1", "10.1.2.3", "172.16.0.1", "172.31.255.254", "192.168.1.1",
      "169.254.1.1", "::1", "fd00::1", "fe80::1", "::ffff:10.0.0.1"]) {
      expect(isPrivateAddress(address), address).toBe(true);
    }
    for (const address of ["79.76.45.245", "172.32.0.1", "8.8.8.8", "2001:db8::1", "not-an-ip"]) {
      expect(isPrivateAddress(address), address).toBe(false);
    }
  });
});
