$ErrorActionPreference = "Stop"
$env:RAIL_CONNECTOR_INSTALLER_TEST = "1"

. (Join-Path $PSScriptRoot "..\install-windows.ps1")

Invoke-NativeChecked -Description "successful probe" -Command {
  & $env:ComSpec /d /c "exit 0"
}

$failedAsExpected = $false
try {
  Invoke-NativeChecked -Description "failing probe" -Command {
    & $env:ComSpec /d /c "exit 7"
  }
} catch {
  if ($_.Exception.Message -notmatch "failing probe failed with native exit code 7") {
    throw
  }
  $failedAsExpected = $true
}
if (-not $failedAsExpected) {
  throw "Invoke-NativeChecked did not reject a nonzero native exit code."
}

$pathProbeDir = Join-Path ([System.IO.Path]::GetTempPath()) ("rail executable probe " + [guid]::NewGuid().ToString("N"))
$firstBin = Join-Path $pathProbeDir "first bin"
$secondBin = Join-Path $pathProbeDir "second bin"
$originalPath = $env:PATH
$originalPathExt = $env:PATHEXT
try {
  New-Item -ItemType Directory -Path $firstBin, $secondBin | Out-Null
  foreach ($extension in @(".cmd", ".bat", ".exe", ".com")) {
    $name = "rail-installer-path-probe$extension"
    $firstCommand = Join-Path $firstBin $name
    $secondCommand = Join-Path $secondBin $name
    # These files are discovered, never executed.
    Set-Content -LiteralPath $firstCommand -Value "exit 43"
    Set-Content -LiteralPath $secondCommand -Value "exit 44"
    $env:PATH = "$firstBin;$secondBin;$originalPath"
    $matches = @(Get-Command $name -All -CommandType Application, ExternalScript -ErrorAction Stop)
    if ($matches.Count -ne 2) {
      throw "The duplicate executable fixture did not expose both PATH entries."
    }
    $resolved = Resolve-InstallerExecutable -Name $name
    if ($resolved -isnot [string] -or $resolved -ne [System.IO.Path]::GetFullPath($firstCommand)) {
      throw "Executable resolution did not return exactly the first scalar PATH entry."
    }
    $env:PATH = "$secondBin;$firstBin;$originalPath"
    $resolved = Resolve-InstallerExecutable -Name $name
    if ($resolved -isnot [string] -or $resolved -ne [System.IO.Path]::GetFullPath($secondCommand)) {
      throw "Executable resolution did not follow changed PATH precedence."
    }
  }
  $mixedName = "rail-installer-mixed-probe"
  $powerShellShim = Join-Path $firstBin "$mixedName.ps1"
  $batchShim = Join-Path $firstBin "$mixedName.cmd"
  $nativeExecutable = Join-Path $secondBin "$mixedName.exe"
  Set-Content -LiteralPath $powerShellShim -Value "throw 'Unsupported shim must never execute'"
  Set-Content -LiteralPath $batchShim -Value "exit 45"
  Set-Content -LiteralPath $nativeExecutable -Value "Not executed"
  $env:PATH = "$firstBin;$secondBin;$originalPath"
  $resolved = Resolve-InstallerExecutable -Name $mixedName
  if ($resolved -isnot [string] -or $resolved -ne [System.IO.Path]::GetFullPath($batchShim)) {
    throw "Mixed PowerShell/batch discovery did not select the first supported launcher."
  }
  $env:PATH = "$secondBin;$firstBin;$originalPath"
  if ((Resolve-InstallerExecutable -Name $mixedName) -ne [System.IO.Path]::GetFullPath($nativeExecutable)) {
    throw "Supported mixed extensions did not preserve changed PATH order."
  }
  $env:PATH = "$firstBin;$secondBin;$originalPath"
  if ((Resolve-InstallerExecutable -Name $mixedName -NativeOnly) -ne [System.IO.Path]::GetFullPath($nativeExecutable)) {
    throw "The persisted Node command did not skip script/batch launchers for a native executable."
  }
  $unsupportedName = "rail-installer-unsupported-probe"
  Set-Content -LiteralPath (Join-Path $firstBin "$unsupportedName.ps1") -Value "throw 'Never execute'"
  $unsupportedRejected = $false
  try {
    Resolve-InstallerExecutable -Name $unsupportedName | Out-Null
  } catch {
    if ($_.Exception.Message -ne "Missing supported executable command: $unsupportedName") { throw }
    $unsupportedRejected = $true
  }
  if (-not $unsupportedRejected) { throw "An unsupported-only PowerShell command was accepted." }
  Set-Content -LiteralPath (Join-Path $secondBin "$unsupportedName.cmd") -Value "exit 46"
  $nativeOnlyRejected = $false
  try {
    Resolve-InstallerExecutable -Name $unsupportedName -NativeOnly | Out-Null
  } catch {
    if ($_.Exception.Message -ne "Missing supported executable command: $unsupportedName") { throw }
    $nativeOnlyRejected = $true
  }
  if (-not $nativeOnlyRejected) { throw "The persisted Node command accepted a batch-only installation." }
  $customExtensionName = "rail-installer-custom-extension-probe"
  Set-Content -LiteralPath (Join-Path $firstBin "$customExtensionName.py") -Value "Never executed"
  $supportedBatch = Join-Path $secondBin "$customExtensionName.cmd"
  Set-Content -LiteralPath $supportedBatch -Value "exit 47"
  $env:PATHEXT = ".PY;$originalPathExt"
  if ((Resolve-InstallerExecutable -Name $customExtensionName) -ne [System.IO.Path]::GetFullPath($supportedBatch)) {
    throw "Custom PATHEXT exposed an unsupported launch type before a supported command."
  }
  $env:PATHEXT = $originalPathExt
  if ((Test-Path -LiteralPath "Alias:\$mixedName") -or (Test-Path -LiteralPath "Function:\$mixedName")) {
    throw "A fixture command name is already owned by this process."
  }
  try {
    Set-Alias -Name $mixedName -Value Write-Output
    if ((Resolve-InstallerExecutable -Name $mixedName) -ne [System.IO.Path]::GetFullPath($batchShim)) {
      throw "An alias shadowed the supported executable selection."
    }
  } finally {
    Remove-Item -LiteralPath "Alias:\$mixedName" -ErrorAction SilentlyContinue
  }
  try {
    Set-Item -LiteralPath "Function:\$mixedName" -Value { throw "Fixture function must not execute" }
    if ((Resolve-InstallerExecutable -Name $mixedName) -ne [System.IO.Path]::GetFullPath($batchShim)) {
      throw "A function shadowed the supported executable selection."
    }
  } finally {
    Remove-Item -LiteralPath "Function:\$mixedName" -ErrorAction SilentlyContinue
  }
  $missingName = "rail-installer-missing-" + [guid]::NewGuid().ToString("N")
  $missingRejected = $false
  try {
    Resolve-InstallerExecutable -Name $missingName | Out-Null
  } catch {
    if ($_.Exception.Message -ne "Missing supported executable command: $missingName") {
      throw
    }
    $missingRejected = $true
  }
  if (-not $missingRejected) {
    throw "Executable resolution accepted a missing command."
  }
} finally {
  $env:PATH = $originalPath
  $env:PATHEXT = $originalPathExt
  $tempRoot = [System.IO.Path]::GetFullPath([System.IO.Path]::GetTempPath()).TrimEnd('\') + '\'
  $cleanupPath = [System.IO.Path]::GetFullPath($pathProbeDir)
  if (-not $cleanupPath.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Executable probe cleanup escaped the temporary root."
  }
  if (Test-Path -LiteralPath $cleanupPath) {
    Remove-Item -LiteralPath $cleanupPath -Recurse -Force
  }
}

$probeDir = Join-Path ([System.IO.Path]::GetTempPath()) "rail connector probe $PID"
$allowedRoot = Join-Path $probeDir "allowed project"
New-Item -ItemType Directory -Path $allowedRoot -Force | Out-Null
$workingCodex = Join-Path $probeDir "codex-good.cmd"
$brokenCodex = Join-Path $probeDir "codex-bad.cmd"
try {
  Set-Content -LiteralPath $workingCodex -Value "@echo off`r`necho codex-cli test`r`nexit /b 0`r`n"
  Set-Content -LiteralPath $brokenCodex -Value "@echo off`r`nexit /b 9`r`n"
  if (-not (Test-CodexExecutable -Path $workingCodex)) {
    throw "Executable Codex probe was rejected."
  }
  if (Test-CodexExecutable -Path $brokenCodex) {
    throw "Failing Codex probe was accepted."
  }
  $resolvedCodex = Resolve-CodexExecutable -PreferredPath $workingCodex
  if ($resolvedCodex -ne [System.IO.Path]::GetFullPath($workingCodex)) {
    throw "Explicit Codex path did not resolve exactly."
  }
  $brokenRejected = $false
  try {
    Resolve-CodexExecutable -PreferredPath $brokenCodex | Out-Null
  } catch {
    if ($_.Exception.Message -notmatch "failed its --version probe") {
      throw
    }
    $brokenRejected = $true
  }
  if (-not $brokenRejected) {
    throw "Resolve-CodexExecutable accepted a failing explicit path."
  }

  $localHostValue = Get-BypassPolicyValue -Policy "LocalHost"
  if ($localHostValue -ne "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS") {
    throw "LocalHost bypass policy value was not generated correctly."
  }
  if (Get-BypassPolicyValue -Policy "Disabled") {
    throw "Disabled bypass policy must not emit an environment value."
  }

  $nodePath = "C:\Program Files\nodejs\node.exe"
  $claudePath = "C:\Tools\claude.cmd"
  $registrationArgs = Get-CodexRegistrationArgs `
    -RootDir "C:\repo" `
    -NodePath $nodePath `
    -ClaudePath $claudePath `
    -Policy "LocalHost" `
    -AllowedRoots @($allowedRoot)
  $joinedArgs = $registrationArgs -join "`n"
  if ($joinedArgs -notmatch [regex]::Escape("RAIL_CONNECTOR_CLAUDE_PATH=$claudePath")) {
    throw "Registration did not preserve the absolute Claude path."
  }
  if ($joinedArgs -notmatch "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS") {
    throw "LocalHost registration did not include the explicit acknowledgement."
  }
  if ($joinedArgs -notmatch [regex]::Escape("RAIL_CONNECTOR_ALLOWED_ROOTS=$((Resolve-Path $allowedRoot).Path)")) {
    throw "Registration did not include canonical allowed roots."
  }

  $quotedNode = ConvertTo-PowerShellLiteral -Value $nodePath
  if ($quotedNode -ne "'$nodePath'") {
    throw "PowerShell registration path quoting is incorrect."
  }
  $quotedApostrophe = ConvertTo-PowerShellLiteral -Value "C:\repo's tools"
  if ($quotedApostrophe -ne "'C:\repo''s tools'") {
    throw "PowerShell registration apostrophe escaping is incorrect."
  }

  $registrationCommand = Format-CodexRegistrationCommand `
    -CodexExecutable "codex" `
    -RootDir "C:\repo's tools" `
    -NodePath $nodePath `
    -ClaudePath $claudePath `
    -Policy "LocalHost" `
    -AllowedRoots @($allowedRoot)
  if ($registrationCommand -notmatch "^& 'codex' ") {
    throw "Manual registration command does not invoke the quoted Codex command."
  }
  $tokens = $null
  $parseErrors = $null
  [void][System.Management.Automation.Language.Parser]::ParseInput(
    $registrationCommand,
    [ref]$tokens,
    [ref]$parseErrors
  )
  if ($parseErrors.Count -ne 0) {
    throw "Manual registration command is not valid PowerShell: $($parseErrors -join '; ')"
  }

  $script:CapturedCodexArgs = @()
  function codex {
    $script:CapturedCodexArgs = @($args)
  }
  try {
    Invoke-Expression $registrationCommand
  } finally {
    Remove-Item Function:\codex -ErrorAction SilentlyContinue
  }
  $expectedRegistrationArgs = Get-CodexRegistrationArgs `
    -RootDir "C:\repo's tools" `
    -NodePath $nodePath `
    -ClaudePath $claudePath `
    -Policy "LocalHost" `
    -AllowedRoots @($allowedRoot)
  if (Compare-Object $expectedRegistrationArgs $script:CapturedCodexArgs -SyncWindow 0) {
    throw "Manual registration command did not preserve the exact Codex arguments."
  }
} finally {
  Remove-Item -LiteralPath $probeDir -Recurse -Force
}

Write-Host "install-windows ok"
