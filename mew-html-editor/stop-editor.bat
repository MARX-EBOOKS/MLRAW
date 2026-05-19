@echo off
powershell -NoProfile -ExecutionPolicy Bypass -Command "$pids = @(Get-NetTCPConnection -LocalPort 4127 -ErrorAction SilentlyContinue | Select-Object -ExpandProperty OwningProcess -Unique); if (!$pids.Count) { Write-Host 'MEW editor is not running on port 4127.'; exit 0 }; foreach ($procId in $pids) { Stop-Process -Id $procId -Force; Write-Host \"Stopped MEW editor process $procId.\" }"
