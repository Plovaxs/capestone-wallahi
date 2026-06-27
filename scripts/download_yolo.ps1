# PowerShell helper to download YOLO model using huggingface-cli
# Requires: Python + pip + huggingface_hub installed and `huggingface-cli login` executed

if (-not (Get-Command huggingface-cli -ErrorAction SilentlyContinue)) {
    Write-Error "huggingface-cli not found. Install it with: pip install huggingface_hub"
    exit 1
}

$target = "public/models/yolov8n-face"
Write-Host "Downloading Xenova/yolov8n-face into $target"

huggingface-cli repo download Xenova/yolov8n-face -o $target

if ($LASTEXITCODE -eq 0) {
    Write-Host "Download complete. Confirm files under $target"
} else {
    Write-Error "Download failed. Check your Hugging Face credentials and network access."
}
