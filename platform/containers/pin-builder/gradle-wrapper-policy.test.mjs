import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

const wrappers = [
  new URL("../../../pin/gradle/wrapper/", import.meta.url),
  new URL("../../../pin/injector/gradle/wrapper/", import.meta.url),
];

async function readWrapperProperties(wrapper) {
  const text = await readFile(new URL("gradle-wrapper.properties", wrapper), "utf8");
  return new Map(
    text
      .split(/\r?\n/u)
      .filter((line) => line && !line.startsWith("#"))
      .map((line) => {
        const separator = line.indexOf("=");
        assert.notEqual(separator, -1, `invalid wrapper property: ${line}`);
        return [line.slice(0, separator), line.slice(separator + 1)];
      }),
  );
}

test("both Gradle 8.9 distributions are pinned to the official SHA-256", async () => {
  for (const wrapper of wrappers) {
    const properties = await readWrapperProperties(wrapper);

    assert.equal(
      properties.get("distributionUrl"),
      "https\\://services.gradle.org/distributions/gradle-8.9-bin.zip",
    );
    assert.equal(
      properties.get("distributionSha256Sum"),
      "d725d707bfabd4dfdc958c624003b3c80accc03f7037b5122c4b1d0ef15cecab",
    );
  }
});

test("both Gradle wrapper executables have reviewed byte identities", async () => {
  const reviewed = [
    "498495120a03b9a6ab5d155f5de3c8f0d986a449153702fb80fc80e134484f17",
    "e996d452d2645e70c01c11143ca2d3742734a28da2bf61f25c82bdc288c9e637",
  ];
  for (const [index, wrapper] of wrappers.entries()) {
    const wrapperJar = await readFile(new URL("gradle-wrapper.jar", wrapper));
    const checksum = createHash("sha256").update(wrapperJar).digest("hex");

    assert.equal(checksum, reviewed[index]);
  }
});
