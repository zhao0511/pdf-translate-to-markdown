import { Modal } from "obsidian";

import {
  PDF_MAX_PAGES_PER_PART,
  countSelectedPages,
  createNextPdfRangeDraft,
  shouldAutoFillPdfRangeEnd,
  validatePdfRanges,
} from "./pdf-range-utils.mjs";

export class PdfRangeModal extends Modal {
  constructor(app, pdfFile, pageCount) {
    super(app);
    this.pdfFile = pdfFile;
    this.pageCount = pageCount;
    this.settled = false;
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
    const resourceUrl = this.app.vault.getResourcePath(this.pdfFile);
    preview.createEl("iframe", {
      attr: {
        src: resourceUrl,
        title: `PDF 预览：${this.pdfFile.name}`,
      },
    });
    const fallback = preview.createEl("p", { cls: "pdf-translate-range-preview-fallback" });
    fallback.appendText("预览无法显示时，可");
    fallback.createEl("a", {
      text: "在新窗口打开 PDF",
      attr: { href: resourceUrl, target: "_blank", rel: "noopener noreferrer" },
    });
    fallback.appendText("。");
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

    const header = sidebar.createDiv({ cls: "pdf-translate-range-row-header" });
    header.createSpan({ text: "起始页" });
    header.createSpan({ text: "" });
    header.createSpan({ text: "结束页" });
    header.createSpan({ text: "" });

    this.rowsContainer = sidebar.createDiv({ cls: "pdf-translate-range-rows" });
    this.statusEl = sidebar.createDiv({ cls: "pdf-translate-range-status" });
    const buttonRow = sidebar.createDiv({ cls: "pdf-translate-range-buttons" });
    const cancelButton = buttonRow.createEl("button", { text: "取消" });
    this.startButton = buttonRow.createEl("button", {
      text: "开始并行处理",
      cls: "mod-cta",
    });

    cancelButton.addEventListener("click", () => this.finish(null));
    this.startButton.addEventListener("click", () => {
      if (this.currentRanges) {
        this.finish(this.currentRanges);
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
        type: "number",
        min: "1",
        max: String(this.pageCount),
        step: "1",
        inputmode: "numeric",
        "aria-label": "起始页",
      },
    });
    const separator = rowEl.createSpan({ text: "–", cls: "pdf-translate-range-separator" });
    const endInput = rowEl.createEl("input", {
      cls: "pdf-translate-range-number",
      attr: {
        type: "number",
        min: "1",
        max: String(this.pageCount),
        step: "1",
        inputmode: "numeric",
        "aria-label": "结束页",
        placeholder: "填写",
      },
    });
    const deleteButton = rowEl.createEl("button", {
      text: "删除",
      cls: "pdf-translate-range-delete",
      attr: { type: "button", "aria-label": "删除这一部分" },
    });

    startInput.addEventListener("input", () => {
      row.start = startInput.value;
      row.startAuto = false;
      row.allowAutoFill = true;
      this.handleRowInput(row, "start");
    });
    endInput.addEventListener("input", () => {
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
    deleteButton.addEventListener("click", () => this.deleteRow(row));

    this.rowElements.set(row.id, {
      rowEl,
      startInput,
      separator,
      endInput,
      deleteButton,
    });
    this.updateRowElement(row);
  }

  handleRowInput(row, field) {
    const activeInput = this.rowElements.get(row.id)?.[`${field}Input`];
    this.reconcileRows();
    this.syncRowsAndValidation(activeInput);
  }

  reconcileRows() {
    let changed = true;
    while (changed) {
      changed = false;
      const last = this.rows.at(-1);
      if (!last) {
        const allowAutoFill = !this.suppressNextAutoFill;
        this.suppressNextAutoFill = false;
        this.rows.push(this.createPendingRow(1, { allowAutoFill }));
        changed = true;
        continue;
      }

      const previous = this.rows.at(-2);
      if (!this.isRowFilled(last)) {
        if (last.startAuto && previous && this.isRowFilled(previous)) {
          const nextStart = Number(previous.end) + 1;
          if (Number.isInteger(nextStart) && nextStart > 0) {
            last.start = String(nextStart);
          }
        }

        if (this.shouldAutoFillLastPage(last)) {
          last.end = String(this.pageCount);
          last.autoFilled = true;
          changed = true;
        }
        continue;
      }

      const start = Number(last.start);
      const end = Number(last.end);
      if (
        Number.isInteger(start) &&
        Number.isInteger(end) &&
        start >= 1 &&
        start <= end &&
        end < this.pageCount &&
        end - start + 1 <= PDF_MAX_PAGES_PER_PART
      ) {
        const allowAutoFill = !this.suppressNextAutoFill;
        this.suppressNextAutoFill = false;
        const draft = createNextPdfRangeDraft(end, this.pageCount, { allowAutoFill });
        if (!draft) {
          continue;
        }
        const nextRow = this.createPendingRow(draft.start, { allowAutoFill });
        if (draft.end !== null) {
          nextRow.end = String(draft.end);
          nextRow.autoFilled = true;
        }
        this.rows.push(nextRow);
        changed = true;
      }
    }
  }

  shouldAutoFillLastPage(row) {
    if (!row.allowAutoFill || row.end !== "") {
      return false;
    }
    return shouldAutoFillPdfRangeEnd(Number(row.start), this.pageCount);
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
    const liveIds = new Set(this.rows.map((row) => row.id));
    for (const [rowId, elements] of this.rowElements) {
      if (!liveIds.has(rowId)) {
        elements.rowEl.remove();
        this.rowElements.delete(rowId);
      }
    }
    for (const row of this.rows) {
      if (!this.rowElements.has(row.id)) {
        this.appendRowElement(row);
      }
      this.updateRowElement(row, activeInput);
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
    elements.rowEl.toggleClass("is-pending", !filled);
    elements.rowEl.toggleClass("is-autofilled", Boolean(row.autoFilled));
    elements.deleteButton.hidden = !filled;
    elements.deleteButton.disabled = !filled;
  }

  updateValidation() {
    const completedRows = this.rows.filter((row) => this.isRowFilled(row));
    const incompleteNonTrailing = this.rows.some(
      (row, index) => !this.isRowFilled(row) && index !== this.rows.length - 1,
    );

    if (completedRows.length === 0 && !incompleteNonTrailing) {
      this.currentRanges = null;
      this.statusEl.setText("请填写第一部分的结束页。");
      this.statusEl.removeClass("is-valid");
      this.statusEl.removeClass("is-error");
      this.startButton.disabled = true;
      return;
    }

    try {
      if (incompleteNonTrailing) {
        throw new Error("请先补完中间未填写的页码范围，或删除该行。");
      }
      const ranges = validatePdfRanges(
        completedRows.map((row) => ({ start: Number(row.start), end: Number(row.end) })),
        this.pageCount,
      );
      this.currentRanges = ranges;
      const selectedPages = countSelectedPages(ranges);
      const hasPendingRow = this.rows.some((row) => !this.isRowFilled(row));
      this.statusEl.setText(
        `已填写 ${ranges.length} 部分，共 ${selectedPages}/${this.pageCount} 页。${
          hasPendingRow ? "灰色待填行不会参与处理。" : ""
        }`,
      );
      this.statusEl.removeClass("is-error");
      this.statusEl.addClass("is-valid");
      this.startButton.disabled = false;
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

  onClose() {
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
