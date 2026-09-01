# Bring up the iOS 17+ developer tunnel so Tether's 'hid' backend can drive the
# iPhone with NO app installed (docs/IOS-CONTROL.md).
#
# Run in an ADMIN PowerShell (the tunnel daemon creates a TUN interface):
#   powershell -ExecutionPolicy Bypass -File scripts\ios-tunnel.ps1
#
# One-time on the iPhone (no download): tap "Trust This Computer" on first USB
# connect, and enable Settings > Privacy & Security > Developer Mode (reboot +
# confirm). Re-run this after a phone reboot (the Developer Disk Image unmounts).

$ErrorActionPreference = 'Stop'

# 1. Verify pymobiledevice3 is installed (PC-side; nothing on the phone).
$pmd3 = Get-Command pymobiledevice3 -ErrorAction SilentlyContinue
if (-not $pmd3) {
    Write-Host "pymobiledevice3 not found. Install it on the PC with:" -ForegroundColor Yellow
    Write-Host "    pip install -U pymobiledevice3" -ForegroundColor Yellow
    exit 1
}

# 2. Mount the Apple-signed Developer Disk Image (auto-downloaded on the PC).
Write-Host "Mounting the Developer Disk Image..." -ForegroundColor Cyan
pymobiledevice3 mounter auto-mount

# 3. Start the tunnel daemon. Leave this window open while you use iOS control;
#    Tether's backend auto-discovers the device via `--tunnel ''`.
Write-Host ""
Write-Host "Starting the RSD tunnel daemon (keep this window open)..." -ForegroundColor Cyan
Write-Host "Sanity check in another terminal:" -ForegroundColor DarkGray
Write-Host "    pymobiledevice3 developer core-device get-display-info --tunnel ''" -ForegroundColor DarkGray
Write-Host ""
pymobiledevice3 remote tunneld
