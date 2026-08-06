# Pdf translate to markdown

一个在 Obsidian 中完成 PDF 转 Markdown 和文档翻译的插件。

插件支持 Mistral OCR 与 MinerU 精准解析，可以把 PDF 转换为 Markdown、保存文档图片，并使用 DeepSeek 翻译为中文。也可以直接翻译 Vault 中已有的 Markdown 文件。

## 主要功能

- **PDF 转为 Markdown 并翻译**：解析 PDF 后自动生成中文 Markdown。
- **仅将 PDF 转为 Markdown**：只转换文档，不调用 DeepSeek。
- **翻译 Markdown**：直接翻译已有的 Markdown 文件。
- 支持 Mistral OCR 和 MinerU 精准解析，并可为两个 PDF 功能分别选择服务。
- 长 PDF 支持手动选择页码范围，也可以根据目录自动按章节划分。
- 多个分块可以并行处理，译文既可按原顺序合并，也可按块分别保存。
- 图片自动保存到 Obsidian 配置的默认附件目录，并避免重名。
- 任务失败时可以重试，并保留已经完成的步骤。
- 可选择将结果保存到 PDF 原目录，或放入 PDF 同名子文件夹。
- 生成的文件会在 Obsidian 主文件区的新标签页中打开。
- 支持调试记录、版本检查和插件内更新。

## 安装

### Windows 安装向导（推荐）

1. 打开 [Releases](https://github.com/zhao0511/pdf-translate-to-markdown/releases)。
2. 下载最新版的 `PdfTranslateToMarkdown-Setup.exe`。
3. 打开安装向导，选择 Obsidian Vault 根目录。
4. 安装完成后重新加载 Obsidian。
5. 在“设置 → 第三方插件”中启用 **Pdf translate to markdown**。

安装或更新不会删除现有插件设置。

### 手动安装

从 [Releases](https://github.com/zhao0511/pdf-translate-to-markdown/releases) 下载以下文件：

- `main.js`
- `manifest.json`
- `styles.css`

把它们放入：

```text
<Vault>/.obsidian/plugins/pdf-translate-to-markdown/
```

然后重新加载 Obsidian 并启用插件。

## 配置 API

打开“设置 → Pdf translate to markdown”，填写需要使用的 API 密钥。

### DeepSeek

- [创建 API 密钥](https://platform.deepseek.com/api_keys)
- [查看使用量](https://platform.deepseek.com/usage)

DeepSeek 用于 PDF 翻译和 Markdown 翻译。

### Mistral

- [创建 API 密钥](https://admin.mistral.ai/organization/api-keys)
- [查看订阅与用量](https://admin.mistral.ai/subscription)
- [查看当前 API 限额](https://admin.mistral.ai/plateforme/limits)

### MinerU

- [创建 Token 和查看使用情况](https://mineru.net/apiManage/token)

API 密钥会优先保存到 Obsidian Secret Storage，不会读取其他插件的密钥。

## 使用方法

### PDF 转为 Markdown 并翻译

在文件列表中右键 PDF，选择“转为 Markdown 并翻译”。

短 PDF 会直接处理；长 PDF 会先打开分块页面，可以手动选择范围，也可以让插件根据目录按章节划分。分块译文可以合并为一个文件，也可以使用自定义块名分别保存到译文文件夹中；设置里可以选择分块文件名是否添加序号。是否同时保留原文 Markdown 可以在设置中选择。

### 仅将 PDF 转为 Markdown

在文件列表中右键 PDF，选择“仅转为 Markdown”。

插件会自动分块、解析并合并结果，不会调用 DeepSeek。默认输出文件名为 `原文件名_OCR.md`，可以在设置中修改。

### 翻译 Markdown

在文件列表中右键 Markdown 文件，选择“翻译”。

译文默认保存在同一文件夹，并使用 `_翻译` 后缀。该功能拥有独立的 DeepSeek 模型、参数、输出后缀和提示词设置。

## 设置

三个主要功能分别位于默认折叠的设置区中：

1. PDF 转为 Markdown 并翻译
2. 翻译 Markdown
3. 仅将 PDF 转为 Markdown

每个功能的设置互相独立。可以分别调整解析服务、模型、输出位置、图片处理方式、DeepSeek 参数和提示词。

Mistral 用户还可以选择是否保留页眉和页脚。遇到 API 限流或临时网络错误时，插件会等待后自动重试。

## 输出示例

对于 `paper.pdf`，默认生成：

```text
paper_翻译.md
```

如果保留转换后的原文 Markdown，还会生成：

```text
paper.md
```

仅转换时默认生成：

```text
paper_OCR.md
```

如果文件已经存在，插件会自动使用新的名称，不会覆盖原文件。

## 更新

任务结束后插件会检查 GitHub Release。发现新版本时，可以在设置页点击“更新”自动安装；也可以重新运行 Windows 安装向导。

## 调试模式

遇到问题时可以临时开启“调试模式”。插件会保存最近一次任务的处理记录，方便定位失败原因。

调试记录可能包含文档正文，分享前请先检查内容。记录中不会保存 API 密钥和图片 Base64。

## 从源码构建

```bash
npm install
npm run build
```

构建结果为 Obsidian 直接加载的 `main.js`。
