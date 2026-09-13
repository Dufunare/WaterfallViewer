param(
    [Parameter(Mandatory = $true)]
    [string]$MediaRoot,

    [ValidateRange(1, 100)]
    [int]$Runs = 5,

    [ValidateRange(0, 100)]
    [int]$Warmups = 1,

    [ValidateRange(16, 4096)]
    [int]$MaxEdge = 256,

    [string]$OutputRoot = "acceptance-results"
)

$ErrorActionPreference = "Stop"

$resolvedMediaRoot = (Resolve-Path -LiteralPath $MediaRoot).Path
if (-not (Test-Path -LiteralPath $resolvedMediaRoot -PathType Container)) {
    throw "MediaRoot is not a directory: $resolvedMediaRoot"
}

$timestamp = Get-Date -Format "yyyyMMdd-HHmmss"
$outputDir = Join-Path $OutputRoot "real-corpus-$timestamp"
New-Item -ItemType Directory -Path $outputDir -Force | Out-Null

function Invoke-CargoBenchmark {
    param(
        [Parameter(Mandatory = $true)]
        [string]$Example,

        [Parameter(Mandatory = $true)]
        [string]$OutputFile,

        [string[]]$ExtraArgs = @()
    )

    $cargoArgs = @(
        "run",
        "--release",
        "--manifest-path", "crates/Cargo.toml",
        "-p", "waterfall-infra",
        "--example", $Example,
        "--",
        $resolvedMediaRoot,
        "--runs", $Runs,
        "--warmups", $Warmups
    ) + $ExtraArgs

    Write-Host "Running $Example..."
    & cargo @cargoArgs 2>&1 | Tee-Object -FilePath $OutputFile
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Example failed with exit code $exitCode. See $OutputFile"
    }
}

$gitCommit = "unknown"
try {
    $gitCommit = (git rev-parse HEAD 2>$null).Trim()
} catch {
    $gitCommit = "unknown"
}

$rustVersion = "unknown"
try {
    $rustVersion = (rustc --version 2>$null).Trim()
} catch {
    $rustVersion = "unknown"
}

$cargoVersion = "unknown"
try {
    $cargoVersion = (cargo --version 2>$null).Trim()
} catch {
    $cargoVersion = "unknown"
}

$osCaption = [System.Runtime.InteropServices.RuntimeInformation]::OSDescription
$architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture
$processorCount = [Environment]::ProcessorCount

@"
WaterfallViewer real-corpus baseline
captured_at: $(Get-Date -Format o)
git_commit: $gitCommit
media_root: $resolvedMediaRoot
runs: $Runs
warmups: $Warmups
thumbnail_max_edge: $MaxEdge
os: $osCaption
architecture: $architecture
logical_processors: $processorCount
rustc: $rustVersion
cargo: $cargoVersion

Interpretation note:
These measurements are local comparative evidence, not machine-independent CI thresholds.
Keep storage type, power mode, thermal conditions and major corpus changes comparable when
using two captures for before/after performance decisions.
"@ | Set-Content -Encoding utf8 (Join-Path $outputDir "environment.txt")

Invoke-CargoBenchmark -Example "scan_bench" -OutputFile (Join-Path $outputDir "scan-bench.txt")
Invoke-CargoBenchmark -Example "media_detail_bench" -OutputFile (Join-Path $outputDir "media-detail-bench.txt")
Invoke-CargoBenchmark -Example "thumbnail_bench" -OutputFile (Join-Path $outputDir "thumbnail-bench.txt") -ExtraArgs @("--max-edge", $MaxEdge)

Write-Host ""
Write-Host "Real-corpus baseline captured at: $outputDir"
Write-Host "Record storage type and any relevant power/thermal conditions alongside this directory."
