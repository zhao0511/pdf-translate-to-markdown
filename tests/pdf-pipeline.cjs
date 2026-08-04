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

let deepSeekRequest;
const obsidianMock = {
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
    deepSeekRequest = request;
    return {
      status: 200,
      json: { choices: [{ message: { content: "# 已翻译\n\n![[图片占位]]\n" } }] },
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
  getAbstractFileByPath(path) {
    return files.get(path) || null;
  },
  async readBinary(file) {
    assert.equal(file, pdf);
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
};

const app = {
  vault,
  workspace: {
    on() {},
    getLeaf() {
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
plugin.createMistralService = () => ({
  async processPdf(_bytes, fileName, callbacks) {
    assert.equal(fileName, "paper.pdf");
    callbacks.onStage(2, "上传");
    callbacks.onStage(3, "OCR");
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
});

(async () => {
  const defaultPlugin = new PluginClass(app);
  await defaultPlugin.loadSettings();
  assert.equal(defaultPlugin.settings.reasoningEffort, "max");
  assert.equal(defaultPlugin.settings.maxTokens, 100000);
  assert.equal(defaultPlugin.settings.outputSuffix, "_翻译");
  assert.equal(defaultPlugin.settings.keepOcrMarkdown, false);
  assert.equal(defaultPlugin.settings.paginate, true);
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

  console.log("PDF pipeline test passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
