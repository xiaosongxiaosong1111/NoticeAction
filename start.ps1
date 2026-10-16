param(
  [switch]$Live,
  [ValidateRange(1024, 65535)]
  [int]$Port = 43173
)

$ErrorActionPreference = 'Stop'

if (-not $Live) {
  node $PSScriptRoot\server.mjs --port $Port
  exit $LASTEXITCODE
}

$appId = Read-Host 'TextIn AppID'
$secureSecret = Read-Host 'TextIn Secret Code（输入不可见）' -AsSecureString
$secretPointer = [Runtime.InteropServices.Marshal]::SecureStringToBSTR($secureSecret)
try {
  $env:TEXTIN_APP_ID = $appId
  $env:TEXTIN_SECRET_CODE = [Runtime.InteropServices.Marshal]::PtrToStringBSTR($secretPointer)
  node $PSScriptRoot\server.mjs --port $Port
  exit $LASTEXITCODE
}
finally {
  [Runtime.InteropServices.Marshal]::ZeroFreeBSTR($secretPointer)
  Remove-Item Env:TEXTIN_APP_ID -ErrorAction SilentlyContinue
  Remove-Item Env:TEXTIN_SECRET_CODE -ErrorAction SilentlyContinue
}
