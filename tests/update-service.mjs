import assert from "node:assert/strict";
import {
  GithubReleaseService,
  UPDATE_API_URL,
  isVersionNewer,
  normalizeVersion,
} from "../src/update-service.mjs";

assert.equal(normalizeVersion("v1.2.3"), "1.2.3");
assert.equal(isVersionNewer("v1.2.0", "1.1.9"), true);
assert.equal(isVersionNewer("1.2.0", "1.2.0"), false);
assert.equal(isVersionNewer("1.1.9", "1.2.0"), false);

const tagName = "v0.5.0";
const assetBase = `https://github.com/zhao0511/pdf-translate-to-markdown/releases/download/${tagName}`;
const release = {
  tag_name: tagName,
  name: "Pdf translate to markdown 0.5.0",
  html_url: "https://github.com/zhao0511/pdf-translate-to-markdown/releases/tag/v0.5.0",
  assets: ["main.js", "manifest.json", "styles.css"].map((name) => ({
    name,
    browser_download_url: `${assetBase}/${name}`,
  })),
};
const remoteFiles = new Map([
  [`${assetBase}/main.js`, "new-main"],
  [
    `${assetBase}/manifest.json`,
    JSON.stringify({ id: "deepseek-translator", version: "0.5.0" }),
  ],
  [`${assetBase}/styles.css`, "new-styles"],
]);
const request = async ({ url }) => {
  if (url === UPDATE_API_URL) {
    return { status: 200, json: release, text: JSON.stringify(release) };
  }
  if (remoteFiles.has(url)) {
    return { status: 200, text: remoteFiles.get(url) };
  }
  return { status: 404, text: "" };
};

const pluginFolder = ".obsidian/plugins/deepseek-translator";
const disk = new Map([
  [`${pluginFolder}/main.js`, "old-main"],
  [`${pluginFolder}/manifest.json`, "old-manifest"],
  [`${pluginFolder}/styles.css`, "old-styles"],
]);
const adapter = {
  async exists(path) {
    return disk.has(path);
  },
  async read(path) {
    return disk.get(path);
  },
  async write(path, contents) {
    disk.set(path, contents);
  },
  async remove(path) {
    disk.delete(path);
  },
};
const app = { vault: { configDir: ".obsidian", adapter } };
const service = new GithubReleaseService(app, "deepseek-translator", "0.4.1", request);

const latest = await service.getLatestRelease();
assert.equal(latest.version, "0.5.0");
assert.equal(await service.installRelease(latest), "0.5.0");
assert.equal(disk.get(`${pluginFolder}/main.js`), "new-main");
assert.equal(disk.get(`${pluginFolder}/styles.css`), "new-styles");
assert.equal(JSON.parse(disk.get(`${pluginFolder}/manifest.json`)).version, "0.5.0");

const tamperedRelease = {
  ...latest,
  assets: latest.assets.map((asset) =>
    asset.name === "main.js"
      ? { ...asset, downloadUrl: "https://example.com/main.js" }
      : asset,
  ),
};
await assert.rejects(() => service.installRelease(tamperedRelease), /不可信/);

console.log("Update service test passed");
