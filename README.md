# Pdf translate to markdown

一个面向 Obsidian 的 PDF OCR 与 Markdown 翻译插件。只需右键 PDF 文件，选择 “OCR 并翻译为 Markdown”，便可**一键自动翻译**，得到 Markdown 版本的译文（图片会保存到当前 Vault 的默认附件目录）。
也支持直接右键翻译已有的 Markdown 文件。
支持**自定义翻译提示词**。

具体工作流程主要分为两步，先用 Mistral 把 PDF 转为 markdown 文件，并把其中的图片保存到附件目录，再用 Deepseek 对得到的 markdown 文件进行翻译。
整个流程都在 Obsidian 内一键完成，不需要手动在多个工具之间复制文件。

当前主要缺点：暂时无法处理特别长的 PDF（当前是直接一次对话实现翻译，想保证效果，最好页数是两位数）；Mistral API 默认的免费版用户限制一个月 2500 页额度；**翻译较慢**（自测40多页论文翻译了五六分钟）。

## 安装

### 从 Release 安装

1. 打开 [Releases](https://github.com/zhao0511/pdf-translate-to-markdown/releases)。
2. 下载最新 Release 中的 `main.js`、`manifest.json` 和 `styles.css`。
3. 在 Vault 中创建目录：

   ```text
   .obsidian/plugins/deepseek-translator/
   ```

4. 把三个文件放入该目录。
5. 重新加载 Obsidian，在“设置 → 第三方插件”中启用 **Pdf translate to markdown**。

### 从源码构建

```bash
npm install
npm run build
```

Obsidian 直接加载构建生成的 `main.js`。

## 配置 API

打开“设置 → Pdf translate to markdown”。设置页顶部也提供以下教程和入口。

### DeepSeek

1. 在 [DeepSeek API Keys](https://platform.deepseek.com/api_keys) 创建密钥。
2. 将密钥粘贴到“DeepSeek API 密钥”。
3. 普通 Markdown 翻译只需要这一项。
4. 本月用量可在 [DeepSeek Usage](https://platform.deepseek.com/usage) 查看。

### Mistral

1. 在 [Mistral API Keys](https://admin.mistral.ai/plateforme/api-keys) 创建密钥。
2. 将密钥粘贴到“Mistral API 密钥”。
3. PDF 一键翻译同时需要 Mistral 和 DeepSeek 密钥。
4. 订阅与用量可在 [Mistral Subscription](https://admin.mistral.ai/subscription) 查看。

API 密钥只用于向对应服务发起请求。支持 Secret Storage 的 Obsidian 版本会将密钥保存到 Secret Storage，而不是普通插件配置中。请勿提交或分享本地 `data.json`。

## 使用与设置

### PDF 一键翻译

右键 `.pdf` 文件并选择 “OCR 并翻译为 Markdown”，默认设置下，会在原文件 `paper.pdf` 的同目录生成：

```text
paper_翻译.md
```

“保留中间结果”默认关闭。开启后会保留英文版 Markdown 文件：

```text
paper.md
```

如果选择“在 PDF 所在文件夹中新建与 PDF 同名子文件夹”，则结果会输出到：

```text
paper/paper_翻译.md
paper/paper.md  # 仅在保留中间结果时生成
paper/paper.pdf  # 可选择是否把原 PDF 也移动到此文件夹中
```

### 翻译 Markdown

右键 `.md` 文件并选择“翻译”。插件会在同目录生成带 `_翻译` 后缀的译文。

## 默认设置

当前默认设置来自插件作者正在使用的配置：

- DeepSeek 模型：`deepseek-v4-flash`
- 深度思考：开启
- 思考强度：`max`
- Temperature：`0.2`（深度思考开启时不发送）
- 最大输出 Token：`100000`
- 译文后缀：`_翻译`
- Mistral OCR 模型：`mistral-ocr-latest`
- 输出位置：PDF 所在文件夹
- 保留英文版 OCR Markdown：关闭
- 提取图片：开启
- 英文版 Markdown 文件包含页面分隔线：开启
- OCR 后删除 Mistral 远程临时文件：开启

设置页中的默认提示词还包含标题层级整理、脚注统一、页眉页脚清理、跨页段落合并、数学符号修正、格式保护和术语一致性要求，可以直接编辑。

## 自动更新

每次 Markdown 或 PDF 任务结束后，插件会查询本仓库的最新正式 Release。发现更高版本时会提示用户进入插件设置。

设置页的“更新”区域提供：

- 检查更新：立即查询最新 Release。
- 更新：点击后可自动下载并安装 Release 中的 `main.js`、`manifest.json` 和 `styles.css`。

更新器只接受本仓库的固定下载地址，并校验插件 ID、Release 标签和 manifest 版本。写入失败时会尝试恢复原文件。更新完成后需要重新加载 Obsidian。

## 当前限制

- 每份 Markdown 或 PDF 只发起一次 DeepSeek 翻译请求，尚未实现按章节分块、并行翻译。
- 处理中关闭或重新加载 Obsidian 无法恢复当前任务。
- 自动更新依赖 GitHub 可访问；网络错误不会影响翻译结果。
- 翻译较慢（自测翻译40多页的论文需要五六分钟）。
- 需要自行配置 API，且受到相关限制（Mistral 免费版限制每月 2500 页额度；Deepseek API 也需自行缴费）。

## 开发与测试

```bash
npm install
npm run build
npm test
```

源码位于 `src/`。测试覆盖 Mistral 上传/OCR/远程清理、公式修正、附件防重名、PDF 完整流程，以及 GitHub Release 版本比较、资源校验和更新写入。
