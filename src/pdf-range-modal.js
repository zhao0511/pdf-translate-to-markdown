import { Modal, loadPdfJs } from "obsidian";

import {
  PDF_MAX_PAGES_PER_PART,
  countSelectedPages,
  createDefaultPdfBlockName,
  findPdfRangeGaps,
  shouldAutoFillPdfRangeEnd,
  validatePdfBlockNames,
  validatePdfRanges,
} from "./pdf-range-utils.mjs";

export class PdfRangeModal extends Modal {
  constructor(app, pdfFile, pageCount, options = {}) {
    super(app);
    this.pdfFile = pdfFile;
    this.pageCount = pageCount;
    this.onAutoDetect = options.onAutoDetect;
    this.pdfBytes = options.pdfBytes || null;
    this.currentPreviewPage = 1;
    this.pendingPreviewPage = 1;
    this.previewZoomPercent = 100;
    this.mergeOutput = true;
    this.pdfPageElements = new Map();
    this.pdfRenderTasks = new Map();
    this.pdfRenderPromises = new Map();
    this.renderedPdfPages = new Set();
    this.settled = false;
    this.autoDetecting = false;
    this.nextRowId = 1;
    this.rows = [this.createPendingRow(1)];
    this.rowElements = new Map();
    this.suppressNextAutoFill = false;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  waitForResult() {
    this.open();
    return this.resultPromise;
  }

  onOpen() {
    this.modalEl.addClass("pdf-translate-range-modal");
    this.setTitle("选择 PDF 翻译页码");

    const { contentEl } = this;
    contentEl.empty();
    const layout = contentEl.createDiv({ cls: "pdf-translate-range-layout" });
    this.renderPreview(layout);
    this.renderSidebar(layout);
  }

  renderPreview(layout) {
    const preview = layout.createDiv({ cls: "pdf-translate-range-preview" });
    this.previewEl = preview;
    this.resourceUrl = this.app.vault.getResourcePath(this.pdfFile);

    const toolbar = preview.createDiv({ cls: "pdf-translate-pdf-toolbar" });
    this.previewPreviousButton = toolbar.createEl("button", {
      text: "上一页",
      attr: { type: "button", "aria-label": "预览上一页" },
    });
    this.previewPageLabel = toolbar.createSpan({ text: `第 1 / ${this.pageCount} 页` });
    this.previewNextButton = toolbar.createEl("button", {
      text: "下一页",
      attr: { type: "button", "aria-label": "预览下一页" },
    });
    this.previewPreviousButton.disabled = true;
    this.previewNextButton.disabled = true;
    this.previewPreviousButton.addEventListener("click", () => {
      this.jumpToPdfPage(this.currentPreviewPage - 1);
    });
    this.previewNextButton.addEventListener("click", () => {
      this.jumpToPdfPage(this.currentPreviewPage + 1);
    });
    const zoomControls = toolbar.createDiv({ cls: "pdf-translate-pdf-zoom" });
    const zoomOutButton = zoomControls.createEl("button", {
      text: "−",
      attr: { type: "button", "aria-label": "缩小 PDF" },
    });
    this.previewZoomSlider = zoomControls.createEl("input", {
      attr: {
        type: "range",
        min: "25",
        max: "150",
        step: "5",
        value: "100",
        "aria-label": "PDF 显示大小",
      },
    });
    this.previewZoomLabel = zoomControls.createSpan({ text: "100%" });
    const zoomInButton = zoomControls.createEl("button", {
      text: "+",
      attr: { type: "button", "aria-label": "放大 PDF" },
    });
    zoomOutButton.addEventListener("click", () => {
      this.setPreviewZoom(this.previewZoomPercent - 10);
    });
    zoomInButton.addEventListener("click", () => {
      this.setPreviewZoom(this.previewZoomPercent + 10);
    });
    this.previewZoomSlider.addEventListener("input", () => {
      this.setPreviewZoom(Number(this.previewZoomSlider.value));
    });
    this.previewZoomLabel.title = "双击恢复为适应窗口高度";
    this.previewZoomLabel.addEventListener("dblclick", () => {
      this.setPreviewZoom(this.fitHeightZoom(this.previewPageRatio));
    });

    this.previewCanvasHost = preview.createDiv({ cls: "pdf-translate-pdf-canvas-host" });
    this.previewPagesEl = this.previewCanvasHost.createDiv({ cls: "pdf-translate-pdf-pages" });
    this.previewStatusEl = this.previewCanvasHost.createDiv({
      text: "正在加载 PDF 预览……",
      cls: "pdf-translate-pdf-preview-status",
    });
    const fallback = preview.createEl("p", { cls: "pdf-translate-range-preview-fallback" });
    fallback.appendText("预览无法显示时，可");
    fallback.createEl("a", {
      text: "在新窗口打开 PDF",
      attr: { href: this.resourceUrl, target: "_blank", rel: "noopener noreferrer" },
    });
    fallback.appendText("。");
    void this.initializePdfPreview();
  }

  async initializePdfPreview() {
    try {
      const pdfjs = await loadPdfJs();
      if (this.settled) {
        return;
      }
      const source = this.pdfBytes || await this.app.vault.readBinary(this.pdfFile);
      const exactBytes = source instanceof ArrayBuffer
        ? source.slice(0)
        : source.buffer.slice(source.byteOffset, source.byteOffset + source.byteLength);
      this.pdfLoadingTask = pdfjs.getDocument({ data: new Uint8Array(exactBytes) });
      this.pdfPreviewDocument = await this.pdfLoadingTask.promise;
      if (this.settled) {
        await this.pdfPreviewDocument.destroy?.();
        return;
      }
      const firstPage = await this.pdfPreviewDocument.getPage(1);
      const firstViewport = firstPage.getViewport({ scale: 1 });
      this.createPdfPagePlaceholders(firstViewport.width / firstViewport.height);
      const ownerWindow = this.previewCanvasHost.ownerDocument?.defaultView || globalThis;
      await new Promise((resolve) => {
        if (typeof ownerWindow.requestAnimationFrame === "function") {
          ownerWindow.requestAnimationFrame(() => resolve());
        } else {
          ownerWindow.setTimeout(resolve, 0);
        }
      });
      if (this.settled) {
        return;
      }
      this.setPreviewZoom(this.fitHeightZoom(firstViewport.width / firstViewport.height));
      this.observePdfPages();
      this.previewPreviousButton.disabled = false;
      this.previewNextButton.disabled = false;
      this.jumpToPdfPage(this.pendingPreviewPage, { behavior: "auto" });
    } catch (error) {
      if (this.settled) {
        return;
      }
      console.warn("Unable to initialize PDF.js preview:", error);
      this.showIframePreviewFallback(error);
    }
  }

  createPdfPagePlaceholders(widthToHeightRatio) {
    this.previewPagesEl.empty();
    this.pdfPageElements.clear();
    const ratio = Number.isFinite(widthToHeightRatio) && widthToHeightRatio > 0
      ? widthToHeightRatio
      : 0.707;
    this.previewPageRatio = ratio;
    for (let page = 1; page <= this.pageCount; page += 1) {
      const pageEl = this.previewPagesEl.createDiv({ cls: "pdf-translate-pdf-page" });
      pageEl.dataset.page = String(page);
      pageEl.style.aspectRatio = `${ratio}`;
      pageEl.createDiv({
        text: `PDF 第 ${page} 页`,
        cls: "pdf-translate-pdf-page-placeholder",
      });
      this.pdfPageElements.set(page, pageEl);
    }
  }

  observePdfPages() {
    const ownerWindow = this.previewCanvasHost.ownerDocument?.defaultView || globalThis;
    const IntersectionObserverClass = ownerWindow.IntersectionObserver || globalThis.IntersectionObserver;
    if (IntersectionObserverClass) {
      this.previewPageObserver = new IntersectionObserverClass(
        (entries) => {
          for (const entry of entries) {
            if (entry.isIntersecting) {
              void this.renderPdfPage(Number(entry.target.dataset.page));
            }
          }
        },
        { root: this.previewCanvasHost, rootMargin: "120% 0px", threshold: 0.01 },
      );
      for (const pageEl of this.pdfPageElements.values()) {
        this.previewPageObserver.observe(pageEl);
      }
    } else {
      void this.renderPdfPage(this.pendingPreviewPage);
    }

    this.previewScrollHandler = () => {
      if (this.previewScrollFrame !== undefined) {
        return;
      }
      this.previewScrollFrame = ownerWindow.requestAnimationFrame(() => {
        this.previewScrollFrame = undefined;
        this.updateCurrentPreviewPageFromScroll();
      });
    };
    this.previewCanvasHost.addEventListener("scroll", this.previewScrollHandler, { passive: true });
  }

  updateCurrentPreviewPageFromScroll() {
    if (this.pdfPageElements.size === 0) {
      return;
    }
    const center = this.previewCanvasHost.scrollTop + this.previewCanvasHost.clientHeight / 2;
    let nearestPage = this.currentPreviewPage;
    let nearestDistance = Number.POSITIVE_INFINITY;
    let low = 1;
    let high = this.pageCount;
    while (low <= high) {
      const page = Math.floor((low + high) / 2);
      const pageEl = this.pdfPageElements.get(page);
      if (!pageEl) {
        break;
      }
      const pageCenter = pageEl.offsetTop + pageEl.offsetHeight / 2;
      const distance = Math.abs(pageCenter - center);
      if (distance < nearestDistance) {
        nearestDistance = distance;
        nearestPage = page;
      }
      if (pageCenter < center) {
        low = page + 1;
      } else {
        high = page - 1;
      }
    }
    this.setCurrentPreviewPage(nearestPage);
    this.releaseDistantPdfPages(nearestPage);
  }

  setCurrentPreviewPage(page) {
    this.currentPreviewPage = page;
    this.pendingPreviewPage = page;
    this.previewPageLabel.setText(`第 ${page} / ${this.pageCount} 页`);
    this.previewPreviousButton.disabled = page <= 1;
    this.previewNextButton.disabled = page >= this.pageCount;
  }

  setPreviewZoom(value) {
    const percent = Math.min(150, Math.max(25, Math.round(Number(value) / 5) * 5 || 100));
    this.previewZoomPercent = percent;
    this.previewZoomSlider.value = String(percent);
    this.previewZoomLabel.setText(`${percent}%`);
    this.previewPagesEl.style.width = `${percent}%`;

    const ownerWindow = this.previewCanvasHost.ownerDocument?.defaultView || globalThis;
    if (this.previewZoomTimer !== undefined) {
      ownerWindow.clearTimeout(this.previewZoomTimer);
    }
    this.previewZoomTimer = ownerWindow.setTimeout(() => {
      this.previewZoomTimer = undefined;
      this.refreshPdfPagesForZoom();
    }, 120);
  }

  fitHeightZoom(widthToHeightRatio) {
    const hostWidth = Math.max(1, this.previewCanvasHost?.clientWidth || 1);
    const hostHeight = Math.max(1, this.previewCanvasHost?.clientHeight || 1);
    const ratio = Number.isFinite(widthToHeightRatio) && widthToHeightRatio > 0
      ? widthToHeightRatio
      : 0.707;
    const availableHeight = Math.max(200, hostHeight - 24);
    return (availableHeight * ratio / hostWidth) * 100;
  }

  refreshPdfPagesForZoom() {
    if (!this.pdfPreviewDocument || this.settled) {
      return;
    }
    for (const renderTask of this.pdfRenderTasks.values()) {
      renderTask.cancel?.();
    }
    this.pdfRenderTasks.clear();
    this.pdfRenderPromises.clear();
    this.renderedPdfPages.clear();
    for (const pageEl of this.pdfPageElements.values()) {
      pageEl.querySelector("canvas")?.remove();
      pageEl.removeClass("is-rendered");
    }
    const ownerWindow = this.previewCanvasHost.ownerDocument?.defaultView || globalThis;
    ownerWindow.requestAnimationFrame(() => {
      if (this.settled) {
        return;
      }
      this.jumpToPdfPage(this.currentPreviewPage, { behavior: "auto" });
      for (
        let page = Math.max(1, this.currentPreviewPage - 2);
        page <= Math.min(this.pageCount, this.currentPreviewPage + 2);
        page += 1
      ) {
        void this.renderPdfPage(page);
      }
    });
  }

  async renderPdfPage(pageNumber) {
    const page = Math.min(this.pageCount, Math.max(1, Math.floor(Number(pageNumber) || 1)));
    if (!this.pdfPreviewDocument) {
      this.pendingPreviewPage = page;
      this.setPreviewStatus(`PDF 加载完成后将定位到第 ${page} 页……`);
      return;
    }
    if (this.renderedPdfPages.has(page)) {
      return;
    }
    if (this.pdfRenderPromises.has(page)) {
      return this.pdfRenderPromises.get(page);
    }

    const renderPromise = (async () => {
      const pageEl = this.pdfPageElements.get(page);
      if (!pageEl) {
        return;
      }
      const pdfPage = await this.pdfPreviewDocument.getPage(page);
      if (this.settled || !this.pdfPageElements.has(page)) {
        return;
      }
      const baseViewport = pdfPage.getViewport({ scale: 1 });
      pageEl.style.aspectRatio = `${baseViewport.width} / ${baseViewport.height}`;
      const availableWidth = Math.max(280, pageEl.clientWidth);
      const cssScale = availableWidth / baseViewport.width;
      const pixelRatio = Math.min(
        2,
        pageEl.ownerDocument?.defaultView?.devicePixelRatio ||
          globalThis.devicePixelRatio ||
          1,
      );
      const renderViewport = pdfPage.getViewport({ scale: cssScale * pixelRatio });
      const oldCanvas = pageEl.querySelector("canvas");
      oldCanvas?.remove();
      const canvas = pageEl.createEl("canvas", {
        attr: { "aria-label": `${this.pdfFile.name}，PDF 第 ${page} 页` },
      });
      const context = canvas.getContext("2d", { alpha: false });
      if (!context) {
        throw new Error("无法创建 PDF 画布");
      }
      canvas.width = Math.max(1, Math.floor(renderViewport.width));
      canvas.height = Math.max(1, Math.floor(renderViewport.height));
      canvas.style.width = `${renderViewport.width / pixelRatio}px`;
      canvas.style.height = `${renderViewport.height / pixelRatio}px`;
      const renderTask = pdfPage.render({
        canvasContext: context,
        viewport: renderViewport,
      });
      this.pdfRenderTasks.set(page, renderTask);
      await renderTask.promise;
      if (this.settled || !this.pdfPageElements.has(page)) {
        return;
      }
      pageEl.addClass("is-rendered");
      this.renderedPdfPages.add(page);
      this.setPreviewStatus("");
    })().catch((error) => {
      if (error?.name === "RenderingCancelledException") {
        return;
      }
      console.warn("Unable to render PDF preview page:", error);
      const pageEl = this.pdfPageElements.get(page);
      pageEl?.addClass("is-error");
      const placeholder = pageEl?.querySelector(".pdf-translate-pdf-page-placeholder");
      if (placeholder) {
        placeholder.textContent =
          `第 ${page} 页渲染失败：${error instanceof Error ? error.message : String(error)}`;
      }
    }).finally(() => {
      this.pdfRenderTasks.delete(page);
      this.pdfRenderPromises.delete(page);
    });
    this.pdfRenderPromises.set(page, renderPromise);
    return renderPromise;
  }

  releaseDistantPdfPages(centerPage) {
    const keepDistance = 8;
    for (const [page, renderTask] of this.pdfRenderTasks) {
      if (Math.abs(page - centerPage) > keepDistance) {
        renderTask.cancel?.();
        this.pdfPageElements.get(page)?.querySelector("canvas")?.remove();
      }
    }
    for (const page of [...this.renderedPdfPages]) {
      if (Math.abs(page - centerPage) <= keepDistance) {
        continue;
      }
      const pageEl = this.pdfPageElements.get(page);
      pageEl?.querySelector("canvas")?.remove();
      pageEl?.removeClass("is-rendered");
      this.renderedPdfPages.delete(page);
    }
  }

  setPreviewStatus(message, isError = false) {
    if (!this.previewStatusEl) {
      return;
    }
    this.previewStatusEl.setText(String(message || ""));
    this.previewStatusEl.toggleClass("is-hidden", !message);
    this.previewStatusEl.toggleClass("is-error", Boolean(isError));
  }

  showIframePreviewFallback(error) {
    this.previewCanvasHost.empty();
    this.previewFrame = this.previewCanvasHost.createEl("iframe", {
      attr: {
        src: this.resourceUrl,
        title: `PDF 预览：${this.pdfFile.name}`,
      },
    });
    this.previewPageLabel.setText("兼容预览模式");
    this.previewPreviousButton.disabled = true;
    this.previewNextButton.disabled = true;
    this.autoStatusEl?.setText?.(
      `PDF.js 预览不可用，已切换兼容模式：${error instanceof Error ? error.message : String(error)}`,
    );
  }

  renderSidebar(layout) {
    const sidebar = layout.createDiv({ cls: "pdf-translate-range-sidebar" });
    sidebar.createEl("h3", { text: `拆分规则（共 ${this.pageCount} 页）` });

    const hints = sidebar.createDiv({ cls: "pdf-translate-range-hints" });
    hints.createEl("p", {
      text: "注意：请填写 PDF 阅读器显示的文件页码，不是书籍正文中印刷的页码。",
    });
    hints.createEl("p", {
      text: "建议按照自然章节边界拆分，否则跨块上下文、标题层级和术语可能难以保持一致。",
    });
    hints.createEl("p", {
      text: `每部分最多 ${PDF_MAX_PAGES_PER_PART} 页。未填完的灰色行不会参与处理。`,
    });
    hints.createEl("p", {
      text: "双击任一已填写的页码框，左侧 PDF 会跳转到对应的文件页。",
    });

    const autoPanel = sidebar.createDiv({ cls: "pdf-translate-range-auto" });
    this.autoDetectButton = autoPanel.createEl("button", {
      text: "根据目录自动按章节划分",
      cls: "mod-cta",
      attr: { type: "button" },
    });
    this.autoStatusEl = autoPanel.createDiv({ cls: "pdf-translate-range-auto-status" });
    this.autoStatusEl.setText("将 OCR 前 15 页；信息不足时最多继续读取到第 35 页。");
    if (typeof this.onAutoDetect !== "function") {
      this.autoDetectButton.disabled = true;
    } else {
      this.autoDetectButton.addEventListener("click", () => void this.runAutoDetect());
    }

    const outputPanel = sidebar.createDiv({ cls: "pdf-translate-range-output" });
    const outputLabel = outputPanel.createEl("label");
    this.mergeOutputCheckbox = outputLabel.createEl("input", {
      attr: { type: "checkbox", "aria-label": "合并分块译文" },
    });
    this.mergeOutputCheckbox.checked = true;
    outputLabel.createSpan({ text: "合并分块译文为一个 Markdown 文件" });
    outputPanel.createDiv({
      cls: "pdf-translate-range-output-description",
      text: "关闭后会创建一个译文文件夹，每块保存为单独的 Markdown 文件。",
    });
    this.mergeOutputCheckbox.addEventListener("change", () => {
      this.mergeOutput = this.mergeOutputCheckbox.checked;
      this.syncRowsAndValidation();
    });

    const header = sidebar.createDiv({ cls: "pdf-translate-range-row-header" });
    header.createSpan({ text: "起始页" });
    header.createSpan({ text: "" });
    header.createSpan({ text: "结束页" });
    header.createSpan({ text: "识别内容" });
    header.createSpan({ text: "页数" });
    header.createSpan({ text: "" });

    this.rowsContainer = sidebar.createDiv({ cls: "pdf-translate-range-rows" });
    this.statusEl = sidebar.createDiv({ cls: "pdf-translate-range-status" });
    const buttonRow = sidebar.createDiv({ cls: "pdf-translate-range-buttons" });
    this.cancelButton = buttonRow.createEl("button", { text: "取消" });
    this.startButton = buttonRow.createEl("button", {
      text: "开始并行处理",
      cls: "mod-cta",
    });

    this.cancelButton.addEventListener("click", () => this.finish(null));
    this.startButton.addEventListener("click", () => {
      if (this.currentRanges) {
        this.finish({
          ranges: this.currentRanges,
          mergeOutput: this.mergeOutput,
        });
      }
    });

    this.renderAllRows();
    this.reconcileRows();
    this.syncRowsAndValidation();
    globalThis.setTimeout(() => this.rowElements.get(this.rows[0]?.id)?.endInput.focus(), 0);
  }

  createPendingRow(start, options = {}) {
    return {
      id: this.nextRowId++,
      start: String(start),
      end: "",
      startAuto: options.startAuto !== false,
      allowAutoFill: options.allowAutoFill !== false,
      autoFilled: false,
      title: options.title || "",
      type: options.type || "",
      blockName: options.blockName || "",
      blockNameAuto: options.blockNameAuto !== false,
    };
  }

  renderAllRows() {
    this.rowsContainer.empty();
    this.rowElements.clear();
    for (const row of this.rows) {
      this.appendRowElement(row);
    }
  }

  appendRowElement(row) {
    const rowEl = this.rowsContainer.createDiv({ cls: "pdf-translate-range-row" });
    rowEl.dataset.rowId = String(row.id);
    const startInput = rowEl.createEl("input", {
      cls: "pdf-translate-range-number",
      attr: {
        type: "text",
        inputmode: "numeric",
        pattern: "[0-9]*",
        "aria-label": "起始页",
      },
    });
    const separator = rowEl.createSpan({ text: "–", cls: "pdf-translate-range-separator" });
    const endInput = rowEl.createEl("input", {
      cls: "pdf-translate-range-number",
      attr: {
        type: "text",
        inputmode: "numeric",
        pattern: "[0-9]*",
        "aria-label": "结束页",
        placeholder: "填写",
      },
    });
    const titleEl = rowEl.createSpan({
      text: row.title || "手动分块",
      cls: "pdf-translate-range-title",
    });
    const pageCountEl = rowEl.createSpan({
      text: "—",
      cls: "pdf-translate-range-page-count",
    });
    const deleteButton = rowEl.createEl("button", {
      text: "删除",
      cls: "pdf-translate-range-delete",
      attr: { type: "button", "aria-label": "删除这一部分" },
    });
    const blockNameWrap = rowEl.createDiv({ cls: "pdf-translate-range-block-name" });
    blockNameWrap.createSpan({ text: "块名" });
    const blockNameInput = blockNameWrap.createEl("input", {
      attr: {
        type: "text",
        placeholder: "输入这一块的文件名",
        "aria-label": "分块文件名",
      },
    });
    startInput.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.jumpToPdfPage(startInput.value);
    });
    endInput.addEventListener("dblclick", (event) => {
      event.preventDefault();
      event.stopPropagation();
      this.jumpToPdfPage(endInput.value);
    });

    startInput.addEventListener("input", () => {
      startInput.value = startInput.value.replace(/\D/g, "");
      row.start = startInput.value;
      row.startAuto = false;
      row.allowAutoFill = true;
      this.handleRowInput(row, "start");
    });
    endInput.addEventListener("input", () => {
      endInput.value = endInput.value.replace(/\D/g, "");
      row.end = endInput.value;
      row.autoFilled = false;
      if (!row.end) {
        row.allowAutoFill = false;
      } else {
        row.allowAutoFill = true;
      }
      this.handleRowInput(row, "end");
    });
    endInput.addEventListener("keydown", (event) => {
      if (event.key !== "Enter") {
        return;
      }
      const nextRow = this.rows[this.rows.indexOf(row) + 1];
      const nextInput = nextRow ? this.rowElements.get(nextRow.id)?.endInput : null;
      if (nextInput) {
        event.preventDefault();
        nextInput.focus();
      }
    });
    blockNameInput.addEventListener("input", () => {
      row.blockName = blockNameInput.value;
      row.blockNameAuto = false;
      this.syncRowsAndValidation(blockNameInput);
    });
    deleteButton.addEventListener("click", () => this.deleteRow(row));

    this.rowElements.set(row.id, {
      rowEl,
      startInput,
      separator,
      endInput,
      titleEl,
      pageCountEl,
      deleteButton,
      blockNameWrap,
      blockNameInput,
    });
    this.updateRowElement(row);
  }

  handleRowInput(row, field) {
    const activeInput = this.rowElements.get(row.id)?.[`${field}Input`];
    this.reconcileRows();
    this.syncRowsAndValidation(activeInput);
  }

  reconcileRows() {
    const completedRows = this.rows
      .filter((row) => this.isRowFilled(row))
      .sort((left, right) => Number(left.start) - Number(right.start));
    const pendingRows = this.rows.filter((row) => !this.isRowFilled(row));

    if (completedRows.length === 0) {
      const pending = pendingRows[0] || this.createPendingRow(1);
      if (pending.startAuto || !pending.start) {
        pending.start = "1";
        pending.startAuto = true;
      }
      this.rows = [pending];
      return;
    }

    const unusedPendingRows = [...pendingRows];
    const takePendingForGap = (start, end, trailing = false) => {
      let pendingIndex = unusedPendingRows.findIndex((row) => {
        const value = Number(row.start);
        return Number.isInteger(value) && value >= start && value <= end;
      });
      if (pendingIndex < 0 && unusedPendingRows.length > 0) {
        pendingIndex = 0;
      }
      const allowAutoFill = trailing && !this.suppressNextAutoFill;
      const row = pendingIndex >= 0
        ? unusedPendingRows.splice(pendingIndex, 1)[0]
        : this.createPendingRow(start, { allowAutoFill });
      const currentStart = Number(row.start);
      if (
        row.startAuto ||
        !Number.isInteger(currentStart) ||
        currentStart < start ||
        currentStart > end
      ) {
        row.start = String(start);
        row.startAuto = true;
      }
      row.gapEnd = end;
      if (
        trailing &&
        row.end === "" &&
        row.allowAutoFill &&
        allowAutoFill &&
        shouldAutoFillPdfRangeEnd(Number(row.start), this.pageCount)
      ) {
        row.end = String(this.pageCount);
        row.autoFilled = true;
      }
      return row;
    };

    const gaps = findPdfRangeGaps(completedRows, this.pageCount);
    const gapRows = gaps.map(({ start, end }) =>
      takePendingForGap(start, end, end === this.pageCount),
    );
    const nextRows = [...completedRows, ...gapRows].sort(
      (left, right) => Number(left.start) - Number(right.start),
    );
    this.suppressNextAutoFill = false;
    this.rows = nextRows;
  }

  deleteRow(row) {
    const index = this.rows.indexOf(row);
    if (index < 0 || !this.isRowFilled(row)) {
      return;
    }
    const wasLastFilledRow = !this.rows.slice(index + 1).some((item) => this.isRowFilled(item));
    this.rows.splice(index, 1);
    if (wasLastFilledRow) {
      while (this.rows.length > 0 && !this.isRowFilled(this.rows.at(-1))) {
        this.rows.pop();
      }
      this.suppressNextAutoFill = true;
    }
    this.renderAllRows();
    this.reconcileRows();
    this.syncRowsAndValidation();
  }

  syncRowsAndValidation(activeInput = null) {
    const shouldRestoreFocus =
      activeInput && activeInput.ownerDocument?.activeElement === activeInput;
    const selectionStart = shouldRestoreFocus ? activeInput.selectionStart : null;
    const selectionEnd = shouldRestoreFocus ? activeInput.selectionEnd : null;
    const liveIds = new Set(this.rows.map((row) => row.id));
    for (const [rowId, elements] of this.rowElements) {
      if (!liveIds.has(rowId)) {
        elements.rowEl.remove();
        this.rowElements.delete(rowId);
      }
    }
    for (let index = 0; index < this.rows.length; index += 1) {
      const row = this.rows[index];
      if (!this.rowElements.has(row.id)) {
        this.appendRowElement(row);
      }
      const elements = this.rowElements.get(row.id);
      const elementAtIndex = this.rowsContainer.children[index] || null;
      if (elements?.rowEl && elementAtIndex !== elements.rowEl) {
        this.rowsContainer.insertBefore(elements.rowEl, elementAtIndex);
      }
      this.updateRowElement(row, activeInput);
    }
    if (shouldRestoreFocus && activeInput.isConnected) {
      activeInput.focus({ preventScroll: true });
      if (selectionStart !== null && selectionEnd !== null) {
        activeInput.setSelectionRange(selectionStart, selectionEnd);
      }
    }
    this.updateValidation();
  }

  updateRowElement(row, activeInput = null) {
    const elements = this.rowElements.get(row.id);
    if (!elements) {
      return;
    }
    if (elements.startInput !== activeInput && elements.startInput.value !== row.start) {
      elements.startInput.value = row.start;
    }
    if (elements.endInput !== activeInput && elements.endInput.value !== row.end) {
      elements.endInput.value = row.end;
    }

    const filled = this.isRowFilled(row);
    if (filled && (row.blockNameAuto || !String(row.blockName || "").trim())) {
      row.blockName = createDefaultPdfBlockName({
        start: Number(row.start),
        end: Number(row.end),
        title: row.title,
      });
      row.blockNameAuto = true;
    }
    if (
      elements.blockNameInput !== activeInput &&
      elements.blockNameInput.value !== row.blockName
    ) {
      elements.blockNameInput.value = row.blockName;
    }
    elements.rowEl.toggleClass("is-pending", !filled);
    elements.rowEl.toggleClass("is-autofilled", Boolean(row.autoFilled));
    elements.titleEl.setText(row.title || "手动分块");
    elements.titleEl.toggleClass("is-empty", !row.title);
    elements.titleEl.title = row.title || "手动分块";
    const start = Number(row.start);
    const end = Number(row.end);
    const rowPageCount = Number.isInteger(start) && Number.isInteger(end) && end >= start
      ? end - start + 1
      : null;
    elements.pageCountEl.setText(rowPageCount === null ? "—" : `${rowPageCount} 页`);
    elements.startInput.disabled = this.autoDetecting;
    elements.endInput.disabled = this.autoDetecting;
    elements.deleteButton.hidden = !filled;
    elements.deleteButton.disabled = this.autoDetecting || !filled;
    elements.blockNameWrap.hidden = this.mergeOutput || !filled;
    elements.blockNameInput.disabled = this.autoDetecting || this.mergeOutput || !filled;
  }

  updateValidation() {
    const completedRows = this.rows.filter((row) => this.isRowFilled(row));

    if (completedRows.length === 0) {
      this.currentRanges = null;
      this.statusEl.setText("请填写第一部分的结束页。");
      this.statusEl.removeClass("is-valid");
      this.statusEl.removeClass("is-error");
      this.startButton.disabled = true;
      return;
    }

    try {
      const validatedRanges = validatePdfRanges(
        completedRows.map((row) => ({ start: Number(row.start), end: Number(row.end) })),
        this.pageCount,
      );
      const ranges = validatedRanges.map((range, index) => {
        const row = completedRows.find(
          (candidate) => Number(candidate.start) === range.start && Number(candidate.end) === range.end,
        );
        if (row && (row.blockNameAuto || !String(row.blockName || "").trim())) {
          row.blockName = createDefaultPdfBlockName({ ...range, title: row.title }, index);
          row.blockNameAuto = true;
        }
        return {
          ...range,
          title: row?.title || "",
          type: row?.type || "",
          blockName: row?.blockName || createDefaultPdfBlockName(range, index),
        };
      });
      if (!this.mergeOutput) {
        validatePdfBlockNames(ranges);
      }
      this.currentRanges = ranges;
      const selectedPages = countSelectedPages(ranges);
      const longestRange = Math.max(...ranges.map(({ start, end }) => end - start + 1));
      const hasPendingRow = this.rows.some((row) => !this.isRowFilled(row));
      this.statusEl.setText(
        `已填写 ${ranges.length} 部分，共 ${selectedPages}/${this.pageCount} 页；最长一块 ${longestRange} 页。${
          hasPendingRow ? "灰色待填行不会参与处理。" : ""
        }${this.mergeOutput ? "" : "译文将按块分别保存。"}`,
      );
      this.statusEl.removeClass("is-error");
      this.statusEl.addClass("is-valid");
      this.startButton.disabled = this.autoDetecting;
    } catch (error) {
      this.currentRanges = null;
      this.statusEl.setText(error instanceof Error ? error.message : String(error));
      this.statusEl.removeClass("is-valid");
      this.statusEl.addClass("is-error");
      this.startButton.disabled = true;
    }
  }

  isRowFilled(row) {
    return row.start !== "" && row.end !== "";
  }

  async runAutoDetect() {
    if (this.autoDetecting || typeof this.onAutoDetect !== "function") {
      return;
    }
    const hasManualRanges = this.rows.some((row) => this.isRowFilled(row));
    if (
      hasManualRanges &&
      typeof globalThis.confirm === "function" &&
      !globalThis.confirm("自动划分将替换当前填写的页码范围，是否继续？")
    ) {
      return;
    }

    this.setAutoDetecting(true);
    this.setAutoStatus("正在准备目录识别……");
    try {
      const result = await this.onAutoDetect({
        onProgress: (message) => this.setAutoStatus(message),
        isCancelled: () => this.settled,
      });
      if (this.settled) {
        return;
      }
      const ranges = Array.isArray(result) ? result : result?.ranges;
      if (!Array.isArray(ranges) || ranges.length === 0) {
        throw new Error("自动划分没有返回可用的页码范围");
      }
      this.applyAutoRanges(ranges);
      const warnings = Array.isArray(result?.warnings) ? result.warnings : [];
      this.setAutoStatus(
        warnings.length > 0
          ? String(warnings[0])
          : `自动划分完成，已填入 ${ranges.length} 个部分。请检查后再开始处理。`,
        warnings.length > 0 ? "warning" : "success",
      );
    } catch (error) {
      console.error("PDF chapter auto split failed:", error);
      this.setAutoStatus(
        `自动划分失败：${error instanceof Error ? error.message : String(error)}`,
        "error",
      );
    } finally {
      if (!this.settled) {
        this.setAutoDetecting(false);
      }
    }
  }

  applyAutoRanges(ranges) {
    this.rows = ranges.map((range) => ({
      id: this.nextRowId++,
      start: String(range.start),
      end: String(range.end),
      startAuto: false,
      allowAutoFill: false,
      autoFilled: true,
      title: String(range.title || ""),
      type: String(range.type || ""),
      blockName: createDefaultPdfBlockName(range),
      blockNameAuto: true,
    }));
    this.suppressNextAutoFill = true;
    this.renderAllRows();
    this.reconcileRows();
    this.syncRowsAndValidation();
    this.rowsContainer.scrollTop = 0;
  }

  setAutoDetecting(value) {
    this.autoDetecting = Boolean(value);
    if (this.autoDetectButton) {
      this.autoDetectButton.disabled = this.autoDetecting;
      this.autoDetectButton.setText(
        this.autoDetecting ? "正在自动划分……" : "根据目录自动按章节划分",
      );
    }
    if (this.cancelButton) {
      this.cancelButton.disabled = this.autoDetecting;
    }
    for (const elements of this.rowElements.values()) {
      elements.startInput.disabled = this.autoDetecting;
      elements.endInput.disabled = this.autoDetecting;
      elements.blockNameInput.disabled = this.autoDetecting || this.mergeOutput;
      elements.deleteButton.disabled = this.autoDetecting || elements.deleteButton.hidden;
    }
    if (this.startButton) {
      this.startButton.disabled = this.autoDetecting || !this.currentRanges;
    }
  }

  setAutoStatus(message, state = "working") {
    if (!this.autoStatusEl || this.settled) {
      return;
    }
    this.autoStatusEl.setText(String(message || ""));
    this.autoStatusEl.removeClass("is-success");
    this.autoStatusEl.removeClass("is-warning");
    this.autoStatusEl.removeClass("is-error");
    if (state !== "working") {
      this.autoStatusEl.addClass(`is-${state}`);
    }
  }

  jumpToPdfPage(value, options = {}) {
    const page = Number(value);
    if (!Number.isInteger(page) || page < 1 || page > this.pageCount) {
      return;
    }
    const pageEl = this.pdfPageElements.get(page);
    if (pageEl) {
      this.setCurrentPreviewPage(page);
      void this.renderPdfPage(page);
      this.previewCanvasHost.scrollTo({
        top: Math.max(0, pageEl.offsetTop - 12),
        behavior: options.behavior || "smooth",
      });
      return;
    }
    if (!this.previewFrame) {
      this.pendingPreviewPage = page;
      this.setPreviewStatus(`PDF 加载完成后将定位到第 ${page} 页……`);
      return;
    }
    const replacement = this.previewFrame.cloneNode(false);
    replacement.setAttribute("src", `${this.resourceUrl.split("#")[0]}#page=${page}`);
    replacement.setAttribute("title", `PDF 预览：${this.pdfFile.name}，第 ${page} 页`);
    replacement.addEventListener("load", () => {
      if (this.previewFrame === replacement) {
        this.setAutoStatus(`左侧已定位到 PDF 第 ${page} 页。`, "success");
      }
    }, { once: true });
    this.previewFrame.replaceWith(replacement);
    this.previewFrame = replacement;
    this.setAutoStatus(`正在重新加载左侧预览并定位到 PDF 第 ${page} 页……`);
  }

  onClose() {
    this.previewPageObserver?.disconnect?.();
    if (this.previewScrollHandler && this.previewCanvasHost) {
      this.previewCanvasHost.removeEventListener("scroll", this.previewScrollHandler);
    }
    const ownerWindow = this.previewCanvasHost?.ownerDocument?.defaultView || globalThis;
    if (this.previewScrollFrame !== undefined) {
      ownerWindow.cancelAnimationFrame?.(this.previewScrollFrame);
    }
    if (this.previewZoomTimer !== undefined) {
      ownerWindow.clearTimeout(this.previewZoomTimer);
    }
    for (const renderTask of this.pdfRenderTasks.values()) {
      renderTask.cancel?.();
    }
    this.pdfRenderTasks.clear();
    this.pdfRenderPromises.clear();
    this.renderedPdfPages.clear();
    const cleanup = this.pdfPreviewDocument?.destroy?.() || this.pdfLoadingTask?.destroy?.();
    if (cleanup?.catch) {
      void cleanup.catch(() => {});
    }
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveResult(null);
    }
  }

  finish(result) {
    if (this.settled) {
      return;
    }
    this.settled = true;
    this.resolveResult(result);
    this.close();
  }
}
