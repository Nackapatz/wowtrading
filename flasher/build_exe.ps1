# Lokaler Build von WoWScannerFlasher.exe (Windows, PowerShell).
# Voraussetzung: Python 3.11 mit tkinter. Die Firmware wird aus firmware\.pio\build\nodemcuv2\
# übernommen, falls vorhanden; sonst muss flasher\firmware.bin bereits liegen.
$ErrorActionPreference = "Stop"

$here = Split-Path -Parent $MyInvocation.MyCommand.Path
$root = Split-Path -Parent $here
Set-Location $here

python -m pip install --upgrade pip
python -m pip install -r requirements.txt pyinstaller pytest

$firmwareBuild = Join-Path $root "firmware\.pio\build\nodemcuv2\firmware.bin"
if (Test-Path $firmwareBuild) {
    Copy-Item $firmwareBuild -Destination (Join-Path $here "firmware.bin") -Force
    Write-Host "Firmware kopiert: $firmwareBuild"
} elseif (-not (Test-Path (Join-Path $here "firmware.bin"))) {
    throw "firmware.bin fehlt. Bitte zuerst 'pio run -d firmware' ausführen."
}

python -m pytest -q $here
if ($LASTEXITCODE -ne 0) { throw "Tests fehlgeschlagen." }

python -m PyInstaller --onefile --windowed --noconfirm --clean `
    --name WoWScannerFlasher `
    --add-data "firmware.bin;." `
    --paths $here `
    --collect-submodules esptool `
    --collect-submodules serial `
    flasher.py
if ($LASTEXITCODE -ne 0) { throw "PyInstaller fehlgeschlagen." }

Write-Host "Fertig: $(Join-Path $here 'dist\WoWScannerFlasher.exe')"
