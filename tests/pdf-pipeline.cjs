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
const exported = require(process.env.PDF_TRANSLATE_TEST_BUNDLE || "../main.js");
Module._load = originalLoad;
const PluginClass = exported.default || exported;

const files = new Map();
const createdText = new Map();
const createdBinary = [];
const binaryDiskPaths = new Set();
const pdf = new TFile("docs/paper.pdf");
files.set(pdf.path, pdf);
const opened = [];

const vault = {
  adapter: {
    async write(path, contents) {
      debugWrites.set(path, contents);
    },
    async writeBinary(path, contents) {
      assert.equal(binaryDiskPaths.has(path), false, `unexpected binary overwrite: ${path}`);
      binaryDiskPaths.add(path);
      createdBinary.push({ path, size: contents.byteLength });
    },
    async exists(path) {
      return files.has(path) || binaryDiskPaths.has(path);
    },
    async remove(path) {
      binaryDiskPaths.delete(path);
    },
  },
  getAbstractFileByPath(path) {
    return files.get(path) || null;
  },
  async readBinary(file) {
    assert.equal(files.has(file.path), true);
    return new Uint8Array([37, 80, 68, 70]).buffer;
  },
  async cachedRead(file) {
    assert.equal(files.has(file.path), true);
    return "# English Markdown";
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
          images: [
            { id: "img-0.jpeg", imageBase64: "data:image/jpeg;base64,AA==" },
            { id: "unused.jpeg", imageBase64: "data:image/jpeg;base64,Ag==" },
          ],
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
  assert.equal(defaultPlugin.settings.numberSplitOutputFiles, true);
  assert.equal(defaultPlugin.settings.paginate, true);
  assert.equal(defaultPlugin.settings.ocrOnlyProvider, "mistral");
  assert.equal(defaultPlugin.settings.ocrOnlyOutputSuffix, "_OCR");
  assert.equal(defaultPlugin.settings.ocrOnlyPaginate, true);
  assert.equal(defaultPlugin.settings.mistralKeepHeadersFooters, true);
  assert.equal(defaultPlugin.settings.ocrOnlyMistralKeepHeadersFooters, true);
  assert.equal(defaultPlugin.settings.markdownModel, "deepseek-v4-flash");
  assert.equal(defaultPlugin.settings.markdownOutputSuffix, "_翻译");
  assert.equal(
    defaultPlugin.settings.markdownTranslationPrompt,
    defaultPlugin.settings.translationPrompt,
  );
  assert.equal(defaultPlugin.settings.debugMode, false);
  assert.equal(
    crypto.createHash("sha256").update(defaultPlugin.settings.translationPrompt).digest("hex"),
    "335276be2e6e9d32738a2a41ddfa44de188c5e895dc40ee7ae18569861c82251",
  );

  let activeLimitedOperations = 0;
  let maxLimitedOperations = 0;
  const limitedResults = await plugin.settleWithConcurrency(
    [1, 2, 3, 4, 5],
    2,
    async (value) => {
      activeLimitedOperations += 1;
      maxLimitedOperations = Math.max(maxLimitedOperations, activeLimitedOperations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeLimitedOperations -= 1;
      return value * 2;
    },
  );
  assert.equal(maxLimitedOperations, 2);
  assert.deepEqual(limitedResults.map((result) => result.value), [2, 4, 6, 8, 10]);

  let activeMaterializations = 0;
  let maxActiveMaterializations = 0;
  await Promise.all([1, 2, 3].map(() =>
    plugin.runExclusiveOcrMaterialization(async () => {
      activeMaterializations += 1;
      maxActiveMaterializations = Math.max(maxActiveMaterializations, activeMaterializations);
      await new Promise((resolve) => setTimeout(resolve, 5));
      activeMaterializations -= 1;
    }),
  ));
  assert.equal(maxActiveMaterializations, 1);

  const priorityOrder = [];
  let releasePriorityBlocker;
  let signalPriorityBlocker;
  const priorityBlockerStarted = new Promise((resolve) => { signalPriorityBlocker = resolve; });
  const priorityBlocker = plugin.runExclusiveOcrMaterialization(async () => {
    priorityOrder.push("blocker");
    signalPriorityBlocker();
    await new Promise((resolve) => { releasePriorityBlocker = resolve; });
  });
  await priorityBlockerStarted;
  const lowPriority = plugin.runExclusiveOcrMaterialization(
    async () => priorityOrder.push("10 pages"),
    10,
  );
  const highPriority = plugin.runExclusiveOcrMaterialization(
    async () => priorityOrder.push("100 pages"),
    100,
  );
  const mediumPriority = plugin.runExclusiveOcrMaterialization(
    async () => priorityOrder.push("50 pages"),
    50,
  );
  releasePriorityBlocker();
  await Promise.all([priorityBlocker, lowPriority, highPriority, mediumPriority]);
  assert.deepEqual(priorityOrder, ["blocker", "100 pages", "50 pages", "10 pages"]);

  const parallelPlugin = new PluginClass(app);
  parallelPlugin.settings = { ...plugin.settings, extractImages: false };
  let activeRemoteOcr = 0;
  let maxActiveRemoteOcr = 0;
  let startedRemoteOcr = 0;
  let releaseRemoteOcr;
  let signalAllRemoteOcrStarted;
  const remoteOcrGate = new Promise((resolve) => { releaseRemoteOcr = resolve; });
  const allRemoteOcrStarted = new Promise((resolve) => { signalAllRemoteOcrStarted = resolve; });
  const parallelStates = Array.from({ length: 6 }, (_, index) => ({
    index,
    segment: { start: index + 1, end: index + 1, arrayBuffer: null },
    segmentName: `parallel-${index + 1}.pdf`,
    ocrProvider: "mistral",
    ocrSettings: {
      ...parallelPlugin.settings,
      extractImages: false,
      keepOcrMarkdown: false,
      deleteMistralFile: false,
    },
    ocrService: {
      supportsRemoteDelete: false,
      async processOcr() {
        activeRemoteOcr += 1;
        startedRemoteOcr += 1;
        maxActiveRemoteOcr = Math.max(maxActiveRemoteOcr, activeRemoteOcr);
        if (startedRemoteOcr === 6) {
          signalAllRemoteOcrStarted();
        }
        await remoteOcrGate;
        activeRemoteOcr -= 1;
        return { pages: [{ index: 0, markdown: `parallel ${index + 1}`, images: [] }] };
      },
    },
    uploaded: true,
    remoteFileId: `parallel-${index + 1}`,
    remoteDeleted: false,
    remoteFileIds: new Set(),
    deletedRemoteFileIds: new Set(),
    signedUrl: `https://mistral.test/parallel-${index + 1}`,
    ocrResponse: null,
    ocrMarkdown: null,
    ocrDone: false,
    imageLinks: new Map(),
    createdImagePaths: new Set(),
    translated: null,
    translationDone: false,
    failure: null,
  }));
  const parallelAttempt = parallelPlugin.processPdfAttempt({
    states: parallelStates,
    file: pdf,
    outputPlan: {
      ocrPath: "docs/parallel.md",
      translationPath: "docs/parallel_翻译.md",
      attachmentReferencePath: "docs/parallel_翻译.md",
    },
    pdfHash: "parallel-hash",
    updateProgress() {},
    debugSession: null,
    includeTranslation: false,
  });
  await Promise.race([
    allRemoteOcrStarted,
    new Promise((_, reject) => setTimeout(() => reject(new Error("remote OCR did not fan out")), 1000)),
  ]);
  assert.equal(maxActiveRemoteOcr, 6, "remote OCR calls should not be capped by local processing limits");
  releaseRemoteOcr();
  assert.equal((await parallelAttempt).length, 0);
  assert.equal(parallelStates.every((state) => state.ocrDone), true);

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

  const splitOutputPdf = new TFile("docs/split-output.pdf");
  files.set(splitOutputPdf.path, splitOutputPdf);
  const splitOutputPlugin = new PluginClass(app);
  splitOutputPlugin.settings = {
    ...largePlugin.settings,
    keepOcrMarkdown: true,
  };
  splitOutputPlugin.busyFiles = new Set();
  splitOutputPlugin.activeProgress = new Set();
  splitOutputPlugin.createPdfDocumentService = largePlugin.createPdfDocumentService;
  splitOutputPlugin.choosePdfRanges = async () => ({
    mergeOutput: false,
    ranges: [
      { start: 1, end: 60, blockName: "第一章" },
      { start: 61, end: 120, blockName: "第二章" },
    ],
  });
  splitOutputPlugin.createMistralService = largePlugin.createMistralService;

  await splitOutputPlugin.translatePdf(splitOutputPdf);
  assert.equal(files.get("docs/split-output_翻译") instanceof TFolder, true);
  assert.equal(createdText.has("docs/split-output_翻译.md"), false);
  assert.equal(createdText.has("docs/split-output_翻译/1 第一章.md"), true);
  assert.equal(createdText.has("docs/split-output_翻译/2 第二章.md"), true);
  assert.equal(opened.at(-1), "docs/split-output_翻译/1 第一章.md");

  const splitNoNumberPdf = new TFile("docs/split-no-number.pdf");
  files.set(splitNoNumberPdf.path, splitNoNumberPdf);
  const splitNoNumberPlugin = new PluginClass(app);
  splitNoNumberPlugin.settings = {
    ...splitOutputPlugin.settings,
    numberSplitOutputFiles: false,
  };
  splitNoNumberPlugin.busyFiles = new Set();
  splitNoNumberPlugin.activeProgress = new Set();
  splitNoNumberPlugin.createPdfDocumentService = largePlugin.createPdfDocumentService;
  splitNoNumberPlugin.choosePdfRanges = splitOutputPlugin.choosePdfRanges;
  splitNoNumberPlugin.createMistralService = largePlugin.createMistralService;

  await splitNoNumberPlugin.translatePdf(splitNoNumberPdf);
  assert.equal(files.get("docs/split-no-number_翻译") instanceof TFolder, true);
  assert.equal(createdText.has("docs/split-no-number_翻译/第一章.md"), true);
  assert.equal(createdText.has("docs/split-no-number_翻译/第二章.md"), true);
  assert.equal(createdText.has("docs/split-no-number_翻译/1 第一章.md"), false);
  assert.equal(opened.at(-1), "docs/split-no-number_翻译/第一章.md");

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
      1,
      "a successful segment should translate without waiting for another segment's OCR failure",
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
    id: "pdf-translate-to-markdown",
    dir: ".obsidian/plugins/pdf-translate-to-markdown",
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
    ".obsidian/plugins/pdf-translate-to-markdown/debug-last-task.json",
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
  assert.equal(binaryDiskPaths.has(abandonedImage.path), false, "abandon should delete OCR images");
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

  const ocrOnlyPdf = new TFile("docs/ocr-only.pdf");
  files.set(ocrOnlyPdf.path, ocrOnlyPdf);
  const ocrOnlyPlugin = new PluginClass(app);
  ocrOnlyPlugin.settings = {
    ...plugin.settings,
    ocrOnlyProvider: "mistral",
    ocrOnlyOutputMode: "same-folder",
    ocrOnlyMovePdfToSubfolder: false,
    ocrOnlyOutputSuffix: "_OCR",
    ocrOnlyMistralModel: "mistral-ocr-latest",
    ocrOnlyExtractImages: false,
    ocrOnlyImageLimit: 0,
    ocrOnlyImageMinSize: 0,
    ocrOnlyPaginate: false,
    ocrOnlyDeleteMistralFile: true,
    debugMode: false,
  };
  ocrOnlyPlugin.busyFiles = new Set();
  ocrOnlyPlugin.activeProgress = new Set();
  const ocrOnlyRanges = [];
  ocrOnlyPlugin.createPdfDocumentService = () => ({
    async load() {
      return 205;
    },
    async createSegments(ranges) {
      ocrOnlyRanges.push(...ranges);
      return ranges.map((range) => ({
        ...range,
        isWholeDocument: false,
        arrayBuffer: new Uint8Array([range.start, range.end]).buffer,
      }));
    },
  });
  let ocrOnlyUploads = 0;
  let ocrOnlyDeletes = 0;
  ocrOnlyPlugin.createMistralService = (settings) => {
    assert.equal(settings.mistralModel, "mistral-ocr-latest");
    assert.equal(settings.extractImages, false);
    return {
      supportsRemoteDelete: true,
      async checkConnection() {
        return true;
      },
      async uploadPdf(_bytes, fileName) {
        ocrOnlyUploads += 1;
        return { fileId: fileName, url: fileName };
      },
      async getSignedUrl(fileId) {
        return fileId;
      },
      async processOcr(fileName) {
        const match = fileName.match(/p(\d{4})-(\d{4})/);
        const start = Number(match[1]);
        const end = Number(match[2]);
        return {
          pages: Array.from({ length: end - start + 1 }, (_, index) => ({
            index,
            markdown: `OCR ${start + index}`,
            images: [],
          })),
        };
      },
      async deleteFile() {
        ocrOnlyDeletes += 1;
        return { deleted: true };
      },
    };
  };
  ocrOnlyPlugin.requestTranslation = async () => {
    throw new Error("OCR-only workflow must not call DeepSeek");
  };

  await ocrOnlyPlugin.ocrPdfOnly(ocrOnlyPdf);
  assert.deepEqual(ocrOnlyRanges, [
    { start: 1, end: 100 },
    { start: 101, end: 200 },
    { start: 201, end: 205 },
  ]);
  assert.equal(ocrOnlyUploads, 3);
  assert.equal(ocrOnlyDeletes, 3);
  assert.equal(createdText.has("docs/ocr-only_OCR.md"), true);
  assert.match(createdText.get("docs/ocr-only_OCR.md"), /^OCR 1/);
  assert.match(createdText.get("docs/ocr-only_OCR.md"), /OCR 205\n$/);
  assert.equal(opened.at(-1), "docs/ocr-only_OCR.md");

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

  const outlinePlugin = new PluginClass(app);
  outlinePlugin.settings = { ...plugin.settings, extractImages: true };
  outlinePlugin.waitBeforeRetry = async () => {};
  await outlinePlugin.requestChapterOutline("--- PDF_PAGE: 1 ---\nContents", 120, 15);
  const outlineRequestBody = JSON.parse(deepSeekRequest.body);
  assert.deepEqual(outlineRequestBody.thinking, { type: "disabled" });
  assert.equal(outlineRequestBody.reasoning_effort, undefined);
  assert.equal(outlineRequestBody.temperature, 0.1);
  assert.equal(outlineRequestBody.max_tokens, 100000);
  const outlineOcrRanges = [];
  let outlineDeletes = 0;
  outlinePlugin.createOcrService = () => ({
    providerId: "mistral",
    providerName: "Mistral",
    supportsRemoteDelete: true,
    async uploadPdf(bytes, fileName) {
      const [start, end] = [...new Uint8Array(bytes)];
      outlineOcrRanges.push([start, end]);
      return { fileId: `outline-${start}-${end}`, url: fileName };
    },
    async getSignedUrl(fileId) {
      return fileId;
    },
    async processOcr(url) {
      const match = url.match(/p(\d{4})-(\d{4})/);
      const start = Number(match[1]);
      const end = Number(match[2]);
      return {
        pages: Array.from({ length: end - start + 1 }, (_, index) => ({
          index,
          markdown: `OCR physical page ${start + index}`,
          images: [],
        })),
      };
    },
    async deleteFile() {
      outlineDeletes += 1;
      return { deleted: true };
    },
  });
  const outlineAnalysisEnds = [];
  outlinePlugin.requestChapterOutline = async (_markdown, pageCount, analyzedThroughPage) => {
    outlineAnalysisEnds.push(analyzedThroughPage);
    const result = analyzedThroughPage < 35
      ? { status: "need_more", reason: "正文页码尚未出现", ranges: [] }
      : {
          status: "ready",
          pageMapping: { pdfPage: 17, printedPage: 1, offset: 16 },
          chapters: [
            { number: 1, title: "One", printedStartPage: 5 },
            { number: 2, title: "Two", printedStartPage: 55 },
          ],
          backMatter: null,
          warnings: [],
        };
    return { finishReason: "stop", content: JSON.stringify(result) };
  };
  const outlineDocument = {
    async createSegments(ranges) {
      return ranges.map((range) => ({
        ...range,
        isWholeDocument: false,
        arrayBuffer: new Uint8Array([range.start, range.end]).buffer,
      }));
    },
  };
  const outlineResult = await outlinePlugin.detectPdfChapterRanges({
    file: largePdf,
    pageCount: 120,
    pdfDocument: outlineDocument,
  });
  assert.deepEqual(outlineOcrRanges, [[1, 15], [16, 25], [26, 35]]);
  assert.deepEqual(outlineAnalysisEnds, [15, 25, 35]);
  assert.equal(outlineDeletes, 3);
  assert.deepEqual(outlineResult.ranges.map(({ start, end }) => ({ start, end })), [
    { start: 1, end: 20 },
    { start: 21, end: 70 },
    { start: 71, end: 120 },
  ]);

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

  const rateLimitPlugin = new PluginClass(app);
  rateLimitPlugin.settings = { ...plugin.settings };
  const retryWaits = [];
  const retryLabels = [];
  rateLimitPlugin.waitBeforeRetry = async (_attempt, waitMs) => retryWaits.push(waitMs);
  let rateLimitCalls = 0;
  const rateLimitResult = await rateLimitPlugin.runStageWithRetries(
    "Mistral OCR",
    async () => {
      rateLimitCalls += 1;
      if (rateLimitCalls === 1) {
        const error = new Error("429 Too Many Requests");
        error.status = 429;
        error.headers = { "retry-after": "2" };
        throw error;
      }
      return "ok";
    },
    (label) => retryLabels.push(label),
  );
  assert.equal(rateLimitResult, "ok");
  assert.equal(rateLimitCalls, 2);
  assert.equal(retryWaits.length, 1);
  assert.equal(retryWaits[0] >= 2000 && retryWaits[0] < 3000, true);
  assert.match(retryLabels[0], /速率限制/);

  const markdownFile = new TFile("docs/standalone.md");
  files.set(markdownFile.path, markdownFile);
  const markdownPlugin = new PluginClass(app);
  markdownPlugin.settings = {
    ...plugin.settings,
    markdownBaseUrl: "https://markdown.deepseek.test",
    markdownModel: "markdown-model",
    markdownThinkingEnabled: false,
    markdownReasoningEffort: "high",
    markdownTemperature: 0.4,
    markdownMaxTokens: 4321,
    markdownOutputSuffix: "_单独翻译",
    markdownTranslationPrompt: "Markdown 专用提示词",
    debugMode: false,
  };
  markdownPlugin.busyFiles = new Set();
  markdownPlugin.activeProgress = new Set();
  await markdownPlugin.translateFile(markdownFile);
  const markdownRequestBody = JSON.parse(deepSeekRequest.body);
  assert.equal(deepSeekRequest.url, "https://markdown.deepseek.test/chat/completions");
  assert.equal(markdownRequestBody.model, "markdown-model");
  assert.equal(markdownRequestBody.messages[0].content, "Markdown 专用提示词");
  assert.deepEqual(markdownRequestBody.thinking, { type: "disabled" });
  assert.equal(markdownRequestBody.temperature, 0.4);
  assert.equal(markdownRequestBody.max_tokens, 4321);
  assert.equal(createdText.has("docs/standalone_单独翻译.md"), true);

  console.log("PDF pipeline test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
