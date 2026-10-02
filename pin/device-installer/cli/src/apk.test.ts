import assert from "node:assert/strict";
import test from "node:test";
import { parseApkApplicationId } from "./apk.js";

test("parses one exact APK manifest application ID", () => {
  assert.equal(
    parseApkApplicationId("com.penumbraos.systeminjector\n"),
    "com.penumbraos.systeminjector"
  );
});

test("rejects ambiguous or malformed APK application IDs", () => {
  assert.throws(
    () => parseApkApplicationId("com.penumbraos.systeminjector\nother.package\n"),
    /Invalid APK application ID/
  );
  assert.throws(() => parseApkApplicationId("../installer"), /Invalid APK application ID/);
});
