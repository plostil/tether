# Allow the phone to reach the Tether broker on this PC (inbound TCP 8080).
# Run once, in an ADMIN PowerShell:  powershell -ExecutionPolicy Bypass -File scripts\allow-firewall.ps1
# Remove later with:                 Remove-NetFirewallRule -DisplayName 'Tether broker :8080'

$ruleName = 'Tether broker :8080'

$existing = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
if ($existing) {
    Write-Host "Firewall rule '$ruleName' already exists." -ForegroundColor Green
} else {
    New-NetFirewallRule -DisplayName $ruleName `
        -Direction Inbound -Protocol TCP -LocalPort 8080 `
        -Action Allow -Profile Private,Domain | Out-Null
    Write-Host "Firewall rule '$ruleName' created (Private/Domain networks only)." -ForegroundColor Green
}

Write-Host ""
Write-Host "This PC's Wi-Fi/LAN addresses (the phone opens http://<address>:8080):"
Get-NetIPAddress -AddressFamily IPv4 |
    Where-Object { $_.IPAddress -notlike '127.*' -and $_.IPAddress -notlike '169.254.*' } |
    ForEach-Object { Write-Host ("  http://{0}:8080  ({1})" -f $_.IPAddress, $_.InterfaceAlias) }
