import { strFromU8, unzip } from "fflate";
import { markdownImageBasenames } from "./markdown-utils.js";

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "bmp", "webp", "jp2"]);

export class MinerUOcrService {
  constructor(settings, requestFn) {
    this.settings = settings;
    this.requestFn = requestFn;
    this.providerId = "mineru";
    this.providerName = "MinerU";
    this.supportsRemoteDelete = false;
    this.pendingUploads = new Map();
    this.pendingBatchPolls = new Map();
  }

  async checkConnection() {
    const response = await this.requestFn({
      url: `${this.baseUrl()}/extract/task/00000000-0000-0000-0000-000000000000`,
      method: "GET",
      headers: this.authHeaders(),
      throw: false,
    });
    const code = response.json?.code;
    if (
      response.status === 401 ||
      response.status === 403 ||
      code === "A0202" ||
      code === "A0211"
    ) {
      throw new Error(`MinerU Token 无效或已过期${response.json?.msg ? `：${response.json.msg}` : ""}`);
    }
    if (response.status === 0 || response.status === 429 || response.status >= 500) {
      throw new Error(`MinerU API 连接失败（${response.status || "无响应"}）`);
    }
    return true;
  }

  async uploadPdf(arrayBuffer, fileName) {
    if (arrayBuffer.byteLength > 200 * 1024 * 1024) {
      throw new Error("MinerU 单个上传文件不能超过 200 MB");
    }
    let batchId;
    try {
      let pending = this.pendingUploads.get(fileName);
      if (!pending) {
        const payload = {
          files: [
            {
              name: fileName,
              data_id: this.dataId(fileName),
              is_ocr: Boolean(this.settings.mineruForceOcr),
            },
          ],
          model_version: this.modelVersion(),
          language: (this.settings.mineruLanguage || "en").trim() || "en",
          enable_formula: this.settings.mineruEnableFormula !== false,
          enable_table: this.settings.mineruEnableTable !== false,
        };
        const result = await this.apiRequest("/file-urls/batch", {
          method: "POST",
          body: JSON.stringify(payload),
          headers: {
            ...this.authHeaders(),
            "Content-Type": "application/json",
          },
        });
        batchId = result.data?.batch_id;
        const uploadUrl = result.data?.file_urls?.[0];
        if (!batchId || !uploadUrl) {
          throw new Error("MinerU 没有返回批次 ID 或上传地址");
        }
        pending = { batchId, uploadUrl, dataId: payload.files[0].data_id };
        this.pendingUploads.set(fileName, pending);
      }
      batchId = pending.batchId;

      const uploadResponse = await this.requestFn({
        url: pending.uploadUrl,
        method: "PUT",
        body: arrayBuffer,
        throw: false,
      });
      if (uploadResponse.status < 200 || uploadResponse.status >= 300) {
        throw new Error(`MinerU 文件上传失败（HTTP ${uploadResponse.status}）`);
      }
      this.pendingUploads.delete(fileName);
      return {
        fileId: batchId,
        url: { batchId, dataId: pending.dataId, fileName },
      };
    } catch (error) {
      const wrapped = new Error(this.errorMessage(error));
      wrapped.cause = error;
      wrapped.uploadedFileId = batchId;
      throw wrapped;
    }
  }

  async prepareBatchUploads(fileNames) {
    const names = [...new Set((fileNames || []).map((name) => String(name || "").trim()))]
      .filter(Boolean)
      .filter((name) => !this.pendingUploads.has(name));
    if (names.length === 0) {
      return;
    }
    if (names.length > 200) {
      throw new Error("MinerU 单次批量上传最多支持 200 个文件");
    }
    const files = names.map((name) => ({
      name,
      data_id: this.dataId(name),
      is_ocr: Boolean(this.settings.mineruForceOcr),
    }));
    const payload = {
      files,
      model_version: this.modelVersion(),
      language: (this.settings.mineruLanguage || "en").trim() || "en",
      enable_formula: this.settings.mineruEnableFormula !== false,
      enable_table: this.settings.mineruEnableTable !== false,
    };
    const result = await this.apiRequest("/file-urls/batch", {
      method: "POST",
      body: JSON.stringify(payload),
      headers: {
        ...this.authHeaders(),
        "Content-Type": "application/json",
      },
    });
    const batchId = result.data?.batch_id;
    const uploadUrls = result.data?.file_urls;
    if (!batchId || !Array.isArray(uploadUrls) || uploadUrls.length !== files.length) {
      throw new Error("MinerU 批量上传地址数量与文件数量不一致");
    }
    for (let index = 0; index < files.length; index += 1) {
      this.pendingUploads.set(files[index].name, {
        batchId,
        uploadUrl: uploadUrls[index],
        dataId: files[index].data_id,
      });
    }
  }

  async getSignedUrl(batchId, previousLocator = null) {
    if (previousLocator && typeof previousLocator === "object") {
      return previousLocator;
    }
    return { batchId, dataId: null, fileName: null };
  }

  async processOcr(locator, callbacks = {}) {
    const batchId = typeof locator === "object" ? locator.batchId : locator;
    const dataId = typeof locator === "object" ? locator.dataId : null;
    const fileName = typeof locator === "object" ? locator.fileName : null;
    const deadline = Date.now() + this.timeoutMinutes() * 60 * 1000;
    while (Date.now() < deadline) {
      const result = await this.pollBatchResults(batchId);
      const items = Array.isArray(result.data?.extract_result)
        ? result.data.extract_result
        : [];
      const item = dataId
        ? items.find((candidate) => candidate?.data_id === dataId) ||
          items.find((candidate) => candidate?.file_name === fileName)
        : items[0];
      if (!item) {
        callbacks.onProgress?.({
          state: "waiting-file",
          extractedPages: null,
          totalPages: null,
        });
        await this.wait(this.pollIntervalSeconds() * 1000);
        continue;
      }
      callbacks.onProgress?.({
        state: item.state,
        extractedPages: item.extract_progress?.extracted_pages ?? null,
        totalPages: item.extract_progress?.total_pages ?? null,
      });
      if (item.state === "done") {
        if (!item.full_zip_url) {
          throw new Error("MinerU 任务完成但没有返回结果压缩包地址");
        }
        if (callbacks.deferLocalProcessing) {
          return {
            provider: "mineru",
            batchId,
            resultZipUrl: item.full_zip_url,
            deferredLocalProcessing: true,
          };
        }
        return this.downloadAndConvertResult(item.full_zip_url, batchId);
      }
      if (item.state === "failed") {
        throw new Error(`MinerU 解析失败：${item.err_msg || "未知原因"}`);
      }
      await this.wait(this.pollIntervalSeconds() * 1000);
    }
    throw new Error(`MinerU 解析等待超过 ${this.timeoutMinutes()} 分钟`);
  }

  async materializeOcrResponse(response) {
    if (!response?.deferredLocalProcessing) {
      return response;
    }
    if (!response.resultZipUrl) {
      throw new Error("MinerU OCR 结果缺少压缩包地址");
    }
    return this.downloadAndConvertResult(response.resultZipUrl, response.batchId);
  }

  pollBatchResults(batchId) {
    const existing = this.pendingBatchPolls.get(batchId);
    if (existing) {
      return existing;
    }
    const request = this.apiRequest(
      `/extract-results/batch/${encodeURIComponent(batchId)}`,
      {
        method: "GET",
        headers: this.authHeaders(),
      },
    ).finally(() => {
      if (this.pendingBatchPolls.get(batchId) === request) {
        this.pendingBatchPolls.delete(batchId);
      }
    });
    this.pendingBatchPolls.set(batchId, request);
    return request;
  }

  async downloadAndConvertResult(zipUrl, batchId) {
    const response = await this.requestFn({
      url: zipUrl,
      method: "GET",
      throw: false,
    });
    if (response.status < 200 || response.status >= 300 || !response.arrayBuffer) {
      throw new Error(`MinerU 结果下载失败（HTTP ${response.status}）`);
    }
    let files;
    try {
      files = await this.unzipArchive(new Uint8Array(response.arrayBuffer));
    } catch (error) {
      throw new Error(`MinerU 结果压缩包无法解压：${this.errorMessage(error)}`);
    }

    const names = Object.keys(files);
    const markdownName = this.findFile(names, (name) => /(^|\/)full\.md$/i.test(name));
    if (!markdownName) {
      throw new Error("MinerU 结果压缩包中没有 full.md");
    }
    const markdown = strFromU8(files[markdownName]);
    const contentList = this.readJsonFile(
      files,
      names,
      (name) => /_content_list\.json$/i.test(name) && !/_content_list_v2\.json$/i.test(name),
    );
    const middle = this.readJsonFile(files, names, (name) => /_middle\.json$/i.test(name));
    const pageCount = this.resultPageCount(middle, contentList);
    if (!pageCount) {
      throw new Error("MinerU 结果中缺少可验证的页面数量");
    }

    const pageByImage = this.imagePageMap(contentList);
    const analysisPages = this.contentListPages(contentList, pageCount);
    const referencedImageIds = markdownImageBasenames(markdown);
    const images = this.settings.extractImages
      ? this.extractImages(files, names, pageByImage, referencedImageIds)
      : [];
    return {
      provider: "mineru",
      batchId,
      pageCount,
      pages: [{ index: 0, markdown, images }],
      analysisPages,
    };
  }

  contentListPages(contentList, pageCount) {
    if (!Array.isArray(contentList) || !Number.isInteger(pageCount) || pageCount < 1) {
      return [];
    }
    const pageParts = Array.from({ length: pageCount }, () => []);
    for (const item of contentList) {
      const pageIndex = Number(item?.page_idx);
      if (!Number.isInteger(pageIndex) || pageIndex < 0 || pageIndex >= pageCount) {
        continue;
      }
      const text = this.contentListItemText(item);
      if (text) {
        pageParts[pageIndex].push(text);
      }
    }
    return pageParts.map((parts, index) => ({
      index,
      markdown: parts.join("\n\n").trim(),
    }));
  }

  contentListItemText(item) {
    const type = String(item?.type || "").toLowerCase();
    const values = [];
    const add = (value) => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          add(entry);
        }
        return;
      }
      if (typeof value === "string" && value.trim()) {
        values.push(value.trim());
      }
    };
    add(item?.text);
    add(item?.table_body);
    add(item?.image_caption);
    add(item?.image_footnote);
    if (values.length === 0) {
      return "";
    }
    if (type === "title") {
      const level = Math.min(6, Math.max(1, Number(item?.text_level) || 1));
      return `${"#".repeat(level)} ${values.join(" ")}`;
    }
    return values.join("\n");
  }

  extractImages(files, names, pageByImage, referencedImageIds = null) {
    const imageLimit = this.nonNegativeInteger(this.settings.imageLimit);
    const imageMinSize = this.nonNegativeInteger(this.settings.imageMinSize);
    const images = [];
    for (const name of names) {
      const normalized = name.replace(/\\/g, "/");
      const extension = normalized.split(".").pop()?.toLowerCase();
      if (!extension || !IMAGE_EXTENSIONS.has(extension) || !/(^|\/)images\//i.test(normalized)) {
        continue;
      }
      const bytes = files[name];
      const dimensions = this.imageDimensions(bytes, extension);
      if (
        imageMinSize > 0 &&
        dimensions &&
        (dimensions.width < imageMinSize || dimensions.height < imageMinSize)
      ) {
        continue;
      }
      const basename = normalized.split("/").pop();
      if (referencedImageIds instanceof Set && !referencedImageIds.has(basename)) {
        continue;
      }
      images.push({
        id: basename,
        imageBytes: bytes,
        mimeType: this.imageMimeType(extension),
        pageIndex: pageByImage.get(basename) ?? 0,
      });
      if (imageLimit > 0 && images.length >= imageLimit) {
        break;
      }
    }
    return images;
  }

  resultPageCount(middle, contentList) {
    const middleCount = Array.isArray(middle?.pdf_info) ? middle.pdf_info.length : 0;
    if (middleCount > 0) {
      return middleCount;
    }
    if (!Array.isArray(contentList) || contentList.length === 0) {
      return 0;
    }
    const indices = contentList
      .map((item) => Number(item?.page_idx))
      .filter(Number.isFinite);
    return indices.length > 0 ? Math.max(...indices) + 1 : 0;
  }

  imagePageMap(contentList) {
    const mapping = new Map();
    if (!Array.isArray(contentList)) {
      return mapping;
    }
    for (const item of contentList) {
      const imagePath = item?.img_path || item?.image_path;
      if (!imagePath) {
        continue;
      }
      const basename = String(imagePath).replace(/\\/g, "/").split("/").pop();
      mapping.set(basename, Number.isFinite(item.page_idx) ? item.page_idx : 0);
    }
    return mapping;
  }

  readJsonFile(files, names, predicate) {
    const name = this.findFile(names, predicate);
    if (!name) {
      return null;
    }
    try {
      return JSON.parse(strFromU8(files[name]));
    } catch (_error) {
      return null;
    }
  }

  findFile(names, predicate) {
    return names.filter(predicate).sort((left, right) => left.length - right.length)[0] || null;
  }

  async apiRequest(path, options) {
    const response = await this.requestFn({
      url: `${this.baseUrl()}${path}`,
      throw: false,
      ...options,
    });
    if (response.status < 200 || response.status >= 300) {
      throw new Error(`MinerU API 返回 HTTP ${response.status}${response.text ? `：${response.text}` : ""}`);
    }
    if (response.json?.code !== 0) {
      throw new Error(`MinerU API 返回 ${response.json?.code ?? "未知错误"}：${response.json?.msg || "请求失败"}`);
    }
    return response.json;
  }

  authHeaders() {
    return { Authorization: `Bearer ${this.settings.mineruApiKey.trim()}` };
  }

  baseUrl() {
    return (this.settings.mineruBaseUrl || "https://mineru.net/api/v4")
      .trim()
      .replace(/\/+$/, "");
  }

  modelVersion() {
    return this.settings.mineruModelVersion === "pipeline" ? "pipeline" : "vlm";
  }

  timeoutMinutes() {
    const value = Math.floor(Number(this.settings.mineruTimeoutMinutes));
    return Number.isFinite(value) && value > 0 ? value : 30;
  }

  pollIntervalSeconds() {
    const value = Number(this.settings.mineruPollIntervalSeconds);
    return Number.isFinite(value) && value >= 1 ? value : 3;
  }

  nonNegativeInteger(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number >= 0 ? number : 0;
  }

  dataId(fileName) {
    const safeName = String(fileName || "document.pdf").replace(/[^a-zA-Z0-9_.-]/g, "-");
    return `${Date.now()}-${safeName}`.slice(0, 128);
  }

  imageMimeType(extension) {
    if (extension === "jpg" || extension === "jpeg") {
      return "image/jpeg";
    }
    if (extension === "jp2") {
      return "image/jp2";
    }
    return `image/${extension}`;
  }

  unzipArchive(bytes) {
    return new Promise((resolve, reject) => {
      unzip(bytes, (error, files) => {
        if (error) {
          reject(error);
          return;
        }
        resolve(files);
      });
    });
  }

  imageDimensions(bytes, extension) {
    if (extension === "png" && bytes.length >= 24) {
      return {
        width: this.readUint32BE(bytes, 16),
        height: this.readUint32BE(bytes, 20),
      };
    }
    if (extension === "gif" && bytes.length >= 10) {
      return {
        width: bytes[6] | (bytes[7] << 8),
        height: bytes[8] | (bytes[9] << 8),
      };
    }
    if ((extension === "jpg" || extension === "jpeg") && bytes.length >= 4) {
      for (let offset = 2; offset + 8 < bytes.length; ) {
        if (bytes[offset] !== 0xff) {
          offset += 1;
          continue;
        }
        const marker = bytes[offset + 1];
        const length = (bytes[offset + 2] << 8) | bytes[offset + 3];
        if (marker >= 0xc0 && marker <= 0xc3 && offset + 8 < bytes.length) {
          return {
            height: (bytes[offset + 5] << 8) | bytes[offset + 6],
            width: (bytes[offset + 7] << 8) | bytes[offset + 8],
          };
        }
        offset += Math.max(2, length + 2);
      }
    }
    return null;
  }

  readUint32BE(bytes, offset) {
    return (
      ((bytes[offset] << 24) >>> 0) +
      (bytes[offset + 1] << 16) +
      (bytes[offset + 2] << 8) +
      bytes[offset + 3]
    );
  }

  wait(milliseconds) {
    return new Promise((resolve) => globalThis.setTimeout(resolve, milliseconds));
  }

  errorMessage(error) {
    return error instanceof Error && error.message ? error.message : String(error || "未知错误");
  }
}
