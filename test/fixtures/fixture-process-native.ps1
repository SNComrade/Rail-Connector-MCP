[CmdletBinding()]
param(
  [ValidateSet('Inspect', 'Serve')][string]$Operation = 'Inspect',
  [int]$ProcessId,
  [int]$ControllerProcessId,
  [string]$ControllerCreationFileTime
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
function Write-InspectPhase(
  [ValidateSet('script-entry', 'before-add-type', 'after-add-type', 'open-process', 'read-identity', 'write-identity', 'exit-success', 'exit-error')]
  [string]$Phase
) {
  if ($Operation -eq 'Inspect') {
    [Console]::Error.WriteLine('[fixture-inspect] phase=' + $Phase)
    [Console]::Error.Flush()
  }
}
Write-InspectPhase 'script-entry'
$nativeSource = @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class PmeFixtureProcess {
  [DllImport("kernel32.dll")]
  public static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint GetProcessId(IntPtr process);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool DuplicateHandle(IntPtr sourceProcess, IntPtr sourceHandle, IntPtr targetProcess,
    out IntPtr targetHandle, uint desiredAccess, bool inherit, uint options);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool GetProcessTimes(IntPtr process, out long creation, out long exit, out long kernel, out long user);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool QueryFullProcessImageName(IntPtr process, uint flags, StringBuilder name, ref int length);
  [DllImport("kernel32.dll", SetLastError=true)]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool TerminateProcess(IntPtr process, uint exitCode);
  [DllImport("kernel32.dll", SetLastError=true)]
  public static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
  [DllImport("kernel32.dll")]
  [return: MarshalAs(UnmanagedType.Bool)]
  public static extern bool CloseHandle(IntPtr handle);
  [DllImport("shell32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern IntPtr CommandLineToArgvW(string commandLine, out int count);
  [DllImport("kernel32.dll")]
  private static extern IntPtr LocalFree(IntPtr memory);
  public static string[] Arguments(string commandLine) {
    int count;
    IntPtr memory = CommandLineToArgvW(commandLine, out count);
    if (memory == IntPtr.Zero) throw new InvalidOperationException("command line could not be parsed");
    try {
      string[] result = new string[count];
      for (int i = 0; i < count; i++) result[i] = Marshal.PtrToStringUni(Marshal.ReadIntPtr(memory, i * IntPtr.Size));
      return result;
    } finally { LocalFree(memory); }
  }
}
'@

function Write-Message($Value) {
  [Console]::Out.WriteLine(($Value | ConvertTo-Json -Compress -Depth 8))
  [Console]::Out.Flush()
}

function Read-CreationFileTime([IntPtr]$Handle) {
  [long]$created = 0; [long]$exited = 0; [long]$kernel = 0; [long]$user = 0
  if (-not [PmeFixtureProcess]::GetProcessTimes($Handle, [ref]$created, [ref]$exited, [ref]$kernel, [ref]$user)) {
    throw 'GetProcessTimes failed'
  }
  # FILETIME exceeds JavaScript's safe integer range. Never emit it as a number.
  return $created.ToString([Globalization.CultureInfo]::InvariantCulture)
}

function Read-Identity([IntPtr]$Handle) {
  $created = Read-CreationFileTime $Handle
  $length = 32768
  $name = New-Object Text.StringBuilder $length
  if (-not [PmeFixtureProcess]::QueryFullProcessImageName($Handle, 0, $name, [ref]$length)) {
    throw 'QueryFullProcessImageName failed'
  }
  return @{ creationFileTime = $created; executablePath = $name.ToString() }
}

function Test-ProcessLive([IntPtr]$Handle) {
  $wait = [PmeFixtureProcess]::WaitForSingleObject($Handle, 0)
  if ($wait -eq 0) { return $false }
  if ($wait -eq 258) { return $true }
  throw 'retained process liveness is unreadable'
}

try {
  Write-InspectPhase 'before-add-type'
  Add-Type -TypeDefinition $nativeSource | Out-Null
  Write-InspectPhase 'after-add-type'
  if ($Operation -eq 'Inspect') {
    if ($ProcessId -le 0) { throw 'a positive process ID is required' }
    # Query and synchronization only: recording a fixture never grants termination.
    Write-InspectPhase 'open-process'
    $handle = [PmeFixtureProcess]::OpenProcess(0x101000, $false, $ProcessId)
    if ($handle -eq [IntPtr]::Zero) { throw 'fixture process identity could not be opened' }
    try {
      Write-InspectPhase 'read-identity'
      $identity = Read-Identity $handle
      if ($ControllerProcessId -gt 0) {
        if ($identity.creationFileTime -notmatch '^[1-9][0-9]{0,18}$' -or $ControllerCreationFileTime -notmatch '^[1-9][0-9]{0,18}$' -or
            [PmeFixtureProcess]::GetProcessId($handle) -ne $ProcessId) { throw 'invalid fixture capture identity' }
        $controllerHandle = [PmeFixtureProcess]::OpenProcess(0x101040, $false, $ControllerProcessId)
        if ($controllerHandle -eq [IntPtr]::Zero) { throw 'fixture controller could not be opened' }
        try {
          if ([PmeFixtureProcess]::GetProcessId($controllerHandle) -ne $ControllerProcessId -or
              (Read-CreationFileTime $controllerHandle) -cne $ControllerCreationFileTime -or
              -not (Test-ProcessLive $controllerHandle)) { throw 'fixture controller generation is unproven' }
          $remoteHandle = [IntPtr]::Zero
          # Only query/synchronize rights, no inheritance or source-close flags.
          if (-not [PmeFixtureProcess]::DuplicateHandle([PmeFixtureProcess]::GetCurrentProcess(), $handle,
              $controllerHandle, [ref]$remoteHandle, 0x101000, $false, 0)) { throw 'original fixture handle could not be retained' }
          if ($remoteHandle.ToInt64() -le 0) { throw 'invalid retained fixture handle' }
          $identity.controllerPid = $ControllerProcessId
          $identity.controllerCreationFileTime = $ControllerCreationFileTime
          $identity.holderHandle = $remoteHandle.ToInt64().ToString('x16', [Globalization.CultureInfo]::InvariantCulture)
          # Never close a handle value in the remote controller. It remains
          # read-only until that short-lived controller process exits.
        } finally { [void][PmeFixtureProcess]::CloseHandle($controllerHandle) }
      } elseif (-not [string]::IsNullOrEmpty($ControllerCreationFileTime)) { throw 'invalid fixture controller' }
      Write-InspectPhase 'write-identity'
      Write-Message $identity
    }
    finally { [void][PmeFixtureProcess]::CloseHandle($handle) }
    Write-InspectPhase 'exit-success'
    exit 0
  }

  $request = [Console]::In.ReadLine() | ConvertFrom-Json
  if ($request.version -ne 1 -or $null -eq $request.records -or $request.controllerPid -le 0 -or
      $request.controllerCreationFileTime -notmatch '^[1-9][0-9]{0,18}$') { throw 'invalid fixture cleanup request' }
  foreach ($record in @($request.records)) {
    $handle = [IntPtr]::Zero
    $originalHandle = [IntPtr]::Zero
    $controllerHandle = [IntPtr]::Zero
    $canTerminate = $false
    try {
      [int]$fixturePid = $record.pid
      if ($fixturePid -le 0) { throw 'invalid fixture process ID' }
      $originalProven = $false
      try {
        # The controller authenticates the immutable record BEFORE sending any
        # source handle here. Never duplicate arbitrary disk-provided handles.
        if ($record.state -cne 'ready' -or $record.controllerPid -ne $request.controllerPid -or
            $record.controllerCreationFileTime -cne $request.controllerCreationFileTime -or
            $record.creationFileTime -notmatch '^[1-9][0-9]{0,18}$' -or
            $record.holderHandle -cnotmatch '^[0-7][0-9a-f]{15}$' -or $record.holderHandle -ceq '0000000000000000') {
          throw 'retained original metadata is unproven'
        }
        $controllerHandle = [PmeFixtureProcess]::OpenProcess(0x101040, $false, [int]$request.controllerPid)
        if ($controllerHandle -eq [IntPtr]::Zero -or [PmeFixtureProcess]::GetProcessId($controllerHandle) -ne $request.controllerPid -or
            (Read-CreationFileTime $controllerHandle) -cne $request.controllerCreationFileTime -or
            -not (Test-ProcessLive $controllerHandle)) { throw 'retained original controller is unproven' }
        $sourceHandle = [IntPtr]::new([Convert]::ToInt64($record.holderHandle, 16))
        if (-not [PmeFixtureProcess]::DuplicateHandle($controllerHandle, $sourceHandle,
            [PmeFixtureProcess]::GetCurrentProcess(), [ref]$originalHandle, 0x101000, $false, 0)) {
          throw 'retained original could not be observed'
        }
        # Check type/PID and exact birth before using a signaled state as proof.
        if ([PmeFixtureProcess]::GetProcessId($originalHandle) -ne $fixturePid -or
            (Read-CreationFileTime $originalHandle) -cne $record.creationFileTime) { throw 'retained original identity changed' }
        if (-not (Test-ProcessLive $originalHandle)) {
          Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone'; proof = 'retained-original' }
          continue
        }
        $originalProven = $true
      } catch { $live = @{ error = 'retained original is unreadable'; errorPhase = 'retained-original' } }
      if ($originalProven) {
      # This same handle remains open from inspection through termination and wait.
      $handle = [PmeFixtureProcess]::OpenProcess(0x101001, $false, $fixturePid)
      if ($handle -eq [IntPtr]::Zero) {
        $openError = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
        if (($openError -eq 87 -or $openError -eq 1168) -and -not (Test-ProcessLive $originalHandle)) {
          Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone'; proof = 'retained-original' }
          continue
        }
        $live = @{ error = 'process identity is unreadable'; errorPhase = 'open-process'; errorCode = $openError }
        if ($openError -eq 5) {
          # Access denial may still permit observation. This same limited handle
          # can only exclude ownership or prove exit; it never grants termination.
          $handle = [PmeFixtureProcess]::OpenProcess(0x101000, $false, $fixturePid)
          if ($handle -eq [IntPtr]::Zero) {
            $live.observationErrorCode = [Runtime.InteropServices.Marshal]::GetLastWin32Error()
          } else {
            try {
              if (-not (Test-ProcessLive $handle)) {
                Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
                continue
              }
              # No image or PID-only CIM query is needed to compare births.
              # Keep the original access error even when birth observation works.
              $live.creationFileTime = Read-CreationFileTime $handle
              if (-not (Test-ProcessLive $handle)) {
                Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
                continue
              }
            } catch {
              # A failed read is not proof of exit. Only this retained handle's
              # signaled state may establish gone; otherwise error5 stays unproven.
              try {
                if (-not (Test-ProcessLive $handle)) {
                  Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
                  continue
                }
              } catch { }
            }
          }
        }
      } elseif (-not (Test-ProcessLive $handle)) {
        $canTerminate = $true
        Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
        continue
      } else {
        $canTerminate = $true
        $diagnosticBirth = $null
        try {
          $identityPhase = 'read-identity'
          $live = Read-Identity $handle
          $diagnosticBirth = $live.creationFileTime
          $identityPhase = 'query-command-line'
          $row = Get-CimInstance Win32_Process -Filter ('ProcessId=' + $fixturePid)
          if ($null -eq $row -or [string]::IsNullOrEmpty($row.CommandLine)) { throw 'command line is unreadable' }
          $identityPhase = 'parse-command-line'
          $live.argv = @([PmeFixtureProcess]::Arguments($row.CommandLine))
          # A live retained handle before and after CIM binds its PID-only argv
          # query to this exact process. An exited handle can never be reused.
          $identityPhase = 'recheck-liveness'
          if (-not (Test-ProcessLive $handle)) {
            Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
            continue
          }
        } catch { $live = @{ error = 'process identity is unreadable'; errorPhase = $identityPhase; creationFileTime = $diagnosticBirth } }
      }

      }
      if ($originalProven -and $live.error) {
        # An exit during a failed fresh lookup is still observable through the
        # already PID/birth-validated original. Unknown waits stay unproven.
        try {
          if (-not (Test-ProcessLive $originalHandle)) {
            Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone'; proof = 'retained-original' }
            continue
          }
        } catch { }
      }
      Write-Message @{ type = 'inspect'; recordId = $record.recordId; live = $live }
      $decisionLine = [Console]::In.ReadLine()
      if ($null -eq $decisionLine) { throw 'cleanup controller disconnected' }
      $decision = $decisionLine | ConvertFrom-Json
      if ($decision.recordId -cne $record.recordId -or $decision.action -notin @('leave', 'terminate')) {
        throw 'invalid fixture cleanup decision'
      }
      if ($decision.action -eq 'leave') {
        Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'left' }
        continue
      }
      if (-not $canTerminate -or $handle -eq [IntPtr]::Zero) {
        throw 'termination requires a termination-capable retained process handle'
      }
      if (-not (Test-ProcessLive $handle)) {
        Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'gone' }
        continue
      }
      if (-not [PmeFixtureProcess]::TerminateProcess($handle, 1)) {
        if (Test-ProcessLive $handle) { throw 'fixture termination failed' }
      }
      if ([PmeFixtureProcess]::WaitForSingleObject($handle, 5000) -ne 0) { throw 'fixture process did not exit' }
      Write-Message @{ type = 'result'; recordId = $record.recordId; state = 'terminated' }
    } finally {
      if ($handle -ne [IntPtr]::Zero) { [void][PmeFixtureProcess]::CloseHandle($handle) }
      if ($originalHandle -ne [IntPtr]::Zero) { [void][PmeFixtureProcess]::CloseHandle($originalHandle) }
      if ($controllerHandle -ne [IntPtr]::Zero) { [void][PmeFixtureProcess]::CloseHandle($controllerHandle) }
    }
  }
  Write-Message @{ type = 'done' }
} catch {
  Write-InspectPhase 'exit-error'
  Write-Message @{ type = 'fatal'; message = $_.Exception.Message }
  exit 1
}
