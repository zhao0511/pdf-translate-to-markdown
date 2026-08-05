const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const Module = require("node:module");

class TFile {
  constructor(path) {
    this.path = path;
    this.name = path.split("/").pop();
    const dot = this.name.lastIndexOf(".");
    this.extension = dot >= 0 ? this.name.slice(dot + 1) : "";
    this.basename = dot >= 0 ? this.name.slice(0, dot) : this.name;
  }
}
class TFolder {
  constructor(path) {
    this.path = path;
  }
}
class Notice {
  constructor(message) {
    this.message = message;
  }
  setMessage(message) {
    this.message = message;
  }
  hide() {}
}
class Plugin {
  constructor(app) {
    this.app = app;
  }
  addSettingTab() {}
  registerEvent() {}
  async loadData() {
    return {};
  }
  async saveData() {}
}
class PluginSettingTab {}
class Setting {}
class Modal {
  constructor(app) {
    this.app = app;
  }
}

let deepSeekRequest;
const deepSeekRequests = [];
let deepSeekFinishReason = "stop";
const debugWrites = new Map();
const obsidianMock = {
  Modal,
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  base64ToArrayBuffer(value) {
    const bytes = Buffer.from(value, "base64");
    return bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
  },
  normalizePath(value) {
    return value.replace(/\\/g, "/").replace(/\/{2,}/g, "/").replace(/^\.\//, "");
  },
  async requestUrl(request) {
    if (request.method === "GET" && request.url.endsWith("/models")) {
      return {
        status: 200,
        json: { data: [{ id: "deepseek-v4-flash" }] },
        text: "",
      };
    }
    deepSeekRequest = request;
    deepSeekRequests.push(request);
    const userContent = JSON.parse(request.body).messages[1].content;
    return {
      status: 200,
      json: {
        choices: [{
          finish_reason: deepSeekFinishReason,
          message: { content: `# 已翻译\n\n${userContent}\n` },
        }],
      },
      text: "",
    };
  },
};

const originalLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === "obsidian") {
    return obsidianMock;
  }
  return originalLoad.call(this, request, parent, isMain);
};
const exported = require("../main.js");
Module._load = originalLoad;
const PluginClass = exported.default || exported;

const files = new Map();
const createdText = new Map();
const createdBinary = [];
const pdf = new TFile("docs/paper.pdf");
files.set(pdf.path, pdf);
const opened = [];

const vault = {
  adapter: {
    async write(path, contents) {
      debugWrites.set(path, contents);
    },
  },
  getAbstractFileByPath(path) {
    return files.get(path) || null;
  },
  async readBinary(file) {
    assert.equal(files.has(file.path), true);
    return new Uint8Array([37, 80, 68, 70]).buffer;
  },
  async createFolder(path) {
    const folder = new TFolder(path);
    files.set(path, folder);
    return folder;
  },
  async create(path, contents) {
    assert.equal(files.has(path), false, `unexpected overwrite: ${path}`);
    const file = new TFile(path);
    files.set(path, file);
    createdText.set(path, contents);
    return file;
  },
  async createBinary(path, contents) {
    assert.equal(files.has(path), false, `unexpected binary overwrite: ${path}`);
    const file = new TFile(path);
    files.set(path, file);
    createdBinary.push({ path, size: contents.byteLength });
    return file;
  },
  async delete(file) {
    files.delete(file.path);
  },
};

const app = {
  vault,
  workspace: {
    on() {},
    getLeaf(mode) {
      assert.equal(mode, "tab");
      return { async openFile(file) { opened.push(file.path); } };
    },
  },
  fileManager: {
    async getAvailablePathForAttachment(fileName) {
      let candidate = `图片/${fileName}`;
      let index = 2;
      while (files.has(candidate)) {
        const dot = candidate.lastIndexOf(".");
        candidate = `${candidate.slice(0, dot)} ${index}${candidate.slice(dot)}`;
        index += 1;
      }
      return candidate;
    },
    generateMarkdownLink(file, _sourcePath, _subpath, alias) {
      return `[[${file.path}|${alias}]]`;
    },
    async renameFile(file, targetPath) {
      files.delete(file.path);
      file.path = targetPath;
      files.set(targetPath, file);
    },
  },
};

const plugin = new PluginClass(app);
plugin.settings = {
  apiKey: "deepseek-test-key",
  baseUrl: "https://api.deepseek.com",
  model: "deepseek-v4-flash",
  thinkingEnabled: true,
  reasoningEffort: "max",
  temperature: 0.2,
  maxTokens: 100000,
  outputSuffix: "_翻译",
  mistralApiKey: "mistral-test-key",
  mistralModel: "mistral-ocr-latest",
  pdfOutputMode: "same-folder",
  movePdfToSubfolder: false,
  keepOcrMarkdown: true,
  extractImages: true,
  imageLimit: 0,
  imageMinSize: 0,
  paginate: false,
  deleteMistralFile: true,
  translationPrompt: "翻译为中文",
};
plugin.busyFiles = new Set();
plugin.activeProgress = new Set();
plugin.createPdfDocumentService = () => ({
  async load() {
    return 2;
  },
  async createSegments(ranges) {
    return ranges.map((range) => ({
      ...range,
      isWholeDocument: true,
      arrayBuffer: new Uint8Array([37, 80, 68, 70]).buffer,
    }));
  },
});
plugin.createMistralService = () => ({
  async checkConnection() {
    return true;
  },
  async uploadPdf(_bytes, fileName) {
    assert.equal(fileName, "paper.pdf");
    return { fileId: "paper-upload", url: "https://mistral.test/paper" };
  },
  async getSignedUrl() {
    return "https://mistral.test/paper";
  },
  async processOcr() {
    return {
      pages: [
        {
          index: 0,
          markdown: "\\[\nx=1\n\\]\n\n![figure](img-0.jpeg)",
          images: [{ id: "img-0.jpeg", imageBase64: "data:image/jpeg;base64,AA==" }],
        },
        {
          index: 1,
          markdown: "Text \\( q \\)\n\n![figure](img-0.jpeg)",
          images: [{ id: "img-0.jpeg", imageBase64: "data:image/jpeg;base64,AQ==" }],
        },
      ],
    };
  },
  async deleteFile() {
    return { deleted: true };
  },
});

(async () => {
  const defaultPlugin = new PluginClass(app);
  await defaultPlugin.loadSettings();
  assert.equal(defaultPlugin.settings.reasoningEffort, "max");
  assert.equal(defaultPlugin.settings.maxTokens, 100000);
  assert.equal(defaultPlugin.settings.outputSuffix, "_翻译");
  assert.equal(defaultPlugin.settings.keepOcrMarkdown, false);
  assert.equal(defaultPlugin.settings.paginate, true);
  assert.equal(defaultPlugin.settings.debugMode, false);
  assert.equal(
    crypto.createHash("sha256").update(defaultPlugin.settings.translationPrompt).digest("hex"),
    "45a2428f5a6be0bd18d6778a20e6c82a6f0a6731dacf2f23d68b8018bb3c61e5",
  );

  await plugin.translatePdf(pdf);

  assert.deepEqual([...createdText.keys()], ["docs/paper.md", "docs/paper_翻译.md"]);
  assert.equal(createdBinary.length, 2);
  assert.equal(createdBinary.every(({ path }) => path.startsWith("图片/paper--")), true);
  assert.notEqual(createdBinary[0].path, createdBinary[1].path);

  const ocr = createdText.get("docs/paper.md");
  assert.match(ocr, /\$\$\nx=1\n\$\$/);
  assert.match(ocr, /Text \$q\$/);
  assert.doesNotMatch(ocr, /!\[figure\]\(img-0\.jpeg\)/);
  assert.match(ocr, /!\[\[图片\/paper--/);

  const body = JSON.parse(deepSeekRequest.body);
  assert.equal(body.messages[1].content, ocr);
  assert.deepEqual(body.thinking, { type: "enabled" });
  assert.equal(body.reasoning_effort, "max");
  assert.equal(body.temperature, undefined);
  assert.equal(opened.at(-1), "docs/paper_翻译.md");
  assert.equal(files.has("docs/paper.pdf"), true);

  const conflictPlan = plugin.getAvailablePdfOutputPlan(pdf);
  assert.equal(conflictPlan.ocrPath, "docs/paper 2.md");
  assert.equal(conflictPlan.translationPath, "docs/paper 2_翻译.md");

  plugin.settings.pdfOutputMode = "subfolder";
  const subfolderPlan = plugin.getAvailablePdfOutputPlan(pdf);
  assert.equal(subfolderPlan.outputFolder, "docs/paper");
  assert.equal(subfolderPlan.ocrPath, "docs/paper/paper.md");

  const largePdf = new TFile("docs/large.pdf");
  files.set(largePdf.path, largePdf);
  const largePlugin = new PluginClass(app);
  largePlugin.settings = {
    ...plugin.settings,
    pdfOutputMode: "same-folder",
    keepOcrMarkdown: true,
    extractImages: false,
    paginate: true,
  };
  largePlugin.busyFiles = new Set();
  largePlugin.activeProgress = new Set();
  largePlugin.createPdfDocumentService = () => ({
    async load() {
      return 120;
    },
    async createSegments(ranges) {
      return ranges.map((range) => ({
        ...range,
        isWholeDocument: false,
        arrayBuffer: new Uint8Array([range.start, range.end]).buffer,
      }));
    },
  });
  largePlugin.choosePdfRanges = async (_file, pageCount) => {
    assert.equal(pageCount, 120);
    return [
      { start: 1, end: 60 },
      { start: 61, end: 120 },
    ];
  };

  let activeOcrRequests = 0;
  let maxActiveOcrRequests = 0;
  let nextUploadId = 0;
  largePlugin.createMistralService = () => {
    let segmentFileName = "";
    return {
    async checkConnection() {
      return true;
    },
    async uploadPdf(_bytes, fileName) {
      nextUploadId += 1;
      segmentFileName = fileName;
      return { fileId: `large-${nextUploadId}`, url: `https://mistral.test/${fileName}` };
    },
    async getSignedUrl(fileId) {
      return `https://mistral.test/${fileId}`;
    },
    async processOcr(url) {
      activeOcrRequests += 1;
      maxActiveOcrRequests = Math.max(maxActiveOcrRequests, activeOcrRequests);
      await new Promise((resolve) => setTimeout(resolve, 15));
      activeOcrRequests -= 1;
      const match = segmentFileName.match(/p(\d{4})-(\d{4})/);
      const pageCount = match ? Number(match[2]) - Number(match[1]) + 1 : 1;
      return {
        pages: Array.from({ length: pageCount }, (_, index) => ({
          index,
          markdown: index === 0 ? `OCR ${url}` : `OCR page ${index + 1}`,
          images: [],
        })),
      };
    },
    async deleteFile() {
      return { deleted: true };
    },
  }};

  await largePlugin.translatePdf(largePdf);
  assert.equal(maxActiveOcrRequests, 2);
  assert.equal(deepSeekRequests.length, 3);
  assert.equal(createdText.has("docs/large.md"), true);
  assert.equal(createdText.has("docs/large_翻译.md"), true);
  const largeTranslation = createdText.get("docs/large_翻译.md");
  const firstPartIndex = largeTranslation.indexOf("p0001-0060");
  const secondPartIndex = largeTranslation.indexOf("p0061-0120");
  assert.equal(firstPartIndex >= 0, true);
  assert.equal(secondPartIndex > firstPartIndex, true);

  const barrierPdf = new TFile("docs/barrier.pdf");
  files.set(barrierPdf.path, barrierPdf);
  const barrierPlugin = new PluginClass(app);
  barrierPlugin.settings = {
    ...plugin.settings,
    pdfOutputMode: "same-folder",
    keepOcrMarkdown: false,
    extractImages: false,
  };
  barrierPlugin.busyFiles = new Set();
  barrierPlugin.activeProgress = new Set();
  barrierPlugin.waitBeforeRetry = async () => {};
  barrierPlugin.createPdfDocumentService = largePlugin.createPdfDocumentService;
  barrierPlugin.choosePdfRanges = largePlugin.choosePdfRanges;
  const barrierUploadCalls = new Map();
  const barrierOcrCalls = new Map();
  barrierPlugin.createMistralService = () => {
    let segmentFileName = "";
    return {
      async checkConnection() {
        return true;
      },
      async uploadPdf(_bytes, fileName) {
        segmentFileName = fileName;
        barrierUploadCalls.set(fileName, (barrierUploadCalls.get(fileName) || 0) + 1);
        return { fileId: fileName, url: `https://mistral.test/${fileName}` };
      },
      async getSignedUrl() {
        return `https://mistral.test/${segmentFileName}`;
      },
      async processOcr() {
        const calls = (barrierOcrCalls.get(segmentFileName) || 0) + 1;
        barrierOcrCalls.set(segmentFileName, calls);
        const isSecond = segmentFileName.includes("p0061-0120");
        const pageCount = isSecond && calls <= 3 ? 59 : 60;
        return {
          pages: Array.from({ length: pageCount }, (_, index) => ({
            index,
            markdown: `${segmentFileName} page ${index + 1}`,
            images: [],
          })),
        };
      },
      async deleteFile() {
        return { deleted: true };
      },
    };
  };
  let barrierTranslationCalls = 0;
  barrierPlugin.requestTranslation = async (markdown) => {
    barrierTranslationCalls += 1;
    return `translated ${markdown}`;
  };
  let barrierPrompts = 0;
  barrierPlugin.askPdfFailureAction = async () => {
    barrierPrompts += 1;
    assert.equal(
      barrierTranslationCalls,
      0,
      "no translation may start when any OCR segment has failed",
    );
    return "retry";
  };

  await barrierPlugin.translatePdf(barrierPdf);
  assert.equal(barrierPrompts, 1);
  assert.equal(barrierUploadCalls.size, 2);
  assert.equal([...barrierUploadCalls.values()].every((calls) => calls === 1), true);
  assert.equal(barrierOcrCalls.get("barrier--p0001-0060.pdf"), 1);
  assert.equal(barrierOcrCalls.get("barrier--p0061-0120.pdf"), 4);
  assert.equal(barrierTranslationCalls, 2);
  assert.equal(createdText.has("docs/barrier_翻译.md"), true);

  const retryPdf = new TFile("docs/retry.pdf");
  files.set(retryPdf.path, retryPdf);
  const retryPlugin = new PluginClass(app);
  retryPlugin.settings = {
    ...plugin.settings,
    pdfOutputMode: "same-folder",
    keepOcrMarkdown: false,
    extractImages: false,
    debugMode: true,
  };
  retryPlugin.manifest = {
    id: "deepseek-translator",
    dir: ".obsidian/plugins/deepseek-translator",
  };
  retryPlugin.busyFiles = new Set();
  retryPlugin.activeProgress = new Set();
  retryPlugin.waitBeforeRetry = async () => {};
  retryPlugin.createPdfDocumentService = () => ({
    async load() {
      return 1;
    },
    async createSegments(ranges) {
      return ranges.map((range) => ({
        ...range,
        isWholeDocument: true,
        arrayBuffer: new Uint8Array([1]).buffer,
      }));
    },
  });
  let retryUploadCalls = 0;
  let retryOcrCalls = 0;
  let retryDeleteCalls = 0;
  retryPlugin.createMistralService = () => ({
    async checkConnection() {
      return true;
    },
    async uploadPdf() {
      retryUploadCalls += 1;
      return { fileId: "retry-upload", url: "https://mistral.test/retry" };
    },
    async getSignedUrl() {
      return "https://mistral.test/retry";
    },
    async processOcr() {
      retryOcrCalls += 1;
      return { pages: [{ index: 0, markdown: "Retry OCR", images: [] }] };
    },
    async deleteFile() {
      retryDeleteCalls += 1;
      return { deleted: true };
    },
  });
  let retryTranslationCalls = 0;
  retryPlugin.requestTranslation = async (markdown) => {
    retryTranslationCalls += 1;
    if (retryTranslationCalls <= 3) {
      throw new Error("temporary DeepSeek failure");
    }
    return `已恢复 \\( x \\)\n\n${markdown}`;
  };
  let failurePrompts = 0;
  retryPlugin.askPdfFailureAction = async () => {
    failurePrompts += 1;
    return "retry";
  };

  await retryPlugin.translatePdf(retryPdf);
  assert.equal(retryUploadCalls, 1, "retry must not upload a successful part again");
  assert.equal(retryOcrCalls, 1, "retry must not OCR a successful part again");
  assert.equal(retryDeleteCalls, 1);
  assert.equal(retryTranslationCalls, 4);
  assert.equal(failurePrompts, 1);
  assert.equal(createdText.has("docs/retry_翻译.md"), true);
  assert.match(createdText.get("docs/retry_翻译.md"), /已恢复 \$x\$/);
  assert.doesNotMatch(createdText.get("docs/retry_翻译.md"), /\\\(/);
  const debugSnapshotText = debugWrites.get(
    ".obsidian/plugins/deepseek-translator/debug-last-task.json",
  );
  const debugSnapshot = JSON.parse(debugSnapshotText);
  assert.equal(debugSnapshot.status, "completed");
  assert.equal(debugSnapshot.segments[0].ocrDone, true);
  assert.equal(debugSnapshot.segments[0].translationDone, true);
  assert.equal(debugSnapshotText.includes("deepseek-test-key"), false);
  assert.equal(debugSnapshotText.includes("mistral-test-key"), false);
  assert.equal(debugSnapshotText.includes("https://mistral.test/retry"), false);

  const abandonPdf = new TFile("docs/abandon.pdf");
  files.set(abandonPdf.path, abandonPdf);
  const abandonPlugin = new PluginClass(app);
  abandonPlugin.settings = {
    ...plugin.settings,
    pdfOutputMode: "same-folder",
    keepOcrMarkdown: false,
    extractImages: true,
    deleteMistralFile: false,
  };
  abandonPlugin.busyFiles = new Set();
  abandonPlugin.activeProgress = new Set();
  abandonPlugin.waitBeforeRetry = async () => {};
  abandonPlugin.createPdfDocumentService = retryPlugin.createPdfDocumentService;
  let abandonRemoteDeletes = 0;
  abandonPlugin.createMistralService = () => ({
    async checkConnection() {
      return true;
    },
    async uploadPdf() {
      return { fileId: "abandon-upload", url: "https://mistral.test/abandon" };
    },
    async getSignedUrl() {
      return "https://mistral.test/abandon";
    },
    async processOcr() {
      return {
        pages: [{
          index: 0,
          markdown: "![figure](abandon.png)",
          images: [{ id: "abandon.png", imageBase64: "data:image/png;base64,AA==" }],
        }],
      };
    },
    async deleteFile() {
      abandonRemoteDeletes += 1;
      return { deleted: true };
    },
  });
  abandonPlugin.requestTranslation = async () => {
    throw new Error("permanent DeepSeek failure");
  };
  abandonPlugin.askPdfFailureAction = async () => "abandon";

  await abandonPlugin.translatePdf(abandonPdf);
  const abandonedImage = createdBinary.find(({ path }) => path.includes("abandon--"));
  assert.ok(abandonedImage, "the OCR image should have been created before translation");
  assert.equal(files.has(abandonedImage.path), false, "abandon should delete OCR images");
  assert.equal(abandonRemoteDeletes, 1, "abandon should delete the remote PDF");
  assert.equal(createdText.has("docs/abandon_翻译.md"), false);

  const mineruPdf = new TFile("docs/mineru.pdf");
  files.set(mineruPdf.path, mineruPdf);
  const mineruPlugin = new PluginClass(app);
  mineruPlugin.settings = {
    ...plugin.settings,
    ocrProvider: "mineru",
    mineruApiKey: "mineru-test-token",
    pdfOutputMode: "same-folder",
    keepOcrMarkdown: true,
    extractImages: false,
  };
  mineruPlugin.busyFiles = new Set();
  mineruPlugin.activeProgress = new Set();
  mineruPlugin.createPdfDocumentService = () => ({
    async load() {
      return 1;
    },
    async createSegments(ranges) {
      return ranges.map((range) => ({
        ...range,
        isWholeDocument: true,
        arrayBuffer: new Uint8Array([1]).buffer,
      }));
    },
  });
  let mineruUploads = 0;
  let mineruOcrCalls = 0;
  mineruPlugin.createMinerUService = () => ({
    providerId: "mineru",
    providerName: "MinerU",
    supportsRemoteDelete: false,
    async checkConnection() {
      return true;
    },
    async uploadPdf() {
      mineruUploads += 1;
      return { fileId: "mineru-batch", url: "mineru-batch" };
    },
    async getSignedUrl() {
      return "mineru-batch";
    },
    async processOcr() {
      mineruOcrCalls += 1;
      return {
        provider: "mineru",
        pageCount: 1,
        pages: [{ index: 0, markdown: "MinerU \\( x \\)", images: [] }],
      };
    },
  });
  mineruPlugin.requestTranslation = async (markdown) => `MinerU translated ${markdown}`;

  await mineruPlugin.translatePdf(mineruPdf);
  assert.equal(mineruUploads, 1);
  assert.equal(mineruOcrCalls, 1);
  assert.equal(createdText.has("docs/mineru.md"), true);
  assert.equal(createdText.has("docs/mineru_翻译.md"), true);
  assert.match(createdText.get("docs/mineru.md"), /MinerU \$x\$/);

  let incompleteMetadata;
  deepSeekFinishReason = "length";
  await assert.rejects(
    plugin.requestTranslation("incomplete", {
      onResponse(metadata) {
        incompleteMetadata = metadata;
      },
    }),
    /finish_reason=length/,
  );
  assert.equal(incompleteMetadata.finishReason, "length");
  deepSeekFinishReason = "stop";

  const offlinePdf = new TFile("docs/offline.pdf");
  files.set(offlinePdf.path, offlinePdf);
  const offlinePlugin = new PluginClass(app);
  offlinePlugin.settings = { ...plugin.settings, debugMode: false };
  offlinePlugin.busyFiles = new Set();
  offlinePlugin.activeProgress = new Set();
  offlinePlugin.waitBeforeRetry = async () => {};
  let offlineDeepSeekChecks = 0;
  offlinePlugin.checkDeepSeekConnection = async () => {
    offlineDeepSeekChecks += 1;
    throw new Error("network unavailable");
  };
  offlinePlugin.createMistralService = () => ({
    async checkConnection() {
      return true;
    },
  });
  let offlinePrompts = 0;
  offlinePlugin.askApiConnectionFailureAction = async () => {
    offlinePrompts += 1;
    return "abandon";
  };
  offlinePlugin.createPdfDocumentService = () => {
    throw new Error("PDF must not be read before API preflight succeeds");
  };

  await offlinePlugin.translatePdf(offlinePdf);
  assert.equal(offlineDeepSeekChecks, 3);
  assert.equal(offlinePrompts, 1);
  assert.equal(offlinePlugin.busyFiles.size, 0);

  console.log("PDF pipeline test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
