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
cp .env.example .env && vi .env   # LLM_API_KEY, 로그인 비밀번호, (선택) TS_AUTHKEY 채우기
./setup.sh                        # GPU 감지 → override 생성 → 실행 → 접속 주소 출력
```

끝나면 이렇게 접속 정보가 출력됩니다.

```
  │  Hermes Desktop → Settings → Gateways → Remote gateway
  │    Remote URL : http://hermes-<호스트명>.<tailnet>.ts.net:9119
  │                 http://100.x.y.z:9119
  │    Sign in    : admin / (.env 의 HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)
```

Tailscale은 처음 한 번만 로그인하면 됩니다. `TS_AUTHKEY`를 넣었으면 자동으로 로그인되고, 비워 두면 `setup.sh`가 로그인 URL을 보여준 뒤 승인될 때까지 기다렸다가 주소를 출력합니다. 로그인 상태는 `tailscale/state/`에 남습니다.

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
| Tailscale 노드 이름 | `.env`의 `TS_HOSTNAME` → `./setup.sh` |

## 설정

| 파일 | 내용 | 누가 |
|---|---|---|
| `.env` | LLM 주소·키, Desktop 로그인, Tailscale 키·노드 이름, 선택 옵션 | **사람이 작성** |
| `docker-compose.override.yml` | 작업 폴더 절대 경로, GPU 패스스루, Tailscale 사이드카, UID | `setup.sh`가 생성 |
| `data/.env` | Desktop 세션 서명키 등 Hermes 내부 비밀값 | 컨테이너가 처음 부팅할 때 생성 |

컨테이너가 부팅할 때마다 `docker/cont-init.d/10-env-config`가 `.env`의 `LLM_*` 값과 작업 폴더를 `data/config.yaml`에 반영합니다. 값을 비워 두면 그 항목은 건드리지 않습니다. `.env`를 고친 뒤에는 `docker compose up -d`로 반영하고, GPU·Tailscale·노드 이름을 바꿨다면 `./setup.sh`를 다시 실행하세요. Desktop에서 고른 모델을 재시작 후에도 유지하려면 `.env`에 `HERMES_APPLY_ENV_CONFIG=0`을 넣으세요.

세션 서명키(`data/.env`의 `HERMES_DASHBOARD_BASIC_AUTH_SECRET`)가 고정돼 있어서 재시작해도 Desktop 로그인이 유지됩니다. 그 줄을 지우고 재시작하면 새 키가 생성되면서 모든 Desktop 세션이 로그아웃됩니다.

## 폴더 구조

```
docker-compose.yml          기본 서비스 (hermes)
compose.tailscale.yml       Tailscale 사이드카 정의 (override가 extends로 불러옴)
tailscale/serve.json        tailnet :9119 → hermes:9119 전달 규칙
docker/cont-init.d/         부팅 때 .env → config.yaml 반영, 세션 서명키 생성
setup.sh                    머신 준비 + 실행 + 접속 주소 출력
.env.example                .env 템플릿
--- git 제외 ---
.env                        사람이 작성하는 설정
docker-compose.override.yml setup.sh가 생성하는 머신별 설정
data/                       Hermes 상태: config, 세션, 메모리, 스킬, 내부 비밀값
workspace/                  에이전트 작업 폴더
tailscale/state/            tailnet 노드 상태
```

`workspace/`는 호스트와 컨테이너에 **같은 절대 경로**로 연결됩니다. 그래서 에이전트가 `docker run -v $PWD:/src ...`처럼 호스트 Docker에 경로를 넘겨도 그대로 맞습니다.

## 운영

```bash
docker compose logs -f                    # 로그
docker compose exec hermes hermes         # 서버에서 바로 CLI 대화
docker compose pull && docker compose up -d   # 업데이트
```

이 폴더에서 실행하면 `docker compose`가 `docker-compose.override.yml`을 자동으로 함께 읽습니다.

## 보안 주의

- 에이전트는 호스트 Docker 전체를 제어할 수 있습니다. 다른 컨테이너를 중지·삭제할 수 있고, `-v /:/host`로 호스트 파일 전체에 접근할 수도 있습니다. Desktop에서 뜨는 승인 요청은 꼭 확인하세요.
- `.env`, `data/`(API 키, 내부 비밀값 포함), `tailscale/state/`(노드 키)는 절대 커밋하지 마세요. `.gitignore`에 들어 있습니다.
