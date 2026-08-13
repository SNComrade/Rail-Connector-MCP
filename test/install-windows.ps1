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
