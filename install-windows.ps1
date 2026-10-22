param(
  [ValidateSet("Disabled", "LocalHost", "Isolated")]
  [string]$BypassPolicy = "Disabled",
  [string]$CodexPath = "",
  [string[]]$AllowedRoot = @(),
  [switch]$RunTests,
  [switch]$CheckOnly,
  [string]$TargetRoot = "",
  [string]$StateDirectory = "",
  [switch]$ClientsClosed
)

$ErrorActionPreference = "Stop"
$script:InstallerRoot = Split-Path -Parent $PSCommandPath
$script:BypassPolicyEnvironment = "RAIL_CONNECTOR_ALLOW_BYPASS_PERMISSIONS"
$script:ClaudePathEnvironment = "RAIL_CONNECTOR_CLAUDE_PATH"
$script:AllowedRootsEnvironment = "RAIL_CONNECTOR_ALLOWED_ROOTS"

function Assert-UpgradeOrdinaryPath {
  param([string]$Path, [switch]$AllowMissing)
  if ($Path -notmatch '^[A-Za-z]:[\\/]' -or $Path -match '[\x00\r\n]') {
    throw "Upgrade guard requires an absolute local drive path."
  }
  $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
  if ($full.Length -eq 2) { $full += '\' }
  $cursor = $full
  $first = $true
  while ($cursor) {
    if (Test-Path -LiteralPath $cursor) {
      $item = Get-Item -LiteralPath $cursor -Force -ErrorAction Stop
      $link = $item.PSObject.Properties['LinkType']
      if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0 -or
          ($link -and $link.Value)) { throw "Upgrade guard refuses linked or reparse paths." }
      if (-not $first -and -not $item.PSIsContainer) { throw "Upgrade guard path ancestor is not a directory." }
    } elseif ($first -and -not $AllowMissing) {
      throw "Upgrade guard target is unavailable."
    }
    $parent = Split-Path -Parent $cursor
    if ($parent -eq $cursor) { break }
    $cursor = $parent
    $first = $false
  }
  return $full
}

function Read-UpgradeFile {
  param([string]$Path, [long]$MaximumBytes = 1048576)
  $full = Assert-UpgradeOrdinaryPath -Path $Path
  $before = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  if ($before.PSIsContainer -or $before.Length -gt $MaximumBytes) { throw "Upgrade guard file type or size is unsupported." }
  $bytes = New-Object byte[] ([int]$before.Length)
  $stream = [IO.File]::Open($full, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
  try {
    $offset = 0
    while ($offset -lt $bytes.Length) {
      $read = $stream.Read($bytes, $offset, $bytes.Length-$offset)
      if ($read -eq 0) { break }
      $offset += $read
    }
    if ($offset -ne $bytes.Length -or $stream.ReadByte() -ne -1) { throw "Upgrade guard file changed size while reading." }
  } finally { $stream.Dispose() }
  $after = Get-Item -LiteralPath $full -Force -ErrorAction Stop
  [void](Assert-UpgradeOrdinaryPath -Path $full)
  if ($bytes.Length -ne $before.Length -or $after.Length -ne $before.Length -or
      $after.CreationTimeUtc.Ticks -ne $before.CreationTimeUtc.Ticks -or
      $after.LastWriteTimeUtc.Ticks -ne $before.LastWriteTimeUtc.Ticks) { throw "Upgrade guard file changed while reading." }
  $hasher = [Security.Cryptography.SHA256]::Create()
  try { $hash = [BitConverter]::ToString($hasher.ComputeHash($bytes)).Replace('-', '').ToLowerInvariant() }
  finally { $hasher.Dispose() }
  return [pscustomobject]@{ Path=$full; Bytes=$bytes; Hash=$hash; Length=$bytes.Length;
    Created=$before.CreationTimeUtc.Ticks; Written=$before.LastWriteTimeUtc.Ticks }
}

function Get-UpgradeStateSelection {
  param([string]$Selected = "")
  $homeDirectory = [Environment]::GetFolderPath('UserProfile')
  $default = [IO.Path]::GetFullPath((Join-Path $homeDirectory '.rail-connector-mcp\state\v1'))
  $chosen = $default
  if ($env:RAIL_CONNECTOR_STATE_DIR) { $chosen = $env:RAIL_CONNECTOR_STATE_DIR }
  if ($Selected) { $chosen = $Selected }
  $full = Assert-UpgradeOrdinaryPath -Path $chosen -AllowMissing
  if ((Test-Path -LiteralPath $full) -and -not (Get-Item -LiteralPath $full).PSIsContainer) {
    throw "Upgrade state path is not an ordinary directory."
  }
  return [pscustomobject]@{ Path=$full; IsCustom=(-not $full.Equals($default, [StringComparison]::OrdinalIgnoreCase)) }
}

function Get-UpgradeSnapshot {
  param([string]$RootDir, [string]$StatePath, [switch]$FreshInstallContinuation)
  $root = Assert-UpgradeOrdinaryPath -Path $RootDir
  if (-not (Get-Item -LiteralPath $root).PSIsContainer) { throw "Upgrade target is not a directory." }
  [void](Assert-UpgradeOrdinaryPath -Path (Join-Path $root '.git'))
  $package = Read-UpgradeFile -Path (Join-Path $root 'package.json')
  $metadata = [Text.Encoding]::UTF8.GetString($package.Bytes) | ConvertFrom-Json
  if ($metadata.name -ne 'rail-connector-mcp') { throw "Upgrade target package identity is unsupported." }
  $records = [Collections.Generic.List[string]]::new()
  $rootInfo = Get-Item -LiteralPath $root -Force
  $records.Add("root|$($rootInfo.CreationTimeUtc.Ticks)")
  $records.Add("package|$($package.Hash)|$($package.Created)|$($package.Written)")
  $state = Assert-UpgradeOrdinaryPath -Path $StatePath -AllowMissing
  if (Test-Path -LiteralPath $state) {
    $stateInfo = Get-Item -LiteralPath $state -Force
    if (-not $stateInfo.PSIsContainer) { throw "Upgrade state path is not a directory." }
    $records.Add("state|$($stateInfo.CreationTimeUtc.Ticks)|$($stateInfo.LastWriteTimeUtc.Ticks)")
  } else { $records.Add('state|absent') }
  $lock = Join-Path $state 'broker-start.lock'
  if (Test-Path -LiteralPath $lock) { throw "Broker startup state is present; stop and reconcile it through its old owner." }
  $tokenPath = Join-Path $state 'broker-token'
  $tokenPresent = Test-Path -LiteralPath $tokenPath
  if ($tokenPresent) {
    $token = Read-UpgradeFile -Path $tokenPath -MaximumBytes 1024
    if ([Text.Encoding]::UTF8.GetString($token.Bytes).Trim() -notmatch '^[0-9a-fA-F]{64}$') {
      throw "Broker token is invalid; the upgrade guard will not replace or repair it."
    }
    $records.Add("token|$($token.Hash)|$($token.Created)|$($token.Written)")
  } else { $records.Add('token|absent') }
  $modules = Join-Path $root 'node_modules'
  $native = [Collections.Generic.List[string]]::new()
  $kind = 'existing'
  if (-not (Test-Path -LiteralPath $modules)) {
    if ($tokenPresent -or -not (Test-UpgradeStateEmpty -StatePath $state)) {
      throw "Dependencies are absent but existing broker state is present; installation identity is unknown."
    }
    $kind = 'fresh'
    $records.Add('dependencies|absent')
  } else {
    [void](Assert-UpgradeOrdinaryPath -Path $modules)
    if (-not $tokenPresent) {
      if (-not $FreshInstallContinuation -or -not (Test-UpgradeStateEmpty -StatePath $state)) {
        throw "Existing dependencies have no valid broker token; old runtime ownership is unknown."
      }
      $kind = 'fresh-installed'
    }
    $ptyRoot = Assert-UpgradeOrdinaryPath -Path (Join-Path $modules 'node-pty')
    $ptyPackage = Read-UpgradeFile -Path (Join-Path $ptyRoot 'package.json')
    $ptyMetadata = [Text.Encoding]::UTF8.GetString($ptyPackage.Bytes) | ConvertFrom-Json
    if ($ptyMetadata.name -ne 'node-pty' -or $ptyMetadata.version -notmatch '^\d+\.\d+\.\d+([-+][A-Za-z0-9.-]+)?$') {
      throw "Existing node-pty package identity is unsupported."
    }
    $records.Add("node-pty|$($ptyPackage.Hash)|$($ptyPackage.Created)|$($ptyPackage.Written)")
    $pending = [Collections.Generic.Stack[object]]::new()
    $pending.Push([pscustomobject]@{Path=$ptyRoot;Depth=0})
    $entries = 0; [long]$total = 0
    while ($pending.Count) {
      $directory = $pending.Pop()
      if ($directory.Depth -gt 8) { throw "Dependency inventory depth bound exceeded." }
      $iterator = [IO.Directory]::EnumerateFileSystemEntries($directory.Path).GetEnumerator()
      try { while ($iterator.MoveNext()) {
        $entries++
        if ($entries -gt 2048) { throw "Dependency inventory entry bound exceeded." }
        $item = Get-Item -LiteralPath $iterator.Current -Force -ErrorAction Stop
        [void](Assert-UpgradeOrdinaryPath -Path $item.FullName)
        if ($item.PSIsContainer) {
          $pending.Push([pscustomobject]@{Path=$item.FullName;Depth=($directory.Depth+1)})
        } elseif ($item.Extension.ToLowerInvariant() -in @('.node','.dll','.exe')) {
          $file = Read-UpgradeFile -Path $item.FullName -MaximumBytes 33554432
          $total += $file.Length
          if ($native.Count -ge 64 -or $total -gt 134217728) { throw "Native dependency inventory bound exceeded." }
          $native.Add($file.Path)
          $records.Add("native|$($file.Path.ToLowerInvariant())|$($file.Hash)|$($file.Length)|$($file.Created)|$($file.Written)")
        }
      } } finally { $iterator.Dispose() }
    }
    if ($native.Count -eq 0 -or @($native | Where-Object { [IO.Path]::GetFileName($_) -eq 'conpty.node' }).Count -eq 0) {
      throw "Existing Windows native dependency inventory is incomplete."
    }
  }
  return [pscustomobject]@{ Root=$root; State=$state; Kind=$kind; TokenPresent=$tokenPresent;
    TargetIdentity=("$($root.ToLowerInvariant())|$($rootInfo.CreationTimeUtc.Ticks)|$($package.Hash)|$($package.Created)|$($package.Written)");
    NativeFiles=@($native|Sort-Object); Signature=([string]::Join("`n", @($records|Sort-Object))) }
}

function Test-UpgradeStateEmpty {
  param([string]$StatePath)
  if (-not (Test-Path -LiteralPath $StatePath)) { return $true }
  $iterator = [IO.Directory]::EnumerateFileSystemEntries($StatePath).GetEnumerator()
  try { return -not $iterator.MoveNext() } finally { $iterator.Dispose() }
}

function Get-UpgradeEndpointObserverScript {
  # Only built-ins and the reviewed client's path derivation are used. No
  # request, token transmission, startup, cleanup or native PTY load occurs.
  return @'
import fs from "node:fs";
import net from "node:net";
import { pathToFileURL } from "node:url";
const [client, state] = process.argv.slice(1);
try {
  const { windowsBrokerPaths } = await import(pathToFileURL(client).href);
  const env = { ...process.env, RAIL_CONNECTOR_STATE_DIR: state };
  const tokenFile = windowsBrokerPaths(env).tokenFile;
  const info = fs.lstatSync(tokenFile);
  if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1 || info.size > 1024) throw new Error();
  const token = fs.readFileSync(tokenFile, "utf8").trim();
  if (!/^[a-f0-9]{64}$/i.test(token)) throw new Error();
  const result = await new Promise((resolve) => {
    const socket = net.createConnection(windowsBrokerPaths(env, token).pipeName);
    let done = false;
    const finish = (connected, errorCode) => { if (done) return; done = true; clearTimeout(timer); socket.destroy(); resolve({ connected, errorCode }); };
    const timer = setTimeout(() => finish(false, "ETIMEDOUT"), 2000);
    socket.once("connect", () => finish(true, null));
    socket.once("error", error => finish(false, /^[A-Z][A-Z0-9_]{0,63}$/.test(error.code) ? error.code : "EOBSERVER"));
    socket.once("close", () => { if (!done) finish(false, "ECLOSE"); });
  });
  console.log(JSON.stringify(result));
} catch { console.log(JSON.stringify({ connected: false, errorCode: "EOBSERVER" })); }
'@
}

function Get-UpgradeBrokerEndpoint {
  param([string]$NodePath, [string]$StatePath)
  $observer = Get-UpgradeEndpointObserverScript
  $client = Join-Path $script:InstallerRoot 'src\windows-broker-client.js'
  [void](Read-UpgradeFile -Path $client)
  # A data URL avoids Windows PowerShell5.1's lossy quoting of double quotes in
  # a multiline native -e argument. Paths remain separate native arguments.
  $encoded = [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($observer))
  $bootstrap = "await import('data:text/javascript;base64,$encoded')"
  $lines = @(& $NodePath --input-type=module -e $bootstrap $client $StatePath 2>$null)
  if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 1 -or ([Text.Encoding]::UTF8.GetByteCount([string]$lines[0])) -gt 256) {
    throw "Broker endpoint observation failed."
  }
  $result = [string]$lines[0] | ConvertFrom-Json
  return Get-UpgradeEndpointClassification -Observation $result
}

function Get-UpgradeEndpointClassification {
  param($Observation)
  if ($null -eq $Observation -or $Observation.connected -isnot [bool] -or
      (@($Observation.PSObject.Properties.Name | Sort-Object) -join ',') -cne 'connected,errorCode') { return 'unknown' }
  if ($Observation.connected) {
    if ($null -ne $Observation.errorCode) { return 'unknown' }
    return 'present'
  }
  if ($Observation.errorCode -is [string] -and $Observation.errorCode -cin @('ENOENT','ECONNREFUSED')) { return 'unavailable' }
  return 'unknown'
}

function Get-UpgradeRestartManagerApi {
  # Compiling these declarations does not call an API. Invoking the adapter
  # below creates transient Windows session/registry state; it is not zero-write.
  if (-not ('RailUpgradeGuard.Native' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
namespace RailUpgradeGuard {
  [StructLayout(LayoutKind.Sequential)] public struct FileTime { public uint Low; public uint High; }
  [StructLayout(LayoutKind.Sequential)] public struct UniqueProcess {
    public uint ProcessId; public FileTime StartTime;
  }
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)] public struct ProcessInfo {
    public UniqueProcess Process;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=256)] public string AppName;
    [MarshalAs(UnmanagedType.ByValTStr, SizeConst=64)] public string ServiceName;
    public int AppType; public uint AppStatus; public uint SessionId;
    [MarshalAs(UnmanagedType.Bool)] public bool Restartable;
  }
  public static class Native {
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern uint RmStartSession(out uint handle, uint flags, StringBuilder key);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern uint RmRegisterResources(uint handle, uint files, [In, MarshalAs(UnmanagedType.LPArray, ArraySubType=UnmanagedType.LPWStr, SizeParamIndex=1)] string[] paths, uint apps, IntPtr processes, uint services, IntPtr names);
    [DllImport("rstrtmgr.dll", CharSet=CharSet.Unicode)] public static extern uint RmGetList(uint handle, out uint needed, ref uint count, [In, Out] ProcessInfo[] rows, out uint reasons);
    [DllImport("rstrtmgr.dll")] public static extern uint RmEndSession(uint handle);
  }
}
'@ -ErrorAction Stop
  }
  return [pscustomobject]@{
    Start={ [uint32]$handle=0; $key=New-Object Text.StringBuilder 33; $code=[RailUpgradeGuard.Native]::RmStartSession([ref]$handle,0,$key); [pscustomobject]@{Code=$code;Handle=$handle} }
    Register={ param($handle,$paths) [RailUpgradeGuard.Native]::RmRegisterResources($handle,$paths.Count,[string[]]$paths,0,[IntPtr]::Zero,0,[IntPtr]::Zero) }
    Get={ param($handle,$capacity)
      [uint32]$needed=0; [uint32]$count=$capacity; [uint32]$reasons=0; $rows=$null
      if ($capacity -gt 0) { $rows=New-Object 'RailUpgradeGuard.ProcessInfo[]' $capacity }
      $code=[RailUpgradeGuard.Native]::RmGetList($handle,[ref]$needed,[ref]$count,$rows,[ref]$reasons)
      $owners=@()
      if ($code -eq 0 -and $count -le $capacity) {
        for ($i=0; $i -lt $count; $i++) {
          $stamp=$rows[$i].Process.StartTime
          $birth=([uint64]$stamp.High -shl 32) -bor [uint64]$stamp.Low
          $owners += [pscustomobject]@{Pid=$rows[$i].Process.ProcessId;StartFileTime=$birth}
        }
      }
      [pscustomobject]@{Code=$code;Needed=$needed;Count=$count;Reasons=$reasons;Owners=$owners}
    }
    End={ param($handle) [RailUpgradeGuard.Native]::RmEndSession($handle) }
  }
}

function Assert-UpgradeNativeFilesUnused {
  param([string[]]$Paths, $Api=$null)
  if ($Paths.Count -eq 0 -or $Paths.Count -gt 64) { throw "Native resource query has an invalid bound." }
  if ($null -eq $Api) { $Api=Get-UpgradeRestartManagerApi }
  $started=$false; $failure=$null; $endFailure=$false; $handle=0
  try {
    $start=& $Api.Start
    if ($start.Code -ne 0) { throw "Restart Manager session start failed (code $($start.Code))." }
    $handle=$start.Handle; $started=$true
    $code=& $Api.Register $handle $Paths
    if ($code -ne 0) { throw "Restart Manager resource registration failed (code $code)." }
    $list=& $Api.Get $handle 0
    if ($list.Reasons -ne 0) { throw "Restart Manager reports an unresolved reboot reason." }
    if ($list.Code -eq 234 -and $list.Needed -ge 1 -and $list.Needed -le 256) {
      $capacity=$list.Needed
      $list=& $Api.Get $handle $capacity
      if ($list.Code -ne 0 -or $list.Reasons -ne 0 -or $list.Count -gt $capacity -or
          $list.Count -ne $capacity -or @($list.Owners).Count -ne $list.Count) {
        throw "Native resource owner inventory changed or could not be established."
      }
      foreach ($owner in @($list.Owners)) {
        if ($owner.Pid -le 0 -or $owner.StartFileTime -le 0) { throw "Native resource owner identity is incomplete." }
      }
      $identities = @($list.Owners | ForEach-Object { "$($_.Pid)/$($_.StartFileTime)" }) -join ', '
      throw "Native dependency resources still have owners (PID/start FILETIME: $identities); stop through their known owner and rerun the guard."
    }
    if ($list.Code -ne 0 -or $list.Needed -ne 0 -or $list.Count -ne 0 -or @($list.Owners).Count -ne 0) {
      throw "Native resource owner observation is uncertain."
    }
  } catch { $failure=$_ }
  finally {
    if ($started) {
      try { if ((& $Api.End $handle) -ne 0) { $endFailure=$true } } catch { $endFailure=$true }
    }
  }
  if ($endFailure) { throw "Restart Manager session cleanup failed; no replacement is permitted." }
  if ($failure) { throw $failure }
}

function Assert-WindowsUpgradeSafety {
  param([string]$RootDir, [string]$NodePath, [string]$SelectedState="", [switch]$ClosedClients, [switch]$RequireDefaultState,
    [switch]$FreshInstallContinuation, [string]$ExpectedTargetIdentity="")
  if (-not $ClosedClients) { throw "Stop affected sessions and the old broker, close clients and rerun with -ClientsClosed; this assertion cannot override failed evidence." }
  $state=Get-UpgradeStateSelection -Selected $SelectedState
  if ($RequireDefaultState -and $state.IsCustom) { throw "Automatic custom-state registration is unsupported; use CheckOnly for inspection/offline prerequisites and preserve the existing registration." }
  $before=Get-UpgradeSnapshot -RootDir $RootDir -StatePath $state.Path -FreshInstallContinuation:$FreshInstallContinuation
  if ($ExpectedTargetIdentity -and $before.TargetIdentity -cne $ExpectedTargetIdentity) { throw "Upgrade target identity changed between installation phases." }
  if ($before.TokenPresent) {
    $endpoint=Get-UpgradeBrokerEndpoint -NodePath $NodePath -StatePath $state.Path
    if ($endpoint -ne 'unavailable') { throw "Broker endpoint is present or uncertain; stop and reconcile it through the old MCP before replacement." }
  }
  if (@($before.NativeFiles).Count -gt 0) {
    Assert-UpgradeNativeFilesUnused -Paths $before.NativeFiles
  }
  $after=Get-UpgradeSnapshot -RootDir $RootDir -StatePath $state.Path -FreshInstallContinuation:$FreshInstallContinuation
  if ($before.Root -cne $after.Root -or $before.State -cne $after.State -or
      $before.Kind -cne $after.Kind -or $before.Signature -cne $after.Signature) { throw "Upgrade target or dependency/state inventory changed during qualification." }
  return [pscustomobject]@{ TargetRoot=$after.Root; StateDirectory=$after.State; Kind=$after.Kind;
    TargetIdentity=$after.TargetIdentity; NativeResourceCount=@($after.NativeFiles).Count; ObservedAt=[DateTime]::UtcNow.ToString('o') }
}

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

function Resolve-InstallerExecutable {
  param(
    [Parameter(Mandatory = $true)]
    [string]$Name,
    [switch]$NativeOnly
  )

  # The persisted Node command must be native. Claude also supports batch shims.
  $supportedExtensions = @(".exe", ".com")
  if (-not $NativeOnly) { $supportedExtensions += @(".cmd", ".bat") }
  # Filter before selecting: a PowerShell shim can shadow a usable batch shim.
  $command = Get-Command $Name -CommandType Application -All -ErrorAction SilentlyContinue |
    Where-Object { [System.IO.Path]::GetExtension($_.Source) -in $supportedExtensions } |
    Select-Object -First 1
  if (-not $command -or [string]::IsNullOrWhiteSpace($command.Source)) {
    throw "Missing supported executable command: $Name"
  }
  $path = [System.IO.Path]::GetFullPath($command.Source)
  if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
    throw "Resolved $Name command is not an executable file: $path"
  }
  return $path
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

function Get-InstallerNodeMajor {
  param([string]$NodePath)
  $lines = @(& $NodePath -p "Number(process.versions.node.split('.')[0])")
  if ($LASTEXITCODE -ne 0 -or $lines.Count -ne 1 -or [string]$lines[0] -notmatch '^\d{1,3}$') {
    throw "The native Node.js major-version probe failed."
  }
  return [int]$lines[0]
}

function Invoke-Installer {
  Write-Host "Rail Connector MCP - Native Windows installer"
  Write-Host ""

  if ($TargetRoot -and -not $CheckOnly) { throw "TargetRoot is supported only with CheckOnly; installation always targets this checkout." }
  $commands = @('node')
  if (-not $CheckOnly) { $commands += @('npm','claude') }
  foreach ($command in $commands) {
    if (-not (Get-Command $command -CommandType Application, ExternalScript -ErrorAction SilentlyContinue)) {
      throw "Missing $command. Install and authenticate native Windows Node.js and Claude Code before continuing."
    }
  }

  $rootDir = $script:InstallerRoot
  if ($TargetRoot) { $rootDir = $TargetRoot }
  $nodePath = Resolve-InstallerExecutable -Name "node" -NativeOnly
  $nodeMajor = Get-InstallerNodeMajor -NodePath $nodePath
  if ($nodeMajor -notin @(22, 24, 26)) {
    throw "Node.js major 22, 24, or 26 is required. Observed major: $nodeMajor"
  }
  Write-Host "The guard never stops a broker or repairs state. A native-owner query uses transient Windows Restart Manager session/registry state."
  $initial = Assert-WindowsUpgradeSafety -RootDir $rootDir -NodePath $nodePath -SelectedState $StateDirectory `
    -ClosedClients:$ClientsClosed -RequireDefaultState:(-not $CheckOnly)
  if ($CheckOnly) {
    Write-Host "CheckOnly: no dependency/configuration replacement. Keep clients closed; this observation is not an atomic runtime lock."
    return $initial
  }
  $claudePath = Resolve-InstallerExecutable -Name "claude"
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
  # Internal fresh-install continuation requires the successful pre-ci observation
  # and completed ci/check/smoke/tests; it is not a public bypass flag.
  [void](Assert-WindowsUpgradeSafety -RootDir $rootDir -NodePath $nodePath -SelectedState $StateDirectory `
    -ClosedClients:$ClientsClosed -RequireDefaultState -FreshInstallContinuation:($initial.Kind -eq 'fresh') `
    -ExpectedTargetIdentity $initial.TargetIdentity)
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
