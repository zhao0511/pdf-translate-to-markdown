import assert from "node:assert/strict";
import { PDFDocument } from "pdf-lib";

import { PdfDocumentService } from "../src/pdf-document-service.mjs";
import {
  countSelectedPages,
  createNextPdfRangeDraft,
  createDefaultPdfRanges,
  mergeMarkdownParts,
  parsePdfRangeRules,
  shouldAutoFillPdfRangeEnd,
  validatePdfRanges,
} from "../src/pdf-range-utils.mjs";

assert.deepEqual(parsePdfRangeRules("101-150\n1 - 50，60"), [
  { start: 101, end: 150 },
  { start: 1, end: 50 },
  { start: 60, end: 60 },
]);

const normalized = validatePdfRanges(parsePdfRangeRules("101-150\n1-50\n60"), 230);
assert.deepEqual(normalized, [
  { start: 1, end: 50 },
  { start: 60, end: 60 },
  { start: 101, end: 150 },
]);
assert.equal(countSelectedPages(normalized), 101);
assert.deepEqual(createDefaultPdfRanges(230), [
  { start: 1, end: 100 },
  { start: 101, end: 200 },
  { start: 201, end: 230 },
]);

assert.throws(() => validatePdfRanges(parsePdfRangeRules("1-101"), 230), /最多 100 页/);
assert.throws(() => validatePdfRanges(parsePdfRangeRules("1-50\n50-70"), 230), /存在重叠/);
assert.throws(() => validatePdfRanges(parsePdfRangeRules("220-240"), 230), /超出 PDF 页码范围/);
assert.throws(() => parsePdfRangeRules("第一章"), /无法识别/);

assert.deepEqual(createNextPdfRangeDraft(60, 120), { start: 61, end: null });
assert.deepEqual(createNextPdfRangeDraft(60, 100), { start: 61, end: 100 });
assert.deepEqual(createNextPdfRangeDraft(60, 100, { allowAutoFill: false }), {
  start: 61,
  end: null,
});
assert.equal(createNextPdfRangeDraft(100, 100), null);
assert.equal(shouldAutoFillPdfRangeEnd(52, 100), true);
assert.equal(shouldAutoFillPdfRangeEnd(51, 100), false);

assert.equal(mergeMarkdownParts(["first\n", "\nsecond"]), "first\n\nsecond\n");
assert.equal(
  mergeMarkdownParts(["first\n", "\nsecond"], "\n\n---\n\n"),
  "first\n\n---\n\nsecond\n",
);
assert.equal(mergeMarkdownParts(["  indented code\n", "next"]), "  indented code\n\nnext\n");

const source = await PDFDocument.create();
for (let index = 0; index < 230; index += 1) {
  source.addPage([300, 400]);
}
const sourceBytes = await source.save();

const service = new PdfDocumentService();
assert.equal(await service.load(sourceBytes), 230);
const segments = await service.createSegments([
  { start: 1, end: 100 },
  { start: 101, end: 170 },
  { start: 200, end: 230 },
]);
assert.equal(segments.length, 3);

const segmentPageCounts = [];
for (const segment of segments) {
  const document = await PDFDocument.load(segment.arrayBuffer);
  segmentPageCounts.push(document.getPageCount());
}
assert.deepEqual(segmentPageCounts, [100, 70, 31]);

console.log("PDF range utilities test passed");
