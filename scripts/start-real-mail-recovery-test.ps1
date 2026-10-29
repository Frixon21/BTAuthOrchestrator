# Test-only launcher. Key is entered masked, passed only to the child process,
# never written to .env, command arguments, shell history, source or a log.
param([ValidateRange(1,65535)][int]$Port = 43210)
$ErrorActionPreference = 'Stop'
$repoRoot = Split-Path -Parent $PSScriptRoot
$runnerPath = Join-Path $PSScriptRoot 'real-mail-recovery-test.js'
if (-not (Test-Path -LiteralPath (Join-Path $repoRoot 'dist/index.js'))) { throw 'Run npm run build first.' }
$nodePath = (Get-Command node -CommandType Application).Source
Write-Host 'Local isolated test: one email attempt to alex@trustbiztech.com from Notifications@trustbiztech.com.'
Write-Host 'No email is sent at startup; you trigger it from the local Forgot password page.'
$secureKey = Read-Host 'Dedicated Resend key (masked; do not paste into chat)' -AsSecureString
$keyPointer = [IntPtr]::Zero
$startInfo = New-Object System.Diagnostics.ProcessStartInfo
$startInfo.FileName = $nodePath
$startInfo.WorkingDirectory = $repoRoot
$startInfo.UseShellExecute = $false
# Share this terminal so Ctrl+C reaches the test server; no new window is created.
$startInfo.CreateNoWindow = $false
# Windows filenames cannot contain quotes. Arguments contain no secret.
$startInfo.Arguments = '"' + $runnerPath + '" --send-real-mail --port=' + $Port
try {
  $keyPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureKey)
  $startInfo.EnvironmentVariables['BT_RECOVERY_TEST_RESEND_KEY'] = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($keyPointer)
  $child = [System.Diagnostics.Process]::Start($startInfo)
} finally {
  $startInfo.EnvironmentVariables.Remove('BT_RECOVERY_TEST_RESEND_KEY')
  if ($keyPointer -ne [IntPtr]::Zero) { [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($keyPointer) }
  $secureKey.Dispose()
}
try { $child.WaitForExit(); exit $child.ExitCode } finally { $child.Dispose() }
