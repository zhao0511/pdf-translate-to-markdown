import assert from "node:assert/strict";
import { MistralOcrService } from "../src/mistral-ocr-service.mjs";

const calls = [];
const client = {
  files: {
    async upload(input) {
      calls.push(["upload", input]);
      return { id: "remote-file" };
    },
    async getSignedUrl(input) {
      calls.push(["signed-url", input]);
      return { url: "https://example.invalid/signed.pdf" };
    },
    async delete(input) {
      calls.push(["delete", input]);
      return { deleted: true };
    },
  },
  ocr: {
    async process(input) {
      calls.push(["ocr", input]);
      return { pages: [{ index: 0, markdown: "page", images: [] }] };
    },
  },
};

const settings = {
  mistralApiKey: "test-key",
  mistralModel: "mistral-ocr-latest",
  extractImages: true,
  imageLimit: 0,
  imageMinSize: 16,
  deleteMistralFile: true,
};
const stages = [];
const service = new MistralOcrService(settings, (apiKey) => {
  assert.equal(apiKey, "test-key");
  return client;
});

const response = await service.processPdf(new Uint8Array([1, 2, 3]).buffer, "paper.pdf", {
  onStage: (phase, label) => stages.push([phase, label]),
});

assert.equal(response.pages.length, 1);
assert.deepEqual(calls.map(([name]) => name), ["upload", "signed-url", "ocr", "delete"]);
assert.equal(calls[0][1].purpose, "ocr");
assert.deepEqual(calls[1][1], { fileId: "remote-file", expiry: 1 });
assert.deepEqual(calls[3][1], { fileId: "remote-file" });
assert.deepEqual(stages.map(([phase]) => phase), [2, 3]);

const ocrInput = calls[2][1];
assert.equal(ocrInput.model, "mistral-ocr-latest");
assert.equal(ocrInput.document.type, "document_url");
assert.equal(ocrInput.includeImageBase64, true);
assert.equal(ocrInput.imageLimit, undefined);
assert.equal(ocrInput.imageMinSize, 16);
assert.equal(ocrInput.includeBlocks, false);

console.log("Mistral service test passed");
