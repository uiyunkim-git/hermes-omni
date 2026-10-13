#!/usr/bin/env bash
# =====================================================================================
#  Hermes — 머신 준비 + 실행 (여러 번 실행해도 안전)
#
#  준비:  cp .env.example .env 후 값 채우기   (또는 hub UI 의 "머신 추가" 에서 --join 명령 복사)
#  사용:  ./setup.sh               머신 감지 → 설정 파일 생성 → up -d → 접속 주소 출력
#         ./setup.sh --no-start    설정 파일 생성까지만
#         ./setup.sh --join <blob> hub 가입 정보(hub 주소·토큰·LLM·로그인)를 .env 에 채운 뒤 위와 같이 진행
#
#  자동 생성 (git 제외, 머신마다 다른 값): docker-compose.override.yml (작업 폴더·프로젝트 루트 절대 경로,
#  GPU, Tailscale 사이드카, UID, link/hub 서비스), tailscale/config/serve.json, omni-state/{link,hub}/*.env
# =====================================================================================
set -Eeuo pipefail
cd "$(dirname "$(readlink -f "$0")")"

log()  { printf '\033[1;36m[hermes]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hermes] 경고:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[hermes] 오류:\033[0m %s\n' "$*" >&2; exit 1; }

PINNED_IMAGE="nousresearch/hermes-agent@sha256:d4da4a40cd7a28aba983775d9fd31d94cbf153eeb0cb9e844d6d0f612b7c24db"
HUB_PORT_INTERNAL=8800
LINK_PORT=8810
JOIN_ENV_KEYS=(LLM_BASE_URL LLM_MODEL LLM_API_KEY LLM_API_MODE LLM_CONTEXT_LENGTH
               HERMES_DASHBOARD_BASIC_AUTH_USERNAME HERMES_DASHBOARD_BASIC_AUTH_PASSWORD TS_AUTHKEY)

START=1
JOIN=""
while (($#)); do
  case "$1" in
    --no-start) START=0 ;;
    --join) (($# >= 2)) || die "--join 뒤에 hub UI 에서 복사한 값(omni1.…)을 붙이세요."; JOIN="$2"; shift ;;
    --join=*) JOIN="${1#--join=}" ;;
    -h|--help) sed -n '3,12p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $1" ;;
  esac
  shift
done

command -v docker >/dev/null || die "docker 가 없습니다."
docker compose version >/dev/null 2>&1 || die "docker compose 플러그인이 없습니다."
docker info >/dev/null 2>&1 || die "docker 데몬에 접근할 수 없습니다 (root 또는 docker 그룹 필요)."

# --- .env 읽기/쓰기 ---------------------------------------------------------------------
# 값을 셸로 source 하지 않음 (키에 # $ 등이 들어갈 수 있음). 따옴표 없는 값은 공백 뒤 # 부터 주석.
get_kv() {
  local f="${2:-.env}" v
  [[ -f "$f" ]] || return 0
  v="$(sed -n "s/^$1=//p" "$f" | tail -n1)"
  case "$v" in
    \'*) v="${v#\'}"; v="${v%%\'*}" ;;
    \"*) v="${v#\"}"; v="${v%%\"*}" ;;
    *)   v="$(sed -E 's/[[:space:]]+#.*$//; s/[[:space:]]+$//' <<<"$v")" ;;
  esac
  printf '%s' "$v"
}

# env 파일 한 줄 값: 안전한 문자만이면 그대로, 아니면 작은따옴표 (compose 가 $ 치환·# 주석 처리를 하지 않음)
env_fmt() {
  local v="$1"
  [[ "$v" != *$'\n'* && "$v" != *$'\r'* ]] || return 1
  if [[ "$v" =~ ^[A-Za-z0-9._~:/@%+=,-]*$ ]]; then printf '%s' "$v"
  elif [[ "$v" != *"'"* ]]; then printf "'%s'" "$v"
  else return 1; fi
}

# KEY=값 을 .env 에 쓴다 (있으면 첫 줄을 바꾸고 중복 줄은 지움, 없으면 끝에 추가). 원자적 교체.
set_kv() {
  local key="$1" val f="${3:-.env}" tmp
  val="$(env_fmt "$2")" || die "$key 값에 줄바꿈이나 작은따옴표(')가 섞여 있어 $f 에 쓸 수 없습니다."
  tmp="$(mktemp "$f.XXXXXX")"
  K="$key" L="$key=$val" awk '
    index($0, ENVIRON["K"] "=") == 1 { if (!done) print ENVIRON["L"]; done = 1; next }
    { print }
    END { if (!done) print ENVIRON["L"] }' "$f" >"$tmp"
  chown --reference="$f" "$tmp" 2>/dev/null || true
  chmod 600 "$tmp"
  mv -f "$tmp" "$f"
}

# 내용($3) → 파일 (같으면 건드리지 않음). 같은 폴더의 임시 파일 + mv 로 원자적. 바뀌었으면 WROTE=1.
WROTE=0
write_file() {
  local f="$1" mode="$2" tmp
  tmp="$(mktemp "$(dirname "$f")/.$(basename "$f").XXXXXX")"
  printf '%s\n' "$3" >"$tmp"
  if [[ -f "$f" ]] && cmp -s "$tmp" "$f"; then rm -f "$tmp"; WROTE=0; return 0; fi
  chmod "$mode" "$tmp"
  mv -f "$tmp" "$f"
  WROTE=1
}

rand_token() { local t; t="$(head -c 48 /dev/urandom | base64 -w0 | tr -dc 'A-Za-z0-9')"; printf '%s' "${t:0:40}"; }

# 한 번 만들어 파일로 보관하는 비밀값 (재실행해도 같은 값)
persist_token() {
  local f="$1" t
  t=""; [[ ! -f "$f" ]] || t="$(tr -dc 'A-Za-z0-9._~-' <"$f")"
  if [[ -z "$t" ]]; then
    t="$(rand_token)"
    (umask 077; printf '%s\n' "$t" >"$f")
  fi
  chmod 600 "$f"
  printf '%s' "$t"
}

hermes_image() { local i; i="$(get_kv HERMES_IMAGE)"; printf '%s' "${i:-$PINNED_IMAGE}"; }

# --- --join <blob>: hub UI 가 만든 가입 정보 → .env ------------------------------------
# blob = "omni1." + base64url(json{hub_url, join_token, env:{...}})
JOIN_PY='
import json, sys
allowed = set(sys.argv[1:])
try:
    d = json.load(sys.stdin)
except ValueError as e:
    sys.exit("JSON 이 아닙니다: %s" % e)
if not isinstance(d, dict) or not isinstance(d.get("env") or {}, dict):
    sys.exit("형식이 다릅니다 (object 아님)")
pairs = [("HUB_URL", d.get("hub_url")), ("HUB_JOIN_TOKEN", d.get("join_token"))]
pairs += [(k, v) for k, v in (d.get("env") or {}).items() if k in allowed]
for k, v in pairs:
    if v is None:
        v = ""
    if isinstance(v, bool) or not isinstance(v, (str, int, float)):
        sys.exit("값 형식이 다릅니다: %s" % k)
    v = str(v)
    if "\0" in v:
        sys.exit("값에 NUL 문자: %s" % k)
    sys.stdout.write(k + "\0" + v + "\0")
'

join_apply() {
  local blob="$1" b64 json out created=0 k v cur img
  blob="$(tr -d '[:space:]' <<<"$blob")"
  [[ "$blob" == omni1.* ]] || die "--join 값은 omni1. 로 시작해야 합니다 (hub UI → Join 화면에서 복사)."
  b64="$(tr '_-' '/+' <<<"${blob#omni1.}")"
  case $(( ${#b64} % 4 )) in
    2) b64+="==" ;; 3) b64+="=" ;; 1) die "--join 값이 잘렸습니다 (base64 길이 오류). 다시 복사하세요." ;;
  esac
  json="$(base64 -d <<<"$b64" 2>/dev/null)" || die "--join 값을 해석할 수 없습니다 (base64). 다시 복사하세요."

  # 결과는 NUL 구분 KEY/값 쌍 (값에 어떤 문자가 와도 안전). 비밀값이라 임시 파일은 바로 지운다.
  out="$(mktemp)"
  local rc=0
  if command -v python3 >/dev/null 2>&1; then
    python3 -I -c "$JOIN_PY" "${JOIN_ENV_KEYS[@]}" <<<"$json" >"$out" || rc=$?
  else
    img="$(hermes_image)"
    docker image inspect "$img" >/dev/null 2>&1 || log "python3 가 없어 Hermes 이미지로 해석합니다 (이미지 받는 중, 처음 한 번)..."
    docker run --rm -i --network none --entrypoint /opt/hermes/.venv/bin/python "$img" \
      -I -c "$JOIN_PY" "${JOIN_ENV_KEYS[@]}" <<<"$json" >"$out" || rc=$?
  fi
  local -A J=()
  while IFS= read -r -d '' k && IFS= read -r -d '' v; do J["$k"]="$v"; done <"$out"
  rm -f "$out"
  ((rc == 0)) || die "--join 값을 해석할 수 없습니다. 다시 복사하세요."
  [[ -n "${J[HUB_URL]:-}" && -n "${J[HUB_JOIN_TOKEN]:-}" ]] || die "--join 값에 hub 주소나 가입 토큰이 없습니다."

  if [[ ! -f .env ]]; then
    [[ -f .env.example ]] || die ".env.example 이 없습니다 (저장소를 다시 받으세요)."
    (umask 077; cp .env.example .env)
    created=1
    log ".env 를 .env.example 로부터 만들었습니다."
  fi
  chmod 600 .env
  [[ "$(get_kv HERMES_ROLE)" != hub ]] || die "이 머신은 HERMES_ROLE=hub 입니다. node 로 바꾸려면 .env 를 직접 고치세요."

  set_kv HERMES_ROLE node
  set_kv HUB_URL "${J[HUB_URL]}"
  set_kv HUB_JOIN_TOKEN "${J[HUB_JOIN_TOKEN]}"
  local filled=()
  for k in "${JOIN_ENV_KEYS[@]}"; do
    v="${J[$k]:-}"; [[ -n "$v" ]] || continue
    cur="$(get_kv "$k")"
    # 새로 만든 .env 는 예시 기본값보다 hub 값을 우선. 기존 .env 는 빈 칸만 채운다.
    if ((created)) || [[ -z "$cur" ]]; then set_kv "$k" "$v"; filled+=("$k"); fi
  done
  log "hub 가입 정보 적용: HUB_URL=${J[HUB_URL]}${filled[*]:+, 채운 값: ${filled[*]}}"
}

[[ -z "$JOIN" ]] || join_apply "$JOIN"

# --- .env 확인 (사용자가 채워 둔다) -------------------------------------------------------
[[ -f .env ]] || die ".env 가 없습니다: cp .env.example .env 후 값을 채우세요 (또는 ./setup.sh --join <blob>)."
chmod 600 .env

missing=()
for k in LLM_BASE_URL LLM_MODEL HERMES_DASHBOARD_BASIC_AUTH_USERNAME HERMES_DASHBOARD_BASIC_AUTH_PASSWORD; do
  [[ -n "$(get_kv "$k")" ]] || missing+=("$k")
done
((${#missing[@]} == 0)) || die ".env 에 값이 비어 있습니다: ${missing[*]}"

tailscale="$(get_kv HERMES_TAILSCALE)"; tailscale="${tailscale:-on}"
[[ "$tailscale" == on || "$tailscale" == off ]] || die "HERMES_TAILSCALE 는 on|off 중 하나: $tailscale"

# --- hermes-omni 역할 -------------------------------------------------------------------
# hub | node. HERMES_ROLE 과 HUB_URL 이 둘 다 비어 있으면(예전 .env) hub 없이 단독 실행 — 기존 동작 그대로.
role="$(get_kv HERMES_ROLE)"
hub_url="$(get_kv HUB_URL)"; hub_url="${hub_url%/}"
join_token=""
if [[ -z "$role" ]]; then
  if [[ -n "$hub_url" ]]; then role=node
  else
    role=standalone
    warn "HERMES_ROLE 이 비어 있어 hub 없이 단독으로 실행합니다 (.env 에 HERMES_ROLE=hub|node 를 넣으면 hermes-omni 사용)."
  fi
fi
case "$role" in
  hub)
    [[ -z "$hub_url" ]] || warn "hub 머신에서는 HUB_URL 을 쓰지 않습니다 (무시)."
    ;;
  node)
    [[ -n "$hub_url" ]] || die "HERMES_ROLE=node 에는 HUB_URL 이 필요합니다 (hub UI → 머신 추가). 이 머신이 hub 면 HERMES_ROLE=hub."
    [[ "$hub_url" =~ ^https?://[A-Za-z0-9.-]+(:[0-9]{1,5})?(/[A-Za-z0-9._~/-]*)?$ ]] \
      || die "HUB_URL 형식이 올바르지 않습니다 (예: http://hermes-hub.<tailnet>.ts.net): $hub_url"
    join_token="$(get_kv HUB_JOIN_TOKEN)"
    [[ -n "$join_token" ]] || die "HERMES_ROLE=node 에는 HUB_JOIN_TOKEN 이 필요합니다 (hub UI → 머신 추가)."
    [[ "$join_token" =~ ^[A-Za-z0-9._~-]{16,256}$ ]] || die "HUB_JOIN_TOKEN 형식이 올바르지 않습니다 (다시 복사하세요)."
    if [[ "$tailscale" == off && "$hub_url" == *.ts.net* ]]; then
      warn "Tailscale 이 꺼져 있어 tailnet 주소($hub_url)의 hub 에 접속하지 못할 수 있습니다."
    fi
    ;;
  standalone) ;;
  *) die "HERMES_ROLE 은 hub|node 중 하나: $role" ;;
esac
omni=0; [[ "$role" == standalone ]] || omni=1

# --- 머신 값 ------------------------------------------------------------------------------
mkdir -p data workspace tailscale/state tailscale/config
# setup.sh 보다 먼저 `docker compose up` 을 하면 Docker 가 빈 tailscale/config 를 root 소유로 만든다
[[ -w tailscale/config ]] \
  || die "tailscale/config 에 쓸 수 없습니다 (setup.sh 전에 docker compose up 을 하면 root 소유로 생김). sudo chown -R \"$(id -u):$(id -g)\" tailscale/config 후 다시 실행하세요."
ws="$PWD/workspace"
# compose YAML/volume 문법을 깨는 문자 (따옴표, $, :, \, 백틱, 제어문자)
bad_path() { [[ "$1" =~ [\"\'\$:\\\`,] || "$1" == *[[:cntrl:]]* ]]; }
bad_path "$ws" && die "이 폴더 경로에는 쓸 수 없는 문자가 있습니다 (\" ' \$ : \\ , 등): $PWD"

# 컨테이너 hermes 사용자 UID: root 로 실행하면 이미지 기본(10000), 아니면 실행한 사용자
uid=""; gid=""
if [[ "$(id -u)" == 0 ]]; then chown 10000:10000 workspace
else uid="$(id -u)"; gid="$(id -g)"; fi
cuid="${uid:-10000}"; cgid="${gid:-10000}"

gpu="$(get_kv HERMES_GPU)"; gpu="${gpu:-auto}"
case "$gpu" in
  on) use_gpu=1 ;;
  off) use_gpu=0 ;;
  auto) if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"' \
           || command -v nvidia-ctk >/dev/null 2>&1; then use_gpu=1; else use_gpu=0; fi ;;
  *) die "HERMES_GPU 는 auto|on|off 중 하나: $gpu" ;;
esac

ts_name="$(get_kv TS_HOSTNAME)"
[[ -n "$ts_name" ]] || ts_name="hermes-$(hostname -s | tr '[:upper:]' '[:lower:]' | tr -c 'a-z0-9-\n' '-')"

# 프로젝트 루트: 절대 경로, 존재, YAML/compose 를 깨는 문자 없음. 작업 폴더가 항상 첫 번째.
roots=("$ws")
IFS=',' read -r -a raw_roots <<<"$(get_kv PROJECT_ROOTS)"
for r in "${raw_roots[@]}"; do
  r="$(sed -E 's/^[[:space:]]+//; s/[[:space:]]+$//' <<<"$r")"
  [[ -n "$r" ]] || continue
  [[ "$r" == /* ]] || die "PROJECT_ROOTS 는 절대 경로여야 합니다: $r"
  bad_path "$r" && die "PROJECT_ROOTS 경로에 쓸 수 없는 문자가 있습니다 (\" ' \$ : \\ 등): $r"
  [[ "$r" == / ]] && die "PROJECT_ROOTS 에 / 전체는 쓸 수 없습니다."
  r="${r%/}"
  [[ -d "$r" ]] || die "PROJECT_ROOTS 폴더가 없습니다 (먼저 만드세요 — 없으면 docker 가 root 소유로 만들어 버림): $r"
  dup=0; for x in "${roots[@]}"; do [[ "$x" == "$r" ]] && dup=1; done
  ((dup)) && continue
  roots+=("$r")
  # 컨테이너 사용자가 쓸 수 있는지 (소유자 / 그룹 쓰기 / 모두 쓰기) — 소유권은 바꾸지 않고 알리기만
  read -r o g m < <(stat -c '%u %g %a' "$r")
  if [[ "$o" != "$cuid" ]] && ! { [[ "$g" == "$cgid" ]] && (( (8#${m: -2:1} & 2) != 0 )); } \
     && (( (8#${m: -1} & 2) == 0 )); then
    warn "컨테이너 사용자(uid $cuid)가 $r 에 쓰지 못할 수 있습니다 (소유자 uid $o). 필요하면 권한을 조정하세요."
  fi
done
roots_csv="$(IFS=,; printf '%s' "${roots[*]}")"

# --- hermes-omni 상태·비밀값 (omni-state/, git 제외) --------------------------------------
link_token=""; node_id=""; dash_url=""; pub_url=""
hub_bind=""; hub_port=""
if ((omni)); then
  mkdir -p omni-state/link omni-state/apk
  chmod 700 omni-state/link

  # hub 에서 쓰는 이 머신 이름. 한 번 정해지면 omni-state/link/node_id 에 남아 유지 (.env 의 NODE_ID 가 우선).
  node_id="$(get_kv NODE_ID)"
  [[ -n "$node_id" || ! -f omni-state/link/node_id ]] || node_id="$(tr -d '[:space:]' <omni-state/link/node_id)"
  [[ -n "$node_id" ]] || node_id="$(get_kv TS_HOSTNAME)"
  [[ -n "$node_id" ]] || node_id="$(hostname -s)"
  node_id="$(tr '[:upper:]' '[:lower:]' <<<"$node_id" | tr -c 'a-z0-9-\n' '-' | sed -E 's/^[^a-z0-9]+//' | cut -c1-63 | sed -E 's/-+$//')"
  [[ "$node_id" =~ ^[a-z0-9][a-z0-9-]{0,62}$ ]] || die "머신 이름(NODE_ID)을 정할 수 없습니다. .env 에 NODE_ID=<영문 소문자·숫자·->"
  printf '%s\n' "$node_id" >omni-state/link/node_id

  link_token="$(persist_token omni-state/link/link_token)"
  dash_url="$(get_kv OMNI_DASHBOARD_URL omni-state/link/link.env)"
  [[ "$tailscale" == on ]] || dash_url=""

  if [[ "$role" == hub ]]; then
    mkdir -p omni-state/hub
    chmod 700 omni-state/hub
    join_token="$(persist_token omni-state/hub/join_token)"
    hub_bind="$(get_kv HUB_BIND)"
    hub_port="$(get_kv HUB_PORT)"; hub_port="${hub_port:-8800}"
    [[ -z "$hub_bind" || "$hub_bind" =~ ^[0-9A-Fa-f.:]+$ ]] || die "HUB_BIND 는 IP 주소여야 합니다: $hub_bind"
    [[ "$hub_port" =~ ^[0-9]{1,5}$ ]] || die "HUB_PORT 는 숫자여야 합니다: $hub_port"
    pub_url="$(get_kv OMNI_PUBLIC_URL omni-state/hub/hub.env)"
    if [[ "$tailscale" == off ]]; then
      pub_url=""
      if [[ -n "$hub_bind" ]]; then
        a="$hub_bind"
        if [[ "$a" == 0.0.0.0 ]]; then
          a="$(hostname -I 2>/dev/null | tr ' ' '\n' | grep -m1 -E '^[0-9]+\.[0-9]+\.[0-9]+\.[0-9]+$' || true)"
        fi
        if [[ -n "$a" ]]; then pub_url="http://$a:$hub_port"; fi
      else
        warn "Tailscale 이 꺼져 있고 HUB_BIND 도 없어 hub UI 에 다른 머신이 접속할 수 없습니다 (.env 에 HUB_BIND)."
      fi
    fi
  fi
fi

# KEY=값 목록 → env 파일 내용
env_lines() {
  local kv v
  for kv in "$@"; do
    v="$(env_fmt "${kv#*=}")" || die "env 파일에 쓸 수 없는 값: ${kv%%=*}"
    printf '%s=%s\n' "${kv%%=*}" "$v"
  done
}

write_link_env() {
  local hub socks="" body
  if [[ "$role" == hub ]]; then hub="http://hub:$HUB_PORT_INTERNAL"
  else
    hub="$hub_url"
    if [[ "$tailscale" == on ]]; then socks="socks5://tailscale:1055"; fi
  fi
  body="$(env_lines \
      "OMNI_NODE_ID=$node_id" "OMNI_ROLE=$role" "OMNI_HUB_URL=$hub" "OMNI_JOIN_TOKEN=$join_token" \
      "OMNI_SOCKS_PROXY=$socks" "OMNI_LINK_TOKEN=$link_token" "OMNI_LINK_PORT=$LINK_PORT" \
      "OMNI_HERMES_URL=http://hermes:9119" "OMNI_PROJECT_ROOTS=$roots_csv" "OMNI_WORKSPACE=$ws" \
      "OMNI_DASHBOARD_URL=$dash_url" "OMNI_HOSTNAME=$(hostname -s)" "OMNI_STATE=/state")"
  write_file omni-state/link/link.env 600 \
    "# 자동 생성 (./setup.sh) — 직접 수정하지 마세요. link 컨테이너 환경값. 비밀값 포함, git 제외.
$body"
}

write_hub_env() {
  local body
  body="$(env_lines \
    "OMNI_HUB_PORT=$HUB_PORT_INTERNAL" "OMNI_JOIN_TOKEN=$join_token" "OMNI_PUBLIC_URL=$pub_url" \
    "OMNI_STATE=/state" "OMNI_APK_DIR=/apk")"
  write_file omni-state/hub/hub.env 600 \
    "# 자동 생성 (./setup.sh) — 직접 수정하지 마세요. hub 컨테이너 환경값. 비밀값 포함, git 제외.
$body"
}

# link/hub 는 컨테이너 사용자로 실행되어 상태 폴더에 써야 한다 (root 로 실행했을 때만 소유자 변경)
own_state() {
  [[ "$(id -u)" == 0 ]] || return 0
  chown -R "$cuid:$cgid" omni-state/link
  if [[ "$role" == hub ]]; then chown -R "$cuid:$cgid" omni-state/hub; fi
}

if ((omni)); then
  write_link_env
  if [[ "$role" == hub ]]; then write_hub_env; fi
  own_state
fi

# --- Tailscale serve 규칙 → tailscale/config/serve.json (폴더 마운트라 실행 중에도 바로 반영) --
serve_tcp='    "9119": { "TCPForward": "hermes:9119" }'
if [[ "$role" == hub ]]; then
  serve_tcp+=$',\n    "80": { "TCPForward": "hub:'"$HUB_PORT_INTERNAL"'" }'
fi
write_file tailscale/config/serve.json 644 "{
  \"TCP\": {
$serve_tcp
  }
}"

# --- docker-compose.override.yml ---------------------------------------------------------
gpu_block() {  # $1 = capabilities
  cat <<EOF
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [$1]
EOF
}

gen_override() {
  echo "# 자동 생성 (./setup.sh, $(date '+%F %T')) — 직접 수정하지 마세요. 이 머신 전용, git 제외."
  echo "# 바꾸려면 .env 를 고치고 ./setup.sh 를 다시 실행하세요."
  echo "services:"
  echo "  hermes:"
  echo "    environment:"
  echo "      - \"HERMES_WORKSPACE=$ws\""
  if [[ -n "$uid" ]]; then echo "      - HERMES_UID=$uid"; echo "      - HERMES_GID=$gid"; fi
  if ((omni)); then
    echo "      - OMNI_LINK_URL=http://link:$LINK_PORT"
    echo "      - OMNI_LINK_TOKEN=$link_token"
  fi
  echo "    volumes:"
  echo "      # 작업 폴더·프로젝트 루트를 호스트와 같은 절대 경로로 — 에이전트가 docker run -v \$PWD:... 해도 맞도록"
  for r in "${roots[@]}"; do echo "      - \"$r:$r\""; done
  if ((omni)); then echo "      - ./plugins/hub-bridge:/opt/data/plugins/hub-bridge:ro"; fi
  if ((use_gpu)); then gpu_block "gpu, compute, utility"; fi
  if [[ "$tailscale" == on ]]; then
    echo "  tailscale:"
    echo "    extends: { file: compose.tailscale.yml, service: tailscale }"
    echo "    hostname: $ts_name"
    echo "    environment:"
    echo "      - TS_HOSTNAME=$ts_name"
  fi
  if ((omni)); then
    echo "  link:"
    echo "    extends: { file: compose.omni.yml, service: link }"
    echo "    user: \"$cuid:$cgid\""
    echo "    volumes:"
    for r in "${roots[@]}"; do echo "      - \"$r:$r\""; done
    # nvidia-smi 로 GPU 사용량을 hub 에 보고 (utility 만)
    if ((use_gpu)); then gpu_block "utility"; fi
  fi
  if [[ "$role" == hub ]]; then
    echo "  hub:"
    echo "    extends: { file: compose.omni.yml, service: hub }"
    echo "    user: \"$cuid:$cgid\""
    if [[ -n "$hub_bind" ]]; then
      echo "    ports:"
      echo "      - \"$hub_bind:$hub_port:$HUB_PORT_INTERNAL\""
    fi
  fi
}
write_file docker-compose.override.yml 600 "$(gen_override)"

if ((use_gpu)); then log "GPU: 모든 nvidia GPU 패스스루"; else log "GPU: 사용 안 함"; fi
if [[ "$tailscale" == on ]]; then log "Tailscale: 사이드카 노드 $ts_name"; else log "Tailscale: 사용 안 함"; fi
log "작업 폴더: $ws"
if ((${#roots[@]} > 1)); then log "프로젝트 루트: ${roots[*]:1}"; fi
case "$role" in
  hub)  log "hermes-omni: hub (+ 이 머신도 node '$node_id')" ;;
  node) log "hermes-omni: node '$node_id' → hub $hub_url" ;;
esac

docker compose config -q || die "compose 설정이 올바르지 않습니다."
((START)) || { log "준비 완료 (--no-start)."; exit 0; }

# --- 실행 -------------------------------------------------------------------------------
docker compose up -d --remove-orphans
name="$(docker compose ps --format '{{.Name}}' hermes | head -n1)"
log "백엔드 대기 중..."
status=""
for _ in $(seq 1 40); do
  status="$(docker exec "$name" curl -fsS -m 3 http://127.0.0.1:9119/api/status 2>/dev/null)" && break
  sleep 3; status=""
done
[[ -n "$status" ]] || die "백엔드가 응답하지 않습니다: docker compose logs -f hermes"
grep -q '"basic"' <<<"$status" || die "Desktop 로그인(basic auth)이 활성화되지 않았습니다: docker compose logs hermes"

# --- 접속 주소 --------------------------------------------------------------------------
urls=()
dns=""
if [[ "$tailscale" == on ]]; then
  tsc="$(docker compose ps --format '{{.Name}}' tailscale | head -n1)"
  ts_ip() { docker exec "$tsc" tailscale ip -4 2>/dev/null | head -n1 || true; }
  ip="$(ts_ip)"
  if [[ -z "$ip" ]]; then
    # 첫 로그인: auth key 가 없으면 로그인 URL 을 보여주고 승인될 때까지 기다린다 (최대 10분)
    log "Tailscale 로그인 대기 중..."
    shown=""
    for _ in $(seq 1 300); do
      ip="$(ts_ip)"; [[ -n "$ip" ]] && break
      login="$(docker exec "$tsc" tailscale status 2>/dev/null | grep -o 'https://login.tailscale.com/[^ ]*' | head -n1 || true)"
      if [[ -n "$login" && "$login" != "$shown" ]]; then
        warn "Tailscale 로그인이 필요합니다 (최초 1회). 브라우저에서 열어 승인하세요:"
        printf '\n   %s\n\n' "$login"
        shown="$login"
      fi
      sleep 2
    done
  fi
  if [[ -n "$ip" ]]; then
    dns="$(docker exec "$tsc" tailscale status --json 2>/dev/null | sed -n 's/^    "DNSName": "\(.*\)\.",*$/\1/p' | head -n1 || true)"
    [[ -n "$dns" ]] && urls+=("http://$dns:9119")
    urls+=("http://$ip:9119")
  else
    warn "Tailscale 로그인이 아직 안 됐습니다. 승인 후 ./setup.sh 를 다시 실행하세요 (docker compose logs tailscale)."
  fi
fi
bind="$(get_kv HERMES_BIND)"; bind="${bind:-127.0.0.1}"
port="$(get_kv HERMES_PORT)"; port="${port:-9119}"
if [[ "$bind" == 0.0.0.0 ]]; then
  for a in $(hostname -I 2>/dev/null); do [[ "$a" == *.*.*.* ]] && urls+=("http://$a:$port (LAN)"); done
fi
urls+=("http://$bind:$port (이 머신에서만)")

# --- hermes-omni: tailnet 주소 반영 → link/hub 재생성, hub 등록 확인 -----------------------
registered=0
if ((omni)); then
  if [[ -n "$dns" ]]; then
    dash_url="http://$dns:9119"
    if [[ "$role" == hub ]]; then pub_url="http://$dns"; fi
  fi
  changed=()
  write_link_env; if ((WROTE)); then changed+=(link); fi
  if [[ "$role" == hub ]]; then write_hub_env; if ((WROTE)); then changed+=(hub); fi; fi
  own_state
  if ((${#changed[@]})); then
    log "tailnet 주소 반영: ${changed[*]} 재시작"
    docker compose up -d "${changed[@]}"
  fi

  # link 가 hub 에 붙으면 omni-state/link/status.json 에 {"connected": true, ...} 를 쓴다
  log "hub 등록 확인 중 (최대 90초)..."
  lc="$(docker compose ps --format '{{.Name}}' link | head -n1)"
  since=0
  if [[ -n "$lc" ]]; then
    since="$(date -d "$(docker inspect -f '{{.State.StartedAt}}' "$lc" 2>/dev/null)" +%s 2>/dev/null || echo 0)"
  fi
  sf="omni-state/link/status.json"
  for _ in $(seq 1 45); do
    if [[ -f "$sf" ]] && (( $(stat -c %Y "$sf") >= since )) \
       && grep -Eq '"connected"[[:space:]]*:[[:space:]]*true' "$sf"; then
      registered=1; break
    fi
    sleep 2
  done
  if ((registered)); then
    log "hub에 등록됨: $node_id → ${hub_url:-이 머신의 hub}"
  else
    warn "90초 안에 hub 에 등록되지 않았습니다. 확인: docker compose logs --tail 50 link"
    if [[ "$role" == node ]]; then warn "HUB_URL($hub_url)·HUB_JOIN_TOKEN 이 맞는지, hub 가 켜져 있는지, (Tailscale) 같은 tailnet 인지 확인하세요."; fi
  fi
fi

user="$(get_kv HERMES_DASHBOARD_BASIC_AUTH_USERNAME)"
cat <<EOF

  ┌──────────────────────────────────────────────────────────────
  │  Hermes 준비 완료
  │
  │  Hermes Desktop → Settings → Gateways → Remote gateway
EOF
first=1
for u in "${urls[@]}"; do
  if ((first)); then printf '  │    Remote URL : %s\n' "$u"; first=0
  else printf '  │                 %s\n' "$u"; fi
done
printf '  │    Sign in    : %s / (.env 의 HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)\n' "$user"
if [[ "$role" == hub ]]; then
  hub_ui=""
  if [[ -n "$pub_url" ]]; then hub_ui="$pub_url/"
  elif [[ -n "$hub_bind" ]]; then hub_ui="http://$hub_bind:$hub_port/"; fi
  cat <<EOF
  │
  │  hermes-omni hub
  │    Hub UI     : ${hub_ui:-(Tailscale 로그인 후 ./setup.sh 다시 실행하면 표시)}
  │    로그인     : $user / (위와 같은 비밀번호)
  │    머신 추가  : Hub UI → Join → 복사한 명령을 새 머신의 상위 폴더(예: ~/)에서 실행
  │    Android 앱 : Hub UI → Join 화면의 APK 다운로드 (폰 브라우저에서)
  │    이 머신    : $node_id $( ((registered)) && echo '(hub에 등록됨)' || echo '(등록 확인 안 됨 — docker compose logs link)')
EOF
elif [[ "$role" == node ]]; then
  cat <<EOF
  │
  │  hermes-omni node : $node_id
  │    hub        : $hub_url $( ((registered)) && echo '(hub에 등록됨)' || echo '(등록 확인 안 됨 — docker compose logs link)')
EOF
fi
cat <<EOF
  └──────────────────────────────────────────────────────────────

EOF
