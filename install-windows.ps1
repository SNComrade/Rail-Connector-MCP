param(
  [ValidateSet("Disabled", "LocalHost", "Isolated")]
  [string]$BypassPolicy = "Disabled",
  [string]$CodexPath = "",
  [string[]]$AllowedRoot = @(),
  [switch]$RunTests
)

$ErrorActionPreference = "Stop"
$script:InstallerRoot = Split-Path -Parent $PSCommandPath
$script:BypassPolicyEnvironment = "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS"
$script:ClaudePathEnvironment = "RAIL_CONNECTOR_CLAUDE_PATH"
$script:AllowedRootsEnvironment = "RAIL_CONNECTOR_ALLOWED_ROOTS"

function Resolve-AllowedRootsValue {
  param(
    [string[]]$Roots = @()
  )

  $resolved = foreach ($root in $Roots) {
    if (-not (Test-Path -LiteralPath $root -PathType Container)) {
      throw "Allowed root is not an existing directory: $root"
    }
    (Resolve-Path -LiteralPath $root -ErrorAction Stop).Path
  }
  return ($resolved -join [System.IO.Path]::PathSeparator)
}

function Get-BypassPolicyValue {
  param(
    [Parameter(Mandatory = $true)]
    [ValidateSet("Disabled", "LocalHost", "Isolated")]
    [string]$Policy
  )

  switch ($Policy) {
    "LocalHost" { return "I_UNDERSTAND_BYPASS_CAN_MODIFY_MY_HOST_WITHOUT_PROMPTS" }
    "Isolated" { return "I_UNDERSTAND_THIS_REQUIRES_ISOLATION" }
    default { return "" }
  }
}

function Get-CodexRegistrationArgs {
  param(
    [Parameter(Mandatory = $true)]
    [string]$RootDir,
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$ClaudePath,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Disabled", "LocalHost", "Isolated")]
    [string]$Policy,
    [string[]]$AllowedRoots = @()
  )

  $arguments = @("mcp", "add", "rail-connector")
  $arguments += @("--env", "$script:ClaudePathEnvironment=$ClaudePath")
  $policyValue = Get-BypassPolicyValue -Policy $Policy
  if ($policyValue) {
    $arguments += @("--env", "$script:BypassPolicyEnvironment=$policyValue")
  }
  $allowedRootsValue = Resolve-AllowedRootsValue -Roots $AllowedRoots
  if ($allowedRootsValue) {
    $arguments += @("--env", "$script:AllowedRootsEnvironment=$allowedRootsValue")
  }
  $arguments += @("--", $NodePath, (Join-Path $RootDir "src\index.js"))
  return $arguments
}

function Invoke-NativeChecked {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Description,
    [Parameter(Mandatory = $true)]
    [scriptblock]$Command
  )

  & $Command
  $exitCode = $LASTEXITCODE
  if ($null -ne $exitCode -and $exitCode -ne 0) {
    throw "$Description failed with native exit code $exitCode."
  }
}

function Test-CodexExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Path
  )

  try {
    & $Path --version *> $null
    return $LASTEXITCODE -eq 0
  } catch {
    return $false
  }
}

function Resolve-CodexExecutable {
  param(
    [AllowEmptyString()]
    [string]$PreferredPath = ""
  )

  $candidates = [System.Collections.Generic.List[string]]::new()
  if ($PreferredPath) {
    try {
      $preferred = Get-Command $PreferredPath -ErrorAction Stop
      if ($preferred.Source) {
        $candidates.Add($preferred.Source)
      }
    } catch {
      throw "The requested Codex CLI path could not be resolved: $PreferredPath"
    }
  } else {
    $pathCommand = Get-Command codex -ErrorAction SilentlyContinue
    if ($pathCommand -and $pathCommand.Source) {
      $candidates.Add($pathCommand.Source)
    }
    $desktopCli = Join-Path $HOME ".codex\.sandbox-bin\codex.exe"
    if (Test-Path -LiteralPath $desktopCli -PathType Leaf) {
      $candidates.Add($desktopCli)
    }
  }

  $seen = @{}
  foreach ($candidate in $candidates) {
    $key = [System.IO.Path]::GetFullPath($candidate).ToLowerInvariant()
    if ($seen.ContainsKey($key)) {
      continue
    }
    $seen[$key] = $true
    if (Test-CodexExecutable -Path $candidate) {
      return [System.IO.Path]::GetFullPath($candidate)
    }
  }

  if ($PreferredPath) {
    throw "The requested Codex CLI failed its --version probe: $PreferredPath"
  }
  return $null
}

function ConvertTo-PowerShellLiteral {
  param(
    [Parameter(Mandatory = $true)]
    [AllowEmptyString()]
    [string]$Value
  )

  return "'$($Value.Replace("'", "''"))'"
}

function Format-CodexRegistrationCommand {
  param(
    [Parameter(Mandatory = $true)]
    [string]$CodexExecutable,
    [Parameter(Mandatory = $true)]
    [string]$RootDir,
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$ClaudePath,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Disabled", "LocalHost", "Isolated")]
    [string]$Policy,
    [string[]]$AllowedRoots = @()
  )

  $registrationArgs = Get-CodexRegistrationArgs `
    -RootDir $RootDir `
    -NodePath $NodePath `
    -ClaudePath $ClaudePath `
    -Policy $Policy `
    -AllowedRoots $AllowedRoots
  $registrationTokens = @($CodexExecutable) + $registrationArgs |
    ForEach-Object { ConvertTo-PowerShellLiteral -Value $_ }
  return "& $($registrationTokens -join ' ')"
}

function Write-ManualCodexRegistration {
  param(
    [AllowEmptyString()]
    [string]$CodexExecutable = "",
    [Parameter(Mandatory = $true)]
    [string]$RootDir,
    [Parameter(Mandatory = $true)]
    [string]$NodePath,
    [Parameter(Mandatory = $true)]
    [string]$ClaudePath,
    [Parameter(Mandatory = $true)]
    [ValidateSet("Disabled", "LocalHost", "Isolated")]
    [string]$Policy,
    [string[]]$AllowedRoots = @()
  )

  Write-Host ""
  Write-Warning "Skipped automatic Codex registration."
  if ($CodexExecutable) {
    Write-Host "Register this MCP from the same native Windows Codex environment with:"
    $registrationCommand = Format-CodexRegistrationCommand `
      -CodexExecutable $CodexExecutable `
      -RootDir $RootDir `
      -NodePath $NodePath `
      -ClaudePath $ClaudePath `
      -Policy $Policy `
      -AllowedRoots $AllowedRoots
    Write-Host "  $registrationCommand"
  } else {
    Write-Host "No Codex CLI candidate passed an executable --version probe."
  }
  Write-Host ""
  Write-Host "Use the Codex Desktop app's MCP/server configuration UI:"
  Write-Host "  Name: rail-connector"
  Write-Host "  Command: $NodePath"
  Write-Host "  Args: $RootDir\src\index.js"
  Write-Host "  Environment: $script:ClaudePathEnvironment=$ClaudePath"
  $policyValue = Get-BypassPolicyValue -Policy $Policy
  if ($policyValue) {
    Write-Host "  Environment: $script:BypassPolicyEnvironment=$policyValue"
  } else {
    Write-Host "  Environment: remove or unset $script:BypassPolicyEnvironment"
  }
  $allowedRootsValue = Resolve-AllowedRootsValue -Roots $AllowedRoots
  if ($allowedRootsValue) {
    Write-Host "  Environment: $script:AllowedRootsEnvironment=$allowedRootsValue"
  }
}

function Invoke-Installer {
  Write-Host "Rail Connector MCP - Native Windows installer"
  Write-Host ""

  foreach ($command in @("node", "npm", "claude")) {
    if (-not (Get-Command $command -CommandType Application, ExternalScript -ErrorAction SilentlyContinue)) {
      throw "Missing $command. Install and authenticate native Windows Node.js and Claude Code before continuing."
    }
  }

  $rootDir = $script:InstallerRoot
  $nodePath = (Get-Command node -CommandType Application, ExternalScript -ErrorAction Stop).Source
  $claudePath = (Get-Command claude -CommandType Application, ExternalScript -ErrorAction Stop).Source
  foreach ($resolvedCommand in @(
    @{ Name = "node"; Path = $nodePath },
    @{ Name = "claude"; Path = $claudePath }
  )) {
    if ([string]::IsNullOrWhiteSpace($resolvedCommand.Path) -or
        -not (Test-Path -LiteralPath $resolvedCommand.Path -PathType Leaf)) {
      throw "Resolved $($resolvedCommand.Name) command is not an executable file: $($resolvedCommand.Path)"
    }
  }
  $nodeMajor = [int]((& $nodePath -p "Number(process.versions.node.split('.')[0])").Trim())
  if ($nodeMajor -notin @(22, 24, 26)) {
    throw "Node.js major 22, 24, or 26 is required. Current version: $(& $nodePath --version)"
  }
  Set-Location $rootDir

  Invoke-NativeChecked -Description "npm ci" -Command { npm ci }
  Invoke-NativeChecked -Description "npm run check" -Command { npm run check }
  Invoke-NativeChecked -Description "npm run smoke" -Command { npm run smoke }
  if ($RunTests) {
    Invoke-NativeChecked -Description "npm test" -Command { npm test }
  } else {
    Write-Host "Skipped the full test suite. Re-run with -RunTests for complete local validation."
  }

  $codexExecutable = Resolve-CodexExecutable -PreferredPath $CodexPath
  if ($codexExecutable) {
    try {
      $registrationArgs = Get-CodexRegistrationArgs `
        -RootDir $rootDir `
        -NodePath $nodePath `
        -ClaudePath $claudePath `
        -Policy $BypassPolicy `
        -AllowedRoots $AllowedRoot
      Invoke-NativeChecked -Description "Codex MCP registration" -Command {
        & $codexExecutable @registrationArgs
      }
      Write-Host ""
      Write-Host "Registered MCP server as: rail-connector"
      try {
        Invoke-NativeChecked -Description "Codex MCP registration verification" -Command {
          & $codexExecutable mcp get rail-connector
        }
      } catch {
        Write-Warning "Registration succeeded, but Codex could not read it back: $($_.Exception.Message)"
      }
      Write-Host "Open a fresh native Windows Codex task so a new MCP process inherits this registration."
      Write-Host "Then confirm tools appear under mcp__rail_connector."
    } catch {
      Write-Host ""
      Write-Warning "Codex CLI registration failed: $($_.Exception.Message)"
      Write-ManualCodexRegistration `
        -CodexExecutable $codexExecutable `
        -RootDir $rootDir `
        -NodePath $nodePath `
        -ClaudePath $claudePath `
        -Policy $BypassPolicy `
        -AllowedRoots $AllowedRoot
    }
  } else {
    Write-ManualCodexRegistration `
      -CodexExecutable "" `
      -RootDir $rootDir `
      -NodePath $nodePath `
      -ClaudePath $claudePath `
      -Policy $BypassPolicy `
      -AllowedRoots $AllowedRoot
  }
}

if ($env:RAIL_CONNECTOR_INSTALLER_TEST -ne "1") {
  Invoke-Installer
}
