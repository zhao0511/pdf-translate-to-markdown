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
  MINERU_SECRET_ID,
  MISTRAL_SECRET_ID,
} from "./defaults.js";
import {
  imageExtension,
  markdownImageBasenames,
  normalizeMistralMath,
  replaceMistralImagePlaceholders,
  sanitizePathSegment,
  shortContentHash,
  stripDataUrlPrefix,
} from "./markdown-utils.js";
import {
  buildChapterOutlineRanges,
  buildPageMarkedMarkdown,
  chapterOutlineStatus,
  parseChapterOutlineResponse,
} from "./chapter-outline-utils.mjs";
import { MistralOcrService } from "./mistral-ocr-service.mjs";
import { MinerUOcrService } from "./mineru-ocr-service.mjs";
import { PdfDocumentService } from "./pdf-document-service.mjs";
import { PdfRangeModal } from "./pdf-range-modal.js";
import {
  PDF_SPLIT_THRESHOLD,
  countSelectedPages,
  createDefaultPdfRanges,
  mergeMarkdownParts,
  validatePdfBlockNames,
} from "./pdf-range-utils.mjs";
import { TaskProgress } from "./task-progress.js";
import { TaskFailureModal } from "./task-failure-modal.js";
import { GithubReleaseService, isVersionNewer } from "./update-service.mjs";

const MAX_STAGE_ATTEMPTS = 3;
const MAX_RATE_LIMIT_ATTEMPTS = 6;
const DEFAULT_RATE_LIMIT_WAIT_MS = 60000;
const DEBUG_WRITE_DEBOUNCE_MS = 750;

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
              .setTitle("仅转为 Markdown")
              .setIcon("scan-line")
              .setSection("action")
              .onClick(() => this.ocrPdfOnly(file));
          });
          menu.addItem((item) => {
            item
              .setTitle("转为 Markdown 并翻译")
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

    const mineruSecret = secretStorage.getSecret(MINERU_SECRET_ID);
    if (mineruSecret) {
      this.settings.mineruApiKey = mineruSecret;
    } else if (saved.mineruApiKey) {
      secretStorage.setSecret(MINERU_SECRET_ID, saved.mineruApiKey);
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
      secretStorage.setSecret(MINERU_SECRET_ID, this.settings.mineruApiKey || "");
      saved.apiKey = "";
      saved.mistralApiKey = "";
      saved.mineruApiKey = "";
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

    const translationSettings = this.getMarkdownTranslationRuntimeSettings();
    const progress = this.createProgress(file.name, 3, "翻译");
    const debugSession = this.createDebugSession("markdown", file, translationSettings);
    try {
      progress.setPhase(1, "读取 Markdown");
      const markdown = await this.app.vault.cachedRead(file);
      const prepared = this.prepareMarkdownForTranslation(markdown);
      await this.updateDebugSession(debugSession, "markdown-prepared", {
        sourceMarkdown: markdown,
        preparedMarkdown: prepared.markdown,
        mathReplacementCount: prepared.replacementCount,
      });

      progress.setPhase(2, "DeepSeek 翻译中");
      const translatedResponse = await this.runStageWithRetries(
        "翻译",
        (attempt) =>
          this.requestTranslation(prepared.markdown, {
            settings: translationSettings,
            onResponse: (response) =>
              this.updateDebugSession(debugSession, "translation-response", {
                attempt,
                response,
              }),
          }),
        (label) => progress.update(label),
        {
          onAttemptFailure: (attempt, error) =>
            this.updateDebugSession(debugSession, "translation-attempt-failed", {
              attempt,
              error: this.serializeError(error),
            }),
        },
      );
      const translated = normalizeMistralMath(translatedResponse);
      await this.updateDebugSession(debugSession, "translation-normalized", {
        translatedMarkdown: translated.markdown,
        mathReplacementCount: translated.replacementCount,
      });
      progress.setPhase(3, "保存译文");
      const outputPath = this.getAvailableMarkdownTranslationPath(file, translationSettings);
      const outputFile = await this.app.vault.create(outputPath, translated.markdown);
      await this.openFileSafely(outputFile);
      await this.updateDebugSession(debugSession, "output-saved", {
        translationPath: outputFile.path,
      });
      progress.complete(`翻译完成：${outputFile.path}`);
      await this.finishDebugSession(debugSession, "completed");
    } catch (error) {
      console.error("Pdf translate to markdown:", error);
      await this.finishDebugSession(debugSession, "failed", error);
      progress.fail(this.getErrorMessage(error));
    } finally {
      this.finishFileTask(file, progress);
      void this.checkForUpdates();
    }
  }

  async translatePdf(file) {
    if (!this.requireOcrProviderKey() || !this.requireDeepSeekKey()) {
      return;
    }
    if (!this.startFileTask(file)) {
      return;
    }

    const progress = this.createProgress(file.name, 8, "PDF 一键处理");
    const debugSession = this.createDebugSession("pdf", file);
    try {
      progress.setPhase(1, "检查 API 连接");
      const connected = await this.ensurePdfApiConnections(progress, debugSession);
      if (!connected) {
        await this.finishDebugSession(debugSession, "abandoned");
        return;
      }

      progress.setPhase(2, "读取 PDF");
      const pdfBytes = await this.app.vault.readBinary(file);
      const pdfHash = await shortContentHash(pdfBytes);
      const pdfDocument = this.createPdfDocumentService();
      const pageCount = await pdfDocument.load(pdfBytes);
      await this.updateDebugSession(debugSession, "pdf-loaded", {
        pageCount,
        pdfHash,
      });

      let ranges = [{ start: 1, end: pageCount }];
      let mergeOutput = true;
      if (pageCount > PDF_SPLIT_THRESHOLD) {
        progress.setPhase(3, "等待选择翻译页码");
        const rangeSelection = await this.choosePdfRanges(file, pageCount, {
          pdfDocument,
          pdfBytes,
          debugSession,
        });
        if (!rangeSelection) {
          await this.finishDebugSession(debugSession, "cancelled");
          new Notice("已取消 PDF 翻译。", 4000);
          return;
        }
        if (Array.isArray(rangeSelection)) {
          ranges = rangeSelection;
        } else {
          ranges = rangeSelection.ranges;
          mergeOutput = rangeSelection.mergeOutput !== false;
        }
      }

      const blockNames = mergeOutput ? [] : validatePdfBlockNames(ranges);

      const outputPlan = this.getAvailablePdfOutputPlan(file, {
        mergeOutput,
        firstBlockName: blockNames[0] || "分块 1",
      });
      await this.ensureOutputFolder(outputPlan.outputFolder);

      progress.setPhase(2, ranges.length > 1 ? `准备 ${ranges.length} 个 PDF 分段` : "准备 PDF");
      const segments = await pdfDocument.createSegments(ranges);
      const sharedOcrService = this.settings.ocrProvider === "mineru"
        ? this.createOcrService(this.settings)
        : null;
      const states = segments.map((segment, index) =>
        this.createPdfSegmentState(segment, index, file, this.settings, sharedOcrService),
      );
      await this.initializeDebugSegments(debugSession, states, ranges);
      const updateAggregateProgress = (retryLabel = "") => {
        const uploaded = states.filter((state) => state.uploaded).length;
        const ocrDone = states.filter((state) => state.ocrDone).length;
        const translationDone = states.filter((state) => state.translationDone).length;
        progress.update(
          `上传 ${uploaded}/${states.length}｜OCR ${ocrDone}/${states.length}｜翻译 ${translationDone}/${states.length}${
            retryLabel ? `｜${retryLabel}` : ""
          }`,
        );
      };

      progress.setPhase(
        3,
        `上传 0/${states.length}｜OCR 0/${states.length}｜翻译 0/${states.length}`,
      );
      updateAggregateProgress();
      let abandoned = false;
      while (states.some((state) => !state.translationDone)) {
        for (const state of states) {
          state.failure = null;
        }
        const failures = await this.processPdfAttempt({
          states,
          file,
          outputPlan,
          pdfHash,
          updateProgress: updateAggregateProgress,
          debugSession,
        });
        if (failures.length === 0) {
          break;
        }

        updateAggregateProgress("等待选择");
        const action = await this.askPdfFailureAction(states, failures);
        if (action === "retry") {
          await this.updateDebugSession(debugSession, "user-retry", {
            failedSegments: failures.map(({ state }) => state.index + 1),
          });
          updateAggregateProgress("正在重试");
          continue;
        }

        abandoned = true;
        updateAggregateProgress("正在清理");
        const cleanup = await this.cleanupPdfSegmentStates(states, {
          forceRemoteDelete: true,
        });
        await this.updateDebugSession(debugSession, "user-abandon", { cleanup });
        new Notice(
          cleanup.failed === 0
            ? "已放弃 PDF 处理，并清理本次任务的中间结果。"
            : `已放弃 PDF 处理，但有 ${cleanup.failed} 项中间结果清理失败，请查看控制台。`,
          cleanup.failed === 0 ? 6000 : 12000,
        );
        break;
      }
      if (abandoned) {
        await this.finishDebugSession(debugSession, "abandoned");
        return;
      }
      const results = states.map((state) => ({
        ocrMarkdown: state.ocrMarkdown,
        translated: state.translated,
        savedImageCount: state.imageLinks.size,
      }));

      progress.setPhase(4, mergeOutput ? "合并分块结果" : "整理分块结果");
      const ocrSeparator =
        this.settings.ocrProvider !== "mineru" && this.settings.paginate
          ? "\n\n---\n\n"
          : "\n\n";
      const ocrMarkdown = mergeMarkdownParts(
        results.map((result) => result.ocrMarkdown),
        ocrSeparator,
      );
      const translated = mergeOutput
        ? mergeMarkdownParts(results.map((result) => result.translated))
        : null;

      progress.setPhase(5, "保存 OCR Markdown");
      let ocrFile = null;
      if (this.settings.keepOcrMarkdown) {
        ocrFile = await this.app.vault.create(outputPlan.ocrPath, ocrMarkdown);
      } else {
        progress.update("跳过 OCR Markdown");
      }

      progress.setPhase(6, "保存译文");
      const translatedFiles = [];
      if (mergeOutput) {
        translatedFiles.push(
          await this.app.vault.create(outputPlan.translationPath, translated),
        );
      } else {
        await this.ensureOutputFolder(outputPlan.translationFolder);
        for (let index = 0; index < results.length; index += 1) {
          const blockStem = sanitizePathSegment(blockNames[index], `分块 ${index + 1}`);
          const blockFileName = this.settings.numberSplitOutputFiles === false
            ? `${blockStem}.md`
            : `${index + 1} ${blockStem}.md`;
          const blockPath = this.joinPath(
            outputPlan.translationFolder,
            blockFileName,
          );
          translatedFiles.push(
            await this.app.vault.create(blockPath, results[index].translated),
          );
        }
      }
      progress.setPhase(7, "完成输出");
      await this.movePdfIfRequested(file, outputPlan);
      await this.openFileSafely(translatedFiles[0]);
      await this.updateDebugSession(debugSession, "output-saved", {
        ocrPath: ocrFile?.path || null,
        translationPath: mergeOutput ? translatedFiles[0].path : null,
        translationFolder: mergeOutput ? null : outputPlan.translationFolder,
        translationPaths: translatedFiles.map((translatedFile) => translatedFile.path),
      });

      const selectedPages = countSelectedPages(ranges);
      const savedImageCount = results.reduce(
        (total, result) => total + result.savedImageCount,
        0,
      );
      const details = [
        `${selectedPages}/${pageCount} 页`,
        `${ranges.length} 个部分`,
        `${savedImageCount} 张图片`,
        ocrFile ? `OCR：${ocrFile.path}` : "未保留 OCR 文件",
      ].join("；");
      const translationDestination = mergeOutput
        ? translatedFiles[0].path
        : outputPlan.translationFolder;
      progress.complete(`PDF 翻译完成：${translationDestination}（${details}）`);
      await this.finishDebugSession(debugSession, "completed");
    } catch (error) {
      console.error("Pdf translate to markdown PDF pipeline:", error);
      await this.finishDebugSession(debugSession, "failed", error);
      progress.fail(this.getErrorMessage(error));
    } finally {
      this.finishFileTask(file, progress);
      void this.checkForUpdates();
    }
  }

  async ocrPdfOnly(file) {
    const ocrSettings = this.getOcrOnlyRuntimeSettings();
    if (!this.requireOcrProviderKey(ocrSettings)) {
      return;
    }
    if (!this.startFileTask(file)) {
      return;
    }

    const progress = this.createProgress(file.name, 6, "仅转为 Markdown");
    const debugSession = this.createDebugSession("pdf-ocr-only", file, ocrSettings);
    try {
      progress.setPhase(1, "检查 OCR API 连接");
      const connected = await this.ensureOcrOnlyApiConnection(
        progress,
        debugSession,
        ocrSettings,
      );
      if (!connected) {
        await this.finishDebugSession(debugSession, "abandoned");
        return;
      }

      progress.setPhase(2, "读取并拆分 PDF");
      const pdfBytes = await this.app.vault.readBinary(file);
      const pdfHash = await shortContentHash(pdfBytes);
      const pdfDocument = this.createPdfDocumentService();
      const pageCount = await pdfDocument.load(pdfBytes);
      const ranges = createDefaultPdfRanges(pageCount, 100);
      await this.updateDebugSession(debugSession, "pdf-loaded", {
        pageCount,
        pdfHash,
        automaticChunkSize: 100,
      });

      const outputPlan = this.getAvailableOcrOnlyOutputPlan(file, ocrSettings);
      await this.ensureOutputFolder(outputPlan.outputFolder);
      const segments = await pdfDocument.createSegments(ranges);
      const sharedOcrService = ocrSettings.ocrProvider === "mineru"
        ? this.createOcrService(ocrSettings)
        : null;
      const states = segments.map((segment, index) =>
        this.createPdfSegmentState(segment, index, file, ocrSettings, sharedOcrService),
      );
      await this.initializeDebugSegments(debugSession, states, ranges);

      const updateAggregateProgress = (retryLabel = "") => {
        const uploaded = states.filter((state) => state.uploaded).length;
        const ocrDone = states.filter((state) => state.ocrDone).length;
        progress.update(
          `上传 ${uploaded}/${states.length}｜OCR ${ocrDone}/${states.length}${
            retryLabel ? `｜${retryLabel}` : ""
          }`,
        );
      };
      progress.setPhase(3, `上传 0/${states.length}｜OCR 0/${states.length}`);
      updateAggregateProgress();

      let abandoned = false;
      while (states.some((state) => !state.ocrDone)) {
        for (const state of states) {
          state.failure = null;
        }
        const failures = await this.processPdfAttempt({
          states,
          file,
          outputPlan,
          pdfHash,
          updateProgress: updateAggregateProgress,
          debugSession,
          includeTranslation: false,
        });
        if (failures.length === 0) {
          break;
        }

        updateAggregateProgress("等待选择");
        const action = await this.askOcrOnlyFailureAction(states, failures, ocrSettings);
        if (action === "retry") {
          await this.updateDebugSession(debugSession, "user-retry", {
            failedSegments: failures.map(({ state }) => state.index + 1),
          });
          updateAggregateProgress("正在重试");
          continue;
        }

        abandoned = true;
        updateAggregateProgress("正在清理");
        const cleanup = await this.cleanupPdfSegmentStates(states, {
          forceRemoteDelete: true,
        });
        await this.updateDebugSession(debugSession, "user-abandon", { cleanup });
        new Notice(
          cleanup.failed === 0
            ? "已放弃 OCR，并清理本次任务的中间结果。"
            : `已放弃 OCR，但有 ${cleanup.failed} 项中间结果清理失败，请查看控制台。`,
          cleanup.failed === 0 ? 6000 : 12000,
        );
        break;
      }
      if (abandoned) {
        await this.finishDebugSession(debugSession, "abandoned");
        return;
      }

      progress.setPhase(4, "合并 OCR 结果");
      const separator =
        ocrSettings.ocrProvider !== "mineru" && ocrSettings.paginate
          ? "\n\n---\n\n"
          : "\n\n";
      const markdown = mergeMarkdownParts(
        states.map((state) => state.ocrMarkdown),
        separator,
      );

      progress.setPhase(5, "保存 OCR Markdown");
      const outputFile = await this.app.vault.create(outputPlan.ocrPath, markdown);
      if (outputPlan.useSubfolder && ocrSettings.movePdfToSubfolder) {
        await this.movePdfIfRequested(file, outputPlan, true);
      }
      await this.openFileSafely(outputFile);
      await this.updateDebugSession(debugSession, "output-saved", {
        ocrPath: outputFile.path,
      });

      const savedImageCount = states.reduce(
        (total, state) => total + state.imageLinks.size,
        0,
      );
      progress.setPhase(6, "完成输出");
      progress.complete(
        `OCR 完成：${outputFile.path}（${pageCount} 页；${ranges.length} 个部分；${savedImageCount} 张图片）`,
      );
      await this.finishDebugSession(debugSession, "completed");
    } catch (error) {
      console.error("Pdf translate to markdown OCR-only pipeline:", error);
      await this.finishDebugSession(debugSession, "failed", error);
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

  createMistralService(settings = this.settings) {
    return new MistralOcrService(settings);
  }

  createMinerUService(settings = this.settings) {
    return new MinerUOcrService(settings, requestUrl);
  }

  createOcrService(settings = this.settings) {
    return settings.ocrProvider === "mineru"
      ? this.createMinerUService(settings)
      : this.createMistralService(settings);
  }

  ocrProviderName(settings = this.settings) {
    return settings.ocrProvider === "mineru" ? "MinerU" : "Mistral";
  }

  getOcrOnlyRuntimeSettings() {
    return {
      ...this.settings,
      ocrProvider: this.settings.ocrOnlyProvider === "mineru" ? "mineru" : "mistral",
      mistralModel:
        this.settings.ocrOnlyMistralModel || DEFAULT_SETTINGS.ocrOnlyMistralModel,
      mineruBaseUrl:
        this.settings.ocrOnlyMineruBaseUrl || DEFAULT_SETTINGS.ocrOnlyMineruBaseUrl,
      mineruModelVersion:
        this.settings.ocrOnlyMineruModelVersion ||
        DEFAULT_SETTINGS.ocrOnlyMineruModelVersion,
      mineruLanguage:
        this.settings.ocrOnlyMineruLanguage || DEFAULT_SETTINGS.ocrOnlyMineruLanguage,
      mineruForceOcr: Boolean(this.settings.ocrOnlyMineruForceOcr),
      mineruEnableFormula: this.settings.ocrOnlyMineruEnableFormula !== false,
      mineruEnableTable: this.settings.ocrOnlyMineruEnableTable !== false,
      mineruPollIntervalSeconds:
        Number(this.settings.ocrOnlyMineruPollIntervalSeconds) ||
        DEFAULT_SETTINGS.ocrOnlyMineruPollIntervalSeconds,
      mineruTimeoutMinutes:
        Number(this.settings.ocrOnlyMineruTimeoutMinutes) ||
        DEFAULT_SETTINGS.ocrOnlyMineruTimeoutMinutes,
      pdfOutputMode: this.settings.ocrOnlyOutputMode,
      movePdfToSubfolder: Boolean(this.settings.ocrOnlyMovePdfToSubfolder),
      keepOcrMarkdown: true,
      extractImages: Boolean(this.settings.ocrOnlyExtractImages),
      imageLimit: Math.max(0, Number(this.settings.ocrOnlyImageLimit) || 0),
      imageMinSize: Math.max(0, Number(this.settings.ocrOnlyImageMinSize) || 0),
      paginate: Boolean(this.settings.ocrOnlyPaginate),
      mistralKeepHeadersFooters:
        this.settings.ocrOnlyMistralKeepHeadersFooters !== false,
      deleteMistralFile: Boolean(this.settings.ocrOnlyDeleteMistralFile),
    };
  }

  getMarkdownTranslationRuntimeSettings() {
    return {
      ...this.settings,
      baseUrl: this.settings.markdownBaseUrl || DEFAULT_SETTINGS.markdownBaseUrl,
      model: this.settings.markdownModel || DEFAULT_SETTINGS.markdownModel,
      thinkingEnabled: Boolean(this.settings.markdownThinkingEnabled),
      reasoningEffort:
        this.settings.markdownReasoningEffort || DEFAULT_SETTINGS.markdownReasoningEffort,
      temperature: this.settings.markdownTemperature,
      maxTokens: this.settings.markdownMaxTokens,
      outputSuffix:
        this.settings.markdownOutputSuffix || DEFAULT_SETTINGS.markdownOutputSuffix,
      translationPrompt:
        this.settings.markdownTranslationPrompt ||
        DEFAULT_SETTINGS.markdownTranslationPrompt,
    };
  }

  createPdfDocumentService() {
    return new PdfDocumentService();
  }

  choosePdfRanges(file, pageCount, options = {}) {
    return new PdfRangeModal(this.app, file, pageCount, {
      pdfBytes: options.pdfBytes,
      onAutoDetect: ({ onProgress, isCancelled }) =>
        this.detectPdfChapterRanges({
          file,
          pageCount,
          pdfDocument: options.pdfDocument,
          debugSession: options.debugSession,
          onProgress,
          isCancelled,
        }),
    }).waitForResult();
  }

  async detectPdfChapterRanges({
    file,
    pageCount,
    pdfDocument,
    debugSession,
    onProgress = () => {},
    isCancelled = () => false,
  }) {
    if (!pdfDocument) {
      throw new Error("PDF 文档尚未准备好，无法自动识别目录");
    }

    const roundEnds = [15, 25, 35]
      .map((end) => Math.min(end, pageCount))
      .filter((end, index, values) => index === 0 || end !== values[index - 1]);
    const pages = [];
    let previousEnd = 0;
    let lastReason = "没有找到足够的目录和正文页码信息";

    for (let roundIndex = 0; roundIndex < roundEnds.length; roundIndex += 1) {
      if (isCancelled()) {
        throw new Error("自动划分已取消");
      }
      const end = roundEnds[roundIndex];
      const start = previousEnd + 1;
      onProgress(`正在 OCR 目录分析页 ${start}-${end}`);
      const [segment] = await pdfDocument.createSegments([{ start, end }]);
      const batchPages = await this.ocrChapterOutlineSegment({
        segment,
        file,
        debugSession,
        onProgress,
      });
      if (isCancelled()) {
        throw new Error("自动划分已取消");
      }
      pages.push(...batchPages);
      previousEnd = end;

      const markedMarkdown = buildPageMarkedMarkdown(pages);
      await this.updateDebugSession(debugSession, "chapter-outline-ocr-ready", {
        round: roundIndex + 1,
        analyzedRange: { start: 1, end },
        pageMarkdown: markedMarkdown,
      });
      onProgress(`DeepSeek 正在分析目录（已读取 1-${end} 页）`);

      const analyzed = await this.runStageWithRetries(
        "DeepSeek 目录分析",
        async (attempt) => {
          const response = await this.requestChapterOutline(markedMarkdown, pageCount, end);
          await this.updateDebugSession(debugSession, "chapter-outline-deepseek-response", {
            round: roundIndex + 1,
            attempt,
            response,
          });
          const result = parseChapterOutlineResponse(response.content);
          if (chapterOutlineStatus(result) === "ready") {
            const built = buildChapterOutlineRanges(result, pageCount);
            return {
              result,
              ranges: built.ranges,
              buildWarnings: built.warnings,
            };
          }
          return { result, ranges: null };
        },
        (label) => onProgress(label),
        {
          onAttemptFailure: (attempt, error) =>
            this.updateDebugSession(debugSession, "chapter-outline-analysis-failed", {
              round: roundIndex + 1,
              attempt,
              error: this.serializeError(error),
            }),
        },
      );
      if (isCancelled()) {
        throw new Error("自动划分已取消");
      }

      if (analyzed.ranges) {
        const modelWarnings = Array.isArray(analyzed.result.warnings)
          ? analyzed.result.warnings.map(String)
          : [];
        const warnings = analyzed.buildWarnings || [];
        await this.updateDebugSession(debugSession, "chapter-outline-completed", {
          analyzedThroughPage: end,
          pageMapping: analyzed.result.pageMapping || null,
          chapters: analyzed.result.chapters || [],
          backMatter: analyzed.result.backMatter || null,
          ranges: analyzed.ranges,
          warnings,
          modelWarnings,
        });
        onProgress(
          warnings.length > 0
            ? String(warnings[0])
            : `自动划分完成，共识别 ${analyzed.ranges.length} 个部分`,
        );
        return { ranges: analyzed.ranges, warnings };
      }

      lastReason = String(analyzed.result?.reason || lastReason);
      if (end < roundEnds.at(-1)) {
        onProgress(`信息不足，将继续读取 PDF 第 ${end + 1}-${roundEnds[roundIndex + 1]} 页`);
      }
    }

    const error = new Error(`分析到 PDF 第 ${previousEnd} 页后仍无法自动划分：${lastReason}`);
    await this.updateDebugSession(debugSession, "chapter-outline-failed", {
      analyzedThroughPage: previousEnd,
      error: this.serializeError(error),
    });
    throw error;
  }

  async ocrChapterOutlineSegment({ segment, file, debugSession, onProgress }) {
    const analysisSettings = { ...this.settings, extractImages: false };
    const service = this.createOcrService(analysisSettings);
    const provider = analysisSettings.ocrProvider === "mineru" ? "mineru" : "mistral";
    const providerName = provider === "mineru" ? "MinerU" : "Mistral";
    const segmentName = `${sanitizePathSegment(file.basename, "PDF")}--目录分析--p${String(
      segment.start,
    ).padStart(4, "0")}-${String(segment.end).padStart(4, "0")}.pdf`;
    const remoteFileIds = new Set();
    let uploaded = null;

    try {
      uploaded = await this.runStageWithRetries(
        "目录页上传",
        async (attempt) => {
          onProgress(`正在上传目录分析页 ${segment.start}-${segment.end}`);
          try {
            const result = await service.uploadPdf(segment.arrayBuffer, segmentName);
            remoteFileIds.add(result.fileId);
            await this.updateDebugSession(debugSession, "chapter-outline-uploaded", {
              range: { start: segment.start, end: segment.end },
              attempt,
              provider,
              remoteFileId: result.fileId,
            });
            return result;
          } catch (error) {
            if (error?.uploadedFileId) {
              remoteFileIds.add(error.uploadedFileId);
            }
            throw error;
          }
        },
        (label) => onProgress(label),
      );

      const response = await this.runStageWithRetries(
        "目录页 OCR",
        async (attempt) => {
          onProgress(`${providerName} 正在 OCR 第 ${segment.start}-${segment.end} 页`);
          const url = attempt === 1
            ? uploaded.url
            : await service.getSignedUrl(uploaded.fileId);
          const result = await service.processOcr(url, {
            onProgress: (status) => {
              const count =
                status.extractedPages !== null && status.totalPages !== null
                  ? ` ${status.extractedPages}/${status.totalPages}`
                  : "";
              onProgress(`${providerName} 正在 OCR 第 ${segment.start}-${segment.end} 页${count}`);
            },
          });
          this.validateOcrPageCount(result, segment, provider);
          await this.updateDebugSession(debugSession, "chapter-outline-ocr-response", {
            range: { start: segment.start, end: segment.end },
            attempt,
            response: this.sanitizeOcrResponseForDebug(result),
          });
          return result;
        },
        (label) => onProgress(label),
      );
      return this.chapterOutlinePagesFromResponse(response, segment, providerName);
    } finally {
      if (service.supportsRemoteDelete !== false) {
        for (const fileId of remoteFileIds) {
          try {
            await this.runStageWithRetries(
              "清理目录分析临时文件",
              async () => {
                const deletion = await service.deleteFile(fileId);
                if (!deletion?.deleted) {
                  throw new Error("OCR 服务返回了未删除状态");
                }
              },
              () => {},
            );
          } catch (error) {
            console.warn("Unable to clean up outline analysis file:", error);
            await this.updateDebugSession(debugSession, "chapter-outline-cleanup-failed", {
              remoteFileId: fileId,
              error: this.serializeError(error),
            });
          }
        }
      }
    }
  }

  chapterOutlinePagesFromResponse(response, segment, providerName) {
    const expected = segment.end - segment.start + 1;
    const candidates =
      Array.isArray(response?.analysisPages) && response.analysisPages.length === expected
        ? response.analysisPages
        : Array.isArray(response?.pages) && response.pages.length === expected
          ? response.pages
          : null;
    if (!candidates) {
      throw new Error(`${providerName} OCR 结果没有提供可靠的逐页文本，无法计算 PDF 页码`);
    }

    const seen = new Set();
    const pages = candidates.map((page, position) => {
      const localIndex = Number.isInteger(page?.index) ? page.index : position;
      if (localIndex < 0 || localIndex >= expected || seen.has(localIndex)) {
        throw new Error(`${providerName} OCR 的页面索引无效或重复`);
      }
      seen.add(localIndex);
      return {
        pdfPage: segment.start + localIndex,
        markdown: String(page?.markdown || ""),
      };
    });
    if (seen.size !== expected) {
      throw new Error(`${providerName} OCR 的逐页文本不完整`);
    }
    return pages;
  }

  async requestChapterOutline(markedMarkdown, pageCount, analyzedThroughPage) {
    const endpoint = this.getChatCompletionsEndpoint();
    const configuredMaxTokens = Math.max(1, Math.floor(Number(this.settings.maxTokens) || 8192));
    const requestBody = {
      model: this.settings.model.trim() || DEFAULT_SETTINGS.model,
      messages: [
        {
          role: "system",
          content: this.chapterOutlineSystemPrompt(),
        },
        {
          role: "user",
          content: [
            `PDF 总页数：${pageCount}`,
            `目前已 OCR PDF 第 1-${analyzedThroughPage} 页。`,
            "下面每个 PDF_PAGE 标记都是 PDF 阅读器显示的物理页码：",
            "",
            markedMarkdown,
          ].join("\n"),
        },
      ],
      thinking: {
        type: "disabled",
      },
      max_tokens: configuredMaxTokens,
      stream: false,
      temperature: 0.1,
    };

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
      const apiMessage = response.json?.error?.message || response.text;
      throw new Error(
        `DeepSeek API 返回 ${response.status}${apiMessage ? `：${apiMessage}` : ""}`,
      );
    }
    const choice = response.json?.choices?.[0];
    const content = choice?.message?.content;
    if (typeof content !== "string" || !content.trim()) {
      throw new Error("DeepSeek 没有返回目录分析文本");
    }
    if (choice?.finish_reason !== "stop") {
      throw new Error(`DeepSeek 目录分析输出不完整（finish_reason=${choice?.finish_reason || "missing"}）`);
    }
    return {
      id: response.json?.id || null,
      model: response.json?.model || requestBody.model,
      finishReason: choice.finish_reason,
      usage: response.json?.usage || null,
      content,
    };
  }

  chapterOutlineSystemPrompt() {
    return `你是 PDF 目录结构提取器。你的任务不是翻译或计算完整分块，而是根据带有 PDF 物理页码标记的 OCR 文本，提取书籍目录、正文印刷页码与 PDF 物理页码的固定偏移、每一章的印刷起始页，以及最后一章之后内容的印刷起始页。插件会自行计算所有 PDF 分块的结束页。

规则：
1. PDF_PAGE 是 PDF 阅读器中的物理页码；目录里的数字通常是书中印刷页码，两者不能混淆。
2. 必须找到足够证据证明已经进入采用正式阿拉伯数字页码的正文，并给出 pdfPage、printedPage、offset，满足 pdfPage - printedPage = offset。不能猜测。
3. chapters 只列“章”级条目，忽略 Part、Exercises、1.1、1.2 等节级条目。number 必须是从 1 开始的连续整数；title 只写章名，不要重复写 Chapter 和章号；printedStartPage 必须直接抄录目录中的印刷起始页，不能换算成 PDF 页码。
4. 如果目录明确给出最后一章之后的附录、参考文献、索引等第一个顶级条目的印刷起始页，写入 backMatter；否则 backMatter 必须为 null，并在 warnings 中说明。不要猜测。
5. 不要输出每一章的结束页、PDF 起始页或 ranges；这些数值全部由插件根据 offset 和下一章起始页计算，以避免重复或遗漏。
6. 即使目录列出的后续章节超过当前 PDF 总页数（文件可能是不完整的节选），也必须返回 status=ready 和完整的目录条目，并在 warnings 中说明；插件会自动删除不在当前文件中的后续章节并截止到 PDF 末页。
7. 如果还不能确认正文页码偏移，status 返回 need_more。如果目录本身尚未读完，也返回 need_more。
8. 只输出一个 JSON 对象，不要输出 Markdown 代码围栏、解释或额外文字。

成功格式：
{"status":"ready","reason":"","pageMapping":{"pdfPage":17,"printedPage":1,"offset":16},"chapters":[{"number":1,"title":"Entropy","printedStartPage":5},{"number":2,"title":"Divergence","printedStartPage":39}],"backMatter":{"title":"References and index","printedStartPage":385},"warnings":[]}

信息不足格式：
{"status":"need_more","reason":"说明还缺少什么证据","pageMapping":null,"chapters":[],"backMatter":null,"warnings":[]}`;
  }

  createPdfSegmentState(
    segment,
    index,
    file,
    ocrSettings = this.settings,
    ocrService = null,
  ) {
    const segmentName = segment.isWholeDocument
      ? file.name
      : `${sanitizePathSegment(file.basename, "PDF")}--p${String(segment.start).padStart(
          4,
          "0",
        )}-${String(segment.end).padStart(4, "0")}.pdf`;
    return {
      segment,
      index,
      segmentName,
      ocrProvider: ocrSettings.ocrProvider === "mineru" ? "mineru" : "mistral",
      ocrSettings,
      ocrService: ocrService || this.createOcrService(ocrSettings),
      uploaded: false,
      remoteFileId: null,
      remoteDeleted: false,
      remoteFileIds: new Set(),
      deletedRemoteFileIds: new Set(),
      signedUrl: null,
      ocrResponse: null,
      ocrMarkdown: null,
      ocrDone: false,
      imageLinks: new Map(),
      createdImagePaths: new Set(),
      translated: null,
      translationDone: false,
      failure: null,
    };
  }

  async processPdfAttempt({
    states,
    file,
    outputPlan,
    pdfHash,
    updateProgress,
    debugSession,
    includeTranslation = true,
  }) {
    const pendingUploads = states.filter((state) => !state.uploaded);
    if (pendingUploads.length > 0) {
      await this.prepareMineruBatchUploads(pendingUploads, updateProgress);
    }

    const settled = await Promise.allSettled(states.map(async (state) => {
      try {
        if (!state.uploaded) {
          await this.uploadPdfSegment(state, updateProgress, debugSession);
        }
        if (!state.ocrDone) {
          await this.ocrPdfSegment(
            state,
            file,
            outputPlan,
            pdfHash,
            updateProgress,
            debugSession,
          );
        }
        if (includeTranslation && !state.translationDone) {
          await this.translatePdfSegment(state, updateProgress, debugSession);
        }
        state.failure = null;
      } catch (error) {
        state.failure = error;
        throw error;
      } finally {
        updateProgress();
      }
    }));

    return settled
      .map((result, index) => ({ result, state: states[index] }))
      .filter(({ result }) => result.status === "rejected");
  }

  async settleWithConcurrency(items, limit, operation) {
    const results = new Array(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(items.length, Math.floor(limit) || 1));
    const workers = Array.from({ length: workerCount }, async () => {
      while (nextIndex < items.length) {
        const index = nextIndex;
        nextIndex += 1;
        try {
          results[index] = { status: "fulfilled", value: await operation(items[index], index) };
        } catch (reason) {
          results[index] = { status: "rejected", reason };
        }
      }
    });
    await Promise.all(workers);
    return results;
  }

  runExclusiveOcrMaterialization(operation, priority = 0) {
    if (!this.ocrMaterializePriorityQueue) {
      this.ocrMaterializePriorityQueue = [];
      this.ocrMaterializeSequence = 0;
      this.ocrMaterializeActive = false;
    }
    return new Promise((resolve, reject) => {
      this.ocrMaterializePriorityQueue.push({
        operation,
        priority: Number.isFinite(priority) ? priority : 0,
        sequence: this.ocrMaterializeSequence,
        resolve,
        reject,
      });
      this.ocrMaterializeSequence += 1;
      this.ocrMaterializePriorityQueue.sort(
        (left, right) => right.priority - left.priority || left.sequence - right.sequence,
      );
      this.scheduleOcrMaterializeDrain();
    });
  }

  scheduleOcrMaterializeDrain() {
    if (this.ocrMaterializeDrainScheduled || this.ocrMaterializeActive) {
      return;
    }
    this.ocrMaterializeDrainScheduled = true;
    globalThis.setTimeout(() => {
      this.ocrMaterializeDrainScheduled = false;
      this.drainOcrMaterializeQueue();
    }, 0);
  }

  drainOcrMaterializeQueue() {
    if (this.ocrMaterializeActive || !this.ocrMaterializePriorityQueue?.length) {
      return;
    }
    const entry = this.ocrMaterializePriorityQueue.shift();
    this.ocrMaterializeActive = true;
    Promise.resolve()
      .then(entry.operation)
      .then(entry.resolve, entry.reject)
      .finally(() => {
        this.ocrMaterializeActive = false;
        this.scheduleOcrMaterializeDrain();
      });
  }

  async prepareMineruBatchUploads(states, updateProgress) {
    const mineruStates = states.filter(
      (state) => state.ocrProvider === "mineru" &&
        typeof state.ocrService.prepareBatchUploads === "function",
    );
    if (mineruStates.length < 2) {
      return;
    }
    const service = mineruStates[0].ocrService;
    const sharedStates = mineruStates.filter((state) => state.ocrService === service);
    if (sharedStates.length < 2) {
      return;
    }
    try {
      await this.runStageWithRetries(
        "准备 MinerU 批量上传",
        () => service.prepareBatchUploads(sharedStates.map((state) => state.segmentName)),
        updateProgress,
      );
    } catch (error) {
      console.warn("Unable to prepare MinerU batch upload; falling back to individual batches:", error);
    }
  }

  async uploadPdfSegment(state, updateProgress, debugSession) {
    const uploaded = await this.runStageWithRetries(
      "上传",
      async (attempt) => {
        try {
          const result = await state.ocrService.uploadPdf(
            state.segment.arrayBuffer,
            state.segmentName,
          );
          await this.recordDebugAttempt(debugSession, state, "upload", attempt, {
            status: "success",
            remoteFileId: result.fileId,
          });
          return result;
        } catch (error) {
          if (error?.uploadedFileId) {
            state.remoteFileIds.add(error.uploadedFileId);
            if (state.ocrService.supportsRemoteDelete !== false) {
              const deleted = await this.deleteRemoteFileId(
                state.ocrService,
                error.uploadedFileId,
              );
              if (deleted) {
                state.deletedRemoteFileIds.add(error.uploadedFileId);
              }
            }
          }
          throw error;
        }
      },
      updateProgress,
      {
        onAttemptFailure: (attempt, error) =>
          this.recordDebugAttempt(debugSession, state, "upload", attempt, {
            status: "failed",
            error: this.serializeError(error),
          }),
      },
    );
    state.remoteFileId = uploaded.fileId;
    state.remoteFileIds.add(uploaded.fileId);
    state.signedUrl = uploaded.url;
    state.uploaded = true;
    state.segment.arrayBuffer = null;
    await this.updateDebugSegment(debugSession, state, {
      uploaded: true,
      remoteFileId: uploaded.fileId,
    });
    updateProgress();
  }

  async ocrPdfSegment(
    state,
    file,
    outputPlan,
    pdfHash,
    updateProgress,
    debugSession,
  ) {
    if (!state.ocrResponse) {
      state.ocrResponse = await this.runStageWithRetries(
        "OCR",
        async (attempt) => {
          if (attempt > 1 || !state.signedUrl) {
            state.signedUrl = await state.ocrService.getSignedUrl(
              state.remoteFileId,
              state.signedUrl,
            );
          }
          const response = await state.ocrService.processOcr(state.signedUrl, {
            deferLocalProcessing: true,
            onProgress: (status) => {
              const count =
                status.extractedPages !== null && status.totalPages !== null
                  ? ` ${status.extractedPages}/${status.totalPages}`
                  : "";
              updateProgress(`${this.ocrProviderName(state.ocrSettings)} OCR${count}`);
            },
          });
          const debugResponse = this.sanitizeOcrResponseForDebug(response);
          await this.recordDebugAttempt(debugSession, state, "ocr-api", attempt, {
            status: "received",
            response: debugResponse,
          });
          if (!response?.deferredLocalProcessing) {
            this.validateOcrPageCount(response, state.segment, state.ocrProvider);
          }
          return response;
        },
        updateProgress,
        {
          onAttemptFailure: (attempt, error) =>
            this.recordDebugAttempt(debugSession, state, "ocr-api", attempt, {
              status: "failed",
              error: this.serializeError(error),
            }),
        },
      );
    }

    let finalizedOcrResponse = state.ocrResponse?.deferredLocalProcessing
      ? null
      : state.ocrResponse;
    const localResult = await this.runStageWithRetries(
      "OCR 结果处理",
      (attempt) =>
        this.runExclusiveOcrMaterialization(async () => {
          if (!finalizedOcrResponse) {
            finalizedOcrResponse = typeof state.ocrService.materializeOcrResponse === "function"
              ? await state.ocrService.materializeOcrResponse(state.ocrResponse)
              : state.ocrResponse;
          }
          this.validateOcrPageCount(
            finalizedOcrResponse,
            state.segment,
            state.ocrProvider,
          );
          await this.recordDebugAttempt(debugSession, state, "ocr-result", attempt, {
            status: "processed",
            response: this.sanitizeOcrResponseForDebug(finalizedOcrResponse),
          });
          const materialized = await this.materializeOcrResult(
            finalizedOcrResponse.pages,
            file,
            outputPlan,
            pdfHash,
            { update: () => updateProgress() },
            {
              pageNumberOffset: state.segment.start - 1,
              settings: state.ocrSettings,
              existingImageLinks: state.imageLinks,
              onImageSaved: ({ key, path, embeddedLink, created }) => {
                state.imageLinks.set(key, { path, embeddedLink });
                if (created) {
                  state.createdImagePaths.add(path);
                }
              },
            },
          );
          return { materialized, response: finalizedOcrResponse };
        }, state.segment.end - state.segment.start + 1),
      updateProgress,
      {
        onAttemptFailure: (attempt, error) =>
          this.recordDebugAttempt(debugSession, state, "ocr-materialize", attempt, {
            status: "failed",
            error: this.serializeError(error),
          }),
      },
    );
    state.ocrResponse = localResult.response;
    const materialized = localResult.materialized;
    const normalized = normalizeMistralMath(materialized.markdown);
    state.ocrMarkdown = normalized.markdown;
    state.ocrDone = true;
    await this.updateDebugSegment(debugSession, state, {
      ocrDone: true,
      ocrPageCount: Number.isFinite(state.ocrResponse.pageCount)
        ? state.ocrResponse.pageCount
        : state.ocrResponse.pages.length,
      ocrMarkdown: state.ocrMarkdown,
      ocrMathReplacementCount: normalized.replacementCount,
      imagePaths: [...state.createdImagePaths],
    });
    state.ocrResponse = null;
    state.signedUrl = null;
    updateProgress();
    if (state.ocrSettings.deleteMistralFile && state.ocrService.supportsRemoteDelete !== false) {
      await this.tryDeleteRemoteFile(state);
    }
  }

  async translatePdfSegment(state, updateProgress, debugSession) {
    const translated = await this.runStageWithRetries(
      "翻译",
      (attempt) =>
        this.requestTranslation(state.ocrMarkdown, {
          onResponse: (response) =>
            this.recordDebugAttempt(debugSession, state, "translation", attempt, {
              status: response.finishReason === "stop" ? "success" : "incomplete",
              response,
            }),
        }),
      updateProgress,
      {
        onAttemptFailure: (attempt, error) =>
          this.recordDebugAttempt(debugSession, state, "translation", attempt, {
            status: "failed",
            error: this.serializeError(error),
          }),
      },
    );
    const normalized = normalizeMistralMath(translated);
    state.translated = normalized.markdown;
    state.translationDone = true;
    await this.updateDebugSegment(debugSession, state, {
      translationDone: true,
      translatedMarkdown: state.translated,
      translatedMathReplacementCount: normalized.replacementCount,
    });
    updateProgress();
  }

  validateOcrPageCount(response, segment, provider = "mistral") {
    const expected = segment.end - segment.start + 1;
    const pages = Array.isArray(response?.pages) ? response.pages : [];
    const actual = Number.isFinite(response?.pageCount) ? response.pageCount : pages.length;
    const providerName = provider === "mineru" ? "MinerU" : "Mistral";
    if (actual !== expected) {
      throw new Error(`${providerName} OCR 返回页数不完整：应为 ${expected} 页，实际为 ${actual} 页`);
    }
    const indices = pages.map((page) => page.index);
    if (
      !Number.isFinite(response?.pageCount) &&
      indices.every(Number.isFinite) &&
      indices.some((pageIndex, position) => pageIndex !== position)
    ) {
      throw new Error(`${providerName} OCR 返回的页面索引不连续`);
    }
  }

  async runStageWithRetries(stageName, operation, updateProgress, options = {}) {
    let lastError;
    let attemptsUsed = 0;
    for (let attempt = 1; attempt <= MAX_RATE_LIMIT_ATTEMPTS; attempt += 1) {
      attemptsUsed = attempt;
      try {
        return await operation(attempt);
      } catch (error) {
        lastError = error;
        await options.onAttemptFailure?.(attempt, error);
        const rateLimited = this.isRateLimitError(error);
        const maxAttempts = rateLimited ? MAX_RATE_LIMIT_ATTEMPTS : MAX_STAGE_ATTEMPTS;
        if (attempt >= maxAttempts) {
          break;
        }
        const waitMs = rateLimited
          ? this.getRateLimitRetryDelayMs(error, attempt)
          : this.getTransientRetryDelayMs(error, attempt);
        const waitSeconds = Math.max(1, Math.ceil(waitMs / 1000));
        updateProgress(
          rateLimited
            ? `${stageName}触发 API 速率限制，等待 ${waitSeconds} 秒后重试 ${attempt + 1}/${maxAttempts}`
            : `${stageName}自动重试 ${attempt + 1}/${maxAttempts}`,
        );
        await this.waitBeforeRetry(attempt, waitMs);
      }
    }
    throw new Error(
      `${stageName}连续 ${attemptsUsed} 次失败：${this.getErrorMessage(lastError)}`,
      { cause: lastError },
    );
  }

  waitBeforeRetry(attempt, delayMs = null) {
    const waitMs = Number.isFinite(delayMs) ? delayMs : attempt * 750;
    return new Promise((resolve) => globalThis.setTimeout(resolve, Math.max(0, waitMs)));
  }

  isRateLimitError(error) {
    return this.getErrorStatus(error) === 429 || /rate.?limit|too many requests|速率限制/i.test(
      this.getErrorMessage(error),
    );
  }

  getTransientRetryDelayMs(error, attempt) {
    const status = this.getErrorStatus(error);
    if ([408, 409, 425, 500, 502, 503, 504].includes(status)) {
      return Math.min(30000, 2000 * (2 ** (attempt - 1))) + Math.floor(Math.random() * 500);
    }
    return attempt * 750;
  }

  getRateLimitRetryDelayMs(error, attempt) {
    const retryAfterMs = this.getRetryAfterMs(error);
    if (Number.isFinite(retryAfterMs) && retryAfterMs > 0) {
      return Math.min(10 * 60 * 1000, retryAfterMs) + Math.floor(Math.random() * 1000);
    }
    return Math.min(5 * 60 * 1000, DEFAULT_RATE_LIMIT_WAIT_MS * (2 ** (attempt - 1))) +
      Math.floor(Math.random() * 2000);
  }

  getErrorStatus(error) {
    for (let current = error, depth = 0; current && depth < 6; depth += 1) {
      const status = Number(
        current.status ?? current.statusCode ?? current.response?.status ?? current.rawResponse?.status,
      );
      if (Number.isFinite(status) && status > 0) {
        return status;
      }
      current = current.cause;
    }
    const match = this.getErrorMessage(error).match(/(?:^|\D)(429|5\d\d)(?:\D|$)/);
    return match ? Number(match[1]) : null;
  }

  getRetryAfterMs(error) {
    for (let current = error, depth = 0; current && depth < 6; depth += 1) {
      const headers = current.headers || current.response?.headers || current.rawResponse?.headers;
      const value = typeof headers?.get === "function"
        ? headers.get("retry-after")
        : headers?.["retry-after"] ?? headers?.["Retry-After"];
      if (value !== undefined && value !== null) {
        const seconds = Number(value);
        if (Number.isFinite(seconds)) {
          return Math.max(0, seconds * 1000);
        }
        const dateMs = Date.parse(String(value));
        if (Number.isFinite(dateMs)) {
          return Math.max(0, dateMs - Date.now());
        }
      }
      current = current.cause;
    }
    return null;
  }

  async ensurePdfApiConnections(progress, debugSession) {
    while (true) {
      const providerName = this.ocrProviderName();
      progress.update(`检查 DeepSeek 和 ${providerName} API 连接`);
      const ocrService = this.createOcrService();
      const checks = await Promise.allSettled([
        this.runStageWithRetries(
          "DeepSeek 连接检查",
          () => this.checkDeepSeekConnection(),
          (label) => progress.update(`检查 API 连接｜${label}`),
        ),
        this.runStageWithRetries(
          `${providerName} 连接检查`,
          () => ocrService.checkConnection(),
          (label) => progress.update(`检查 API 连接｜${label}`),
        ),
      ]);
      const services = ["DeepSeek", providerName];
      const results = checks.map((result, index) => ({
        service: services[index],
        status: result.status,
        error:
          result.status === "rejected" ? this.serializeError(result.reason) : null,
      }));
      await this.updateDebugSession(debugSession, "api-preflight", { results });
      const failures = results.filter((result) => result.status === "rejected");
      if (failures.length === 0) {
        progress.update("API 连接正常");
        return true;
      }

      const action = await this.askApiConnectionFailureAction(failures);
      if (action !== "retry") {
        new Notice("已取消 PDF 处理，尚未上传任何文件。", 6000);
        return false;
      }
      await this.updateDebugSession(debugSession, "api-preflight-user-retry");
    }
  }

  async ensureOcrOnlyApiConnection(progress, debugSession, ocrSettings) {
    while (true) {
      const providerName = this.ocrProviderName(ocrSettings);
      progress.update(`检查 ${providerName} API 连接`);
      const ocrService = this.createOcrService(ocrSettings);
      try {
        await this.runStageWithRetries(
          `${providerName} 连接检查`,
          () => ocrService.checkConnection(),
          (label) => progress.update(`检查 API 连接｜${label}`),
        );
        await this.updateDebugSession(debugSession, "api-preflight", {
          results: [{ service: providerName, status: "fulfilled", error: null }],
        });
        progress.update("OCR API 连接正常");
        return true;
      } catch (error) {
        const failure = {
          service: providerName,
          status: "rejected",
          error: this.serializeError(error),
        };
        await this.updateDebugSession(debugSession, "api-preflight", {
          results: [failure],
        });
        const action = await new TaskFailureModal(
          this.app,
          `任务尚未开始，${providerName} API 连接检查失败。`,
          [`${providerName}：${failure.error?.message || "未知错误"}`],
          {
            retryDescription: `重试会再次检查 ${providerName} 的网络和密钥。`,
            abandonDescription:
              "放弃会取消任务；此时尚未上传 PDF，也没有创建 OCR 图片。关闭此窗口也视为放弃。",
          },
        ).waitForResult();
        if (action !== "retry") {
          new Notice("已取消 OCR，尚未上传任何文件。", 6000);
          return false;
        }
        await this.updateDebugSession(debugSession, "api-preflight-user-retry");
      }
    }
  }

  askApiConnectionFailureAction(failures) {
    return new TaskFailureModal(
      this.app,
      `任务尚未开始，${failures.map((failure) => failure.service).join("、")} API 连接检查失败。`,
      failures.map(
        (failure) => `${failure.service}：${failure.error?.message || "未知错误"}`,
      ),
      {
        retryDescription: "重试会再次检查两个 API 的网络、密钥和模型可用性。",
        abandonDescription:
          "放弃会取消任务；此时尚未上传 PDF，也没有创建 OCR 图片。关闭此窗口也视为放弃。",
      },
    ).waitForResult();
  }

  askPdfFailureAction(states, failures) {
    const uploaded = states.filter((state) => state.uploaded).length;
    const ocrDone = states.filter((state) => state.ocrDone).length;
    const translationDone = states.filter((state) => state.translationDone).length;
    const summary = `上传 ${uploaded}/${states.length}｜OCR ${ocrDone}/${states.length}｜翻译 ${translationDone}/${states.length}。自动重试后仍有 ${failures.length} 个分块未完成。`;
    const details = failures.map(({ result, state }) =>
      `第 ${state.index + 1} 部分（${state.segment.start}-${state.segment.end} 页）：${this.getErrorMessage(result.reason)}`,
    );
    const isMinerU = this.settings.ocrProvider === "mineru";
    return new TaskFailureModal(this.app, summary, details, {
      abandonDescription: isMinerU
        ? "放弃会删除本次任务创建的本地图片。MinerU 未提供任务删除接口，已经提交的远程解析任务无法由插件主动删除；关闭此窗口也视为放弃。"
        : "放弃会删除本次任务创建的图片，并清理尚存的 Mistral 临时文件。关闭此窗口也视为放弃。",
    }).waitForResult();
  }

  askOcrOnlyFailureAction(states, failures, ocrSettings) {
    const uploaded = states.filter((state) => state.uploaded).length;
    const ocrDone = states.filter((state) => state.ocrDone).length;
    const summary = `上传 ${uploaded}/${states.length}｜OCR ${ocrDone}/${states.length}。自动重试后仍有 ${failures.length} 个分块未完成。`;
    const details = failures.map(({ result, state }) =>
      `第 ${state.index + 1} 部分（${state.segment.start}-${state.segment.end} 页）：${this.getErrorMessage(result.reason)}`,
    );
    const isMinerU = ocrSettings.ocrProvider === "mineru";
    return new TaskFailureModal(this.app, summary, details, {
      retryDescription:
        "重试会保留已经完成的上传、OCR 文本和图片，只继续未成功的步骤。",
      abandonDescription: isMinerU
        ? "放弃会删除本次任务创建的本地图片。MinerU 未提供任务删除接口，已经提交的远程解析任务无法由插件主动删除；关闭此窗口也视为放弃。"
        : "放弃会删除本次任务创建的图片，并清理尚存的 Mistral 临时文件。关闭此窗口也视为放弃。",
    }).waitForResult();
  }

  async tryDeleteRemoteFile(state) {
    if (!state.remoteFileId || state.remoteDeleted) {
      return;
    }
    try {
      await this.runStageWithRetries(
        "清理 Mistral 临时文件",
        async () => {
          const deletion = await state.ocrService.deleteFile(state.remoteFileId);
          if (!deletion?.deleted) {
            throw new Error("Mistral 返回了未删除状态");
          }
          return deletion;
        },
        () => {},
      );
      state.remoteDeleted = true;
      state.deletedRemoteFileIds.add(state.remoteFileId);
    } catch (error) {
      console.warn("Unable to delete Mistral temporary file:", error);
      new Notice(`无法删除 Mistral 远程临时文件：${this.getErrorMessage(error)}`, 10000);
    }
  }

  async deleteRemoteFileId(mistral, fileId) {
    try {
      const deletion = await mistral.deleteFile(fileId);
      return Boolean(deletion?.deleted);
    } catch (error) {
      console.warn("Unable to clean up a partially uploaded Mistral file:", error);
      return false;
    }
  }

  async cleanupPdfSegmentStates(states, options = {}) {
    const forceRemoteDelete = Boolean(options.forceRemoteDelete);
    const imagePaths = new Set(
      states.flatMap((state) => [...state.createdImagePaths]),
    );
    const cleanupResults = await Promise.allSettled(
      [...imagePaths].map(async (path) => {
        const file = this.app.vault.getAbstractFileByPath(path);
        if (file) {
          await this.runStageWithRetries(
            "清理 OCR 图片",
            () => this.app.vault.delete(file, true),
            () => {},
          );
        } else if (typeof this.app.vault.adapter.remove === "function") {
          const exists = typeof this.app.vault.adapter.exists !== "function" ||
            await this.app.vault.adapter.exists(path);
          if (exists) {
            await this.runStageWithRetries(
              "清理 OCR 图片",
              () => this.app.vault.adapter.remove(path),
              () => {},
            );
          }
        }
      }),
    );
    for (const result of cleanupResults) {
      if (result.status === "rejected") {
        console.warn("Unable to delete an OCR image during cleanup:", result.reason);
      }
    }

    if (forceRemoteDelete) {
      const remoteResults = await Promise.allSettled(
        states.flatMap((state) =>
          state.ocrService.supportsRemoteDelete === false
            ? []
            : [...state.remoteFileIds]
            .filter((fileId) => !state.deletedRemoteFileIds.has(fileId))
            .map(async (fileId) => {
              await this.runStageWithRetries(
                "清理 Mistral 临时文件",
                async () => {
                  const deletion = await state.ocrService.deleteFile(fileId);
                  if (!deletion?.deleted) {
                    throw new Error("Mistral 返回了未删除状态");
                  }
                },
                () => {},
              );
              state.deletedRemoteFileIds.add(fileId);
              if (fileId === state.remoteFileId) {
                state.remoteDeleted = true;
              }
            }),
        ),
      );
      cleanupResults.push(...remoteResults);
    }
    return {
      failed: cleanupResults.filter((result) => result.status === "rejected").length,
    };
  }

  createDebugSession(taskType, file, taskSettings = this.settings) {
    if (!this.settings.debugMode || !this.app.vault.adapter?.write) {
      return null;
    }
    const pluginDir = this.manifest.dir || `.obsidian/plugins/${this.manifest.id}`;
    const session = {
      path: normalizePath(`${pluginDir}/debug-last-task.json`),
      schemaVersion: 1,
      taskType,
      taskId: `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      status: "running",
      startedAt: new Date().toISOString(),
      endedAt: null,
      file: { path: file.path, name: file.name },
      settings: {
        deepSeekBaseUrl: taskSettings.baseUrl,
        deepSeekModel: taskSettings.model,
        thinkingEnabled: taskSettings.thinkingEnabled,
        reasoningEffort: taskSettings.reasoningEffort,
        maxTokens: taskSettings.maxTokens,
        ocrProvider: taskSettings.ocrProvider,
        mistralModel: taskSettings.mistralModel,
        mineruBaseUrl: taskSettings.mineruBaseUrl,
        mineruModelVersion: taskSettings.mineruModelVersion,
        mineruLanguage: taskSettings.mineruLanguage,
        mineruForceOcr: taskSettings.mineruForceOcr,
        mineruEnableFormula: taskSettings.mineruEnableFormula,
        mineruEnableTable: taskSettings.mineruEnableTable,
        extractImages: taskSettings.extractImages,
        paginate: taskSettings.paginate,
        translationPrompt: taskSettings.translationPrompt,
      },
      metadata: {},
      segments: [],
      events: [],
      writeQueue: Promise.resolve(),
      writeDirty: false,
      writeScheduled: false,
      writeTimer: null,
    };
    void this.updateDebugSession(session, "task-started");
    return session;
  }

  async initializeDebugSegments(session, states, ranges) {
    if (!session) {
      return;
    }
    session.metadata.ranges = ranges;
    session.segments = states.map((state) => ({
      index: state.index + 1,
      range: { start: state.segment.start, end: state.segment.end },
      segmentName: state.segmentName,
      uploaded: false,
      ocrDone: false,
      translationDone: false,
      attempts: [],
    }));
    await this.updateDebugSession(session, "segments-created", {
      count: states.length,
      ranges,
    });
  }

  async updateDebugSegment(session, state, patch) {
    if (!session) {
      return;
    }
    const segment = session.segments[state.index];
    if (!segment) {
      return;
    }
    Object.assign(segment, patch);
    await this.queueDebugWrite(session);
  }

  async recordDebugAttempt(session, state, stage, attempt, details) {
    if (!session) {
      return;
    }
    const segment = session.segments[state.index];
    if (!segment) {
      return;
    }
    segment.attempts.push({
      timestamp: new Date().toISOString(),
      stage,
      attempt,
      ...details,
    });
    await this.queueDebugWrite(session);
  }

  async updateDebugSession(session, eventType, data = null) {
    if (!session) {
      return;
    }
    if (data && eventType === "pdf-loaded") {
      Object.assign(session.metadata, data);
    }
    session.events.push({
      timestamp: new Date().toISOString(),
      type: eventType,
      data,
    });
    await this.queueDebugWrite(session);
  }

  async finishDebugSession(session, status, error = null) {
    if (!session) {
      return;
    }
    session.status = status;
    session.endedAt = new Date().toISOString();
    session.events.push({
      timestamp: session.endedAt,
      type: "task-finished",
      data: error ? { error: this.serializeError(error) } : { status },
    });
    await this.queueDebugWrite(session, { flush: true });
    await session.writeQueue;
  }

  queueDebugWrite(session, options = {}) {
    if (!session) {
      return Promise.resolve();
    }
    session.writeDirty = true;
    if (options.flush) {
      return this.flushDebugWrite(session);
    }
    if (!session.writeScheduled) {
      session.writeScheduled = true;
      session.writeTimer = globalThis.setTimeout(() => {
        session.writeScheduled = false;
        session.writeTimer = null;
        void this.flushDebugWrite(session);
      }, DEBUG_WRITE_DEBOUNCE_MS);
    }
    return Promise.resolve();
  }

  flushDebugWrite(session) {
    if (!session) {
      return Promise.resolve();
    }
    if (session.writeTimer !== null) {
      globalThis.clearTimeout(session.writeTimer);
      session.writeTimer = null;
      session.writeScheduled = false;
    }
    if (!session.writeDirty) {
      return session.writeQueue;
    }
    session.writeDirty = false;
    const snapshot = JSON.stringify(
      {
        schemaVersion: session.schemaVersion,
        taskType: session.taskType,
        taskId: session.taskId,
        status: session.status,
        startedAt: session.startedAt,
        endedAt: session.endedAt,
        file: session.file,
        settings: session.settings,
        metadata: session.metadata,
        segments: session.segments,
        events: session.events,
      },
      null,
      2,
    );
    session.writeQueue = session.writeQueue
      .catch(() => {})
      .then(() => this.app.vault.adapter.write(session.path, snapshot))
      .catch((error) => {
        console.warn("Unable to write debug snapshot:", error);
      })
      .finally(() => {
        if (session.writeDirty && !session.writeScheduled) {
          session.writeScheduled = true;
          session.writeTimer = globalThis.setTimeout(() => {
            session.writeScheduled = false;
            session.writeTimer = null;
            void this.flushDebugWrite(session);
          }, DEBUG_WRITE_DEBOUNCE_MS);
        }
      });
    return session.writeQueue;
  }

  sanitizeOcrResponseForDebug(response) {
    return {
      provider: response?.provider || null,
      pageCount: Number.isFinite(response?.pageCount)
        ? response.pageCount
        : Array.isArray(response?.pages)
          ? response.pages.length
          : 0,
      pages: Array.isArray(response?.pages)
        ? response.pages.map((page) => ({
            index: page.index,
            markdownChars: String(page.markdown || "").length,
            imageCount: Array.isArray(page.images) ? page.images.length : 0,
          }))
        : [],
      analysisPages: Array.isArray(response?.analysisPages)
        ? response.analysisPages.map((page) => ({
            index: page.index,
            markdownChars: String(page.markdown || "").length,
          }))
        : [],
    };
  }

  serializeError(error, depth = 0) {
    const serialized = {
      name: error instanceof Error ? error.name : "Error",
      message: this.sanitizeDebugText(this.getErrorMessage(error)),
    };
    if (error instanceof Error && error.stack) {
      serialized.stack = this.sanitizeDebugText(error.stack);
    }
    if (depth < 2 && error?.cause) {
      serialized.cause = this.serializeError(error.cause, depth + 1);
    }
    return serialized;
  }

  sanitizeDebugText(value) {
    let text = String(value || "");
    for (const secret of [
      this.settings.apiKey,
      this.settings.mistralApiKey,
      this.settings.mineruApiKey,
    ]) {
      if (secret) {
        text = text.split(secret).join("[REDACTED_API_KEY]");
      }
    }
    return text
      .replace(/(authorization\s*:\s*bearer\s+)[^\s,;]+/gi, "$1[REDACTED]")
      .replace(/(https?:\/\/[^\s?'\"<>]+)\?[^\s'\"<>]+/gi, "$1?[REDACTED]");
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

  requireMinerUKey() {
    if (this.settings.mineruApiKey.trim()) {
      return true;
    }
    new Notice("请先在插件设置中填写 MinerU API Token。");
    return false;
  }

  requireOcrProviderKey(settings = this.settings) {
    return settings.ocrProvider === "mineru"
      ? this.requireMinerUKey()
      : this.requireMistralKey();
  }

  prepareMarkdownForTranslation(markdown) {
    return normalizeMistralMath(markdown);
  }

  async requestTranslation(markdown, options = {}) {
    const settings = options.settings || this.settings;
    const endpoint = this.getChatCompletionsEndpoint(settings);
    const temperature = this.clampNumber(settings.temperature, 0, 2, 0.2);
    const maxTokens = Math.max(1, Math.floor(Number(settings.maxTokens) || 8192));
    const requestBody = {
      model: settings.model.trim() || DEFAULT_SETTINGS.model,
      messages: [
        {
          role: "system",
          content: settings.translationPrompt.trim() || DEFAULT_SETTINGS.translationPrompt,
        },
        { role: "user", content: markdown },
      ],
      thinking: {
        type: settings.thinkingEnabled ? "enabled" : "disabled",
      },
      max_tokens: maxTokens,
      stream: false,
    };

    if (settings.thinkingEnabled) {
      requestBody.reasoning_effort = settings.reasoningEffort === "max" ? "max" : "high";
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

    const choice = response.json?.choices?.[0];
    const content = choice?.message?.content;
    const responseMetadata = {
      id: response.json?.id || null,
      model: response.json?.model || requestBody.model,
      finishReason: choice?.finish_reason ?? null,
      usage: response.json?.usage || null,
      content: typeof content === "string" ? content : null,
    };
    await options.onResponse?.(responseMetadata);
    if (typeof content !== "string" || content.trim().length === 0) {
      throw new Error("DeepSeek API 没有返回可用的翻译文本");
    }
    if (choice?.finish_reason !== "stop") {
      const reason = choice?.finish_reason || "missing";
      throw new Error(`DeepSeek 输出不完整（finish_reason=${reason}）`);
    }
    return content;
  }

  async checkDeepSeekConnection(settings = this.settings) {
    const response = await requestUrl({
      url: `${this.getDeepSeekApiRoot(settings)}/models`,
      method: "GET",
      headers: {
        Authorization: `Bearer ${this.settings.apiKey.trim()}`,
      },
      throw: false,
    });
    if (response.status < 200 || response.status >= 300) {
      const apiMessage = response.json?.error?.message || response.text;
      throw new Error(
        `DeepSeek API 连接失败（${response.status}）${apiMessage ? `：${apiMessage}` : ""}`,
      );
    }
    const models = response.json?.data;
    if (!Array.isArray(models)) {
      throw new Error("DeepSeek 模型列表响应无效");
    }
    const configuredModel = settings.model.trim() || DEFAULT_SETTINGS.model;
    if (models.length > 0 && !models.some((model) => model?.id === configuredModel)) {
      throw new Error(`DeepSeek 当前账户不可用模型：${configuredModel}`);
    }
    return true;
  }

  getDeepSeekApiRoot(settings = this.settings) {
    const baseUrl = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl)
      .trim()
      .replace(/\/+$/, "");
    return baseUrl.replace(/\/chat\/completions$/, "");
  }

  getChatCompletionsEndpoint(settings = this.settings) {
    const baseUrl = (settings.baseUrl || DEFAULT_SETTINGS.baseUrl).trim().replace(/\/+$/, "");
    return baseUrl.endsWith("/chat/completions") ? baseUrl : `${baseUrl}/chat/completions`;
  }

  getAvailableMarkdownTranslationPath(sourceFile, settings = this.settings) {
    const folderPath = this.parentPath(sourceFile.path);
    const suffix = this.sanitizeSuffix(settings.outputSuffix);
    const baseName = `${sourceFile.basename}${suffix}`;

    for (let index = 0; ; index += 1) {
      const numberedName = index === 0 ? baseName : `${baseName} ${index + 1}`;
      const candidate = this.joinPath(folderPath, `${numberedName}.md`);
      if (!this.app.vault.getAbstractFileByPath(candidate)) {
        return candidate;
      }
    }
  }

  getAvailablePdfOutputPlan(pdfFile, options = {}) {
    const parent = this.parentPath(pdfFile.path);
    const originalStem = sanitizePathSegment(pdfFile.basename, "PDF");
    const translationSuffix = this.sanitizeSuffix(this.settings.outputSuffix);
    const useSubfolder = this.settings.pdfOutputMode === "subfolder";
    const mergeOutput = options.mergeOutput !== false;

    for (let index = 0; ; index += 1) {
      const stem = index === 0 ? originalStem : `${originalStem} ${index + 1}`;
      const outputFolder = useSubfolder ? this.joinPath(parent, stem) : parent;
      const ocrPath = this.joinPath(outputFolder, `${stem}.md`);
      const translationStem = `${stem}${translationSuffix}`;
      const translationFolder = this.joinPath(outputFolder, translationStem);
      const translationPath = mergeOutput
        ? `${translationFolder}.md`
        : translationFolder;
      const translationSiblingPath = mergeOutput
        ? translationFolder
        : `${translationFolder}.md`;
      const firstBlockStem = sanitizePathSegment(options.firstBlockName, "分块 1");
      const firstBlockFileName = this.settings.numberSplitOutputFiles === false
        ? `${firstBlockStem}.md`
        : `1 ${firstBlockStem}.md`;
      const attachmentReferencePath = mergeOutput
        ? translationPath
        : this.joinPath(translationFolder, firstBlockFileName);

      if (useSubfolder) {
        if (!this.app.vault.getAbstractFileByPath(outputFolder)) {
          return {
            outputFolder,
            stem,
            ocrPath,
            translationPath,
            translationFolder: mergeOutput ? null : translationFolder,
            attachmentReferencePath,
            mergeOutput,
            useSubfolder,
          };
        }
        continue;
      }

      if (
        !this.app.vault.getAbstractFileByPath(ocrPath) &&
        !this.app.vault.getAbstractFileByPath(translationPath) &&
        !this.app.vault.getAbstractFileByPath(translationSiblingPath)
      ) {
        return {
          outputFolder,
          stem,
          ocrPath,
          translationPath,
          translationFolder: mergeOutput ? null : translationFolder,
          attachmentReferencePath,
          mergeOutput,
          useSubfolder,
        };
      }
    }
  }

  getAvailableOcrOnlyOutputPlan(pdfFile, ocrSettings) {
    const parent = this.parentPath(pdfFile.path);
    const originalStem = sanitizePathSegment(pdfFile.basename, "PDF");
    const suffix = sanitizePathSegment(
      this.settings.ocrOnlyOutputSuffix || DEFAULT_SETTINGS.ocrOnlyOutputSuffix,
      DEFAULT_SETTINGS.ocrOnlyOutputSuffix,
    );
    const useSubfolder = ocrSettings.pdfOutputMode === "subfolder";

    for (let index = 0; ; index += 1) {
      const stem = index === 0 ? originalStem : `${originalStem} ${index + 1}`;
      const outputFolder = useSubfolder ? this.joinPath(parent, stem) : parent;
      const ocrPath = this.joinPath(outputFolder, `${stem}${suffix}.md`);
      if (useSubfolder) {
        if (!this.app.vault.getAbstractFileByPath(outputFolder)) {
          return {
            outputFolder,
            stem,
            ocrPath,
            translationPath: ocrPath,
            useSubfolder,
          };
        }
        continue;
      }
      if (!this.app.vault.getAbstractFileByPath(ocrPath)) {
        return {
          outputFolder,
          stem,
          ocrPath,
          translationPath: ocrPath,
          useSubfolder,
        };
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

  async materializeOcrResult(pages, pdfFile, outputPlan, pdfHash, progress, options = {}) {
    const settings = options.settings || this.settings;
    const referenceSourcePath = settings.keepOcrMarkdown
      ? outputPlan.ocrPath
      : outputPlan.attachmentReferencePath || outputPlan.translationPath;
    const pageImageCandidates = settings.extractImages
      ? pages.map((page) => this.referencedOcrImages(page))
      : pages.map(() => []);
    const imageCount = pageImageCandidates.reduce(
      (total, candidates) => total + candidates.length,
      0,
    );
    const pageMarkdowns = [];
    let savedImageCount = 0;
    const pageNumberOffset = Math.max(0, Math.floor(Number(options.pageNumberOffset) || 0));
    const existingImageLinks =
      options.existingImageLinks instanceof Map ? options.existingImageLinks : new Map();

    for (let pageOffset = 0; pageOffset < pages.length; pageOffset += 1) {
      const page = pages[pageOffset];
      const pageNumber =
        pageNumberOffset + (Number.isFinite(page.index) ? page.index + 1 : pageOffset + 1);
      let markdown = page.markdown || "";

      if (settings.extractImages) {
        const imageCandidates = pageImageCandidates[pageOffset];
        const imageReplacements = new Map();
        for (const { image, imageOffset, originalId } of imageCandidates) {
          const imagePageNumber = Number.isFinite(image.pageIndex)
            ? pageNumberOffset + image.pageIndex + 1
            : pageNumber;
          const imageKey = `${imagePageNumber}:${imageOffset}:${originalId}`;
          const existing = existingImageLinks.get(imageKey);
          if (existing && this.app.vault.getAbstractFileByPath(existing.path)) {
            imageReplacements.set(originalId, existing.embeddedLink);
            savedImageCount += 1;
            image.imageBytes = null;
            image.imageBase64 = null;
            await this.reportOcrImageProgress(progress, savedImageCount, imageCount);
            continue;
          }
          if (existing) {
            existingImageLinks.delete(imageKey);
          }

          const fileName = this.uniqueImageName(
            pdfFile.basename,
            pdfHash,
            imagePageNumber,
            imageOffset,
            originalId,
            image.imageBase64 || (image.mimeType ? `data:${image.mimeType};base64,` : ""),
          );
          const imagePath = await this.app.fileManager.getAvailablePathForAttachment(
            fileName,
            referenceSourcePath,
          );
          const deterministicPath = this.joinPath(this.parentPath(imagePath), fileName);
          let imageFile = this.app.vault.getAbstractFileByPath(deterministicPath);
          let storedImagePath = deterministicPath;
          let created = false;
          const deterministicExists = imageFile instanceof TFile ||
            (typeof this.app.vault.adapter.exists === "function" &&
              await this.app.vault.adapter.exists(deterministicPath));
          let deterministicSize = imageFile instanceof TFile
            ? imageFile.stat?.size
            : undefined;
          if (
            deterministicExists &&
            !Number.isFinite(deterministicSize) &&
            typeof this.app.vault.adapter.stat === "function"
          ) {
            deterministicSize = (await this.app.vault.adapter.stat(deterministicPath))?.size;
          }
          const deterministicUsable = deterministicExists &&
            (!Number.isFinite(deterministicSize) || deterministicSize > 0);
          if (!deterministicUsable) {
            storedImagePath = deterministicExists ? deterministicPath : imagePath;
            const imageBinary = image.imageBytes
              ? this.toExactArrayBuffer(image.imageBytes)
              : base64ToArrayBuffer(stripDataUrlPrefix(image.imageBase64));
            if (typeof this.app.vault.adapter.writeBinary === "function") {
              await this.app.vault.adapter.writeBinary(storedImagePath, imageBinary);
              imageFile = this.app.vault.getAbstractFileByPath(storedImagePath);
            } else {
              imageFile = await this.app.vault.createBinary(storedImagePath, imageBinary);
            }
            created = true;
          }
          image.imageBytes = null;
          image.imageBase64 = null;
          let embeddedLink = imageFile instanceof TFile
            ? this.app.fileManager.generateMarkdownLink(
                imageFile,
                referenceSourcePath,
                undefined,
                originalId,
              )
            : this.fallbackOcrImageLink(storedImagePath, originalId);
          if (!embeddedLink.startsWith("!")) {
            embeddedLink = `!${embeddedLink}`;
          }
          options.onImageSaved?.({
            key: imageKey,
            path: storedImagePath,
            embeddedLink,
            created,
          });
          imageReplacements.set(originalId, embeddedLink);

          savedImageCount += 1;
          await this.reportOcrImageProgress(progress, savedImageCount, imageCount);
        }
        markdown = replaceMistralImagePlaceholders(markdown, imageReplacements);
      }

      pageMarkdowns.push(markdown.trimEnd());
    }

    if (imageCount === 0) {
      progress.update("没有需要保存的 OCR 图片");
    }

    const separator = settings.paginate ? "\n\n---\n\n" : "\n\n";
    return {
      markdown: pageMarkdowns.join(separator).trim() + "\n",
      savedImageCount,
    };
  }

  fallbackOcrImageLink(path, alias) {
    const safePath = String(path || "").replace(/\\/g, "/").replace(/\|/g, "%7C");
    const safeAlias = String(alias || "图片").replace(/\|/g, "¦");
    return `![[${safePath}|${safeAlias}]]`;
  }

  referencedOcrImages(page) {
    const referencedIds = markdownImageBasenames(page?.markdown || "");
    const candidates = [];
    const seen = new Set();
    const images = Array.isArray(page?.images) ? page.images : [];
    for (let imageOffset = 0; imageOffset < images.length; imageOffset += 1) {
      const image = images[imageOffset];
      if (!image?.imageBase64 && !image?.imageBytes) {
        continue;
      }
      const rawId = String(image.id || `img-${imageOffset}.png`);
      const originalId = rawId.replace(/\\/g, "/").split("/").pop();
      if (!referencedIds.has(originalId) || seen.has(originalId)) {
        image.imageBytes = null;
        image.imageBase64 = null;
        continue;
      }
      seen.add(originalId);
      candidates.push({ image, imageOffset, originalId });
    }
    return candidates;
  }

  async reportOcrImageProgress(progress, savedImageCount, imageCount) {
    if (savedImageCount % 8 !== 0 && savedImageCount !== imageCount) {
      return;
    }
    progress.update(`保存 OCR 图片 ${savedImageCount}/${imageCount}`);
    await new Promise((resolve) => globalThis.setTimeout(resolve, 0));
  }

  uniqueImageName(pdfBaseName, pdfHash, pageNumber, imageOffset, imageId, imageBase64) {
    const prefix = sanitizePathSegment(pdfBaseName, "PDF").slice(0, 80).trim();
    const extension = imageExtension(imageId, imageBase64);
    const rawImageStem = String(imageId || `img-${imageOffset}`).replace(/\.[^.]+$/, "");
    const imageStem = sanitizePathSegment(rawImageStem, `img-${imageOffset + 1}`).slice(0, 40);
    const page = String(pageNumber).padStart(4, "0");
    return `${prefix}--${pdfHash}--p${page}--${imageStem}.${extension}`;
  }

  toExactArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
      return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("OCR 图片数据格式无效");
  }

  async movePdfIfRequested(
    pdfFile,
    outputPlan,
    moveToSubfolder = this.settings.movePdfToSubfolder,
  ) {
    if (!outputPlan.useSubfolder || !moveToSubfolder) {
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
      await this.app.workspace.getLeaf("tab").openFile(file);
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
    this.openSections = new Set();
  }

  display() {
    this.captureOpenSections();
    const settingsRoot = this.containerEl;
    let containerEl = settingsRoot;
    containerEl.empty();
    containerEl.createEl("h2", { text: "Pdf translate to markdown" });
    containerEl.createEl("h3", { text: "API 密钥" });

    containerEl.createEl("p", {
      text: "使用教程：先按下面的步骤创建并填写 API 密钥。配置完成后，可在文件列表中右键 Markdown 翻译，或右键 PDF 选择仅转换、转换并翻译。",
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
      "https://admin.mistral.ai/organization/api-keys",
    );
    mistralGuide.appendText(" 创建密钥，复制到下方；订阅与用量可在 ");
    this.addExternalLink(
      mistralGuide,
      "Mistral Subscription",
      "https://admin.mistral.ai/subscription",
    );
    mistralGuide.appendText(" 查看。");

    const mineruGuide = guide.createEl("li");
    mineruGuide.appendText("如使用 MinerU，打开 MinerU ");
    this.addExternalLink(mineruGuide, "API 管理", "https://mineru.net/apiManage/token");
    mineruGuide.appendText(" 创建精准解析 API Token；使用情况也可通过此链接查看。");

    const usageGuide = guide.createEl("li");
    usageGuide.appendText(
      "翻译 Markdown 只需要 DeepSeek 密钥；PDF 转换并翻译需要 DeepSeek 和所选解析服务；仅将 PDF 转为 Markdown 只需要所选解析服务。其余设置通常可保持默认。",
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
      "用于 Mistral OCR。不会读取或复用其他插件中的密钥。",
      "mistralApiKey",
    );
    this.addPasswordSetting(
      containerEl,
      "MinerU API Token",
      "用于 MinerU 精准解析 API。支持 Secret Storage 时不会写入 data.json。",
      "mineruApiKey",
    );

    containerEl.createEl("h3", { text: "功能设置" });
    containerEl = this.createCollapsibleSection(
      settingsRoot,
      "pdf-translate",
      "PDF 转为 Markdown 并翻译",
      "先用 Mistral 或 MinerU 转换，再用 DeepSeek 翻译；支持手动或按目录分块。",
    );
    containerEl.createEl("h4", { text: "流程与输出" });
    new Setting(containerEl)
      .setName("PDF OCR 服务")
      .setDesc("选择 PDF 上传和 Markdown 解析所使用的服务。DeepSeek 始终负责翻译。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("mistral", "Mistral OCR")
          .addOption("mineru", "MinerU 精准解析")
          .setValue(this.plugin.settings.ocrProvider)
          .onChange(async (value) => {
            await this.updateSetting("ocrProvider", value);
            this.display();
          }),
      );

    containerEl.createEl("h4", { text: "PDF 输出设置" });
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

    new Setting(containerEl)
      .setName("分块译文文件名前添加序号")
      .setDesc("仅在选择不合并分块译文时生效；例如“1 第一章.md”。关闭后保存为“第一章.md”。")
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.numberSplitOutputFiles !== false)
          .onChange((value) => this.updateSetting("numberSplitOutputFiles", value)),
      );

    containerEl.createEl("h4", { text: "DeepSeek 设置" });
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
      .setDesc("普通 Markdown 整篇发送；长 PDF 的每个人工分段会分别使用此上限。")
      .addText((text) => {
        text
          .setValue(String(this.plugin.settings.maxTokens))
          .onChange((value) => this.updatePositiveInteger("maxTokens", value));
        text.inputEl.type = "number";
        text.inputEl.min = "1";
      });

    const usingMinerU = this.plugin.settings.ocrProvider === "mineru";
    containerEl.createEl("h4", { text: usingMinerU ? "MinerU 解析设置" : "Mistral OCR 设置" });
    if (usingMinerU) {
      new Setting(containerEl)
        .setName("API 地址")
        .setDesc("MinerU 精准解析 API v4 基础地址。")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.mineruBaseUrl)
            .setValue(this.plugin.settings.mineruBaseUrl)
            .onChange((value) => this.updateSetting("mineruBaseUrl", value.trim())),
        );

      new Setting(containerEl)
        .setName("解析模型")
        .setDesc("VLM 为官方推荐选项；Pipeline 更接近传统版面分析流程。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("vlm", "VLM（推荐）")
            .addOption("pipeline", "Pipeline")
            .setValue(this.plugin.settings.mineruModelVersion)
            .onChange((value) => this.updateSetting("mineruModelVersion", value)),
        );

      new Setting(containerEl)
        .setName("文档语言")
        .setDesc("影响 OCR 识别；英文资料填写 en，中文资料填写 ch。")
        .addText((text) =>
          text
            .setPlaceholder("en")
            .setValue(this.plugin.settings.mineruLanguage)
            .onChange((value) => this.updateSetting("mineruLanguage", value.trim())),
        );

      new Setting(containerEl)
        .setName("强制 OCR")
        .setDesc("扫描版 PDF 建议开启；含可提取文本的普通 PDF 通常关闭即可。")
        .addToggle((toggle) =>
          toggle
            .setValue(Boolean(this.plugin.settings.mineruForceOcr))
            .onChange((value) => this.updateSetting("mineruForceOcr", value)),
        );

      new Setting(containerEl)
        .setName("识别公式")
        .setDesc("对应 MinerU enable_formula；VLM 模式下主要影响行内公式。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.mineruEnableFormula !== false)
            .onChange((value) => this.updateSetting("mineruEnableFormula", value)),
        );

      new Setting(containerEl)
        .setName("识别表格")
        .setDesc("对应 MinerU enable_table。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.mineruEnableTable !== false)
            .onChange((value) => this.updateSetting("mineruEnableTable", value)),
        );

      new Setting(containerEl)
        .setName("轮询间隔（秒）")
        .setDesc("等待 MinerU 异步解析结果时的查询间隔，建议保持 3 秒。")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.mineruPollIntervalSeconds))
            .onChange((value) =>
              this.updateFiniteNumber("mineruPollIntervalSeconds", value, 1, 60),
            );
          text.inputEl.type = "number";
          text.inputEl.min = "1";
          text.inputEl.max = "60";
        });

      new Setting(containerEl)
        .setName("单次等待上限（分钟）")
        .setDesc("超过后算作一次失败；重试会继续查询同一个 MinerU 批次，不会重复上传。")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.mineruTimeoutMinutes))
            .onChange((value) => this.updatePositiveInteger("mineruTimeoutMinutes", value));
          text.inputEl.type = "number";
          text.inputEl.min = "1";
        });
    } else {
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
        .setName("保留页眉和页脚")
        .setDesc(
          "关闭后，Mistral 会识别页眉页脚并将其从正文 Markdown 中移除；该能力要求 OCR 2512 或更新模型。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.mistralKeepHeadersFooters !== false)
            .onChange((value) => this.updateSetting("mistralKeepHeadersFooters", value)),
        );
    }

    new Setting(containerEl)
      .setName("提取图片")
      .setDesc(`将 ${usingMinerU ? "MinerU" : "Mistral"} 返回的图片写入 Obsidian 默认附件路径，并重写 Markdown 链接。`)
      .addToggle((toggle) =>
        toggle.setValue(this.plugin.settings.extractImages).onChange(async (value) => {
          await this.updateSetting("extractImages", value);
          this.display();
        }),
      );

    if (this.plugin.settings.extractImages) {
      new Setting(containerEl)
        .setName("图片数量上限")
        .setDesc(usingMinerU ? "0 表示不限制；MinerU 结果下载后在本地应用此限制。" : "0 表示不限制。")
        .addText((text) => {
          text
            .setValue(String(this.plugin.settings.imageLimit))
            .onChange((value) => this.updateNonNegativeInteger("imageLimit", value));
          text.inputEl.type = "number";
          text.inputEl.min = "0";
        });

      new Setting(containerEl)
        .setName("图片最小尺寸")
        .setDesc(
          usingMinerU
            ? "宽和高的最小像素值；0 表示不限制。MinerU 图片会在本地过滤。"
            : "宽和高的最小像素值；0 表示不限制。",
        )
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
      .setDesc(
        usingMinerU
          ? "MinerU 的 full.md 不保留逐页 Markdown 边界，因此此选项仅适用于 Mistral。"
          : "开启后在每页 OCR Markdown 之间插入 ---。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.paginate)
          .setDisabled(usingMinerU)
          .onChange((value) => this.updateSetting("paginate", value)),
      );

    if (usingMinerU) {
      new Setting(containerEl)
        .setName("远程任务清理")
        .setDesc(
          "MinerU 精准解析 API 目前没有公开的任务或上传文件删除接口，插件无法主动删除已经提交的远程任务。",
        );
    } else {
      new Setting(containerEl)
        .setName("删除 Mistral 远程临时文件")
        .setDesc("建议开启；OCR 响应返回后立即尝试删除上传的 PDF。")
        .addToggle((toggle) =>
          toggle
            .setValue(this.plugin.settings.deleteMistralFile)
            .onChange((value) => this.updateSetting("deleteMistralFile", value)),
        );
    }

    containerEl.createEl("h4", { text: "翻译提示词" });
    this.renderPromptSetting(
      containerEl,
      "translationPrompt",
      DEFAULT_SETTINGS.translationPrompt,
    );

    containerEl = this.createCollapsibleSection(
      settingsRoot,
      "markdown-translate",
      "翻译 Markdown",
      "直接翻译现有 Markdown 文件；此处的 DeepSeek 参数和提示词独立于 PDF 翻译。",
    );
    this.renderMarkdownTranslationSettings(containerEl);

    containerEl = this.createCollapsibleSection(
      settingsRoot,
      "ocr-only",
      "仅将 PDF 转为 Markdown",
      "固定按每 100 页一块并行转换后合并，不调用 DeepSeek。",
    );
    this.renderOcrOnlySettings(containerEl);

    containerEl = settingsRoot;

    containerEl.createEl("h3", { text: "调试" });
    new Setting(containerEl)
      .setName("调试模式")
      .setDesc(
        "开启后把最近一次任务的阶段、重试、错误、OCR 文本和译文保存到插件目录的 debug-last-task.json。每次任务会覆盖上一次；不会保存 API 密钥、签名 URL 或图片 Base64。调试文件包含文档正文，请勿随意分享。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(this.plugin.settings.debugMode))
          .onChange((value) => this.updateSetting("debugMode", value)),
      );

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

  renderOcrOnlySettings(containerEl) {
    const settings = this.plugin.settings;
    const usingMinerU = settings.ocrOnlyProvider === "mineru";
    containerEl.createEl("h4", { text: "流程与输出" });
    containerEl.createEl("p", {
      text: "右键 PDF 选择“仅转为 Markdown”后，插件会固定按每 100 页一块并行处理并合并结果，不调用 DeepSeek。这里的选项独立于“PDF 转为 Markdown 并翻译”。",
    });

    new Setting(containerEl)
      .setName("OCR 服务")
      .setDesc("仅转换功能使用的解析服务。API 密钥在设置页顶部统一填写。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("mistral", "Mistral OCR")
          .addOption("mineru", "MinerU 精准解析")
          .setValue(settings.ocrOnlyProvider)
          .onChange(async (value) => {
            await this.updateSetting("ocrOnlyProvider", value);
            this.display();
          }),
      );

    new Setting(containerEl)
      .setName("结果输出位置")
      .setDesc("图片仍遵循 Obsidian 的默认附件路径。")
      .addDropdown((dropdown) =>
        dropdown
          .addOption("same-folder", "PDF 所在文件夹")
          .addOption("subfolder", "在 PDF 所在文件夹中新建与 PDF 同名子文件夹")
          .setValue(settings.ocrOnlyOutputMode)
          .onChange(async (value) => {
            await this.updateSetting("ocrOnlyOutputMode", value);
            this.display();
          }),
      );

    if (settings.ocrOnlyOutputMode === "subfolder") {
      new Setting(containerEl)
        .setName("将原 PDF 移入结果文件夹")
        .setDesc("仅在全部 OCR 成功并写入 Markdown 后移动。")
        .addToggle((toggle) =>
          toggle
            .setValue(Boolean(settings.ocrOnlyMovePdfToSubfolder))
            .onChange((value) => this.updateSetting("ocrOnlyMovePdfToSubfolder", value)),
        );
    }

    new Setting(containerEl)
      .setName("输出文件名后缀")
      .setDesc("例如 paper.pdf 默认输出 paper_OCR.md。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.ocrOnlyOutputSuffix)
          .setValue(settings.ocrOnlyOutputSuffix)
          .onChange((value) => this.updateSetting("ocrOnlyOutputSuffix", value)),
      );

    if (usingMinerU) {
      new Setting(containerEl)
        .setName("API 地址")
        .setDesc("仅转换功能使用的 MinerU API v4 基础地址。")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.ocrOnlyMineruBaseUrl)
            .setValue(settings.ocrOnlyMineruBaseUrl)
            .onChange((value) => this.updateSetting("ocrOnlyMineruBaseUrl", value.trim())),
        );
      new Setting(containerEl)
        .setName("解析模型")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("vlm", "VLM（推荐）")
            .addOption("pipeline", "Pipeline")
            .setValue(settings.ocrOnlyMineruModelVersion)
            .onChange((value) => this.updateSetting("ocrOnlyMineruModelVersion", value)),
        );
      new Setting(containerEl)
        .setName("文档语言")
        .setDesc("英文资料使用 en，中文资料使用 ch。")
        .addText((text) =>
          text
            .setPlaceholder("en")
            .setValue(settings.ocrOnlyMineruLanguage)
            .onChange((value) => this.updateSetting("ocrOnlyMineruLanguage", value.trim())),
        );
      new Setting(containerEl)
        .setName("强制 OCR")
        .setDesc("扫描版 PDF 建议开启。")
        .addToggle((toggle) =>
          toggle
            .setValue(Boolean(settings.ocrOnlyMineruForceOcr))
            .onChange((value) => this.updateSetting("ocrOnlyMineruForceOcr", value)),
        );
      new Setting(containerEl)
        .setName("识别公式")
        .addToggle((toggle) =>
          toggle
            .setValue(settings.ocrOnlyMineruEnableFormula !== false)
            .onChange((value) => this.updateSetting("ocrOnlyMineruEnableFormula", value)),
        );
      new Setting(containerEl)
        .setName("识别表格")
        .addToggle((toggle) =>
          toggle
            .setValue(settings.ocrOnlyMineruEnableTable !== false)
            .onChange((value) => this.updateSetting("ocrOnlyMineruEnableTable", value)),
        );
      new Setting(containerEl)
        .setName("轮询间隔（秒）")
        .addText((text) => {
          text
            .setValue(String(settings.ocrOnlyMineruPollIntervalSeconds))
            .onChange((value) =>
              this.updateFiniteNumber("ocrOnlyMineruPollIntervalSeconds", value, 1, 60),
            );
          text.inputEl.type = "number";
          text.inputEl.min = "1";
          text.inputEl.max = "60";
        });
      new Setting(containerEl)
        .setName("单块等待上限（分钟）")
        .addText((text) => {
          text
            .setValue(String(settings.ocrOnlyMineruTimeoutMinutes))
            .onChange((value) =>
              this.updatePositiveInteger("ocrOnlyMineruTimeoutMinutes", value),
            );
          text.inputEl.type = "number";
          text.inputEl.min = "1";
        });
    } else {
      new Setting(containerEl)
        .setName("OCR 模型")
        .setDesc("可填写 Mistral OCR API 支持的其他模型名称。")
        .addText((text) =>
          text
            .setPlaceholder(DEFAULT_SETTINGS.ocrOnlyMistralModel)
            .setValue(settings.ocrOnlyMistralModel)
            .onChange((value) => this.updateSetting("ocrOnlyMistralModel", value.trim())),
        );

      new Setting(containerEl)
        .setName("保留页眉和页脚")
        .setDesc(
          "关闭后，Mistral 会识别页眉页脚并将其从正文 Markdown 中移除；该能力要求 OCR 2512 或更新模型。",
        )
        .addToggle((toggle) =>
          toggle
            .setValue(settings.ocrOnlyMistralKeepHeadersFooters !== false)
            .onChange((value) =>
              this.updateSetting("ocrOnlyMistralKeepHeadersFooters", value),
            ),
        );
    }

    new Setting(containerEl)
      .setName("提取图片")
      .setDesc(`将 ${usingMinerU ? "MinerU" : "Mistral"} 返回的图片写入 Obsidian 默认附件路径。`)
      .addToggle((toggle) =>
        toggle.setValue(Boolean(settings.ocrOnlyExtractImages)).onChange(async (value) => {
          await this.updateSetting("ocrOnlyExtractImages", value);
          this.display();
        }),
      );

    if (settings.ocrOnlyExtractImages) {
      new Setting(containerEl)
        .setName("图片数量上限")
        .setDesc("每个 API 分块的上限；0 表示不限制。")
        .addText((text) => {
          text
            .setValue(String(settings.ocrOnlyImageLimit))
            .onChange((value) => this.updateNonNegativeInteger("ocrOnlyImageLimit", value));
          text.inputEl.type = "number";
          text.inputEl.min = "0";
        });
      new Setting(containerEl)
        .setName("图片最小尺寸")
        .setDesc("宽和高的最小像素值；0 表示不限制。")
        .addText((text) => {
          text
            .setValue(String(settings.ocrOnlyImageMinSize))
            .onChange((value) => this.updateNonNegativeInteger("ocrOnlyImageMinSize", value));
          text.inputEl.type = "number";
          text.inputEl.min = "0";
        });
    }

    new Setting(containerEl)
      .setName("页面之间添加分隔线")
      .setDesc(
        usingMinerU
          ? "MinerU 的 full.md 不保留可靠的逐页边界，因此此选项不可用。"
          : "开启后在每页 OCR Markdown 之间插入 ---。",
      )
      .addToggle((toggle) =>
        toggle
          .setValue(Boolean(settings.ocrOnlyPaginate))
          .setDisabled(usingMinerU)
          .onChange((value) => this.updateSetting("ocrOnlyPaginate", value)),
      );

    if (usingMinerU) {
      new Setting(containerEl)
        .setName("远程任务清理")
        .setDesc("MinerU 当前没有公开的任务删除接口，插件无法主动删除远程任务。");
    } else {
      new Setting(containerEl)
        .setName("删除 Mistral 远程临时文件")
        .setDesc("建议开启；每块 OCR 完成后立即尝试删除上传的临时 PDF。")
        .addToggle((toggle) =>
          toggle
            .setValue(Boolean(settings.ocrOnlyDeleteMistralFile))
            .onChange((value) => this.updateSetting("ocrOnlyDeleteMistralFile", value)),
        );
    }
  }

  renderMarkdownTranslationSettings(containerEl) {
    const settings = this.plugin.settings;
    containerEl.createEl("h4", { text: "输出设置" });
    new Setting(containerEl)
      .setName("输出文件名后缀")
      .setDesc("例如：note.md 的译文保存为 note_翻译.md。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.markdownOutputSuffix)
          .setValue(settings.markdownOutputSuffix)
          .onChange((value) => this.updateSetting("markdownOutputSuffix", value)),
      );

    containerEl.createEl("h4", { text: "DeepSeek 设置" });
    new Setting(containerEl)
      .setName("API 地址")
      .setDesc("仅用于直接翻译 Markdown；填写基础地址或完整的 /chat/completions 地址。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.markdownBaseUrl)
          .setValue(settings.markdownBaseUrl)
          .onChange((value) => this.updateSetting("markdownBaseUrl", value.trim())),
      );

    new Setting(containerEl)
      .setName("模型")
      .setDesc("DeepSeek 模型名称，也可以填写兼容服务的模型名。")
      .addText((text) =>
        text
          .setPlaceholder(DEFAULT_SETTINGS.markdownModel)
          .setValue(settings.markdownModel)
          .onChange((value) => this.updateSetting("markdownModel", value.trim())),
      );

    new Setting(containerEl)
      .setName("深度思考")
      .setDesc("关闭通常更适合普通翻译；开启后可选择思考强度。")
      .addToggle((toggle) =>
        toggle.setValue(Boolean(settings.markdownThinkingEnabled)).onChange(async (value) => {
          await this.updateSetting("markdownThinkingEnabled", value);
          this.display();
        }),
      );

    if (settings.markdownThinkingEnabled) {
      new Setting(containerEl)
        .setName("思考强度")
        .setDesc("仅在深度思考开启时生效。")
        .addDropdown((dropdown) =>
          dropdown
            .addOption("high", "High")
            .addOption("max", "Max")
            .setValue(settings.markdownReasoningEffort)
            .onChange((value) => this.updateSetting("markdownReasoningEffort", value)),
        );
    }

    new Setting(containerEl)
      .setName("Temperature")
      .setDesc(
        settings.markdownThinkingEnabled
          ? "深度思考模式下不发送 Temperature。"
          : "控制随机性，范围 0–2；翻译建议使用较低值。",
      )
      .addText((text) => {
        text
          .setValue(String(settings.markdownTemperature))
          .onChange((value) =>
            this.updateFiniteNumber("markdownTemperature", value, 0, 2),
          );
        text.inputEl.type = "number";
        text.inputEl.min = "0";
        text.inputEl.max = "2";
        text.inputEl.step = "0.1";
      });

    new Setting(containerEl)
      .setName("最大输出 Token")
      .setDesc("直接翻译 Markdown 时整篇发送，并使用此输出上限。")
      .addText((text) => {
        text
          .setValue(String(settings.markdownMaxTokens))
          .onChange((value) => this.updatePositiveInteger("markdownMaxTokens", value));
        text.inputEl.type = "number";
        text.inputEl.min = "1";
      });

    containerEl.createEl("h4", { text: "翻译提示词" });
    this.renderPromptSetting(
      containerEl,
      "markdownTranslationPrompt",
      DEFAULT_SETTINGS.markdownTranslationPrompt,
    );
  }

  renderPromptSetting(containerEl, key, placeholder) {
    new Setting(containerEl)
      .setName("系统提示词")
      .setDesc("Markdown 原文会作为下一条用户消息完整提交。")
      .addTextArea((text) => {
        text
          .setPlaceholder(placeholder)
          .setValue(this.plugin.settings[key])
          .onChange((value) => this.updateSetting(key, value));
        text.inputEl.rows = 14;
        text.inputEl.addClass("deepseek-translator-prompt");
      });
  }

  createCollapsibleSection(parent, id, title, description) {
    const details = parent.createEl("details", {
      cls: "pdf-translate-settings-section",
      attr: { "data-section-id": id },
    });
    details.open = this.openSections.has(id);
    const summary = details.createEl("summary");
    summary.createEl("h3", { text: title });
    summary.createEl("span", { text: description });
    return details.createDiv({ cls: "pdf-translate-settings-section-content" });
  }

  captureOpenSections() {
    const sections = this.containerEl?.querySelectorAll?.(
      "details.pdf-translate-settings-section[data-section-id]",
    );
    if (!sections) {
      return;
    }
    this.openSections.clear();
    for (const section of sections) {
      if (section.open) {
        this.openSections.add(section.dataset.sectionId);
      }
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
