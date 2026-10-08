#!/usr/bin/env bash
# =====================================================================================
#  Hermes — 머신 준비 + 실행 (여러 번 실행해도 안전)
#
#  준비:  cp .env.example .env 후 값 채우기
#  사용:  ./setup.sh             머신 감지 → docker-compose.override.yml 생성 → up -d → 접속 주소 출력
#         ./setup.sh --no-start  override 생성까지만
#
#  docker-compose.override.yml (자동 생성, git 제외): 작업 폴더 절대 경로, GPU 패스스루,
#  Tailscale 사이드카/노드 이름, 컨테이너 UID — 머신마다 다른 값들.
# =====================================================================================
set -Eeuo pipefail
cd "$(dirname "$(readlink -f "$0")")"

log()  { printf '\033[1;36m[hermes]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hermes] 경고:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[hermes] 오류:\033[0m %s\n' "$*" >&2; exit 1; }

START=1
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    -h|--help) sed -n '3,10p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $arg" ;;
  esac
done

command -v docker >/dev/null || die "docker 가 없습니다."
docker compose version >/dev/null 2>&1 || die "docker compose 플러그인이 없습니다."
docker info >/dev/null 2>&1 || die "docker 데몬에 접근할 수 없습니다 (root 또는 docker 그룹 필요)."

# --- .env 확인 (사용자가 채워 둔다) -------------------------------------------------------
[[ -f .env ]] || die ".env 가 없습니다: cp .env.example .env 후 값을 채우세요."
chmod 600 .env
# 값을 셸로 source 하지 않음 (키에 # $ 등이 들어갈 수 있음). 공백 뒤 # 은 주석.
get_kv() { sed -n "s/^$1=//p" .env | tail -n1 | sed -E 's/[[:space:]]+#.*$//'; }

missing=()
for k in LLM_BASE_URL LLM_MODEL HERMES_DASHBOARD_BASIC_AUTH_USERNAME HERMES_DASHBOARD_BASIC_AUTH_PASSWORD; do
  [[ -n "$(get_kv "$k")" ]] || missing+=("$k")
done
((${#missing[@]} == 0)) || die ".env 에 값이 비어 있습니다: ${missing[*]}"

tailscale="$(get_kv HERMES_TAILSCALE)"; tailscale="${tailscale:-on}"
[[ "$tailscale" == on || "$tailscale" == off ]] || die "HERMES_TAILSCALE 는 on|off 중 하나: $tailscale"

# --- 머신 값 → docker-compose.override.yml ----------------------------------------------
mkdir -p data workspace tailscale/state
ws="$PWD/workspace"

# 컨테이너 hermes 사용자 UID: root 로 실행하면 이미지 기본(10000), 아니면 실행한 사용자
uid=""; gid=""
if [[ "$(id -u)" == 0 ]]; then chown 10000:10000 workspace
else uid="$(id -u)"; gid="$(id -g)"; fi

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

{
  echo "# 자동 생성 (./setup.sh, $(date '+%F %T')) — 직접 수정하지 마세요. 이 머신 전용, git 제외."
  echo "# 바꾸려면 .env 를 고치고 ./setup.sh 를 다시 실행하세요."
  echo "services:"
  echo "  hermes:"
  echo "    environment:"
  echo "      - \"HERMES_WORKSPACE=$ws\""
  if [[ -n "$uid" ]]; then echo "      - HERMES_UID=$uid"; echo "      - HERMES_GID=$gid"; fi
  echo "    volumes:"
  echo "      # 작업 폴더를 호스트와 같은 절대 경로로 — 에이전트가 docker run -v \$PWD:... 해도 맞도록"
  echo "      - \"$ws:$ws\""
  if ((use_gpu)); then
    cat <<'EOF'
    deploy:
      resources:
        reservations:
          devices:
            - driver: nvidia
              count: all
              capabilities: [gpu, compute, utility]
EOF
  fi
  if [[ "$tailscale" == on ]]; then
    echo "  tailscale:"
    echo "    extends: { file: compose.tailscale.yml, service: tailscale }"
    echo "    hostname: $ts_name"
    echo "    environment:"
    echo "      - TS_HOSTNAME=$ts_name"
  fi
} > docker-compose.override.yml

if ((use_gpu)); then log "GPU: 모든 nvidia GPU 패스스루"; else log "GPU: 사용 안 함"; fi
if [[ "$tailscale" == on ]]; then log "Tailscale: 사이드카 노드 $ts_name"; else log "Tailscale: 사용 안 함"; fi
log "작업 폴더: $ws"

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
cat <<EOF
  │    Sign in    : $(get_kv HERMES_DASHBOARD_BASIC_AUTH_USERNAME) / (.env 의 HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)
  └──────────────────────────────────────────────────────────────

EOF
