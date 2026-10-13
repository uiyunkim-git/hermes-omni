# Hermes Omni (self-hosted)

[Hermes Agent](https://github.com/NousResearch/hermes-agent)를 여러 머신에 Docker로 띄우고, **hub 하나로 묶어** 폰·브라우저에서 모든 머신의 프로젝트와 세션을 다루기 위한 설정입니다. 에이전트끼리 머신을 넘어 메시지를 주고받을 수도 있습니다. 각 머신은 지금처럼 **Hermes Desktop의 원격 백엔드**로도 그대로 쓸 수 있습니다.

- **모델**: OpenAI 호환 엔드포인트. 기본값은 GLM-5.3-Flash(vLLM)이며 `.env`에서 바꿉니다.
- **GPU**: nvidia 런타임이 있는 머신이면 모든 GPU를 자동으로 연결하고, 없으면 GPU 없이 실행합니다.
- **Docker**: 호스트의 `docker.sock`을 연결해서 에이전트가 호스트 Docker로 컨테이너를 띄울 수 있습니다.
- **Tailscale**: 사이드카 컨테이너가 머신마다 `hermes-<호스트명>` tailnet 노드를 띄워 tailnet에만 포트를 노출합니다. 호스트의 Tailscale과는 무관합니다.
- **hub / node**: tailnet에 hub 머신 하나, 나머지는 node. hub가 웹 UI·Android 앱·에이전트 간 메시지를 맡고, hub 머신도 node 역할을 겸합니다.
- **상태 보관**: 모든 상태는 이 폴더 안(`data/`, `workspace/`, `omni-state/`, `tailscale/state/`)에 저장됩니다. `restart: unless-stopped`라서 재부팅하면 자동으로 다시 뜹니다.
- **이미지 고정**: 검증된 Hermes 빌드(v0.21.5 · `749220ef`)에 digest로 고정돼 있습니다. hub·link도 같은 이미지의 Python으로 실행되므로 따로 빌드할 것이 없습니다.

## 구조

```
폰 / 브라우저 / Android 앱
   │  tailnet: http://<hub 노드>/
   ▼
[hub 머신]  tailscale :80 ──▶ hub :8800 ◀── WebSocket /link ── link ⇄ hermes :9119   (hub 머신 자신)
                                  ▲
                                  └──── WebSocket /link (tailnet, SOCKS5 경유) ──── [node 머신] link ⇄ hermes :9119
                                                                                     … 머신마다 반복
```

| 컨테이너 | 어디서 | 하는 일 |
|---|---|---|
| `hermes` | 모든 머신 | Hermes Agent 본체 (대시보드 :9119, Desktop 원격 백엔드) |
| `link` | 모든 머신 (`HERMES_ROLE` 이 hub 또는 node) | 이 머신의 Hermes를 hub에 연결한다. 프로젝트 목록·세션·실시간 이벤트·승인 요청을 hub로 전달하고, hub가 보낸 프롬프트를 Hermes에 넣는다. GPU 사용량도 보고. |
| `hub` | hub 머신만 | 웹 UI, 머신 등록, 에이전트 간 메시지 큐, APK 배포. tailnet `:80`으로만 노출 |
| `tailscale` | `HERMES_TAILSCALE=on` | tailnet 노드. node의 link는 이 사이드카의 SOCKS5(:1055, compose 네트워크 안에서만)를 거쳐 hub에 접속 |

## 설치

### 1. hub 머신 (처음 한 번, tailnet에 하나)

```bash
git clone https://github.com/uiyunkim-git/hermes-omni hermes-omni && cd hermes-omni
cp .env.example .env && vi .env   # LLM_API_KEY, 로그인 비밀번호, HERMES_ROLE=hub, (선택) TS_AUTHKEY, PROJECT_ROOTS
./setup.sh                        # GPU 감지 → 설정 생성 → 실행 → 접속 주소 출력
```

끝나면 이렇게 출력됩니다.

```
  │  Hermes Desktop → Settings → Gateways → Remote gateway
  │    Remote URL : http://hermes-<호스트명>.<tailnet>.ts.net:9119
  │                 http://100.x.y.z:9119
  │    Sign in    : admin / (.env 의 HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)
  │
  │  hermes-omni hub
  │    Hub UI     : http://hermes-<호스트명>.<tailnet>.ts.net/
  │    로그인     : admin / (위와 같은 비밀번호)
  │    ...
```

**Hub UI 로그인**은 hub 머신 `.env`의 `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD`입니다.

### 2. node 머신 추가 (머신마다)

1. Hub UI → **머신 추가** 화면에서 명령을 복사합니다. 명령 안의 `omni1.…` 값(blob)에는 hub 주소, 가입 토큰, hub의 LLM 설정·로그인 정보, (있으면) `TS_AUTHKEY`가 들어 있습니다.
2. 새 머신에서 **설치할 위치의 상위 폴더**(예: `~/`)에서 그대로 붙여 넣습니다. 복사한 명령이 저장소를 `hermes-omni/`로 받고 그 안에서 `setup.sh --join`까지 실행하므로, 미리 clone하지 마세요.

```bash
git clone https://github.com/uiyunkim-git/hermes-omni hermes-omni && cd hermes-omni && ./setup.sh --join 'omni1.eyJodWJfdXJsIjoi...'
```

이미 저장소를 받아 둔 머신이라면 그 폴더에서 `--join` 부분만 실행합니다: `./setup.sh --join 'omni1.…'`.

`--join`은 `.env`가 없으면 `.env.example`로 만들고 `HERMES_ROLE=node`, `HUB_URL`, `HUB_JOIN_TOKEN`을 씁니다. LLM·로그인·`TS_AUTHKEY` 값은 **비어 있는 칸만** 채웁니다(새로 만든 `.env`는 hub 값으로 채움). 그다음은 보통 `./setup.sh`와 같습니다. 마지막에 link가 hub에 붙을 때까지 최대 90초 기다렸다가 `hub에 등록됨` 또는 경고를 출력합니다.

blob 없이 직접 해도 됩니다. `.env`에 `HERMES_ROLE=node`, `HUB_URL=http://<hub 노드>.<tailnet>.ts.net`, `HUB_JOIN_TOKEN=…`을 넣고 `./setup.sh`.

node는 hub의 tailnet 주소로 접속하므로 **같은 tailnet**에 있어야 합니다. 새 머신 호스트는 tailnet에 없어도 됩니다(사이드카가 노드가 됨). 그래서 hub에서 무언가를 받아오는 방식이 아니라 명령을 붙여 넣는 방식입니다.

### Tailscale 로그인

처음 한 번만 하면 됩니다. `TS_AUTHKEY`가 있으면 자동으로 로그인되고, 비워 두면 `setup.sh`가 로그인 URL을 보여준 뒤 승인될 때까지 기다립니다. 로그인 상태는 `tailscale/state/`에 남습니다. 로그인 뒤 `setup.sh`가 이 머신의 tailnet 주소를 알아내 link(Desktop 링크)와 hub(공개 주소)에 넣고, 바뀌었으면 그 컨테이너만 다시 띄웁니다.

`setup.sh`는 여러 번 실행해도 안전합니다. 폴더를 옮겼거나, GPU가 생겼거나, `.env`의 역할·hub·프로젝트 루트를 바꿨다면 다시 실행하세요.

### 예전 설치에서 올라올 때

`.env`에 `HERMES_ROLE`과 `HUB_URL`이 둘 다 없으면 hub 없이 **예전처럼 단독으로** 실행됩니다(경고만 출력). hermes-omni를 쓰려면 `HERMES_ROLE=hub` 또는 `node`를 넣고 `./setup.sh`를 다시 실행하세요.

**`git pull` 뒤에는 `docker compose up`보다 먼저 `./setup.sh`를 한 번 실행하세요.** Tailscale 사이드카는 이제 예전 `tailscale/serve.json` 대신 `tailscale/config/` 폴더를 마운트하는데, 이 폴더와 그 안의 `serve.json`은 `setup.sh`만 만듭니다(`docker-compose.override.yml`도 setup.sh가 다시 생성). 먼저 `docker compose up -d`로 사이드카를 다시 만들면 Docker가 빈 `tailscale/config/`를 root 소유로 만들고, serve 규칙이 없어 tailnet에서 :9119가 사라집니다. 그렇게 됐다면 `./setup.sh`를 실행하면 복구됩니다(그 폴더에 `serve.json`을 쓰고 사이드카에 반영). root가 아닌 사용자로 실행한다면 먼저 `sudo chown -R "$(id -u):$(id -g)" tailscale/config`가 필요하고, setup.sh가 이를 안내합니다. 예전 `tailscale/serve.json`은 지워도 됩니다.

## 프로젝트

각 머신의 **프로젝트 = 프로젝트 루트 바로 아래의 폴더 하나**입니다. 숨김 폴더는 제외됩니다. 작업 폴더 `./workspace`는 항상 첫 번째 루트이고, 그 자체도 `workspace`라는 프로젝트입니다.

```
# .env — 쉼표로 구분, 절대 경로, 미리 만들어 둔 폴더
PROJECT_ROOTS=/home/me/src,/data/research
```

- 루트는 hermes와 link 컨테이너에 **호스트와 같은 절대 경로**로 연결됩니다. 그래서 에이전트가 `docker run -v $PWD:/src ...`처럼 경로를 호스트 Docker에 넘겨도 그대로 맞습니다.
- `setup.sh`는 경로를 검사합니다. 절대 경로여야 하고, 폴더가 이미 있어야 하며(없으면 Docker가 root 소유로 만들어 버림), `" ' $ : \ ,` 같은 문자는 쓸 수 없습니다. 컨테이너 사용자(root로 실행하면 uid 10000, 아니면 실행한 사용자)가 쓸 수 없어 보이면 경고만 합니다. 소유권은 바꾸지 않습니다.
- 폴더마다 **대표 세션**(`📁 <프로젝트>`)이 하나 있고, 필요하면 세션을 더 만들 수 있습니다. Hub UI에서 새 프로젝트(폴더)도 만들 수 있습니다.
- 같은 이름의 폴더가 두 루트에 있으면 두 번째 것은 `이름~abcd`처럼 짧은 해시가 붙습니다.

## 에이전트 간 메시지

모든 세션은 다른 머신·다른 프로젝트의 세션에 메시지를 보낼 수 있습니다. 각 Hermes에 `hub-bridge` 플러그인이 자동으로 연결되어 도구 세 개가 생깁니다.

| 도구 | 하는 일 |
|---|---|
| `hub_directory()` | 머신(node)·온라인 여부·프로젝트·주소 목록 |
| `hub_send(to, message, wait=false, expect_reply=true, timeout_s=120)` | 메시지 보내기 |
| `hub_inbox(limit=20)` | 이 세션이 주고받은 최근 메시지와 상태 |

**주소 형식**

| 주소 | 대상 |
|---|---|
| `<node>/<project>` | 그 프로젝트의 대표 세션 (없으면 만들어짐) |
| `<node>/<project>#<세션 id>` | 그 프로젝트의 특정 세션 |
| `<node>#<세션 id>` | 그 머신의 특정 세션 |

`<node>`는 머신 이름입니다. `.env`의 `NODE_ID`, 없으면 `TS_HOSTNAME`, 그것도 없으면 호스트명을 소문자로 쓰고, 한 번 정해지면 `omni-state/link/node_id`에 남아 유지됩니다.

**동작 방식**

- 받는 쪽 세션에는 `⟦omni:<id>⟧ Message from <보낸 주소> …`로 시작하는 새 턴으로 들어갑니다. 받는 세션이 작업 중이면 끝난 뒤 차례로 처리됩니다(끼어들지 않음).
- 기본은 **비동기**입니다. 답장은 받는 쪽의 그 턴 최종 응답이며, 보낸 세션에 `⟦omni:…⟧ Reply from …` 새 턴으로 돌아옵니다. 받는 쪽 에이전트가 `hub_send`로 직접 답장할 필요는 없습니다.
- `wait=true`면 답장을 최대 `timeout_s`(최대 300초) 동안 기다렸다가 도구 결과로 돌려받습니다. 받는 쪽이 바쁘거나 서로 기다리는 교착이 생길 상황이면 자동으로 비동기로 바뀝니다.
- 메시지가 다른 메시지를 낳는 연쇄는 4단계까지만 허용합니다. 메시지는 20,000자까지입니다.
- 꺼져 있는 머신으로 보낸 메시지는 큐에 남았다가 그 머신이 다시 붙으면 전달됩니다.
- 모든 메시지는 Hub UI의 **메시지** 화면에서 주소별로 볼 수 있습니다. 사람이 Hub UI에서 직접 세션에 메시지를 보낼 수도 있습니다(`from: human`).

이미 열려 있던 세션은 플러그인 도구를 `/new` 또는 다음 압축 이후에 보게 될 수 있습니다.

## Hub UI와 Android 앱

`http://<hub 노드>.<tailnet>.ts.net/` (tailnet 안에서만). 휴대폰 화면에 맞춰져 있고 다크·라이트 모드를 지원합니다.

- **머신**: 온라인 여부, GPU 사용량, Hermes 상태, 프로젝트 수, 그 머신의 Hermes 대시보드(:9119) 링크
- **프로젝트**: 검색, 대표 세션 상태(작업 중/대기/마지막 활동), 새 프로젝트, 다시 읽기, 다른 세션 목록
- **채팅**: 기록 + 실시간 스트리밍, 추론·도구 표시, 승인·질문·sudo·비밀값 요청 응답, 보내기(큐) / Steer(작업 중인 턴에 끼어들기) / Stop
- **요청**: 모든 머신에서 대기 중인 승인 요청. 상단 배지로 개수 표시
- **메시지**: 에이전트 간 메시지 기록
- **머신 추가**: `--join` 명령 복사, Android 앱(APK) 다운로드

**Android 앱**은 Hub UI를 감싼 WebView 앱입니다. 처음 실행하면 hub 주소를 묻습니다(메뉴에서 변경 가능). 폰에도 Tailscale 앱이 켜져 있어야 합니다. hub 머신에서 빌드하면 Hub UI가 배포합니다.

```bash
scripts/build-apk.sh    # Docker 안에서 빌드 → omni-state/apk/hermes-omni.apk (+ meta.json)
```

서명 키는 처음 빌드할 때 `omni-state/android/`에 생성됩니다. 이 키를 잃으면 이미 설치된 앱은 업데이트하지 못하고 지웠다가 다시 설치해야 합니다.

## Hermes Desktop 연결

**Settings → Gateways → Remote gateway**
- **URL**: `http://hermes-<호스트명>.<tailnet>.ts.net:9119` (`setup.sh`가 출력)
- **로그인**: 그 머신 `.env`의 `HERMES_DASHBOARD_BASIC_AUTH_USERNAME` / `_PASSWORD`

Desktop과 Hub UI는 같은 세션을 동시에 볼 수 있습니다. 한쪽에서 보낸 턴이 다른 쪽에도 실시간으로 보입니다.

## 접속 경로

이 백엔드는 호스트 Docker(=root 권한)를 쥐고 있고 비밀번호 로그인은 신뢰할 수 있는 네트워크용이므로, **공인 인터넷에 직접 열지 마세요**.

| 경로 | 설정 |
|---|---|
| tailnet (기본) | `setup.sh`가 만드는 `tailscale/config/serve.json`: `:9119` → `hermes:9119`, hub 머신은 `:80` → `hub:8800` |
| 호스트 로컬 | `127.0.0.1:9119` (`HERMES_BIND`) |
| 신뢰할 수 있는 LAN | `.env`에서 `HERMES_BIND=0.0.0.0` → `docker compose up -d` |
| Hub UI를 호스트에도 | hub 머신 `.env`에 `HUB_BIND=127.0.0.1`(또는 LAN IP), `HUB_PORT=8800` → `./setup.sh` |
| Tailscale 끄기 | `.env`에서 `HERMES_TAILSCALE=off` → `./setup.sh`. 이때 node는 `HUB_URL`로 직접 접속하므로 hub에 `HUB_BIND`가 필요합니다(평문 LAN). |
| Tailscale 노드 이름 | `.env`의 `TS_HOSTNAME` → `./setup.sh` |

## 설정

| 파일 | 내용 | 누가 |
|---|---|---|
| `.env` | LLM 주소·키, 로그인, Tailscale, 역할(`HERMES_ROLE`), hub 주소·토큰, 프로젝트 루트, 선택 옵션 | **사람이 작성** (또는 `--join`) |
| `docker-compose.override.yml` | 작업 폴더·프로젝트 루트 절대 경로, GPU, Tailscale 사이드카, UID, link/hub 서비스, 플러그인 마운트 | `setup.sh`가 생성 |
| `tailscale/config/serve.json` | tailnet 노출 규칙. 폴더째 마운트되어 실행 중에도 바로 반영 | `setup.sh`가 생성 |
| `omni-state/link/link.env`, `link_token`, `node_id` | link 환경값, hermes ⇄ link 토큰, 머신 이름 | `setup.sh`가 생성 |
| `omni-state/hub/hub.env`, `join_token` | hub 환경값, 가입 토큰(처음 한 번 생성) | `setup.sh`가 생성 |
| `omni-state/link/link.json`, `status.json` | link 상태, hub 연결 상태 | link |
| `omni-state/hub/hub.db`, `secret` | 머신·메시지 기록, 로그인 쿠키 서명키 | hub |
| `data/.env` | Desktop 세션 서명키 등 Hermes 내부 비밀값 | 컨테이너가 처음 부팅할 때 생성 |

컨테이너가 부팅할 때마다 `docker/cont-init.d/10-env-config`가 `.env`의 `LLM_*` 값과 작업 폴더를 `data/config.yaml`에 반영하고, hub-bridge 플러그인을 켭니다. 값을 비워 두면 그 항목은 건드리지 않습니다. `.env`를 고친 뒤에는 `docker compose up -d`로 반영하고, GPU·Tailscale·역할·hub·프로젝트 루트·노드 이름을 바꿨다면 `./setup.sh`를 다시 실행하세요. Desktop에서 고른 모델을 재시작 후에도 유지하려면 `.env`에 `HERMES_APPLY_ENV_CONFIG=0`을 넣으세요.

세션 서명키(`data/.env`의 `HERMES_DASHBOARD_BASIC_AUTH_SECRET`)가 고정돼 있어서 재시작해도 Desktop 로그인이 유지됩니다. 그 줄을 지우고 재시작하면 새 키가 생성되면서 모든 Desktop 세션이 로그아웃됩니다.

## 폴더 구조

```
docker-compose.yml          기본 서비스 (hermes)
compose.tailscale.yml       Tailscale 사이드카 정의 (override가 extends로 불러옴)
compose.omni.yml            link·hub 서비스 정의 (override가 extends로 불러옴)
omni/                       link·hub Python 코드 + 웹 UI (omni/web) — 컨테이너에 읽기 전용 마운트
plugins/hub-bridge/         Hermes 플러그인 (hub_directory·hub_send·hub_inbox)
android/                    Android 앱 (Hub UI WebView)
scripts/build-apk.sh        APK 빌드
docker/cont-init.d/         부팅 때 .env → config.yaml 반영, 세션 서명키 생성, 플러그인 켜기
setup.sh                    머신 준비 + 실행 + 접속 주소 출력 (--join 으로 hub 가입)
.env.example                .env 템플릿
--- git 제외 ---
.env                        사람이 작성하는 설정
docker-compose.override.yml setup.sh가 생성하는 머신별 설정
tailscale/config/           setup.sh가 생성하는 serve.json
tailscale/state/            tailnet 노드 상태
omni-state/                 link·hub 상태, 토큰, hub DB, APK, 앱 서명 키
data/                       Hermes 상태: config, 세션, 메모리, 스킬, 내부 비밀값
workspace/                  에이전트 작업 폴더
```

## 운영

```bash
docker compose logs -f                        # 전체 로그
docker compose logs -f link                   # hub 연결 상태 (hub 머신은 hub 도)
docker compose exec hermes hermes             # 서버에서 바로 CLI 대화
git pull && ./setup.sh                        # 업데이트 (코드 + 설정 다시 생성) — up 전에 항상 setup.sh
docker compose restart link                   # omni/ 코드만 바뀌었을 때 (hub 머신은 restart link hub)
```

이 폴더에서 실행하면 `docker compose`가 `docker-compose.override.yml`을 자동으로 함께 읽습니다. 컨테이너 이름은 `hermes`, `hermes-tailscale`, `hermes-link`, `hermes-hub`입니다(`HERMES_CONTAINER_NAME`으로 접두어 변경).

- **Hermes 이미지 업데이트**: 고정된 digest를 쓰므로 `docker compose pull`로는 바뀌지 않습니다. 새 버전은 이 저장소에서 검증한 뒤 `docker-compose.yml`·`compose.omni.yml`의 기본값을 올립니다. 직접 바꾸려면 `.env`의 `HERMES_IMAGE`를 쓰세요.
- **머신 제거**: 그 머신에서 `docker compose down`. hub에는 오프라인으로 남습니다.
- **가입 토큰 교체**: hub 머신에서 `omni-state/hub/join_token`을 지우고 `./setup.sh`를 실행합니다. 그 뒤 모든 node의 `.env`의 `HUB_JOIN_TOKEN`을 새 값으로 바꾸고 `./setup.sh`를 다시 실행해야 합니다.
- **hub 옮기기**: 새 hub 머신에서 `HERMES_ROLE=hub`로 설치한 뒤, node들의 `HUB_URL`·`HUB_JOIN_TOKEN`을 바꾸고 `./setup.sh`를 다시 실행합니다(메시지 기록은 `omni-state/hub/`를 복사하면 유지됩니다).

## 보안 주의

- 에이전트는 호스트 Docker 전체를 제어할 수 있습니다. 다른 컨테이너를 중지·삭제할 수 있고, `-v /:/host`로 호스트 파일 전체에 접근할 수도 있습니다. 즉 **각 머신의 에이전트는 사실상 그 머신의 root**이고, 그 머신의 모든 비밀값(`.env`, `omni-state/`)을 읽을 수 있습니다. Desktop·Hub UI에서 뜨는 승인 요청은 꼭 확인하세요.
- hub는 **tailnet 전용**입니다. Hub UI 로그인 하나로 모든 머신의 에이전트를 움직일 수 있으니 공인 인터넷이나 신뢰할 수 없는 LAN에 열지 마세요(`HUB_BIND`는 신중하게). 통신은 Tailscale(WireGuard)로 암호화되며, Tailscale을 끄면 평문입니다.
- **가입 토큰(`HUB_JOIN_TOKEN`)과 `--join` blob은 비밀번호처럼 다루세요.** 가진 사람은 누구나 tailnet 안에서 머신을 hub에 등록할 수 있고, blob에는 LLM 키와 로그인 비밀번호, `TS_AUTHKEY`까지 들어 있습니다. 유출되면 토큰을 교체하세요(위 운영 참고).
- 에이전트 간 메시지는 보낸 사람의 권한으로 받는 쪽 에이전트를 움직입니다. 한 세션에 들어간 악성 입력(prompt injection)이 다른 머신으로 번질 수 있으니 승인 요청을 끄지 마세요.
- `.env`, `data/`(API 키, 내부 비밀값 포함), `omni-state/`(토큰, hub DB, 앱 서명 키), `tailscale/state/`(노드 키)는 절대 커밋하지 마세요. `.gitignore`에 들어 있습니다.
