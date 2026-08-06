import assert from "node:assert/strict";
import { strToU8, zipSync } from "fflate";
import { MinerUOcrService } from "../src/mineru-ocr-service.mjs";

const png = new Uint8Array(24);
png.set([137, 80, 78, 71, 13, 10, 26, 10]);
const pngView = new DataView(png.buffer);
pngView.setUint32(16, 100);
pngView.setUint32(20, 80);

const zipBytes = zipSync({
  "result/full.md": strToU8("# Title\n\n![figure](images/hash.png)\n"),
  "result/paper_middle.json": strToU8(
    JSON.stringify({ pdf_info: [{ page_idx: 0 }, { page_idx: 1 }] }),
  ),
  "result/paper_content_list.json": strToU8(
    JSON.stringify([
      { type: "title", text: "Contents", text_level: 1, page_idx: 0 },
      { type: "text", text: "Chapter 1 ........ 1", page_idx: 0 },
      { type: "image", img_path: "images/hash.png", page_idx: 1 },
    ]),
  ),
  "result/images/hash.png": png,
});

const calls = [];
let pollCount = 0;
const requestFn = async (request) => {
  calls.push(request);
  if (request.url.endsWith("/extract/task/00000000-0000-0000-0000-000000000000")) {
    return { status: 200, json: { code: -60003, msg: "task not found" }, text: "" };
  }
  if (request.url.endsWith("/file-urls/batch")) {
    return {
      status: 200,
      json: {
        code: 0,
        data: { batch_id: "batch-1", file_urls: ["https://upload.example/signed"] },
      },
      text: "",
    };
  }
  if (request.url === "https://upload.example/signed") {
    return { status: 200, json: null, text: "" };
  }
  if (request.url.endsWith("/extract-results/batch/batch-1")) {
    pollCount += 1;
    return {
      status: 200,
      json: {
        code: 0,
        data: {
          extract_result: [
            pollCount === 1
              ? {
                  state: "running",
                  extract_progress: { extracted_pages: 1, total_pages: 2 },
                }
              : { state: "done", full_zip_url: "https://download.example/result.zip" },
          ],
        },
      },
      text: "",
    };
  }
  if (request.url === "https://download.example/result.zip") {
    return {
      status: 200,
      arrayBuffer: zipBytes.buffer.slice(
        zipBytes.byteOffset,
        zipBytes.byteOffset + zipBytes.byteLength,
      ),
      text: "",
    };
  }
  throw new Error(`Unexpected request: ${request.method} ${request.url}`);
};

const settings = {
  mineruApiKey: "mineru-test-token",
  mineruBaseUrl: "https://mineru.net/api/v4",
  mineruModelVersion: "vlm",
  mineruLanguage: "en",
  mineruForceOcr: true,
  mineruEnableFormula: true,
  mineruEnableTable: true,
  mineruPollIntervalSeconds: 1,
  mineruTimeoutMinutes: 1,
  extractImages: true,
  imageLimit: 0,
  imageMinSize: 16,
};
const service = new MinerUOcrService(settings, requestFn);
service.wait = async () => {};

assert.equal(await service.checkConnection(), true);
const uploaded = await service.uploadPdf(new Uint8Array([1, 2, 3]).buffer, "paper.pdf");
assert.deepEqual(uploaded, { fileId: "batch-1", url: "batch-1" });

const uploadRequest = calls.find((call) => call.url.endsWith("/file-urls/batch"));
const uploadBody = JSON.parse(uploadRequest.body);
assert.equal(uploadBody.model_version, "vlm");
assert.equal(uploadBody.language, "en");
assert.equal(uploadBody.enable_formula, true);
assert.equal(uploadBody.enable_table, true);
assert.equal(uploadBody.files[0].is_ocr, true);
assert.match(uploadRequest.headers.Authorization, /^Bearer /);

const statuses = [];
const response = await service.processOcr(uploaded.url, {
  onProgress: (status) => statuses.push(status),
});
assert.equal(response.provider, "mineru");
assert.equal(response.pageCount, 2);
assert.equal(response.pages.length, 1);
assert.equal(response.analysisPages.length, 2);
assert.match(response.analysisPages[0].markdown, /Chapter 1/);
assert.match(response.pages[0].markdown, /Title/);
assert.equal(response.pages[0].images.length, 1);
assert.equal(response.pages[0].images[0].id, "hash.png");
assert.equal(response.pages[0].images[0].pageIndex, 1);
assert.match(response.pages[0].images[0].imageBase64, /^data:image\/png;base64,/);
assert.equal(statuses[0].extractedPages, 1);

const invalidService = new MinerUOcrService(settings, async () => ({
  status: 200,
  json: { code: "A0202", msg: "Token 错误" },
  text: "",
}));
await assert.rejects(invalidService.checkConnection(), /Token 无效/);

let retryPostCount = 0;
let retryPutCount = 0;
const retryService = new MinerUOcrService(settings, async (request) => {
  if (request.url.endsWith("/file-urls/batch")) {
    retryPostCount += 1;
    return {
      status: 200,
      json: {
        code: 0,
        data: { batch_id: "batch-retry", file_urls: ["https://upload.example/retry"] },
      },
      text: "",
    };
  }
  if (request.url === "https://upload.example/retry") {
    retryPutCount += 1;
    return { status: retryPutCount === 1 ? 503 : 200, json: null, text: "" };
  }
  throw new Error(`Unexpected retry request: ${request.method} ${request.url}`);
});
await assert.rejects(
  retryService.uploadPdf(new Uint8Array([4, 5, 6]).buffer, "retry.pdf"),
  /HTTP 503/,
);
assert.deepEqual(
  await retryService.uploadPdf(new Uint8Array([4, 5, 6]).buffer, "retry.pdf"),
  { fileId: "batch-retry", url: "batch-retry" },
);
assert.equal(retryPostCount, 1, "upload retries should reuse the existing MinerU batch");
assert.equal(retryPutCount, 2);

console.log("MinerU service test passed");
