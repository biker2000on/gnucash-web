$procs = Get-Process -Name "node" -ErrorAction SilentlyContinue

if (-not $procs) {
    Write-Host "No node processes found."
    return
}

Write-Host "Found $($procs.Count) node process(es):`n"
$procs | Format-Table Id, ProcessName, CPU, @{L='Memory(MB)';E={[math]::Round($_.WorkingSet64/1MB,1)}}, Path -AutoSize

$confirm = Read-Host "`nKill all? (y/n)"
if ($confirm -eq 'y') {
    $procs | Stop-Process -Force
    Write-Host "`nAll node processes killed."
} else {
    Write-Host "Cancelled."
}
