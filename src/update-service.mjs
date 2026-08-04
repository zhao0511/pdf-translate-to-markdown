export const UPDATE_REPOSITORY = "zhao0511/pdf-translate-to-markdown";
export const UPDATE_API_URL = `https://api.github.com/repos/${UPDATE_REPOSITORY}/releases/latest`;

export function normalizeVersion(value) {
  return String(value || "")
    .trim()
    .replace(/^v/i, "")
    .split("-")[0];
}

export function isVersionNewer(candidate, current) {
  const candidateParts = normalizeVersion(candidate).split(".").map(Number);
  const currentParts = normalizeVersion(current).split(".").map(Number);
  if (
    candidateParts.some((part) => !Number.isFinite(part)) ||
    currentParts.some((part) => !Number.isFinite(part))
  ) {
    return false;
  }

  const length = Math.max(candidateParts.length, currentParts.length);
  for (let index = 0; index < length; index += 1) {
    const candidatePart = candidateParts[index] || 0;
    const currentPart = currentParts[index] || 0;
    if (candidatePart !== currentPart) {
      return candidatePart > currentPart;
    }
  }
  return false;
}

export class GithubReleaseService {
  constructor(app, pluginId, currentVersion, request) {
    this.app = app;
    this.pluginId = pluginId;
    this.currentVersion = currentVersion;
    this.request = request;
  }

  async getLatestRelease() {
    const response = await this.request({
      url: UPDATE_API_URL,
      method: "GET",
      headers: {
        Accept: "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      throw: false,
    });

    if (response.status === 404) {
      return null;
    }
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`GitHub 更新检查失败：${response.status}`);
    }

    const release = response.json;
    if (!release?.tag_name || !Array.isArray(release.assets)) {
      throw new Error("GitHub Release 数据不完整");
    }

    return {
      version: normalizeVersion(release.tag_name),
      tagName: release.tag_name,
      name: release.name || release.tag_name,
      htmlUrl: release.html_url,
      assets: release.assets.map((asset) => ({
        name: asset.name,
        downloadUrl: asset.browser_download_url,
      })),
    };
  }

  async installRelease(release) {
    if (!release || !isVersionNewer(release.version, this.currentVersion)) {
      throw new Error("没有可安装的新版本");
    }

    const requiredFiles = ["main.js", "manifest.json", "styles.css"];
    const downloaded = new Map();
    for (const fileName of requiredFiles) {
      const asset = release.assets.find((candidate) => candidate.name === fileName);
      if (!asset) {
        throw new Error(`Release 缺少 ${fileName}`);
      }
      this.validateAssetUrl(asset.downloadUrl, release.tagName, fileName);
      downloaded.set(fileName, await this.downloadText(asset.downloadUrl));
    }

    let remoteManifest;
    try {
      remoteManifest = JSON.parse(downloaded.get("manifest.json"));
    } catch (_error) {
      throw new Error("Release 中的 manifest.json 无效");
    }
    if (remoteManifest.id !== this.pluginId) {
      throw new Error("Release 的插件 ID 与当前插件不一致");
    }
    if (normalizeVersion(remoteManifest.version) !== release.version) {
      throw new Error("Release 标签与 manifest.json 版本不一致");
    }

    const adapter = this.app.vault.adapter;
    const pluginFolder = `${this.app.vault.configDir}/plugins/${this.pluginId}`.replace(/\\/g, "/");
    const backups = new Map();
    const writeOrder = ["styles.css", "main.js", "manifest.json"];

    for (const fileName of writeOrder) {
      const path = `${pluginFolder}/${fileName}`;
      backups.set(fileName, (await adapter.exists(path)) ? await adapter.read(path) : null);
    }

    try {
      for (const fileName of writeOrder) {
        await adapter.write(`${pluginFolder}/${fileName}`, downloaded.get(fileName));
      }
    } catch (error) {
      await this.restoreBackups(adapter, pluginFolder, backups, writeOrder);
      throw new Error(`更新写入失败，已恢复原文件：${this.errorMessage(error)}`);
    }

    return remoteManifest.version;
  }

  validateAssetUrl(url, tagName, fileName) {
    const expected = `https://github.com/${UPDATE_REPOSITORY}/releases/download/${encodeURIComponent(tagName)}/${fileName}`;
    if (url !== expected) {
      throw new Error(`Release 资源地址不可信：${fileName}`);
    }
  }

  async downloadText(url) {
    const response = await this.request({ url, method: "GET", throw: false });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`下载更新文件失败：${response.status}`);
    }
    return response.text;
  }

  async restoreBackups(adapter, pluginFolder, backups, writeOrder) {
    for (const fileName of writeOrder) {
      const backup = backups.get(fileName);
      const path = `${pluginFolder}/${fileName}`;
      try {
        if (backup === null) {
          if (await adapter.exists(path)) {
            await adapter.remove(path);
          }
        } else {
          await adapter.write(path, backup);
        }
      } catch (error) {
        console.error("Failed to restore plugin update backup:", fileName, error);
      }
    }
  }

  errorMessage(error) {
    return error instanceof Error && error.message ? error.message : String(error || "未知错误");
  }
}
