$ErrorActionPreference = "Stop"

$installerRoot = Split-Path -Parent $MyInvocation.MyCommand.Path
$outputRoot = Join-Path $installerRoot "bin"
$compilerPath = "$env:WINDIR\Microsoft.NET\Framework64\v4.0.30319\csc.exe"

if (-not (Test-Path -LiteralPath $compilerPath)) {
    throw "未找到 .NET Framework C# 编译器：$compilerPath"
}

New-Item -ItemType Directory -Force -Path $outputRoot | Out-Null

& $compilerPath `
    /nologo `
    /target:winexe `
    /optimize+ `
    /platform:anycpu `
    /out:"$outputRoot\PdfTranslateToMarkdown-Setup.exe" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    "$installerRoot\Installer.cs"

if ($LASTEXITCODE -ne 0) {
    throw "安装器编译失败，退出码：$LASTEXITCODE"
}

& $compilerPath `
    /nologo `
    /target:exe `
    /optimize+ `
    /platform:anycpu `
    /out:"$outputRoot\PdfTranslateToMarkdown-Setup.Tests.exe" `
    /reference:System.dll `
    /reference:System.Core.dll `
    /reference:System.Drawing.dll `
    /reference:System.Windows.Forms.dll `
    /reference:System.Web.Extensions.dll `
    "$installerRoot\Installer.cs"

if ($LASTEXITCODE -ne 0) {
    throw "安装器测试程序编译失败，退出码：$LASTEXITCODE"
}

Write-Host "Built $outputRoot\PdfTranslateToMarkdown-Setup.exe"
