// Unit tests for pb_hooks/lib/uiupdate.js: the pure helpers (the PocketBase parts are exercised on a box).
import { describe, expect, test } from "bun:test";
// eslint-disable-next-line @typescript-eslint/no-require-imports
const ui = require("../pb_hooks/lib/uiupdate.js");

describe("uiupdate", () => {
  test("versionOf reads the build's meta; a dev build or none is empty", () => {
    expect(ui.versionOf('<head>\n    <meta name="relay-ui-version" content="v0.2.1" />')).toBe("v0.2.1");
    expect(ui.versionOf('<meta name="relay-ui-version" content="%VITE_UI_VERSION%">')).toBe("");
    expect(ui.versionOf("<html></html>")).toBe("");
  });
  test("validTag: only v-tags reach a URL or a shell line", () => {
    expect(ui.validTag("v0.2.1")).toBe(true);
    expect(ui.validTag("v1.0.0-rc.1")).toBe(true);
    expect(ui.validTag("latest")).toBe(false);
    expect(ui.validTag("v1.0.0'; rm -rf /")).toBe(false);
  });
  test("isNewer compares numerically; anything beats an unknown install", () => {
    expect(ui.isNewer("v0.10.0", "v0.9.9")).toBe(true);
    expect(ui.isNewer("v0.2.1", "v0.2.1")).toBe(false);
    expect(ui.isNewer("v0.2.0", "v0.2.1")).toBe(false);
    expect(ui.isNewer("v0.3.0", "")).toBe(true);
    expect(ui.isNewer("", "v0.2.1")).toBe(false);
  });
  test("zipUrl", () => {
    expect(ui.zipUrl("v0.2.1")).toBe("https://github.com/laris-co/message-relay-v3-ui/releases/download/v0.2.1/dist.zip");
  });
});
