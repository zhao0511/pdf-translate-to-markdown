# Pdf translate to markdown

一个面向 Obsidian 的 PDF OCR 与 Markdown 翻译插件。它可以把 PDF 交给 Mistral OCR 转换为 Markdown，将图片保存到当前 Vault 的默认附件目录，修正常见的公式定界符问题，再调用 DeepSeek 生成中文 Markdown 译文。

插件也支持直接右键翻译已有的 Markdown 文件。整个流程都在 Obsidian 内完成，不需要手动在多个工具之间复制文件。

## 功能

- PDF 一键执行 Mistral OCR → 公式修正 → DeepSeek 翻译。
- 直接翻译 Vault 中已有的 Markdown 文件。
- 图片自动保存到 Obsidian 当前配置的默认附件路径。
- 图片名包含 PDF 名称、内容哈希、页码和图片标识，避免不同 PDF 的附件重名。
- 输出到 PDF 原文件夹，或自动创建与 PDF 同名的子文件夹。
- 可选择是否保留 OCR 得到的英文版 Markdown 中间文件。
- 已有结果不会被覆盖，会自动选择 `paper 2`、`paper 3` 等新名称。
- 持续显示“上传至 Mistral”“Mistral OCR 中”“DeepSeek 翻译中”等任务状态和等待时间。
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

1. 在 [Mistral API Keys](https://admin.mistral.ai/plateforme/api-keys) 创建密钥。
2. 将密钥粘贴到“Mistral API 密钥”。
3. PDF 一键翻译同时需要 Mistral 和 DeepSeek 密钥。
4. 订阅与用量可在 [Mistral Subscription](https://admin.mistral.ai/subscription) 查看。

API 密钥只用于向对应服务发起请求。支持 Secret Storage 的 Obsidian 版本会将密钥保存到 Secret Storage，而不是普通插件配置中。请勿提交或分享本地 `data.json`。

## 使用

### PDF 一键翻译

在 Obsidian 文件列表中右键 `.pdf` 文件，选择“OCR 并翻译为 Markdown”。插件会依次：

1. 读取 PDF 并规划无冲突的输出路径。
2. 上传临时 PDF 到 Mistral。
3. 使用配置的 OCR 模型识别页面 Markdown 和图片。
4. 保存图片并重写 Markdown 图片链接。
5. 修正公式格式，并按设置决定是否保存英文版 OCR Markdown。
6. 调用 DeepSeek 翻译完整 Markdown。
7. 保存译文；如果启用了移动 PDF，只在全部处理成功后移动原文件。

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

右键 `.md` 文件并选择“翻译”。插件会先修正常见的 Mistral 公式边界，再在同目录生成带 `_翻译` 后缀的译文。

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
- 页面分隔线：开启
- OCR 后删除 Mistral 远程临时文件：开启

设置页中的默认提示词还包含标题层级整理、脚注统一、页眉页脚清理、跨页段落合并、数学符号修正、格式保护和术语一致性要求，可以直接编辑。

## 公式修正

公式修正固定启用，并同时作用于英文版 OCR Markdown 和 DeepSeek 翻译输入。替换严格按照以下顺序执行：

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

- 每份 Markdown 或 PDF 只发起一次 DeepSeek 翻译请求，尚未实现按章节分块、并行翻译和任务恢复。
- 处理中关闭或重新加载 Obsidian 无法恢复当前任务。
- 自动更新依赖 GitHub 可访问；网络错误不会影响翻译结果。
- 自动化测试不会调用真实 API，以免上传私人 PDF 或消耗额度。

## 开发与测试

```bash
npm install
npm run build
npm test
```

源码位于 `src/`。测试覆盖 Mistral 上传/OCR/远程清理、公式修正、附件防重名、PDF 完整流程，以及 GitHub Release 版本比较、资源校验和更新写入。

Windows 安装向导源码位于 `installer/Installer.cs`。在带有 .NET Framework C# 编译器的 Windows 环境中运行以下命令构建：

```powershell
powershell -NoProfile -ExecutionPolicy Bypass -File installer/build.ps1
```

构建产物为 `installer/bin/PdfTranslateToMarkdown-Setup.exe`。可使用 `--self-test` 参数运行不联网的路径与 manifest 校验自检。
