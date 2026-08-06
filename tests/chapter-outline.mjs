import assert from "node:assert/strict";

import {
  buildChapterOutlineRanges,
  buildPageMarkedMarkdown,
  chapterOutlineStatus,
  parseChapterOutlineResponse,
} from "../src/chapter-outline-utils.mjs";

const parsed = parseChapterOutlineResponse(`\`\`\`json
{
  "status": "ready",
  "pageMapping": { "pdfPage": 17, "printedPage": 1, "offset": 16 },
  "chapters": [
    { "number": 2, "title": "Divergence", "printedStartPage": 39 },
    { "number": 1, "title": "Entropy", "printedStartPage": 5 }
  ],
  "backMatter": { "title": "References", "printedStartPage": 95 }
}
\`\`\``);

assert.equal(chapterOutlineStatus(parsed), "ready");
assert.deepEqual(buildChapterOutlineRanges(parsed, 120), { ranges: [
  { start: 1, end: 20, type: "front_matter", title: "第一章之前的内容" },
  { start: 21, end: 54, type: "chapter", title: "Chapter 1 Entropy" },
  { start: 55, end: 110, type: "chapter", title: "Chapter 2 Divergence" },
  { start: 111, end: 120, type: "back_matter", title: "References" },
], warnings: [] });
assert.equal(chapterOutlineStatus({ status: "need_more" }), "need_more");
assert.deepEqual(
  buildChapterOutlineRanges(
    {
      status: "ready",
      pageMapping: { pdfPage: 11, printedPage: 1, offset: 10 },
      chapters: [{ number: 1, title: "Long chapter", printedStartPage: 1 }],
      backMatter: null,
    },
    120,
  ),
  {
    ranges: [
      { start: 1, end: 10, type: "front_matter", title: "第一章之前的内容" },
      { start: 11, end: 120, type: "chapter", title: "Chapter 1 Long chapter" },
    ],
    warnings: [],
  },
);
const missingChapter = buildChapterOutlineRanges(
  {
    status: "ready",
    pageMapping: { pdfPage: 11, printedPage: 1, offset: 10 },
    chapters: [
      { number: 1, title: "One", printedStartPage: 1 },
      { number: 3, title: "Three", printedStartPage: 20 },
    ],
  },
  120,
);
assert.deepEqual(missingChapter.warnings, []);
assert.deepEqual(missingChapter.ranges.map(({ start, end }) => ({ start, end })), [
  { start: 1, end: 10 },
  { start: 11, end: 29 },
  { start: 30, end: 120 },
]);

const duplicateChapter = buildChapterOutlineRanges(
  {
    status: "ready",
    pageMapping: { pdfPage: 11, printedPage: 1, offset: 10 },
    chapters: [
      { number: 1, title: "One", printedStartPage: 1 },
      { number: 1, title: "One again", printedStartPage: 20 },
    ],
  },
  120,
);
assert.deepEqual(duplicateChapter.warnings, []);
assert.deepEqual(duplicateChapter.ranges.map(({ start, end }) => ({ start, end })), [
  { start: 1, end: 10 },
  { start: 11, end: 120 },
]);

const truncated = buildChapterOutlineRanges(
  {
    status: "ready",
    pageMapping: { pdfPage: 11, printedPage: 1, offset: 10 },
    chapters: [
      { number: 1, title: "One", printedStartPage: 1 },
      { number: 2, title: "Two", printedStartPage: 40 },
      { number: 3, title: "Three", printedStartPage: 90 },
      { number: 4, title: "Four", printedStartPage: 140 },
    ],
    backMatter: { title: "Index", printedStartPage: 180 },
  },
  120,
);
assert.deepEqual(truncated.ranges.map(({ start, end }) => ({ start, end })), [
  { start: 1, end: 10 },
  { start: 11, end: 49 },
  { start: 50, end: 99 },
  { start: 100, end: 120 },
]);
assert.deepEqual(truncated.warnings, [
  "目录页码与当前 PDF 的实际页数存在不一致，请检查自动填写的分块范围。",
]);

const noExistingChapter = buildChapterOutlineRanges(
  {
    status: "ready",
    pageMapping: { pdfPage: 11, printedPage: 1, offset: 10 },
    chapters: [{ number: 1, title: "One", printedStartPage: 140 }],
    backMatter: { title: "Index", printedStartPage: 5 },
  },
  120,
);
assert.deepEqual(noExistingChapter.ranges.map(({ start, end }) => ({ start, end })), [
  { start: 1, end: 120 },
]);
assert.deepEqual(noExistingChapter.warnings, [
  "目录页码与当前 PDF 的实际页数存在不一致，请检查自动填写的分块范围。",
]);
assert.throws(
  () =>
    buildChapterOutlineRanges(
      {
        status: "ready",
        pageMapping: { pdfPage: 17, printedPage: 1, offset: 15 },
        chapters: [{ number: 1, title: "One", printedStartPage: 1 }],
      },
      120,
    ),
  /对应关系不一致/,
);
assert.match(
  buildPageMarkedMarkdown([
    { pdfPage: 2, markdown: "second" },
    { pdfPage: 1, markdown: "first" },
  ]),
  /^--- PDF_PAGE: 1 ---\nfirst\n\n--- PDF_PAGE: 2 ---\nsecond$/,
);

console.log("Chapter outline utilities test passed");
