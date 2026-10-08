#!/bin/bash

HOST=${1:-localhost}
PORT=${2:-3000}
SOCKETS=${3:-200}

echo "Executando Slowloris..."
echo "Host: $HOST"
echo "Porta: $PORT"
echo "Conexões: $SOCKETS"

python3 slowloris.py "$HOST" -p "$PORT" -s "$SOCKETS"