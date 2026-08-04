import { Mistral } from "@mistralai/mistralai";

export class MistralOcrService {
  constructor(settings, clientFactory = (apiKey) => new Mistral({ apiKey })) {
    this.settings = settings;
    this.clientFactory = clientFactory;
  }

  async processPdf(arrayBuffer, fileName, callbacks = {}) {
    const client = this.clientFactory(this.settings.mistralApiKey.trim());
    let uploadedFileId;

    try {
      callbacks.onStage?.(2, "上传至 Mistral");
      const upload = await client.files.upload({
        file: this.createUploadFile(arrayBuffer, fileName),
        purpose: "ocr",
      });

      if (!upload?.id) {
        throw new Error("Mistral 没有返回上传文件 ID");
      }
      uploadedFileId = upload.id;

      const signedUrl = await client.files.getSignedUrl({
        fileId: uploadedFileId,
        expiry: 1,
      });
      if (!signedUrl?.url) {
        throw new Error("Mistral 没有返回文件签名地址");
      }

      callbacks.onStage?.(3, "Mistral OCR 中");
      const imageLimit = this.positiveIntegerOrUndefined(this.settings.imageLimit);
      const imageMinSize = this.positiveIntegerOrUndefined(this.settings.imageMinSize);
      const response = await client.ocr.process({
        model: this.settings.mistralModel.trim() || "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl: signedUrl.url,
        },
        includeImageBase64: Boolean(this.settings.extractImages),
        imageLimit,
        imageMinSize,
        includeBlocks: false,
      });

      if (!Array.isArray(response?.pages) || response.pages.length === 0) {
        throw new Error("Mistral OCR 没有返回页面内容");
      }
      return response;
    } finally {
      if (this.settings.deleteMistralFile && uploadedFileId) {
        try {
          const deletion = await client.files.delete({ fileId: uploadedFileId });
          if (!deletion?.deleted) {
            callbacks.onWarning?.("Mistral 返回了未删除状态，远程临时文件可能仍然存在。");
          }
        } catch (error) {
          callbacks.onWarning?.(`无法删除 Mistral 远程临时文件：${this.errorMessage(error)}`);
        }
      }
    }
  }

  createUploadFile(arrayBuffer, fileName) {
    if (typeof File !== "undefined") {
      return new File([arrayBuffer], fileName, { type: "application/pdf" });
    }
    const blob = new Blob([arrayBuffer], { type: "application/pdf" });
    blob.name = fileName;
    return blob;
  }

  positiveIntegerOrUndefined(value) {
    const number = Math.floor(Number(value));
    return Number.isFinite(number) && number > 0 ? number : undefined;
  }

  errorMessage(error) {
    return error instanceof Error && error.message ? error.message : String(error || "未知错误");
  }
}
