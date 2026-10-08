param(
    [string]$Host = "localhost",
    [int]$Port = 3000,
    [int]$Sockets = 200
)

Write-Host "Executando Slowloris..."
Write-Host "Host: $Host"
Write-Host "Porta: $Port"
Write-Host "Conexoes: $Sockets"

python slowloris.py $Host -p $Port -s $Sockets