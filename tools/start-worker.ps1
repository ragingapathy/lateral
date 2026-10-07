# Starts the Lateral transcription worker in the background (Windows).
# Reads the token from data\podcast-worker.json so Lateral and the worker always agree.
$root = Split-Path -Parent $PSScriptRoot
$cfg = Get-Content (Join-Path $root 'data\podcast-worker.json') -Raw | ConvertFrom-Json
$py = Join-Path $PSScriptRoot '.venv\Scripts\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
$env:LATERAL_WORKER_TOKEN = $cfg.token
Start-Process -WindowStyle Hidden -FilePath $py -ArgumentList @((Join-Path $PSScriptRoot 'transcribe_worker.py')) -WorkingDirectory $root
Write-Host 'Lateral transcription worker starting on port 3007.'
