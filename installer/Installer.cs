using System;
using System.Collections.Generic;
using System.Drawing;
using System.IO;
using System.Net;
using System.Text;
using System.Threading.Tasks;
using System.Web.Script.Serialization;
using System.Windows.Forms;

[assembly: System.Reflection.AssemblyTitle("Pdf translate to markdown Setup")]
[assembly: System.Reflection.AssemblyDescription("Installer for the Pdf translate to markdown Obsidian plugin")]
[assembly: System.Reflection.AssemblyCompany("zhao0511")]
[assembly: System.Reflection.AssemblyProduct("Pdf translate to markdown")]
[assembly: System.Reflection.AssemblyVersion("0.6.0.0")]
[assembly: System.Reflection.AssemblyFileVersion("0.6.0.0")]

namespace PdfTranslateToMarkdownSetup
{
    internal static class InstallerConstants
    {
        internal const string PluginId = "deepseek-translator";
        internal const string Repository = "zhao0511/pdf-translate-to-markdown";
        internal const string LatestDownloadBase =
            "https://github.com/" + Repository + "/releases/latest/download/";

        internal static readonly string[] RequiredFiles =
        {
            "main.js",
            "manifest.json",
            "styles.css"
        };
    }

    internal static class InstallerLogic
    {
        internal static string ResolveVaultPath(string selectedPath)
        {
            if (string.IsNullOrWhiteSpace(selectedPath))
            {
                throw new InvalidOperationException("请先选择 Obsidian 仓库目录。");
            }

            string fullPath = Path.GetFullPath(selectedPath.Trim());
            if (!Directory.Exists(fullPath))
            {
                throw new InvalidOperationException("选择的目录不存在。");
            }

            if (string.Equals(
                new DirectoryInfo(fullPath).Name,
                ".obsidian",
                StringComparison.OrdinalIgnoreCase))
            {
                DirectoryInfo parent = Directory.GetParent(fullPath);
                if (parent == null)
                {
                    throw new InvalidOperationException("无法确定 Obsidian 仓库目录。");
                }
                return parent.FullName;
            }

            if (!Directory.Exists(Path.Combine(fullPath, ".obsidian")))
            {
                throw new InvalidOperationException(
                    "所选目录中没有 .obsidian 文件夹，请选择 Obsidian 仓库根目录。");
            }

            return fullPath;
        }

        internal static string GetPluginDirectory(string vaultPath)
        {
            string vaultRoot = Path.GetFullPath(vaultPath);
            string pluginDirectory = Path.GetFullPath(Path.Combine(
                vaultRoot,
                ".obsidian",
                "plugins",
                InstallerConstants.PluginId));
            string expectedPrefix = vaultRoot.TrimEnd(Path.DirectorySeparatorChar) +
                Path.DirectorySeparatorChar;

            if (!pluginDirectory.StartsWith(expectedPrefix, StringComparison.OrdinalIgnoreCase))
            {
                throw new InvalidOperationException("插件目录不在所选 Obsidian 仓库中。");
            }

            return pluginDirectory;
        }

        internal static string ReadInstalledVersion(string pluginDirectory)
        {
            string manifestPath = Path.Combine(pluginDirectory, "manifest.json");
            if (!File.Exists(manifestPath))
            {
                return null;
            }

            try
            {
                byte[] manifestBytes = File.ReadAllBytes(manifestPath);
                return ValidateManifest(manifestBytes);
            }
            catch
            {
                return string.Empty;
            }
        }

        internal static string ValidateManifest(byte[] manifestBytes)
        {
            if (manifestBytes == null || manifestBytes.Length < 20)
            {
                throw new InvalidDataException("Release 中的 manifest.json 为空或不完整。");
            }

            string json = Encoding.UTF8.GetString(manifestBytes);
            var serializer = new JavaScriptSerializer();
            Dictionary<string, object> manifest =
                serializer.Deserialize<Dictionary<string, object>>(json);

            object idValue;
            object versionValue;
            string id = manifest != null && manifest.TryGetValue("id", out idValue)
                ? Convert.ToString(idValue)
                : string.Empty;
            string version = manifest != null && manifest.TryGetValue("version", out versionValue)
                ? Convert.ToString(versionValue)
                : string.Empty;

            if (!string.Equals(id, InstallerConstants.PluginId, StringComparison.Ordinal))
            {
                throw new InvalidDataException("Release 中的插件 ID 不正确，安装已取消。");
            }
            if (string.IsNullOrWhiteSpace(version))
            {
                throw new InvalidDataException("Release 中缺少插件版本号，安装已取消。");
            }

            return version;
        }

        internal static void ValidateDownloadedFiles(Dictionary<string, byte[]> files)
        {
            if (files == null || !files.ContainsKey("main.js") ||
                !files.ContainsKey("manifest.json") || !files.ContainsKey("styles.css"))
            {
                throw new InvalidDataException("下载结果缺少必要的插件文件。");
            }
            if (files["main.js"] == null || files["main.js"].Length < 50000)
            {
                throw new InvalidDataException("下载的 main.js 不完整，安装已取消。");
            }
            if (files["styles.css"] == null || files["styles.css"].Length < 20)
            {
                throw new InvalidDataException("下载的 styles.css 不完整，安装已取消。");
            }

            ValidateManifest(files["manifest.json"]);
        }

        internal static async Task<Dictionary<string, byte[]>> DownloadRequiredFilesAsync()
        {
            var tasks = new Dictionary<string, Task<byte[]>>();
            foreach (string fileName in InstallerConstants.RequiredFiles)
            {
                tasks[fileName] = DownloadFileAsync(fileName);
            }

            await Task.WhenAll(tasks.Values);
            var results = new Dictionary<string, byte[]>(StringComparer.OrdinalIgnoreCase);
            foreach (KeyValuePair<string, Task<byte[]>> pair in tasks)
            {
                results[pair.Key] = pair.Value.Result;
            }
            return results;
        }

        private static async Task<byte[]> DownloadFileAsync(string fileName)
        {
            Uri uri = new Uri(InstallerConstants.LatestDownloadBase + fileName);
            using (var client = new WebClient())
            {
                client.Headers[HttpRequestHeader.UserAgent] =
                    "PdfTranslateToMarkdown-Setup/0.6.0";
                client.Headers[HttpRequestHeader.Accept] = "application/octet-stream";
                return await client.DownloadDataTaskAsync(uri);
            }
        }

        internal static void InstallFilesWithRollback(
            string pluginDirectory,
            string temporaryDirectory,
            Dictionary<string, byte[]> downloadedFiles)
        {
            string backupDirectory = Path.Combine(temporaryDirectory, "backup");
            Directory.CreateDirectory(backupDirectory);
            Directory.CreateDirectory(pluginDirectory);

            var existingFiles = new Dictionary<string, bool>(StringComparer.OrdinalIgnoreCase);
            foreach (string fileName in InstallerConstants.RequiredFiles)
            {
                string targetPath = Path.Combine(pluginDirectory, fileName);
                bool exists = File.Exists(targetPath);
                existingFiles[fileName] = exists;
                if (exists)
                {
                    File.Copy(targetPath, Path.Combine(backupDirectory, fileName), true);
                }
            }

            try
            {
                string[] writeOrder = { "styles.css", "main.js", "manifest.json" };
                foreach (string fileName in writeOrder)
                {
                    string stagedPath = Path.Combine(temporaryDirectory, fileName);
                    File.WriteAllBytes(stagedPath, downloadedFiles[fileName]);
                    File.Copy(stagedPath, Path.Combine(pluginDirectory, fileName), true);
                }
            }
            catch
            {
                foreach (string fileName in InstallerConstants.RequiredFiles)
                {
                    string targetPath = Path.Combine(pluginDirectory, fileName);
                    if (existingFiles[fileName])
                    {
                        File.Copy(Path.Combine(backupDirectory, fileName), targetPath, true);
                    }
                    else if (File.Exists(targetPath))
                    {
                        File.Delete(targetPath);
                    }
                }
                throw;
            }
        }
    }

    internal sealed class InstallerForm : Form
    {
        private readonly TextBox vaultPathTextBox;
        private readonly Button browseButton;
        private readonly Label detectionLabel;
        private readonly Label statusLabel;
        private readonly Button installButton;
        private readonly ProgressBar progressBar;

        internal InstallerForm()
        {
            Text = "Pdf translate to markdown 安装向导";
            ClientSize = new Size(700, 430);
            MinimumSize = new Size(716, 469);
            StartPosition = FormStartPosition.CenterScreen;
            Font = new Font("Microsoft YaHei UI", 9F, FontStyle.Regular);
            BackColor = Color.White;

            var titleLabel = new Label
            {
                AutoSize = true,
                Font = new Font("Microsoft YaHei UI", 18F, FontStyle.Bold),
                Location = new Point(30, 26),
                Text = "安装 Pdf translate to markdown"
            };

            var introLabel = new Label
            {
                AutoSize = false,
                Location = new Point(34, 75),
                Size = new Size(630, 48),
                Text = "选择需要安装插件的 Obsidian 仓库。安装器会自动检测已有版本，" +
                    "并从 GitHub 最新 Release 下载和安装插件文件。"
            };

            var pathLabel = new Label
            {
                AutoSize = true,
                Location = new Point(34, 139),
                Text = "Obsidian 仓库目录"
            };

            vaultPathTextBox = new TextBox
            {
                Location = new Point(37, 165),
                Size = new Size(518, 28),
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };
            vaultPathTextBox.TextChanged += delegate { RefreshDetection(); };

            browseButton = new Button
            {
                Location = new Point(568, 163),
                Size = new Size(96, 32),
                Text = "选择…",
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            browseButton.Click += BrowseButtonClick;

            var detectionCaption = new Label
            {
                AutoSize = true,
                Location = new Point(34, 218),
                Text = "检测结果"
            };

            detectionLabel = new Label
            {
                AutoSize = false,
                BorderStyle = BorderStyle.FixedSingle,
                Location = new Point(37, 244),
                Size = new Size(627, 54),
                Padding = new Padding(10, 8, 10, 8),
                Text = "请选择 Obsidian 仓库目录。",
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            progressBar = new ProgressBar
            {
                Location = new Point(37, 317),
                Size = new Size(627, 8),
                Style = ProgressBarStyle.Marquee,
                MarqueeAnimationSpeed = 25,
                Visible = false,
                Anchor = AnchorStyles.Top | AnchorStyles.Left | AnchorStyles.Right
            };

            statusLabel = new Label
            {
                AutoSize = false,
                Location = new Point(37, 337),
                Size = new Size(450, 50),
                ForeColor = Color.DimGray,
                Text = "安装过程中请保持网络连接。"
            };

            installButton = new Button
            {
                Location = new Point(522, 337),
                Size = new Size(142, 42),
                Text = "安装",
                Enabled = false,
                Anchor = AnchorStyles.Top | AnchorStyles.Right
            };
            installButton.Click += InstallButtonClick;

            Controls.Add(titleLabel);
            Controls.Add(introLabel);
            Controls.Add(pathLabel);
            Controls.Add(vaultPathTextBox);
            Controls.Add(browseButton);
            Controls.Add(detectionCaption);
            Controls.Add(detectionLabel);
            Controls.Add(progressBar);
            Controls.Add(statusLabel);
            Controls.Add(installButton);
        }

        private async void BrowseButtonClick(object sender, EventArgs e)
        {
            using (var dialog = new FolderBrowserDialog())
            {
                dialog.Description = "选择 Obsidian 仓库根目录";
                dialog.ShowNewFolderButton = false;
                if (Directory.Exists(vaultPathTextBox.Text))
                {
                    dialog.SelectedPath = vaultPathTextBox.Text;
                }

                if (dialog.ShowDialog(this) == DialogResult.OK)
                {
                    vaultPathTextBox.Text = dialog.SelectedPath;
                    try
                    {
                        string vaultPath = InstallerLogic.ResolveVaultPath(vaultPathTextBox.Text);
                        string pluginDirectory = InstallerLogic.GetPluginDirectory(vaultPath);
                        if (InstallerLogic.ReadInstalledVersion(pluginDirectory) == null)
                        {
                            await InstallSelectedVaultAsync();
                        }
                    }
                    catch
                    {
                        // RefreshDetection already shows why the selected folder is not a Vault.
                    }
                }
            }
        }

        private void RefreshDetection()
        {
            try
            {
                string vaultPath = InstallerLogic.ResolveVaultPath(vaultPathTextBox.Text);
                string pluginDirectory = InstallerLogic.GetPluginDirectory(vaultPath);
                string installedVersion = InstallerLogic.ReadInstalledVersion(pluginDirectory);

                if (installedVersion == null)
                {
                    detectionLabel.Text = "未检测到本插件。点击“安装”后会自动创建插件目录。";
                    detectionLabel.ForeColor = Color.FromArgb(38, 93, 173);
                    installButton.Text = "安装";
                }
                else if (installedVersion.Length == 0)
                {
                    detectionLabel.Text = "检测到不完整或无法识别的安装。点击“修复安装”可重新写入插件文件。";
                    detectionLabel.ForeColor = Color.FromArgb(181, 98, 0);
                    installButton.Text = "修复安装";
                }
                else
                {
                    detectionLabel.Text = "已安装版本：" + installedVersion +
                        "。点击“更新/重装”会安装 GitHub 最新正式版本。";
                    detectionLabel.ForeColor = Color.FromArgb(31, 122, 65);
                    installButton.Text = "更新/重装";
                }

                vaultPathTextBox.Text = vaultPath;
                installButton.Enabled = true;
            }
            catch (Exception error)
            {
                detectionLabel.Text = error.Message;
                detectionLabel.ForeColor = Color.FromArgb(181, 50, 50);
                installButton.Enabled = false;
            }
        }

        private async void InstallButtonClick(object sender, EventArgs e)
        {
            await InstallSelectedVaultAsync();
        }

        private async Task InstallSelectedVaultAsync()
        {
            string vaultPath;
            string pluginDirectory;
            try
            {
                vaultPath = InstallerLogic.ResolveVaultPath(vaultPathTextBox.Text);
                pluginDirectory = InstallerLogic.GetPluginDirectory(vaultPath);
            }
            catch (Exception error)
            {
                MessageBox.Show(this, error.Message, "无法安装", MessageBoxButtons.OK,
                    MessageBoxIcon.Warning);
                return;
            }

            SetBusy(true, "正在从 GitHub 下载最新版本…");
            string temporaryDirectory = Path.Combine(
                Path.GetTempPath(),
                "pdf-translate-to-markdown-setup-" + Guid.NewGuid().ToString("N"));

            try
            {
                Directory.CreateDirectory(temporaryDirectory);
                Dictionary<string, byte[]> downloadedFiles =
                    await InstallerLogic.DownloadRequiredFilesAsync();
                SetStatus("正在校验下载文件…");
                InstallerLogic.ValidateDownloadedFiles(downloadedFiles);
                string version = InstallerLogic.ValidateManifest(downloadedFiles["manifest.json"]);

                SetStatus("正在安装插件文件…");
                InstallerLogic.InstallFilesWithRollback(
                    pluginDirectory, temporaryDirectory, downloadedFiles);
                RefreshDetection();
                SetBusy(false, "安装完成。请重新加载 Obsidian，然后在第三方插件中启用插件。");

                MessageBox.Show(this,
                    "Pdf translate to markdown " + version + " 已安装完成。\r\n\r\n" +
                    "请重新加载 Obsidian，并在“设置 → 第三方插件”中启用它。",
                    "安装完成",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Information);
            }
            catch (Exception error)
            {
                SetBusy(false, "安装失败：" + error.Message);
                MessageBox.Show(this,
                    "安装失败，原有插件文件已尽可能恢复。\r\n\r\n" + error.Message,
                    "安装失败",
                    MessageBoxButtons.OK,
                    MessageBoxIcon.Error);
            }
            finally
            {
                TryDeleteDirectory(temporaryDirectory);
            }
        }

        private void SetBusy(bool busy, string status)
        {
            progressBar.Visible = busy;
            browseButton.Enabled = !busy;
            vaultPathTextBox.Enabled = !busy;
            installButton.Enabled = !busy;
            UseWaitCursor = busy;
            SetStatus(status);
        }

        private void SetStatus(string status)
        {
            statusLabel.Text = status;
            statusLabel.ForeColor = status.StartsWith("安装失败", StringComparison.Ordinal)
                ? Color.FromArgb(181, 50, 50)
                : Color.DimGray;
        }

        private static void TryDeleteDirectory(string path)
        {
            try
            {
                if (Directory.Exists(path))
                {
                    Directory.Delete(path, true);
                }
            }
            catch
            {
                // Temporary cleanup failure does not affect the installed plugin.
            }
        }
    }

    internal static class Program
    {
        [STAThread]
        private static int Main(string[] args)
        {
            ServicePointManager.SecurityProtocol = (SecurityProtocolType)3072;

            if (args != null && args.Length == 1 &&
                string.Equals(args[0], "--self-test", StringComparison.OrdinalIgnoreCase))
            {
                return RunSelfTest();
            }

            if (args != null && args.Length == 1 &&
                string.Equals(args[0], "--network-test", StringComparison.OrdinalIgnoreCase))
            {
                return RunNetworkTest();
            }

            Application.EnableVisualStyles();
            Application.SetCompatibleTextRenderingDefault(false);

            if (args != null && args.Length == 2 &&
                string.Equals(args[0], "--render", StringComparison.OrdinalIgnoreCase))
            {
                return RenderPreview(args[1]);
            }

            Application.Run(new InstallerForm());
            return 0;
        }

        private static int RenderPreview(string outputPath)
        {
            try
            {
                using (var form = new InstallerForm())
                {
                    form.ShowInTaskbar = false;
                    form.StartPosition = FormStartPosition.Manual;
                    form.Location = new Point(-3000, -3000);
                    form.Show();
                    Application.DoEvents();

                    using (var bitmap = new Bitmap(form.Width, form.Height))
                    {
                        form.DrawToBitmap(bitmap, new Rectangle(Point.Empty, form.Size));
                        bitmap.Save(outputPath, System.Drawing.Imaging.ImageFormat.Png);
                    }
                    form.Close();
                }
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
        }

        private static int RunNetworkTest()
        {
            try
            {
                Dictionary<string, byte[]> files =
                    InstallerLogic.DownloadRequiredFilesAsync().GetAwaiter().GetResult();
                InstallerLogic.ValidateDownloadedFiles(files);
                string version = InstallerLogic.ValidateManifest(files["manifest.json"]);
                Console.WriteLine("Installer network test passed: " + version);
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
        }

        private static int RunSelfTest()
        {
            string root = Path.Combine(
                Path.GetTempPath(),
                "pdf-translate-to-markdown-installer-test-" + Guid.NewGuid().ToString("N"));
            try
            {
                Directory.CreateDirectory(Path.Combine(root, ".obsidian"));
                string resolvedRoot = InstallerLogic.ResolveVaultPath(root);
                string resolvedConfig = InstallerLogic.ResolveVaultPath(
                    Path.Combine(root, ".obsidian"));
                if (!string.Equals(resolvedRoot, resolvedConfig, StringComparison.OrdinalIgnoreCase))
                {
                    throw new Exception("Vault path resolution failed.");
                }

                string pluginDirectory = InstallerLogic.GetPluginDirectory(root);
                string expectedSuffix = Path.Combine(
                    ".obsidian", "plugins", InstallerConstants.PluginId);
                if (!pluginDirectory.EndsWith(expectedSuffix, StringComparison.OrdinalIgnoreCase))
                {
                    throw new Exception("Plugin directory resolution failed.");
                }

                byte[] manifest = Encoding.UTF8.GetBytes(
                    "{\"id\":\"deepseek-translator\",\"version\":\"9.9.9\"}");
                if (InstallerLogic.ValidateManifest(manifest) != "9.9.9")
                {
                    throw new Exception("Manifest validation failed.");
                }

                var downloadedFiles = new Dictionary<string, byte[]>
                {
                    { "main.js", new byte[50000] },
                    { "manifest.json", manifest },
                    { "styles.css", Encoding.UTF8.GetBytes("/* installer self-test */") }
                };
                InstallerLogic.ValidateDownloadedFiles(downloadedFiles);

                Directory.CreateDirectory(pluginDirectory);
                string dataPath = Path.Combine(pluginDirectory, "data.json");
                File.WriteAllText(dataPath, "{\"keep\":true}", Encoding.UTF8);
                string stagingDirectory = Path.Combine(root, "installer-temp");
                Directory.CreateDirectory(stagingDirectory);
                InstallerLogic.InstallFilesWithRollback(
                    pluginDirectory, stagingDirectory, downloadedFiles);

                if (!File.Exists(Path.Combine(pluginDirectory, "main.js")) ||
                    !File.Exists(Path.Combine(pluginDirectory, "styles.css")) ||
                    InstallerLogic.ReadInstalledVersion(pluginDirectory) != "9.9.9")
                {
                    throw new Exception("Plugin file installation failed.");
                }
                if (File.ReadAllText(dataPath, Encoding.UTF8) != "{\"keep\":true}")
                {
                    throw new Exception("Existing data.json was modified.");
                }

                Console.WriteLine("Installer self-test passed");
                return 0;
            }
            catch (Exception error)
            {
                Console.Error.WriteLine(error.ToString());
                return 1;
            }
            finally
            {
                try
                {
                    if (Directory.Exists(root))
                    {
                        Directory.Delete(root, true);
                    }
                }
                catch
                {
                }
            }
        }
    }
}
