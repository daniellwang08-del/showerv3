# Run once as Administrator to allow other devices on your local network to reach the dev servers.
# Usage (PowerShell as Admin):  .\scripts\open_lan_firewall.ps1

$ErrorActionPreference = 'Stop'

$rules = @(
    @{ Name = 'Job Scraper Frontend (5173)'; Port = 5173 }
)

foreach ($rule in $rules) {
    $existing = Get-NetFirewallRule -DisplayName $rule.Name -ErrorAction SilentlyContinue
    if ($existing) {
        Write-Host "Rule already exists: $($rule.Name)"
        continue
    }
    New-NetFirewallRule `
        -DisplayName $rule.Name `
        -Direction Inbound `
        -Action Allow `
        -Protocol TCP `
        -LocalPort $rule.Port `
        -Profile Private, Domain | Out-Null
    Write-Host "Added firewall rule: $($rule.Name)"
}

Write-Host "Done. Other devices can use http://<your-lan-ip>:5173"
