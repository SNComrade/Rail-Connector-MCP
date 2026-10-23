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

# The upgrade lane uses plain copied-text files, synthetic endpoint responses
# and inert native API delegates. It never queries a real broker or RM session.
function Assert-GuardRejects {
  param([scriptblock]$Operation, [string]$Pattern)
  $rejected = $false
  try { & $Operation | Out-Null } catch {
    if ($_.Exception.Message -notmatch $Pattern) { throw }
    $rejected = $true
  }
  if (-not $rejected) { throw "Upgrade guard unexpectedly accepted: $Pattern" }
}

$fixtureRoot = Join-Path ([IO.Path]::GetTempPath()) ('rail-windows-upgrade-' + [guid]::NewGuid().ToString('N'))
[void][IO.Directory]::CreateDirectory($fixtureRoot)
$guardSuccess = $false
$originalFunctions = @{}
foreach ($name in @('Get-UpgradeBrokerEndpoint','Assert-UpgradeNativeFilesUnused','Get-UpgradeRestartManagerApi',
    'Assert-WindowsUpgradeSafety','Get-Command','Resolve-CodexExecutable','Invoke-NativeChecked','Resolve-InstallerExecutable','Get-InstallerNodeMajor')) {
  $existingFunction = Get-Command -Name $name -CommandType Function -ErrorAction SilentlyContinue
  $originalFunctions[$name] = if ($existingFunction) { $existingFunction.ScriptBlock } else { $null }
}
$originalVariables = @{}
foreach ($name in @('InstallerRoot','CheckOnly','TargetRoot','StateDirectory','ClientsClosed','CodexPath','BypassPolicy','AllowedRoot','RunTests')) {
  $originalVariables[$name] = Get-Variable -Name $name -ValueOnly -Scope Script
}
$originalLocation = Get-Location
$junction = $null
function New-GuardFixture {
  param([string]$Name, [switch]$Dependencies, [switch]$Token)
  $root = Join-Path $fixtureRoot $Name
  [void][IO.Directory]::CreateDirectory($root)
  [IO.File]::WriteAllText((Join-Path $root '.git'), 'inert fixture marker, not a Git repository')
  [IO.File]::WriteAllText((Join-Path $root 'package.json'), '{"name":"rail-connector-mcp"}')
  $state = Join-Path $fixtureRoot ($Name+'-state')
  if ($Token) {
    [void][IO.Directory]::CreateDirectory($state)
    [IO.File]::WriteAllText((Join-Path $state 'broker-token'), (('a'*64)+"`n"))
  }
  $native = Join-Path $root 'node_modules\node-pty\prebuilds\win32-x64\conpty.node'
  if ($Dependencies) {
    [void][IO.Directory]::CreateDirectory((Split-Path -Parent $native))
    [IO.File]::WriteAllText((Join-Path $root 'node_modules\node-pty\package.json'), '{"name":"node-pty","version":"1.2.0-beta.15"}')
    [IO.File]::WriteAllText($native, 'inert native-file sentinel; never loaded')
  }
  [IO.File]::WriteAllText((Join-Path $root 'replacement-sentinel'), 'unchanged')
  return [pscustomobject]@{Root=$root;State=$state;Native=$native;Sentinel=(Join-Path $root 'replacement-sentinel')}
}

try {
  foreach ($code in @('ENOENT','ECONNREFUSED','ECONNRESET','ECONNABORTED','EPIPE','ETIMEDOUT','ECLOSE','EOBSERVER','enoent','')) {
    $classified = Get-UpgradeEndpointClassification ([pscustomobject]@{connected=$false;errorCode=$code})
    $expected = if ($code -cin @('ENOENT','ECONNREFUSED')) { 'unavailable' } else { 'unknown' }
    if ($classified -cne $expected) { throw "Endpoint error classification failed for $code" }
  }
  if ((Get-UpgradeEndpointClassification ([pscustomobject]@{connected=$true;errorCode=$null})) -cne 'present' -or
      (Get-UpgradeEndpointClassification ([pscustomobject]@{connected='false';errorCode='ENOENT'})) -cne 'unknown' -or
      (Get-UpgradeEndpointClassification ([pscustomobject]@{connected=$false;errorCode='ENOENT';extra=$true})) -cne 'unknown') {
    throw 'Malformed/present endpoint observation was accepted.'
  }

  # Execute the actual observer JavaScript under an owned preload that replaces
  # net.createConnection with an inert socket before the script can import it.
  # No NODE_OPTIONS or host settings are changed; all paths/state are task-owned.
  $endpointFixture=New-GuardFixture -Name 'endpoint-observer' -Token
  $preload=Join-Path $fixtureRoot 'endpoint-net-mock.mjs'
  [IO.File]::WriteAllText($preload, @'
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import childProcess from "node:child_process";
import { EventEmitter } from "node:events";
import { syncBuiltinESMExports } from "node:module";
const state=fs.realpathSync(process.argv[2]);
const root=path.dirname(state);
if (!path.basename(root).startsWith("rail-windows-upgrade-") || path.basename(state)!=="endpoint-observer-state") throw new Error("Wrong observer fixture");
const selection=JSON.parse(fs.readFileSync(path.join(root,"endpoint-selection.json"),"utf8"));
for (const name of ["spawn","spawnSync","exec","execSync","execFile","execFileSync","fork"]) childProcess[name]=()=>{throw new Error("Observer attempted forbidden child startup")};
net.createConnection = () => {
  const socket=new EventEmitter();
  socket.destroy=()=>fs.appendFileSync(path.join(root,"endpoint-events.jsonl"),JSON.stringify({kind:"destroy",selection})+"\n");
  socket.write=()=>{throw new Error("Mock observer attempted a forbidden request")};
  fs.appendFileSync(path.join(root,"endpoint-events.jsonl"),JSON.stringify({kind:"mock-connect",selection})+"\n");
  queueMicrotask(()=>{
    if (selection==="connect") socket.emit("connect");
    else if (selection==="close") socket.emit("close");
    else if (selection!=="timeout") socket.emit("error",Object.assign(new Error("inert socket fault"),{code:selection}));
  });
  return socket;
};
syncBuiltinESMExports();
'@)
  $nodeExecutable=(Get-Command node -ErrorAction Stop).Source
  $clientFile=Join-Path $script:InstallerRoot 'src\windows-broker-client.js'
  if (-not (Test-Path -LiteralPath $clientFile)) {
    # The private repository's overlay is not a complete public candidate. Its
    # source/mock runner supplies one hash-bound, branded temporary module.
    $clientFile=$env:RAIL_CONNECTOR_INSTALLER_OBSERVER_CLIENT
    if (-not $clientFile) { throw 'Public observer fixture requires its branded client module.' }
  }
  [void](Read-UpgradeFile -Path $clientFile)
  $encoded=[Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes((Get-UpgradeEndpointObserverScript)))
  $bootstrap="await import('data:text/javascript;base64,$encoded')"
  $preloadUri=([uri]$preload).AbsoluteUri
  foreach ($selection in @('connect','ENOENT','ECONNREFUSED','ECONNRESET','ECONNABORTED','EPIPE','timeout','close')) {
    [IO.File]::WriteAllText((Join-Path $fixtureRoot 'endpoint-selection.json'), ('"'+$selection+'"'))
    $output=@(& $nodeExecutable --import $preloadUri --input-type=module -e $bootstrap $clientFile $endpointFixture.State)
    if ($LASTEXITCODE -ne 0 -or $output.Count -ne 1) { throw 'Inert observer child failed.' }
    $observed=Get-UpgradeEndpointClassification ([string]$output[0]|ConvertFrom-Json)
    $expected=if($selection -eq 'connect'){'present'}elseif($selection -in @('ENOENT','ECONNREFUSED')){'unavailable'}else{'unknown'}
    if ($observed -cne $expected) { throw "Actual observer classification failed for $selection" }
  }
  $events=@(Get-Content -LiteralPath (Join-Path $fixtureRoot 'endpoint-events.jsonl')|ForEach-Object{$_|ConvertFrom-Json})
  if (@($events|Where-Object kind -eq 'mock-connect').Count -ne 8 -or @($events|Where-Object kind -eq 'destroy').Count -ne 8) { throw 'Mock observer socket was not created/closed exactly once per case.' }

  # Managed declaration compilation/layout only: no P/Invoke method is called.
  $compiledApi = & $originalFunctions['Get-UpgradeRestartManagerApi']
  if ([Runtime.InteropServices.Marshal]::SizeOf([type]('RailUpgradeGuard.UniqueProcess' -as [type])) -ne 12 -or
      [Runtime.InteropServices.Marshal]::SizeOf([type]('RailUpgradeGuard.ProcessInfo' -as [type])) -ne 668) {
    throw 'Restart Manager declaration layout is wrong.'
  }
  $imports = @([RailUpgradeGuard.Native].GetMethods() | Where-Object { $_.DeclaringType -eq [RailUpgradeGuard.Native] } | ForEach-Object Name | Sort-Object)
  if (($imports -join ',') -cne 'RmEndSession,RmGetList,RmRegisterResources,RmStartSession') { throw 'Unexpected native API surface.' }
  Set-Item Function:Get-UpgradeRestartManagerApi -Value { throw 'REAL RESTART MANAGER IS FORBIDDEN IN MOCK TESTS' }

  foreach ($scenario in @('clear','start-error','start-throw','register-error','register-throw','get-error','get-throw',
      'reboot','owners','growth','shrunk','invalid-owner','too-many','end-error','end-throw')) {
    $control = [pscustomobject]@{Scenario=$scenario;Start=0;Register=0;Get=0;End=0;Paths=@()}
    $api = [pscustomobject]@{
      Start={
        $control.Start++
        if ($control.Scenario -eq 'start-throw') { throw 'synthetic start failure' }
        [pscustomobject]@{Code=$(if ($control.Scenario -eq 'start-error') {121}else{0});Handle=7}
      }.GetNewClosure()
      Register={ param($handle,$paths)
        $control.Register++; $control.Paths=@($paths)
        if ($control.Scenario -eq 'register-throw') { throw 'synthetic register failure' }
        if ($control.Scenario -eq 'register-error') { return 5 }; return 0
      }.GetNewClosure()
      Get={ param($handle,$capacity)
        $control.Get++
        if ($control.Scenario -eq 'get-throw') { throw 'synthetic list failure' }
        $record = [pscustomobject]@{Code=0;Needed=0;Count=0;Reasons=0;Owners=@()}
        if ($control.Scenario -eq 'get-error') { $record.Code=5 }
        if ($control.Scenario -eq 'reboot') { $record.Reasons=1 }
        if ($control.Scenario -eq 'too-many') { $record.Code=234; $record.Needed=257 }
        if ($control.Scenario -in @('owners','growth','shrunk','invalid-owner')) {
          $record.Needed=1
          if ($capacity -eq 0) { $record.Code=234 }
          elseif ($control.Scenario -eq 'growth') { $record.Code=234; $record.Needed=2 }
          elseif ($control.Scenario -eq 'shrunk') { $record.Needed=0 }
          else {
            $record.Count=1
            $record.Owners=@([pscustomobject]@{Pid=123;StartFileTime=$(if($control.Scenario -eq 'invalid-owner'){0}else{456789})})
          }
        }
        return $record
      }.GetNewClosure()
      End={ param($handle)
        $control.End++
        if ($control.Scenario -eq 'end-throw') { throw 'synthetic end failure' }
        if ($control.Scenario -eq 'end-error') { return 5 }; return 0
      }.GetNewClosure()
    }
    $operation = { & $originalFunctions['Assert-UpgradeNativeFilesUnused'] -Paths @('C:\inert\conpty.node') -Api $api }
    if ($scenario -eq 'clear') { & $operation } else { Assert-GuardRejects $operation 'Restart Manager|Native resource|Native dependency|synthetic' }
    $expectedEnd = if ($scenario -in @('start-error','start-throw')) {0}else{1}
    if ($control.Start -ne 1 -or $control.End -ne $expectedEnd -or $control.Get -gt 2) { throw "Native delegate lifecycle failed: $scenario" }
    if ($control.Register -gt 0 -and ($control.Paths -join ',') -cne 'C:\inert\conpty.node') { throw 'Wrong native resource registered.' }
  }

  $script:EndpointStatus='unavailable'; $script:EndpointCalls=0; $script:NativeCalls=0
  $script:NativeRefusal=$false; $script:NativeMutation=$null
  Set-Item Function:Get-UpgradeBrokerEndpoint -Value {
    param($NodePath,$StatePath) $script:EndpointCalls++; return $script:EndpointStatus
  }
  Set-Item Function:Assert-UpgradeNativeFilesUnused -Value {
    param($Paths,$Api) $script:NativeCalls++
    if ($script:NativeMutation) { & $script:NativeMutation }
    if ($script:NativeRefusal) { throw 'Native dependency resources still have owners (synthetic).' }
  }
  $fresh = New-GuardFixture -Name 'fresh'
  $ready = Assert-WindowsUpgradeSafety -RootDir $fresh.Root -NodePath 'C:\inert\node.exe' -SelectedState $fresh.State -ClosedClients
  if ($ready.Kind -ne 'fresh' -or $script:EndpointCalls -ne 0 -or $script:NativeCalls -ne 0) { throw 'Fresh install classification failed.' }
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $fresh.Root -NodePath 'C:\inert\node.exe' -SelectedState $fresh.State } 'ClientsClosed'
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $fresh.Root -NodePath 'C:\inert\node.exe' -SelectedState $fresh.State -ClosedClients -RequireDefaultState } 'custom-state'
  $existing = New-GuardFixture -Name 'existing' -Dependencies -Token
  $nativeBefore = (Read-UpgradeFile $existing.Native).Hash
  foreach ($status in @('present','unknown','reset','timeout')) {
    $script:EndpointStatus=$status; $beforeNative=$script:NativeCalls
    Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients } 'endpoint'
    if ($script:NativeCalls -ne $beforeNative) { throw 'Refused endpoint reached the native observer.' }
  }
  $script:EndpointStatus='unavailable'; $script:NativeRefusal=$true
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients } 'owners'
  $script:NativeRefusal=$false
  $ready=Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients
  if ($ready.Kind -ne 'existing' -or $ready.NativeResourceCount -ne 1) { throw 'Stopped existing installation failed qualification.' }
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients -ExpectedTargetIdentity 'different-target' } 'identity changed'
  $tokenPath=Join-Path $existing.State 'broker-token'
  [IO.File]::WriteAllText($tokenPath,'invalid')
  Assert-GuardRejects { Get-UpgradeSnapshot $existing.Root $existing.State } 'token is invalid'
  [IO.File]::Delete($tokenPath)
  Assert-GuardRejects { Get-UpgradeSnapshot $existing.Root $existing.State } 'no valid broker token'
  [IO.File]::WriteAllText($tokenPath,(('a'*64)+"`n"))
  $startLock=Join-Path $existing.State 'broker-start.lock'
  [IO.File]::WriteAllText($startLock,'inert')
  Assert-GuardRejects { Get-UpgradeSnapshot $existing.Root $existing.State } 'startup state'
  [IO.File]::Delete($startLock)
  $smallFile=Join-Path $fixtureRoot 'bounded-file'
  [IO.File]::WriteAllText($smallFile,'12345')
  Assert-GuardRejects { Read-UpgradeFile $smallFile -MaximumBytes 4 } 'size is unsupported'
  $script:NativeMutation = { [IO.File]::WriteAllText($existing.Native,'changed by inert observer') }
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients } 'inventory changed'
  [IO.File]::WriteAllText($existing.Native,'inert native-file sentinel; never loaded')
  $script:NativeMutation=$null
  if ((Read-UpgradeFile $existing.Native).Hash -ne $nativeBefore -or [IO.File]::ReadAllText($existing.Sentinel) -cne 'unchanged') { throw 'Refusal changed the sentinel.' }
  $newDependencies=New-GuardFixture -Name 'newly-installed' -Dependencies
  Assert-GuardRejects { Get-UpgradeSnapshot $newDependencies.Root $newDependencies.State } 'no valid broker token'
  $beforeEndpoint=$script:EndpointCalls; $beforeNative=$script:NativeCalls
  $ready=Assert-WindowsUpgradeSafety -RootDir $newDependencies.Root -NodePath 'C:\inert\node.exe' -SelectedState $newDependencies.State -ClosedClients -FreshInstallContinuation
  if ($ready.Kind -ne 'fresh-installed' -or $script:EndpointCalls -ne $beforeEndpoint -or $script:NativeCalls -ne $beforeNative+1) { throw 'Internal fresh-install second qualification failed.' }
  [void][IO.Directory]::CreateDirectory($newDependencies.State)
  $unknownState=Join-Path $newDependencies.State 'unknown-owner'
  [IO.File]::WriteAllText($unknownState,'inert')
  Assert-GuardRejects { Get-UpgradeSnapshot $newDependencies.Root $newDependencies.State -FreshInstallContinuation } 'no valid broker token'
  [IO.File]::Delete($unknownState)

  # Ordinary-file checks must reject hardlinks in both supported PowerShells.
  # Both names refer only to an inert task-owned text file, never a real module.
  $hardlink=Join-Path $fixtureRoot 'owned-hardlink'
  New-Item -ItemType HardLink -Path $hardlink -Target $smallFile -ErrorAction Stop | Out-Null
  Assert-GuardRejects { Read-UpgradeFile $hardlink } 'linked or reparse'
  Assert-GuardRejects { Read-UpgradeFile $smallFile } 'linked or reparse'
  [IO.File]::Delete($hardlink)
  [void](Read-UpgradeFile $smallFile)

  $script:NativeMutation = { [IO.File]::WriteAllText($tokenPath,(('b'*64)+"`n")) }
  Assert-GuardRejects { Assert-WindowsUpgradeSafety -RootDir $existing.Root -NodePath 'C:\inert\node.exe' -SelectedState $existing.State -ClosedClients } 'inventory changed'
  [IO.File]::WriteAllText($tokenPath,(('a'*64)+"`n"))
  $script:NativeMutation=$null

  $tooMany=New-GuardFixture -Name 'too-many-natives' -Dependencies -Token
  $nativeDirectory=Split-Path -Parent $tooMany.Native
  foreach ($number in 1..64) { [IO.File]::WriteAllText((Join-Path $nativeDirectory ('inert-'+$number+'.dll')),'inert') }
  Assert-GuardRejects { Get-UpgradeSnapshot $tooMany.Root $tooMany.State } 'inventory bound'

  # Reparse rejection uses an owned junction to another owned fixture directory.
  $junction=Join-Path $existing.Root 'node_modules\node-pty\owned-junction'
  $junctionCreated=$false
  try { New-Item -ItemType Junction -Path $junction -Target $fresh.Root -ErrorAction Stop | Out-Null; $junctionCreated=$true }
  catch { Write-Host 'upgrade guard junction fixture unavailable; no native-owner claim' }
  if ($junctionCreated) {
    Assert-GuardRejects { Get-UpgradeSnapshot $existing.Root $existing.State } 'linked or reparse'
    [IO.Directory]::Delete($junction)
    $junction=$null
  }

  # Top-level ordering: every external command is inert, including npm and Codex.
  $script:InstallerRoot=$existing.Root; $script:ClientsClosed=$true
  $script:CheckOnly=$false; $script:TargetRoot=''; $script:StateDirectory=''; $script:CodexPath=''; $script:BypassPolicy='Disabled'; $script:AllowedRoot=@(); $script:RunTests=$false
  $script:InstallEvents=[Collections.Generic.List[string]]::new(); $script:InstallGuardCount=0
  $script:InstallFailureAt=0; $script:InstallKind='existing'; $script:CapturedContinuation=$false
  Set-Item Function:Get-Command -Value { param($Name) [pscustomobject]@{Source=('C:\inert\'+$Name+'.exe')} }
  $script:ResolveNames=[Collections.Generic.List[string]]::new(); $script:ObservedMajor=24
  Set-Item Function:Resolve-InstallerExecutable -Value { param($Name,[switch]$NativeOnly)
    $script:ResolveNames.Add($Name)
    if ($Name -eq 'node' -and -not $NativeOnly) { throw 'Node discovery lost its NativeOnly pin.' }
    return ('C:\inert\'+$Name+'.exe')
  }
  Set-Item Function:Get-InstallerNodeMajor -Value { param($NodePath) return $script:ObservedMajor }
  Set-Item Function:Resolve-CodexExecutable -Value { param($PreferredPath) $script:InstallEvents.Add('resolve'); return 'C:\inert\codex.exe' }
  Set-Item Function:Invoke-NativeChecked -Value { param($Description,$Command) $script:InstallEvents.Add($Description) }
  Set-Item Function:Assert-WindowsUpgradeSafety -Value {
    param($RootDir,$NodePath,$SelectedState,[switch]$ClosedClients,[switch]$RequireDefaultState,[switch]$FreshInstallContinuation,$ExpectedTargetIdentity)
    $script:InstallGuardCount++; $script:InstallEvents.Add('guard'+$script:InstallGuardCount)
    if ($script:InstallGuardCount -eq 2) { $script:CapturedContinuation=[bool]$FreshInstallContinuation }
    if ($script:InstallGuardCount -eq $script:InstallFailureAt) { throw 'synthetic owner/state refusal' }
    [pscustomobject]@{Kind=$script:InstallKind;TargetRoot=$RootDir;TargetIdentity='inert-target-identity'}
  }
  Invoke-Installer | Out-Null
  if (($script:InstallEvents -join ',') -cne 'guard1,npm ci,npm run check,npm run smoke,resolve,guard2,Codex MCP registration,Codex MCP registration verification') { throw 'Installer command ordering is wrong.' }
  foreach ($phase in @(1,2)) {
    $script:InstallEvents.Clear(); $script:InstallGuardCount=0; $script:InstallFailureAt=$phase
    Assert-GuardRejects { Invoke-Installer } 'synthetic owner/state refusal'
    if (@($script:InstallEvents|Where-Object {$_ -like 'Codex MCP registration*'}).Count -ne 0 -or
        ($phase -eq 1 -and @($script:InstallEvents|Where-Object {$_ -like 'npm *'}).Count -ne 0)) { throw 'Refusal allowed replacement or registration.' }
  }
  $script:InstallFailureAt=0; $script:InstallKind='fresh'; $script:InstallGuardCount=0; $script:InstallEvents.Clear()
  Invoke-Installer | Out-Null
  if (-not $script:CapturedContinuation) { throw 'Fresh install did not bind its internal post-ci qualification.' }
  $script:RunTests=$true; $script:InstallGuardCount=0; $script:InstallEvents.Clear()
  Invoke-Installer | Out-Null
  if (-not $script:InstallEvents.Contains('npm test')) { throw 'RunTests lost full-suite validation.' }
  $script:RunTests=$false
  $script:CheckOnly=$true; $script:TargetRoot=$fresh.Root; $script:InstallGuardCount=0; $script:InstallEvents.Clear(); $script:ResolveNames.Clear()
  $inspection=Invoke-Installer
  if (($script:InstallEvents -join ',') -cne 'guard1' -or $inspection.TargetRoot -cne $fresh.Root) { throw 'CheckOnly performed an installation step or inspected the wrong target.' }
  if (($script:ResolveNames -join ',') -cne 'node') { throw 'CheckOnly performed Claude discovery.' }
  $script:ObservedMajor=20; $script:InstallGuardCount=0; $script:InstallEvents.Clear()
  Assert-GuardRejects { Invoke-Installer } 'Node.js major 22, 24, or 26'
  if ($script:InstallEvents.Count -ne 0) { throw 'Unsupported Node reached the guard or installation.' }
  $script:ObservedMajor=24
  $script:CheckOnly=$false; $script:InstallGuardCount=0; $script:InstallEvents.Clear()
  Assert-GuardRejects { Invoke-Installer } 'TargetRoot is supported only'
  if ($script:InstallEvents.Count -ne 0) { throw 'TargetRoot refusal performed an external command.' }
  if ([IO.File]::ReadAllText($existing.Sentinel) -cne 'unchanged') { throw 'Installer mocks changed the replacement sentinel.' }
  $guardSuccess=$true
  Write-Host 'upgrade guard mocks ok; no broker connection or Restart Manager API call executed'
} finally {
  foreach ($name in $originalFunctions.Keys) {
    if ($originalFunctions[$name]) { Set-Item -LiteralPath ('Function:'+ $name) -Value $originalFunctions[$name] }
    else { Remove-Item -LiteralPath ('Function:'+ $name) -ErrorAction SilentlyContinue }
  }
  foreach ($name in $originalVariables.Keys) { Set-Variable -Name $name -Value $originalVariables[$name] -Scope Script }
  Set-Location -LiteralPath $originalLocation.Path
  if ($junction -and (Test-Path -LiteralPath $junction)) { [IO.Directory]::Delete($junction) }
  $resolved=[IO.Path]::GetFullPath($fixtureRoot)
  $temporary=[IO.Path]::GetFullPath([IO.Path]::GetTempPath()).TrimEnd('\')+'\'
  if (-not $resolved.StartsWith($temporary,[StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($resolved) -notmatch '^rail-windows-upgrade-[a-f0-9]{32}$') { throw 'Owned fixture cleanup boundary failed.' }
  if ($guardSuccess) { Remove-Item -LiteralPath $resolved -Recurse -Force }
  else { Write-Host "Upgrade mock diagnostics preserved at $resolved" }
}

Write-Host "install-windows ok"
