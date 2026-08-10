# Stops the claude-monitor watchdog loop and the server it supervises.
# Order matters: kill the cmd loop first, otherwise it respawns node.
param([int]$Port = 4756)

$killed = $false

# 1. Watchdog loop (cmd.exe running run-server.cmd)
Get-CimInstance Win32_Process -Filter "Name='cmd.exe'" |
    Where-Object { $_.CommandLine -like '*run-server.cmd*' } |
    ForEach-Object {
        Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue
        "stopped watchdog PID $($_.ProcessId)"
        $script:killed = $true
    }

Start-Sleep -Milliseconds 300

# 2. Whatever still holds the monitor port
Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue |
    Select-Object -ExpandProperty OwningProcess -Unique |
    ForEach-Object {
        Stop-Process -Id $_ -Force -ErrorAction SilentlyContinue
        "stopped server PID $_ (port $Port)"
        $script:killed = $true
    }

if (-not $killed) { "nothing running on port $Port" }
