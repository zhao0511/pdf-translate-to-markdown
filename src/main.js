import {
  Notice,
  Plugin,
  PluginSettingTab,
  Setting,
  TFile,
  TFolder,
  base64ToArrayBuffer,
  normalizePath,
  requestUrl,
} from "obsidian";

import {
  DEEPSEEK_SECRET_ID,
  DEFAULT_SETTINGS,
  MISTRAL_SECRET_ID,
} from "./defaults.js";
import {
  imageExtension,
  normalizeMistralMath,
  replaceMistralImagePlaceholder,
  sanitizePathSegment,
  shortContentHash,
  stripDataUrlPrefix,
} from "./markdown-utils.js";
import { MistralOcrService } from "./mistral-ocr-service.mjs";
import { TaskProgress } from "./task-progress.js";
import { GithubReleaseService, isVersionNewer } from "./update-service.mjs";

class DeepSeekTranslatorPlugin extends Plugin {
  async onload() {
    await this.loadSettings();
    this.busyFiles = new Set();
    this.activeProgress = new Set();
    this.latestRelease = null;
    this.updateCheckPromise = null;
    this.updateInstalling = false;
    this.notifiedReleaseVersion = null;
    this.releaseService = new GithubReleaseService(
      this.app,
      this.manifest.id,
      this.manifest.version,
      requestUrl,
    );

    this.addSettingTab(new DeepSeekTranslatorSettingTab(this.app, this));

    this.registerEvent(
      this.app.workspace.on("file-menu", (menu, file) => {
        if (!(file instanceof TFile)) {
          return;
        }

        const extension = file.extension.toLowerCase();
        if (extension === "md") {
          menu.addItem((item) => {
            item
              .setTitle("翻译")
              .setIcon("languages")
              .setSection("action")
              .onClick(() => this.translateFile(file));
          });
        }

        if (extension === "pdf") {
          menu.addItem((item) => {
            item
              .setTitle("OCR 并翻译为 Markdown")
              .setIcon("scan-text")
              .setSection("action")
              .onClick(() => this.translatePdf(file));
          });
        }
      }),
    );
  }

  onunload() {
    for (const progress of this.activeProgress) {
      progress.dispose();
    }
    this.activeProgress.clear();
  }

  async loadSettings() {
    const saved = (await this.loadData()) || {};
    this.settings = Object.assign({}, DEFAULT_SETTINGS, saved);
    delete this.settings.normalizeMistralMath;
    delete this.settings.normalizeOcrMarkdown;

    const secretStorage = this.app.secretStorage;
    if (!secretStorage) {
      return;
    }

    let shouldMigrate = false;
    const deepSeekSecret = secretStorage.getSecret(DEEPSEEK_SECRET_ID);
    if (deepSeekSecret) {
      this.settings.apiKey = deepSeekSecret;
    } else if (saved.apiKey) {
      secretStorage.setSecret(DEEPSEEK_SECRET_ID, saved.apiKey);
      shouldMigrate = true;
    }

    const mistralSecret = secretStorage.getSecret(MISTRAL_SECRET_ID);
    if (mistralSecret) {
      this.settings.mistralApiKey = mistralSecret;
    } else if (saved.mistralApiKey) {
      secretStorage.setSecret(MISTRAL_SECRET_ID, saved.mistralApiKey);
      shouldMigrate = true;
    }

    if (shouldMigrate) {
      await this.saveSettings();
    }
  }

  async saveSettings() {
    const saved = Object.assign({}, this.settings);
    const secretStorage = this.app.secretStorage;

    if (secretStorage) {
      secretStorage.setSecret(DEEPSEEK_SECRET_ID, this.settings.apiKey || "");
      secretStorage.setSecret(MISTRAL_SECRET_ID, this.settings.mistralApiKey || "");
      saved.apiKey = "";
      saved.mistralApiKey = "";
    }

    await this.saveData(saved);
  }

  async translateFile(file) {
    if (!this.requireDeepSeekKey()) {
      return;
    }
    if (!this.startFileTask(file)) {
      return;
    }

    const progress = this.createProgress(file.name, 3, "翻译");
    try {
      progress.setPhase(1, "读取 Markdown");
      const markdown = await this.app.vault.cachedRead(file);
      const prepared = this.prepareMarkdownForTranslation(markdown);

      progress.setPhase(2, "DeepSeek 翻译中");
      const translated = await this.requestTranslation(prepared.markdown);
      progress.setPhase(3, "保存译文");
      const outputPath = this.getAvailableMarkdownTranslationPath(file);
      const outputFile = await this.app.vault.create(outputPath, translated);
      await this.openFileSafely(outputFile);
      progress.complete(`翻译完成：${outputFile.path}`);
    } catch (error) {
      console.error("Pdf translate to markdown:", error);
      progress.fail(this.getErrorMessage(error));
    } finally {
      this.finishFileTask(file, progress);
      void this.checkForUpdates();
    }
  }

  async translatePdf(file) {
    if (!this.requireMistralKey() || !this.requireDeepSeekKey()) {
      return;
    }
    if (!this.startFileTask(file)) {
      return;
    }

    const progress = this.createProgress(file.name, 7, "PDF 一键处理");
    try {
      progress.setPhase(1, "读取 PDF");
      const pdfBytes = await this.app.vault.readBinary(file);
      const pdfHash = await shortContentHash(pdfBytes);
      const outputPlan = this.getAvailablePdfOutputPlan(file);

      const mistral = this.createMistralService();
      const ocrResponse = await mistral.processPdf(pdfBytes, file.name, {
        onStage: (phase, label) => progress.setPhase(phase, label),
        onWarning: (message) => {
          console.warn("Pdf translate to markdown:", message);
          new Notice(message, 10000);
        },
      });

      progress.setPhase(4, "保存 OCR 图片");
      await this.ensureOutputFolder(outputPlan.outputFolder);
      const materialized = await this.materializeOcrResult(
        ocrResponse.pages,
        file,
        outputPlan,
        pdfHash,
        progress,
      );

      const normalized = normalizeMistralMath(materialized.markdown);
      const ocrMarkdown = normalized.markdown;
      const translationInput = normalized.markdown;

      progress.setPhase(5, "保存 OCR Markdown");
      let ocrFile = null;
      if (this.settings.keepOcrMarkdown) {
        ocrFile = await this.app.vault.create(outputPlan.ocrPath, ocrMarkdown);
      } else {
        progress.update("跳过 OCR Markdown");
      }

      progress.setPhase(6, "DeepSeek 翻译中");
      const translated = await this.requestTranslation(translationInput);

      progress.setPhase(7, "保存译文");
      const translatedFile = await this.app.vault.create(outputPlan.translationPath, translated);
      await this.movePdfIfRequested(file, outputPlan);
      await this.openFileSafely(translatedFile);

      const details = [
        `${ocrResponse.pages.length} 页`,
        `${materialized.savedImageCount} 张图片`,
        ocrFile ? `OCR：${ocrFile.path}` : "未保留 OCR 文件",
      ].join("；");
      progress.complete(`PDF 翻译完成：${translatedFile.path}（${details}）`);
    } catch (error) {
      console.error("Pdf translate to markdown PDF pipeline:", error);
      progress.fail(this.getErrorMessage(error));
    } finally {
      this.finishFileTask(file, progress);
      void this.checkForUpdates();
    }
  }

  async checkForUpdates(options = {}) {
    const manual = Boolean(options.manual);
    if (!this.releaseService) {
      return null;
    }
    if (this.updateCheckPromise) {
      return this.updateCheckPromise;
    }

    this.updateCheckPromise = (async () => {
      try {
        const release = await this.releaseService.getLatestRelease();
        if (release && isVersionNewer(release.version, this.manifest.version)) {
          this.latestRelease = release;
          if (manual || this.notifiedReleaseVersion !== release.version) {
            this.notifiedReleaseVersion = release.version;
            new Notice(
              `发现新版本 ${release.version}。请打开 Pdf translate to markdown 设置并点击“更新”。`,
              12000,
            );
          }
          return release;
        }

        this.latestRelease = null;
        if (manual) {
          new Notice(`当前已是最新版本 ${this.manifest.version}。`, 5000);
        }
        return null;
      } catch (error) {
        console.warn("Pdf translate to markdown update check:", error);
        if (manual) {
          new Notice(`检查更新失败：${this.getErrorMessage(error)}`, 10000);
        }
        return null;
      } finally {
        this.updateCheckPromise = null;
      }
    })();

    return this.updateCheckPromise;
  }

  async installLatestUpdate() {
    if (this.updateInstalling) {
      new Notice("正在更新，请稍候。");
      return false;
    }

    let release = this.latestRelease;
    if (!release) {
      release = await this.checkForUpdates({ manual: true });
    }
    if (!release) {
      return false;
    }

    this.updateInstalling = true;
    const progress = new Notice(`正在下载版本 ${release.version}...`, 0);
    try {
      const installedVersion = await this.releaseService.installRelease(release);
      progress.hide();
      this.latestRelease = null;
      new Notice(
        `版本 ${installedVersion} 已安装。请重新加载 Obsidian 以启用新版本。`,
        15000,
      );
      return true;
    } catch (error) {
      progress.hide();
      console.error("Pdf translate to markdown update install:", error);
      new Notice(`更新失败：${this.getErrorMessage(error)}`, 12000);
      return false;
    } finally {
      this.updateInstalling = false;
    }
  }

  createMistralService() {
    return new MistralOcrService(this.settings);
  }

  createProgress(fileName, totalPhases, taskLabel) {
    const progress = new TaskProgress(fileName, totalPhases, taskLabel);
    this.activeProgress.add(progress);
    return progress;
  }

  startFileTask(file) {
    if (this.busyFiles.has(file.path)) {
      new Notice(`“${file.name}”正在处理中，请稍候。`);
      return false;
    }
    this.busyFiles.add(file.path);
    return true;
  }

  finishFileTask(file, progress) {
    progress.dispose();
    this.activeProgress.delete(progress);
    this.busyFiles.delete(file.path);
  }

  requireDeepSeekKey() {
    if (this.settings.apiKey.trim()) {
      return true;
    }
    new Notice("请先在插件设置中填写 DeepSeek API 密钥。");
    return false;
  }

  requireMistralKey() {
    if (this.settings.mistralApiKey.trim()) {
      return true;
    }
    new Notice("请先在插件设置中填写 Mistral API 密钥。");
    return false;
  }

  prepareMarkdownForTranslation(markdown) {
    return normalizeMistralMath(markdown);
  }

  async requestTranslation(markdown) {
    const endpoint = this.getChatCompletionsEndpoint();
    const temperature = this.clampNumber(this.settings.temperature, 0, 2, 0.2);
    const maxTokens = Math.max(1, Math.floor(Number(this.settings.maxTokens) || 8192));
    const requestBody = {
      model: this.settings.model.trim() || DEFAULT_SETTINGS.model,
      messages: [
        {
          role: "system",
          content: this.settings.translationPrompt.trim() || DEFAULT_SETTINGS.translationPrompt,
        },
        { role: "user", content: markdown },
      ],
      thinking: {
        type: this.settings.thinkingEnabled ? "enabled" : "disabled",
      },
      max_tokens: maxTokens,
      stream: false,
    };

    if (this.settings.thinkingEnabled) {
      requestBody.reasoning_effort = this.settings.reasoningEffort === "max" ? "max" : "high";
    } else {
      requestBody.temperature = temperature;
    }

    const response = await requestUrl({
      url: endpoint,
      method: "POST",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify(requestBody),
      throw: false,
    });

    if (response.status < 200 || response.status >= 300) {
      let apiMessage = response.text;
      try {
        apiMessage = response.json?.error?.message || response.text;
      } catch (_error) {
        // Some proxies return a non-JSON error body.
      }
      throw new Error(`DeepSeek API 返回 ${response.status}${apiMessage ? `：${apiMessage}` : ""}`);
    }

    const content = response.json?.choices?.[0]?.message?.content;
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("DeepSeek API 没有返回可用的翻译文本");
    }
    return content;
  }

  getChatCompletionsEndpoint() {
    const baseUrl = (this.settings.baseUrl || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, "");
    return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  }

  getAvailableMarkdownTranslationPath(sourceFile) {
    const folderPath = this.parentPath(sourceFile.path);
    const suffix = this.sanitizeSuffix(this.settings.outputSuffix);
    const baseName = `${sourceFile.basename}${suffix}`;

    for (let index = 0; ; index += 1) {
      const numberedName = index === 0 ? baseName : `${baseName} ${index + 1}`;
      const candidate = this.joinPath(folderPath, `${numberedName}.md`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }
  }

  getAvailablePdfOutputPlan(pdfFile) {
    const parent = this.parentPath(pdfFile.path);
    const originalStem = sanitizePathSegment(pdfFile.basename, "PDF");
    const translationSuffix = this.sanitizeSuffix(this.settings.outputSuffix);
    const useSubfolder = this.settings.pdfOutputMode === "subfolder";

    for (let index = 0; ; index += 1) {
      const stem = index === 0 ? originalStem : `${originalStem} ${index + 1}`;
      const outputFolder = useSubfolder ? this.joinPath(parent, stem) : parent;
      const ocrPath = this.joinPath(outputFolder, `${stem}.md`);
      const translationPath = this.joinPath(outputFolder, `${stem}${translationSuffix}.md`);

      if (useSubfolder) {
        if (!this.app.vault.getAbstractFileByPath(outputFolder)) {
          return { outputFolder, stem, ocrPath, translationPath, useSubfolder };
        }
        continue;
      }

      if (
        !this.app.vault.getAbstractFileByPath(ocrPath) &&
        !this.app.vault.getAbstractFileByPath(translationPath)
      ) {
        return { outputFolder, stem, ocrPath, translationPath, useSubfolder };
      }
    }
  }

  async ensureOutputFolder(folderPath) {
    if (!folderPath) {
      return;
    }
    const existing = this.app.vault.getAbstractFileByPath(folderPath);
    if (existing instanceof TFolder) {
      return;
    }
    if (existing) {
      throw new Error(`输出路径已被文件占用：${folderPath}`);
    }
    await this.app.vault.createFolder(folderPath);
  }

  async materializeOcrResult(pages, pdfFile, outputPlan, pdfHash, progress) {
    const referenceSourcePath = this.settings.keepOcrMarkdown
      ? outputPlan.ocrPath
      : outputPlan.translationPath;
    const imageCount = this.settings.extractImages
      ? pages.reduce(
          (total, page) => total + (page.images || []).filter((image) => image.imageBase64).length,
          0,
        )
      : 0;
    const pageMarkdowns = [];
    let savedImageCount = 0;

    for (let pageOffset = 0; pageOffset < pages.length; pageOffset += 1) {
      const page = pages[pageOffset];
      const pageNumber = Number.isFinite(page.index) ? page.index + 1 : pageOffset + 1;
      let markdown = page.markdown || "";

      if (this.settings.extractImages) {
        const images = page.images || [];
        for (let imageOffset = 0; imageOffset < images.length; imageOffset += 1) {
          const image = images[imageOffset];
          if (!image.imageBase64) {
            continue;
          }

          const originalId = String(image.id || `img-${imageOffset}.png`);
          const fileName = this.uniqueImageName(
            pdfFile.basename,
            pdfHash,
            pageNumber,
            imageOffset,
            originalId,
            image.imageBase64,
          );
          const imagePath = await this.app.fileManager.getAvailablePathForAttachment(
            fileName,
            referenceSourcePath,
          );
          const imageFile = await this.app.vault.createBinary(
            imagePath,
            base64ToArrayBuffer(stripDataUrlPrefix(image.imageBase64)),
          );
          let embeddedLink = this.app.fileManager.generateMarkdownLink(
            imageFile,
            referenceSourcePath,
            undefined,
            originalId,
          );
          if (!embeddedLink.startsWith("!")) {
            embeddedLink = `!${embeddedLink}`;
          }
          markdown = replaceMistralImagePlaceholder(markdown, originalId, embeddedLink);

          savedImageCount += 1;
          progress.update(`保存 OCR 图片 ${savedImageCount}/${imageCount}`);
        }
      }

      pageMarkdowns.push(markdown.trimEnd());
    }

    if (imageCount === 0) {
      progress.update("没有需要保存的 OCR 图片");
    }

    const separator = this.settings.paginate ? "\n\n---\n\n" : "\n\n";
    return {
      markdown: pageMarkdowns.join(separator).trim() + "\n",
      savedImageCount,
    };
  }

  uniqueImageName(pdfBaseName, pdfHash, pageNumber, imageOffset, imageId, imageBase64) {
    const prefix = sanitizePathSegment(pdfBaseName, "PDF").slice(0, 80).trim();
    const extension = imageExtension(imageId, imageBase64);
    const rawImageStem = String(imageId || `img-${imageOffset}`).replace(/\.[^.]+$/, "");
    const imageStem = sanitizePathSegment(rawImageStem, `img-${imageOffset + 1}`).slice(0, 40);
    const page = String(pageNumber).padStart(4, "0");
    return `${prefix}--${pdfHash}--p${page}--${imageStem}.${extension}`;
  }

  async movePdfIfRequested(pdfFile, outputPlan) {
    if (!outputPlan.useSubfolder || !this.settings.movePdfToSubfolder) {
      return;
    }
    const targetPath = this.joinPath(outputPlan.outputFolder, pdfFile.name);
    try {
      await this.app.fileManager.renameFile(pdfFile, targetPath);
    } catch (error) {
      console.error("Failed to move source PDF:", error);
      new Notice(`译文已生成，但移动原 PDF 失败：${this.getErrorMessage(error)}`, 10000);
    }
  }

  async openFileSafely(file) {
    try {
      await this.app.workspace.getLeaf(false).openFile(file);
    } catch (error) {
      console.warn("Unable to open generated file:", error);
      new Notice(`文件已生成，但无法自动打开：${file.path}`, 8000);
    }
  }

  parentPath(path) {
    const slashIndex = path.lastIndexOf("/");
    return slashIndex >= 0 ? path.slice(0, slashIndex) : "";
  }

  joinPath(folder, name) {
    return normalizePath(folder ? `${folder}/${name}` : name);
  }

  sanitizeSuffix(value) {
    return sanitizePathSegment(value || DEFAULT_SETTINGS.outputSuffix, DEFAULT_SETTINGS.outputSuffix);
  }

  clampNumber(value, min, max, fallback) {
    const number = Number(value);
    return Number.isFinite(number) ? Math.min(max, Math.max(min, number)) : fallback;
  }

  getErrorMessage(error) {
    if (error instanceof Error && error.message) {
      return error.message;
    }
    return String(error || "未知错误");
  }
}

class DeepSeekTranslatorSettingTab extends PluginSettingTab {
  constructor(app, plugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display() {
    const { containerEl } = this;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Pdf translate to markdown" });
    containerEl.createEl("h3", { text: "API 密钥" });

    containerEl.createEl("p", {
      text: "使用教程：先按下面的步骤创建并填写 API 密钥。配置完成后，可在文件列表中右键 Markdown 直接翻译，或右键 PDF 执行 OCR 并翻译。",
    });
    const guide = containerEl.createEl("ol");
    const deepSeekGuide = guide.createEl("li");
    deepSeekGuide.appendText("打开 DeepSeek ");
    this.addExternalLink(deepSeekGuide, "API Keys", "https://platform.deepseek.com/api_keys");
    deepSeekGuide.appendText(" 创建密钥，复制到下方；本月用量可在 ");
    this.addExternalLink(deepSeekGuide, "DeepSeek Usage", "https://platform.deepseek.com/usage");
    deepSeekGuide.appendText(" 查看。");

    const mistralGuide = guide.createEl("li");
    mistralGuide.appendText("打开 Mistral ");
    this.addExternalLink(
      mistralGuide,
      "API Keys",
      "https://admin.mistral.ai/plateforme/api-keys",
    );
    mistralGuide.appendText(" 创建密钥，复制到下方；订阅与用量可在 ");
    this.addExternalLink(
      mistralGuide,
      "Mistral Subscription",
      "https://admin.mistral.ai/subscription",
    );
    mistralGuide.appendText(" 查看。");

    const usageGuide = guide.createEl("li");
    usageGuide.appendText(
      "普通 Markdown 翻译只需要 DeepSeek 密钥；PDF 一键翻译同时需要 Mistral 和 DeepSeek 密钥。其余设置通常可保持默认。",
    );

    this.addPasswordSetting(
      containerEl,
      "DeepSeek API 密钥",
      "用于翻译 Markdown。支持 Secret Storage 时会安全迁移，不再写入 data.json。",
      "apiKey",
    );
    this.addPasswordSetting(
      containerEl,
      "Mistral API 密钥",
      "用于 PDF OCR。不会读取或复用其他插件中的密钥。",
      "mistralApiKey",
    );

    containerEl.createEl("h3", { text: "PDF 输出设置" });
    new Setting(containerEl)
      .setName("结果输出位置")
      .setDesc("图片始终遵循 Obsidian 的默认附件路径。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("same-folder", "PDF 所在文件夹")
          .addOption("subfolder", "在 PDF 所在文件夹中新建与 PDF 同名子文件夹")
          .setValue(this.plugin.settings.pdfOutputMode)
          .onChange(async (value) => {
            await this.updateSetting("pdfOutputMode", value);
            this.display();
          }),
      );

    if (this.plugin.settings.pdfOutputMode === "subfolder") {
      new Setting(containerEl)
        .setName("将原 PDF 移入结果文件夹")
        .setDesc("默认关闭；仅在全部处理成功后移动 PDF。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.movePdfToSubfolder)
            .onChange((value) => this.updateSetting("movePdfToSubfolder", value)),
        );
    }

    new Setting(containerEl)
      .setName("保留中间结果（OCR 得到的英文版 Markdown 文件）")
      .setDesc("建议开启；DeepSeek 失败时仍可保留 OCR 结果并单独重试翻译。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.keepOcrMarkdown)
          .onChange((value) => this.updateSetting("keepOcrMarkdown", value)),
      );

    new Setting(containerEl)
      .setName("输出文件名后缀")
      .setDesc("例如：paper.md 的译文保存为 paper_翻译.md。")
      .addText((text) =>
        text
          .setValue(this.plugin.settings.outputSuffix)
          .onChange((value) => this.updateSetting("outputSuffix", value)),
      );

    containerEl.createEl("h3", { text: "DeepSeek 设置" });
    new Setting(containerEl)
      .setName("API 地址")
      .setDesc("填写基础地址或完整的 /chat/completions 地址。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.baseUrl)
          .setValue(this.plugin.settings.baseUrl)
          .onChange((value) => this.updateSetting("baseUrl", value.trim())),
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("DeepSeek 模型名称，也可以填写兼容服务的模型名。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.model)
          .setValue(this.plugin.settings.model)
          .onChange((value) => this.updateSetting("model", value.trim())),
      );

    new Setting(containerEl)
      .setName("深度思考")
      .setDesc("关闭通常更适合普通翻译；开启后可选择思考强度。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.thinkingEnabled).onChange(async (value) => {
          await this.updateSetting("thinkingEnabled", value);
          this.display();
        }),
      );

    if (this.plugin.settings.thinkingEnabled) {
      new Setting(containerEl)
        .setName("思考强度")
        .setDesc("仅在深度思考开启时生效。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("high", "High")
            .addOption("max", "Max")
            .setValue(this.plugin.settings.reasoningEffort)
            .onChange((value) => this.updateSetting("reasoningEffort", value)),
        );
    }

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(
        this.plugin.settings.thinkingEnabled
          ? "深度思考模式下不发送 Temperature。"
          : "控制随机性，范围 0–2；翻译建议使用较低值。",
      )
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.temperature))
          .onChange((value) => this.updateFiniteNumber("temperature", value, 0, 2));
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "2";
        text.inputEl.step = "0.1";
      });

    new Setting(containerEl)
      .setName("最大输出 Token")
      .setDesc("当前版本整篇只发起一次请求；长文仍可能受此值或模型上下文限制。")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange((value) => this.updatePositiveInteger("maxTokens", value));
        text.inputEl.type = "number";
        text.inputEl.min = "1";
      });

    containerEl.createEl("h3", { text: "Mistral OCR 设置" });
    new Setting(containerEl)
      .setName("OCR 模型")
      .setDesc("默认使用 Mistral 的最新 OCR 模型别名。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.mistralModel)
          .setValue(this.plugin.settings.mistralModel)
          .onChange((value) => this.updateSetting("mistralModel", value.trim())),
      );

    new Setting(containerEl)
      .setName("提取图片")
      .setDesc("将 Mistral 返回的图片写入 Obsidian 默认附件路径，并重写 Markdown 链接。")
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.extractImages).onChange(async (value) => {
          await this.updateSetting("extractImages", value);
          this.display();
        }),
      );

    if (this.plugin.settings.extractImages) {
      new Setting(containerEl)
        .setName("图片数量上限")
        .setDesc("0 表示不限制。")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.imageLimit))
            .onChange((value) => this.updateNonNegativeInteger("imageLimit", value));
          text.inputEl.type = "number";
          text.inputEl.min = "0";
        });

      new Setting(containerEl)
        .setName("图片最小尺寸")
        .setDesc("宽和高的最小像素值；0 表示不限制。")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.imageMinSize))
            .onChange((value) => this.updateNonNegativeInteger("imageMinSize", value));
          text.inputEl.type = "number";
          text.inputEl.min = "0";
        });
    }

    new Setting(containerEl)
      .setName("页面之间添加分隔线")
      .setDesc("开启后在每页 OCR Markdown 之间插入 ---。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.paginate)
          .onChange((value) => this.updateSetting("paginate", value)),
      );

    new Setting(containerEl)
      .setName("删除 Mistral 远程临时文件")
      .setDesc("建议开启；OCR 响应返回后立即尝试删除上传的 PDF。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.deleteMistralFile)
          .onChange((value) => this.updateSetting("deleteMistralFile", value)),
      );

    containerEl.createEl("h3", { text: "翻译提示词" });
    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("Markdown 原文会作为下一条用户消息完整提交。")
      .addTextArea((text) => {
        text
          .setPlaceholder(DEFAULT_SETTINGS.translationPrompt)
          .setValue(this.plugin.settings.translationPrompt)
          .onChange((value) => this.updateSetting("translationPrompt", value));
        text.inputEl.rows = 14;
        text.inputEl.addClass("deepseek-translator-prompt");
      });

    containerEl.createEl("h3", { text: "更新" });
    const release = this.plugin.latestRelease;
    const updateSetting = new Setting(containerEl)
      .setName(release ? `发现新版本 ${release.version}` : `当前版本 ${this.plugin.manifest.version}`)
      .setDesc(
        release
          ? "点击更新后会从固定 GitHub Release 下载并校验插件文件。安装完成后需要重新加载 Obsidian。"
          : "每次翻译任务结束后会自动检查 GitHub Release，也可以手动检查。",
      );

    updateSetting.addButton((button) =>
      button.setButtonText("检查更新").onClick(async () => {
        button.setDisabled(true).setButtonText("检查中...");
        await this.plugin.checkForUpdates({ manual: true });
        this.display();
      }),
    );

    if (release) {
      updateSetting.addButton((button) =>
        button
          .setButtonText("更新")
          .setCta()
          .onClick(async () => {
            button.setDisabled(true).setButtonText("更新中...");
            const installed = await this.plugin.installLatestUpdate();
            if (!installed) {
              this.display();
            }
          }),
      );
    }
  }

  addExternalLink(parent, label, url) {
    parent.createEl("a", {
      text: label,
      attr: {
        href: url,
        target: "_blank",
        rel: "noopener noreferrer",
      },
    });
  }

  addPasswordSetting(containerEl, name, description, key) {
    new Setting(containerEl)
      .setName(name)
      .setDesc(description)
      .addText((text) => {
        text
          .setPlaceholder("填写 API 密钥")
          .setValue(this.plugin.settings[key])
          .onChange((value) => this.updateSetting(key, value.trim()));
        text.inputEl.type = "password";
        text.inputEl.autocomplete = "off";
      });
  }

  async updateSetting(key, value) {
    this.plugin.settings[key] = value;
    await this.plugin.saveSettings();
  }

  async updateFiniteNumber(key, value, min, max) {
    const number = Number(value);
    if (Number.isFinite(number)) {
      await this.updateSetting(key, Math.min(max, Math.max(min, number)));
    }
  }

  async updatePositiveInteger(key, value) {
    const number = Math.floor(Number(value));
    if (Number.isFinite(number) && number > 0) {
      await this.updateSetting(key, number);
    }
  }

  async updateNonNegativeInteger(key, value) {
    const number = Math.floor(Number(value));
    if (Number.isFinite(number) && number >= 0) {
      await this.updateSetting(key, number);
    }
  }
}

export default DeepSeekTranslatorPlugin;
