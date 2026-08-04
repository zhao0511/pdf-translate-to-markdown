import { Notice } from "obsidian";

export class TaskProgress {
  constructor(fileName, totalPhases, taskLabel) {
    this.fileName = fileName;
    this.totalPhases = totalPhases;
    this.taskLabel = taskLabel;
    this.phase = 1;
    this.phaseLabel = "准备中";
    this.phaseStartedAt = Date.now();
    this.dotFrame = 0;
    this.notice = new Notice(this.getMessage(), 0);
    this.timer = globalThis.setInterval(() => this.render(), 750);
  }

  setPhase(phase, label) {
    this.phase = phase;
    this.phaseLabel = label;
    this.phaseStartedAt = Date.now();
    this.dotFrame = 0;
    this.render();
  }

  update(label) {
    this.phaseLabel = label;
    this.render();
  }

  render() {
    if (!this.notice) {
      return;
    }
    this.notice.setMessage(this.getMessage());
    this.dotFrame += 1;
  }

  getMessage() {
    const dots = ".".repeat((this.dotFrame % 3) + 1);
    const elapsed = this.formatElapsed(Date.now() - this.phaseStartedAt);
    return `${this.phaseLabel}${dots}（${elapsed}）`;
  }

  formatElapsed(milliseconds) {
    const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = String(totalSeconds % 60).padStart(2, "0");
    return `${minutes}:${seconds}`;
  }

  complete(message) {
    this.dispose();
    new Notice(message, 6000);
  }

  fail(message) {
    this.dispose();
    new Notice(`处理失败：${message}`, 12000);
  }

  dispose() {
    if (this.timer !== undefined) {
      globalThis.clearInterval(this.timer);
      this.timer = undefined;
    }
    if (this.notice) {
      this.notice.hide();
      this.notice = null;
    }
  }
}
