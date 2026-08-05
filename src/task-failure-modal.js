import { Modal } from "obsidian";

export class TaskFailureModal extends Modal {
  constructor(app, summary, details = [], options = {}) {
    super(app);
    this.summary = summary;
    this.details = details;
    this.options = options;
    this.settled = false;
    this.resultPromise = new Promise((resolve) => {
      this.resolveResult = resolve;
    });
  }

  waitForResult() {
    this.open();
    return this.resultPromise;
  }

  onOpen() {
    this.modalEl.addClass("pdf-translate-failure-modal");
    this.setTitle("PDF 处理未完成");
    this.contentEl.empty();
    this.contentEl.createEl("p", { text: this.summary });
    this.contentEl.createEl("p", {
      text:
        this.options.retryDescription ||
        "重试会保留已经完成的上传、OCR、图片和翻译结果，只继续未成功的步骤。",
    });
    this.contentEl.createEl("p", {
      text:
        this.options.abandonDescription ||
        "放弃会删除本次任务创建的图片，并清理尚存的 Mistral 临时文件。关闭此窗口也视为放弃。",
      cls: "pdf-translate-failure-warning",
    });

    if (this.details.length > 0) {
      const details = this.contentEl.createEl("details");
      details.createEl("summary", { text: "查看错误详情" });
      const list = details.createEl("ul");
      for (const detail of this.details) {
        list.createEl("li", { text: detail });
      }
    }

    const buttons = this.contentEl.createDiv({ cls: "pdf-translate-failure-buttons" });
    const abandonButton = buttons.createEl("button", { text: "放弃" });
    const retryButton = buttons.createEl("button", { text: "重试", cls: "mod-cta" });
    abandonButton.addEventListener("click", () => this.finish("abandon"));
    retryButton.addEventListener("click", () => this.finish("retry"));
  }

  onClose() {
    this.contentEl.empty();
    if (!this.settled) {
      this.settled = true;
      this.resolveResult("abandon");
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
