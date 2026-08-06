import { Mistral } from "@mistralai/mistralai";

export class MistralOcrService {
  constructor(settings, clientFactory = (apiKey) => new Mistral({ apiKey })) {
    this.settings = settings;
    this.clientFactory = clientFactory;
    this.providerId = "mistral";
    this.providerName = "Mistral";
    this.supportsRemoteDelete = true;
  }

  async processPdf(arrayBuffer, fileName, callbacks = {}) {
    let uploadedFileId;

    try {
      callbacks.onStage?.(2, "上传至 Mistral");
      const uploaded = await this.uploadPdf(arrayBuffer, fileName);
      uploadedFileId = uploaded.fileId;

      callbacks.onStage?.(3, "Mistral OCR 中");
      return await this.processOcr(uploaded.url);
    } catch (error) {
      uploadedFileId = uploadedFileId || error?.uploadedFileId;
      throw error;
    } finally {
      if (this.settings.deleteMistralFile && uploadedFileId) {
        try {
          const deletion = await this.deleteFile(uploadedFileId);
          if (!deletion?.deleted) {
            callbacks.onWarning?.("Mistral 返回了未删除状态，远程临时文件可能仍然存在。");
          }
        } catch (error) {
          callbacks.onWarning?.(`无法删除 Mistral 远程临时文件：${this.errorMessage(error)}`);
        }
      }
    }
  }

  async uploadPdf(arrayBuffer, fileName) {
    const client = this.createClient();
    let uploadedFileId;
    try {
      const upload = await client.files.upload({
        file: this.createUploadFile(arrayBuffer, fileName),
        purpose: "ocr",
      });
      if (!upload?.id) {
        throw new Error("Mistral 没有返回上传文件 ID");
      }
      uploadedFileId = upload.id;
      const url = await this.getSignedUrl(uploadedFileId, client);
      return { fileId: uploadedFileId, url };
    } catch (error) {
      const wrapped = this.wrapApiError(error);
      wrapped.uploadedFileId = uploadedFileId;
      throw wrapped;
    }
  }

  async getSignedUrl(fileId, existingClient = null) {
    const client = existingClient || this.createClient();
    const signedUrl = await client.files.getSignedUrl({
      fileId,
      expiry: 1,
    });
    if (!signedUrl?.url) {
      throw new Error("Mistral 没有返回文件签名地址");
    }
    return signedUrl.url;
  }

  async processOcr(documentUrl) {
    const client = this.createClient();
    const imageLimit = this.positiveIntegerOrUndefined(this.settings.imageLimit);
    const imageMinSize = this.positiveIntegerOrUndefined(this.settings.imageMinSize);
    let response;
    try {
      response = await client.ocr.process({
        model: this.settings.mistralModel.trim() || "mistral-ocr-latest",
        document: {
          type: "document_url",
          documentUrl,
        },
        includeImageBase64: Boolean(this.settings.extractImages),
        imageLimit,
        imageMinSize,
        extractHeader: this.settings.mistralKeepHeadersFooters === false,
        extractFooter: this.settings.mistralKeepHeadersFooters === false,
        includeBlocks: false,
      });
    } catch (error) {
      throw this.wrapApiError(error);
    }
    if (!Array.isArray(response?.pages) || response.pages.length === 0) {
      throw new Error("Mistral OCR 没有返回页面内容");
    }
    return response;
  }

  async deleteFile(fileId) {
    return this.createClient().files.delete({ fileId });
  }

  async checkConnection() {
    let response;
    try {
      response = await this.createClient().models.list();
    } catch (error) {
      throw this.wrapApiError(error);
    }
    if (!response || !Array.isArray(response.data)) {
      throw new Error("Mistral 模型列表响应无效");
    }
    const configuredModel = this.settings.mistralModel.trim() || "mistral-ocr-latest";
    if (
      response.data.length > 0 &&
      !response.data.some(
        (model) =>
          model?.id === configuredModel ||
          (Array.isArray(model?.aliases) && model.aliases.includes(configuredModel)),
      )
    ) {
      throw new Error(`Mistral 当前账户不可用模型：${configuredModel}`);
    }
    return true;
  }

  createClient() {
    return this.clientFactory(this.settings.mistralApiKey.trim());
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

  wrapApiError(error) {
    if (error?.mistralQuotaHint) {
      return error;
    }
    const originalMessage = this.errorMessage(error);
    const quotaLikely = /(?:status\s*402|http\s*402|\b402\b|check your subscription)/i.test(
      originalMessage,
    );
    const message = quotaLikely
      ? `Mistral API 返回 HTTP 402，可能是额度已用完或订阅不可用。请前往 https://admin.mistral.ai/subscription 检查订阅与用量。原始错误：${originalMessage}`
      : originalMessage;
    const wrapped = new Error(message);
    wrapped.cause = error;
    if (quotaLikely) {
      wrapped.status = 402;
      wrapped.mistralQuotaHint = true;
    }
    return wrapped;
  }
}
