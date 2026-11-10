"""compose 네트워크 안의 TCP 포트 → Tailscale 사이드카를 거쳐 tailnet 의 host:port 로.

왜 필요한가: 사이드카는 userspace 모드라 다른 컨테이너에 tailnet 경로가 없다. 보통은
HTTP(S)_PROXY 로 해결하지만, Hermes 이미지의 게이트웨이는 s6 run 스크립트가 with-contenv 를
쓰지 않아 프로세스 환경이 PATH 하나뿐이다 — 환경변수로는 프록시를 알려줄 수 없다.
그래서 "프록시가 필요 없는 평범한 주소"를 만들어 준다: hermes 는 http://llm-tailnet:18000/v1 에
그냥 붙고, 이 프로세스가 사이드카의 HTTP 프록시로 CONNECT 터널을 뚫어 그대로 흘려보낸다.

평문 TCP 터널이라 HTTP 전용이다 (https 는 클라이언트가 이 호스트 이름의 인증서를 기대하므로
TLS 가 깨진다). setup.sh 가 http:// tailnet 주소일 때만 이 서비스를 붙인다.

환경값: FWD_LISTEN(기본 18000), FWD_TARGET(host:port), FWD_PROXY(host:port, 사이드카 HTTP 프록시)
별도 이미지를 쓰지 않는다 — Hermes 이미지의 Python 으로 실행한다 (compose.omni.yml 과 같은 방식).
"""
import asyncio
import os
import sys

LISTEN = int(os.environ.get("FWD_LISTEN", "18000"))
TARGET = os.environ.get("FWD_TARGET", "")
PROXY = os.environ.get("FWD_PROXY", "")


def split_hostport(value: str, what: str) -> tuple[str, int]:
    host, _, port = value.rpartition(":")
    if not host or not port.isdigit():
        sys.exit(f"[tailnet-forward] {what} 는 host:port 형식이어야 합니다: {value!r}")
    return host, int(port)


async def pump(reader: asyncio.StreamReader, writer: asyncio.StreamWriter) -> None:
    try:
        while chunk := await reader.read(65536):
            writer.write(chunk)
            await writer.drain()
    except (ConnectionError, asyncio.IncompleteReadError, OSError):
        pass
    finally:
        try:
            writer.close()
        except OSError:
            pass


async def handle(client_r: asyncio.StreamReader, client_w: asyncio.StreamWriter) -> None:
    up_r = up_w = None
    try:
        up_r, up_w = await asyncio.wait_for(asyncio.open_connection(proxy_host, proxy_port), 15)
        up_w.write(f"CONNECT {TARGET} HTTP/1.1\r\nHost: {TARGET}\r\n\r\n".encode())
        await up_w.drain()
        # 프록시 응답 헤더를 빈 줄까지 걷어낸다. 그 뒤부터는 투명한 TCP 터널.
        status = await asyncio.wait_for(up_r.readline(), 15)
        if b" 200 " not in status:
            raise ConnectionError(f"프록시가 터널을 거부했습니다: {status!r}")
        while (line := await asyncio.wait_for(up_r.readline(), 15)) not in (b"\r\n", b"\n", b""):
            pass
        await asyncio.gather(pump(client_r, up_w), pump(up_r, client_w))
    except (OSError, ConnectionError, asyncio.TimeoutError) as e:
        print(f"[tailnet-forward] {TARGET} 연결 실패: {e}", flush=True)
    finally:
        for w in (client_w, up_w):
            if w is not None:
                try:
                    w.close()
                except OSError:
                    pass


async def main() -> None:
    server = await asyncio.start_server(handle, "0.0.0.0", LISTEN)
    print(f"[tailnet-forward] :{LISTEN} → {TARGET} (프록시 {PROXY})", flush=True)
    async with server:
        await server.serve_forever()


if not TARGET or not PROXY:
    sys.exit("[tailnet-forward] FWD_TARGET 과 FWD_PROXY 가 필요합니다.")
target_host, target_port = split_hostport(TARGET, "FWD_TARGET")
proxy_host, proxy_port = split_hostport(PROXY, "FWD_PROXY")

try:
    asyncio.run(main())
except KeyboardInterrupt:
    pass
