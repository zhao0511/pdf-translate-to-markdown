# Pdf translate to markdown

一个面向 Obsidian 的 PDF OCR 与 Markdown 翻译插件。它可以选择使用 Mistral OCR 或 MinerU 精准解析把 PDF 转换为 Markdown，将图片保存到当前 Vault 的默认附件目录，修正常见的公式定界符问题，再调用 DeepSeek 生成中文 Markdown 译文。

插件也支持直接右键翻译已有的 Markdown 文件。整个流程都在 Obsidian 内完成，不需要手动在多个工具之间复制文件。

## 功能

- PDF 一键执行 Mistral OCR / MinerU 精准解析 → 公式修正 → DeepSeek 翻译。
- 设置中可随时切换 Mistral 与 MinerU，并分别保存各自密钥和服务参数。
- 超过 50 页的 PDF 会打开分页规划窗口；可对照原 PDF 自选页码范围，并行 OCR 与翻译后按页码顺序合并。
- 直接翻译 Vault 中已有的 Markdown 文件。
- 图片自动保存到 Obsidian 当前配置的默认附件路径。
- 图片名包含 PDF 名称、内容哈希、页码和图片标识，避免不同 PDF 的附件重名。
- 输出到 PDF 原文件夹，或自动创建与 PDF 同名的子文件夹。
- 可选择是否保留 OCR 得到的英文版 Markdown 中间文件。
- 已有结果不会被覆盖，会自动选择 `paper 2`、`paper 3` 等新名称。
- 生成的 Markdown 默认在主文件区的新标签页中打开，不会占用左侧边栏。
- 处理时按阶段持续显示整体进度，例如“上传 3/5｜OCR 2/5｜翻译 1/5”。
- 上传、OCR、翻译阶段失败时自动重试；多次失败后可选择保留成功步骤继续重试，或放弃并清理中间结果。
- PDF 任务开始时先检查 DeepSeek 与当前所选 OCR 服务的网络、密钥和模型可用性，检查通过后才读取并上传 PDF。
- 检查 OCR 服务返回页数与 DeepSeek `finish_reason`，不完整响应会按失败重试，不再保存半截译文。
- OCR 输入和最终译文都会修正 Obsidian 不兼容的公式定界符。
- 可选调试模式保存最近一次任务的完整阶段、重试、错误、OCR 文本和译文快照。
- 每次任务结束后检查 GitHub Release；发现新版后可在设置页点击“更新”。
- 提供 Windows 图形安装向导，可选择 Vault 后自动安装、修复或更新插件。
- 支持 Obsidian Secret Storage，不会读取其他插件保存的 API 密钥。

## 安装

### Windows 安装向导（推荐）

1. 打开 [Releases](https://github.com/zhao0511/pdf-translate-to-markdown/releases)。
2. 下载最新 Release 中的 `PdfTranslateToMarkdown-Setup.exe` 并打开。
3. 点击“选择…”，选择需要安装插件的 Obsidian 仓库根目录，也就是内部包含 `.obsidian` 文件夹的目录。
4. 安装向导会自动检测并处理：

   - 未安装：选择仓库后立即自动创建插件目录并安装。
   - 已安装：显示现有版本，并允许更新或重新安装。
   - 安装不完整：允许修复安装。

5. 如果已安装或安装不完整，点击“更新/重装”或“修复安装”；未安装时直接等待完成提示。
6. 重新加载 Obsidian，在“设置 → 第三方插件”中启用 **Pdf translate to markdown**。

安装向导会从本仓库的最新正式 Release 下载 `main.js`、`manifest.json` 和 `styles.css`，校验插件 ID 与版本后再写入。更新时不会删除 `data.json`，因此现有插件设置和 API 密钥不会被覆盖；写入失败时会尝试恢复原文件。

安装器目前仅支持 Windows，且暂未进行商业代码签名。Windows SmartScreen 可能显示未知发布者警告；可以先在本仓库查看 `installer/Installer.cs` 源码，再决定是否运行。

### 手动安装

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

1. 在 [Mistral API Keys](https://admin.mistral.ai/organization/api-keys) 创建密钥。
2. 将密钥粘贴到“Mistral API 密钥”。
3. PDF 一键翻译同时需要 Mistral 和 DeepSeek 密钥。
4. 订阅与用量可在 [Mistral Subscription](https://admin.mistral.ai/subscription) 查看。

### MinerU

1. 打开 [MinerU API 管理](https://mineru.net/apiManage/token) 创建精准解析 API Token。
2. 在“PDF OCR 服务”中选择“MinerU 精准解析”。
3. 将 Token 粘贴到“MinerU API Token”。
4. 默认使用官方推荐的 `vlm`；普通英文教材可使用语言 `en`，中文资料使用 `ch`。
5. 扫描版 PDF 可开启“强制 OCR”，普通含文本 PDF 通常保持关闭。
6. Token 和使用情况均可在 [MinerU API 管理](https://mineru.net/apiManage/token) 查看。

API 密钥只用于向对应服务发起请求。支持 Secret Storage 的 Obsidian 版本会将密钥保存到 Secret Storage，而不是普通插件配置中。请勿提交或分享本地 `data.json`。

## 使用

### PDF 一键翻译

在 Obsidian 文件列表中右键 `.pdf` 文件，选择“OCR 并翻译为 Markdown”。插件会依次：

1. 检查 DeepSeek 和当前所选 OCR 服务的网络、API 密钥及模型可用性；不会上传 PDF，也不会产生 OCR 或翻译用量。
2. 在本地读取 PDF 页数并规划无冲突的输出路径。
3. 如果超过 50 页，打开分页规划窗口；否则直接处理完整 PDF。
4. 为选定范围在内存中生成临时 PDF 分段，并行上传到 Mistral 或 MinerU。
5. 使用配置的 OCR/解析模型识别各段 Markdown 和图片，并核对实际返回页数。
6. 保存图片、重写链接并修正公式格式。
7. 对各段并行调用 DeepSeek，确认 `finish_reason=stop` 后再接受结果，并对译文再次修正公式定界符。
8. 按原始页码顺序合并，保存英文版 OCR Markdown 和译文；如果启用了移动 PDF，只在全部处理成功后移动原文件。

处理过程中会分别统计完成上传、OCR 和翻译的分块数量，而不是只显示某一个分块的状态。每个阶段失败后会自动尝试 3 次。三个阶段之间设有整体屏障：只要任意一块上传彻底失败，就不会开始 OCR；只要任意一块 OCR 彻底失败，就不会开始翻译。自动重试仍未成功时，整个任务会暂停并提供两种选择：

- **重试**：保留已成功的上传、OCR 文本、图片和翻译结果，只运行尚未完成的步骤。例如某块已经完成 OCR、仅翻译失败，就不会再次上传和 OCR。
- **放弃**：停止整项任务，删除本次任务生成的 OCR 图片，并清理尚存的 Mistral 远程临时文件；不会生成最终 Markdown。

#### 超过 50 页时的手动拆分

分页规划窗口左侧显示接近全屏高度的原 PDF，右侧逐行填写“起始页 — 结束页”：

- 每部分最多 100 页。
- 第一行的起始页默认是 `1`，也可以手动修改；填写结束页后会自动出现下一行。
- 下一待填行的起始页会实时设为上一行结束页加 `1`，待填行以较暗样式显示。
- 如果最后剩余不足 50 页，会自动把 PDF 末页填入结束页，仍可手动修改。
- 已填好的每一行都可以单独删除；未填完的灰色行不会参与处理。
- 可以只填写其中一部分，例如把第一行改为 `35 — 80` 后直接开始。
- 范围不能重叠，且必须位于 PDF 的实际页数内。
- 插件会按起始页自动排序，并行处理后仍按页码顺序合并。
- 分段只存在于内存中，不会在 Vault 中留下临时 PDF 文件。

这里填写的是 PDF 阅读器显示的文件页码，不是书籍正文中印刷的页码。建议尽量在自然章节边界拆分，否则跨块上下文、标题层级和术语可能难以保持一致。

默认情况下，`paper.pdf` 会在同目录生成：

```text
paper_翻译.md
```

“保留中间结果”默认关闭。开启后还会生成：

```text
paper.md
```

如果选择“在 PDF 所在文件夹中新建与 PDF 同名子文件夹”，则结果会输出到：

```text
paper/paper_翻译.md
paper/paper.md  # 仅在保留中间结果时生成
```

### 翻译 Markdown

右键 `.md` 文件并选择“翻译”。插件会先修正常见的 OCR 公式边界，再在同目录生成带 `_翻译` 后缀的译文。

## 默认设置

当前默认设置来自插件作者正在使用的配置：

- DeepSeek 模型：`deepseek-v4-flash`
- 深度思考：开启
- 思考强度：`max`
- Temperature：`0.2`（深度思考开启时不发送）
- 最大输出 Token：`100000`
- 译文后缀：`_翻译`
- Mistral OCR 模型：`mistral-ocr-latest`
- PDF OCR 服务：Mistral
- MinerU 模型：`vlm`
- MinerU 文档语言：`en`
- MinerU 强制 OCR：关闭
- MinerU 公式识别：开启
- MinerU 表格识别：开启
- MinerU 轮询间隔：3 秒
- MinerU 单次等待上限：30 分钟
- 输出位置：PDF 所在文件夹
- 保留英文版 OCR Markdown：关闭
- 提取图片：开启
- 页面分隔线：开启
- OCR 后删除 Mistral 远程临时文件：开启
- 调试模式：关闭

设置页中的默认提示词还包含标题层级整理、脚注统一、页眉页脚清理、跨页段落合并、数学符号修正、格式保护和术语一致性要求，可以直接编辑。

## 调试模式

设置中的“调试模式”默认关闭。开启后，插件会把最近一次任务保存为：

```text
.obsidian/plugins/deepseek-translator/debug-last-task.json
```

文件包含 API 预检、各分块范围、每次自动重试、错误堆栈、OCR 页面 Markdown、最终 OCR Markdown、DeepSeek `finish_reason`、token 用量和译文。每次新任务会覆盖上一份记录。

调试文件不会保存 API 密钥、Mistral/MinerU 签名 URL 或图片 Base64，但会包含所处理文档的正文，因此不要直接公开分享。

## 公式修正

公式修正固定启用，并同时作用于英文版 OCR Markdown、DeepSeek 翻译输入和 DeepSeek 返回的最终译文。替换严格按照以下顺序执行：

- `\[` → `$$`
- `\]` → `$$`
- `\( ` → `$`
- ` \)` → `$`
- `\(` → `$`
- `\)` → `$`

带空格的行内公式边界会先处理，再处理不带空格的边界。

## 自动更新

每次 Markdown 或 PDF 任务结束后，插件会查询本仓库的最新正式 Release。发现更高版本时会提示用户进入插件设置。

设置页的“更新”区域提供：

- 检查更新：立即查询最新 Release。
- 更新：下载并安装 Release 中的 `main.js`、`manifest.json` 和 `styles.css`。

更新器只接受本仓库的固定下载地址，并校验插件 ID、Release 标签和 manifest 版本。写入失败时会尝试恢复原文件。更新完成后需要重新加载 Obsidian。

## 当前限制

- 当前 PDF 分块完全由用户按页码指定，尚未实现自动按章节拆分、跨块术语表或跨块标题层级协调。
- 普通 Markdown 仍整篇发起一次 DeepSeek 翻译请求。
- MinerU 返回的 `full.md` 不保留可靠的逐页 Markdown 边界，因此“页面之间添加分隔线”只适用于 Mistral；MinerU 仍会通过结构化结果核对总页数。
- MinerU 精准解析 API 当前没有公开的任务或上传文件删除接口，因此插件可以在放弃时删除本地图片，但不能主动删除已经提交的 MinerU 远程任务。
- MinerU 精准解析单文件上限为 200 MB；插件仍保持每个手动分块最多 100 页，但高分辨率扫描件还可能因文件体积超限而失败。
- 任务内的人工重试可以复用已完成步骤；但处理中关闭或重新加载 Obsidian 后仍无法恢复任务。
- 自动更新依赖 GitHub 可访问；网络错误不会影响翻译结果。
- 自动化测试不会调用真实 API，以免上传私人 PDF 或消耗额度。

## 开发与测试

```bash
npm install
npm run build
npm test
```

源码位于 `src/`。测试覆盖 Mistral 上传/OCR/远程清理、MinerU 签名上传/轮询/ZIP 结果/图片提取、OCR 服务切换、PDF 页码规则、本地拆页、并行管线、有序合并、分阶段自动重试、断点续跑、放弃清理、公式修正、附件防重名、PDF 完整流程，以及 GitHub Release 版本比较、资源校验和更新写入。

Windows 安装向导源码位于 `installer/Installer.cs`。在带有 .NET Framework C# 编译器的 Windows 环境中运行以下命令构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/build.ps1
```

构建产物为 `installer/bin/PdfTranslateToMarkdown-Setup.exe`。可使用 `--self-test` 参数运行不联网的路径与 manifest 校验自检。
