# Hermes (self-hosted)

[Hermes Agent](https://github.com/NousResearch/hermes-agent)를 Docker로 띄워 **Hermes Desktop의 원격 백엔드**로 쓰기 위한 설정입니다.

- **모델**: OpenAI 호환 엔드포인트. 기본값은 GLM-5.3-Flash(vLLM)이며 `.env`에서 바꿉니다.
- **GPU**: nvidia 런타임이 있는 머신이면 모든 GPU를 자동으로 연결하고, 없으면 GPU 없이 실행합니다.
- **Docker**: 호스트의 `docker.sock`을 연결해서 에이전트가 호스트 Docker로 컨테이너를 띄울 수 있습니다.
- **Tailscale**: 사이드카 컨테이너가 머신마다 `hermes-<호스트명>` tailnet 노드를 띄워 tailnet에만 `:9119`를 노출합니다. 호스트의 Tailscale과는 무관합니다.
- **상태 보관**: 모든 상태는 이 폴더 안(`data/`, `workspace/`, `tailscale/state/`)에 저장됩니다. `restart: unless-stopped`라서 재부팅하면 자동으로 다시 뜹니다.

## 새 머신에 설치

```bash
git clone https://github.com/uiyunkim-git/hermes-omni hermes && cd hermes
./setup.sh    # .env 생성(비밀번호 자동 생성, API 키 입력) → GPU 감지 → Tailscale 사이드카 → 실행
```

Tailscale은 처음 한 번만 로그인하면 됩니다.
- `.env`의 `TS_AUTHKEY`에 [auth key](https://login.tailscale.com/admin/settings/keys)를 넣거나,
- 비워 두면 `setup.sh`가 로그인 URL을 보여줍니다. 승인한 뒤 `./setup.sh`를 한 번 더 실행하면 접속 주소가 나옵니다.

`setup.sh`는 여러 번 실행해도 안전합니다. 폴더를 옮겼거나 GPU가 생겼다면 다시 실행하세요.

## Hermes Desktop 연결

**Settings → Gateways → Remote gateway**
- **URL**: `http://hermes-<호스트명>.<tailnet>.ts.net:9119` (`setup.sh`가 출력)
- **로그인**: `.env`의 `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD`

## 접속 경로

이 백엔드는 호스트 Docker(=root 권한)를 쥐고 있고 비밀번호 로그인은 신뢰할 수 있는 네트워크용이므로, **공인 인터넷에 직접 열지 마세요**.

| 경로 | 설정 |
|---|---|
| tailnet (기본) | Tailscale 사이드카 `tailscale/serve.json`: tailnet `:9119` → `hermes:9119` |
| 호스트 로컬 | `127.0.0.1:9119` (`HERMES_BIND`) |
| 신뢰할 수 있는 LAN | `.env`에서 `HERMES_BIND=0.0.0.0` → `docker compose up -d` |
| Tailscale 끄기 | `.env`에서 `HERMES_TAILSCALE=off` → `./setup.sh` |
| 그 외 머신 전용 설정 | `docker-compose.override.yml`(git 제외)에 작성 → `./setup.sh` |

## 설정 (`.env`)

`.env`가 유일한 설정 원천입니다. 컨테이너가 부팅될 때마다 `docker/cont-init.d/10-env-config`가 아래 값을 `data/config.yaml`에 반영합니다. 값을 비워 두면 그 항목은 건드리지 않습니다.

| 변수 | 반영 위치 |
|---|---|
| `LLM_BASE_URL`, `LLM_MODEL`, `LLM_API_KEY`, `LLM_API_MODE`, `LLM_CONTEXT_LENGTH` | `model.*` |
| `HERMES_WORKSPACE` (setup.sh가 채움) | `terminal.cwd` (에이전트 기본 작업 폴더) |

수정한 뒤에는 `docker compose up -d`로 반영합니다. Desktop에서 고른 모델을 재시작 후에도 유지하려면 `HERMES_APPLY_ENV_CONFIG=0`으로 두세요.

## 폴더 구조

```
docker-compose.yml          기본 서비스
compose.gpu.yml             GPU 패스스루 (setup.sh가 감지되면 COMPOSE_FILE에 추가)
compose.tailscale.yml       Tailscale 사이드카 (HERMES_TAILSCALE=on, 기본)
tailscale/serve.json        tailnet :9119 → hermes:9119 전달 규칙
tailscale/state/            tailnet 노드 상태 (git 제외)
docker-compose.override.yml 머신 전용 설정 (선택, git 제외)
docker/cont-init.d/         부팅 때 .env → config.yaml 반영
setup.sh                    머신 준비 + 실행
.env                        비밀값 / 설정 (git 제외)
data/                       Hermes 상태: config, 세션, 메모리, 스킬 (git 제외)
workspace/                  에이전트 작업 폴더 (git 제외)
```

`workspace/`는 호스트와 컨테이너에 **같은 절대 경로**로 연결됩니다. 그래서 에이전트가 `docker run -v $PWD:/src ...`처럼 호스트 Docker에 경로를 넘겨도 그대로 맞습니다.

## 운영

```bash
docker compose logs -f                    # 로그
docker compose exec hermes hermes         # 서버에서 바로 CLI 대화
docker compose pull && docker compose up -d   # 업데이트
```

`docker compose`는 `.env`의 `COMPOSE_FILE`을 읽기 때문에 GPU/Tailscale/override 파일 조합이 자동으로 적용됩니다.

## 보안 주의

- 에이전트는 호스트 Docker 전체를 제어할 수 있습니다. 다른 컨테이너를 중지·삭제할 수 있고, `-v /:/host`로 호스트 파일 전체에 접근할 수도 있습니다. Desktop에서 뜨는 승인 요청은 꼭 확인하세요.
- `.env`, `data/`(설정 파일에 API 키 포함)는 절대 커밋하지 마세요. `.gitignore`에 들어 있습니다.
