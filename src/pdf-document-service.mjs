import { PDFDocument } from "pdf-lib";

export class PdfDocumentService {
  constructor() {
    this.sourceDocument = null;
    this.sourceBytes = null;
  }

  async load(arrayBuffer) {
    this.sourceBytes = this.toExactArrayBuffer(arrayBuffer);
    this.sourceDocument = await PDFDocument.load(new Uint8Array(this.sourceBytes), {
      updateMetadata: false,
    });
    return this.sourceDocument.getPageCount();
  }

  async createSegments(ranges) {
    if (!this.sourceDocument || !this.sourceBytes) {
      throw new Error("必须先读取 PDF，才能创建分页片段。");
    }

    const pageCount = this.sourceDocument.getPageCount();
    const segments = [];
    for (const range of ranges) {
      if (range.start === 1 && range.end === pageCount) {
        segments.push({ ...range, arrayBuffer: this.sourceBytes, isWholeDocument: true });
        continue;
      }

      const output = await PDFDocument.create();
      const indexes = Array.from(
        { length: range.end - range.start + 1 },
        (_unused, offset) => range.start - 1 + offset,
      );
      const pages = await output.copyPages(this.sourceDocument, indexes);
      for (const page of pages) {
        output.addPage(page);
      }
      const bytes = await output.save();
      segments.push({
        ...range,
        arrayBuffer: this.toExactArrayBuffer(bytes),
        isWholeDocument: false,
      });
    }
    return segments;
  }

  toExactArrayBuffer(value) {
    if (value instanceof ArrayBuffer) {
      return value.slice(0);
    }
    if (ArrayBuffer.isView(value)) {
      return value.buffer.slice(value.byteOffset, value.byteOffset + value.byteLength);
    }
    throw new Error("PDF 数据格式无效。");
  }
}
