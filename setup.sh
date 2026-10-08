#!/usr/bin/env bash
# =====================================================================================
#  Hermes — 머신 준비 + 실행 (여러 번 실행해도 안전)
#
#  사용법:
#    ./setup.sh               .env 준비 → 폴더 준비 → GPU 감지 → docker compose up -d
#    ./setup.sh --no-start    .env / 폴더만 준비하고 실행은 하지 않음
#    ./setup.sh --tailscale   호스트 tailscale 로 tailnet 에 :HERMES_PORT 노출 (tailscale serve, 재부팅 유지)
#
#  .env 가 없으면 .env.example 에서 만들고 Desktop 로그인 비밀번호/서명키를 무작위로 채운다.
#  LLM_API_KEY 가 비어 있으면 (터미널일 때) 물어본다.
#  매번 다시 계산하는 값: HERMES_WORKSPACE, COMPOSE_FILE. 나머지는 이미 있으면 건드리지 않는다.
# =====================================================================================
set -Eeuo pipefail
cd "$(dirname "$(readlink -f "$0")")"

log()  { printf '\033[1;36m[hermes]\033[0m %s\n' "$*"; }
warn() { printf '\033[1;33m[hermes] 경고:\033[0m %s\n' "$*" >&2; }
die()  { printf '\033[1;31m[hermes] 오류:\033[0m %s\n' "$*" >&2; exit 1; }

START=1
TAILSCALE=0
for arg in "$@"; do
  case "$arg" in
    --no-start) START=0 ;;
    --tailscale) TAILSCALE=1 ;;
    -h|--help) sed -n '3,13p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) die "알 수 없는 인자: $arg" ;;
  esac
done

command -v docker >/dev/null || die "docker 가 없습니다."
docker compose version >/dev/null 2>&1 || die "docker compose 플러그인이 없습니다."
docker info >/dev/null 2>&1 || die "docker 데몬에 접근할 수 없습니다 (root 또는 docker 그룹 필요)."

# --- .env helpers (값을 셸로 source 하지 않음: 키에 # $ 등이 들어갈 수 있음) -----------------
get_kv() { sed -n "s/^$1=//p" .env | tail -n1; }
set_kv() {
  local key="$1" val="$2" tmp
  tmp="$(mktemp)"
  if grep -q "^$key=" .env; then
    awk -v k="$key" -v v="$val" 'BEGIN{FS=OFS="="} $1==k {print k "=" v; next} {print}' .env >"$tmp"
  else
    cat .env >"$tmp"; printf '%s=%s\n' "$key" "$val" >>"$tmp"
  fi
  cat "$tmp" >.env; rm -f "$tmp"
}
rand() { head -c 64 /dev/urandom | base64 | tr -dc 'A-Za-z0-9' | head -c "$1"; }

# --- .env -------------------------------------------------------------------------------
if [[ ! -f .env ]]; then
  cp .env.example .env
  log ".env 를 .env.example 에서 만들었습니다."
fi
chmod 600 .env

[[ -n "$(get_kv HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)" ]] || set_kv HERMES_DASHBOARD_BASIC_AUTH_PASSWORD "$(rand 20)"
[[ -n "$(get_kv HERMES_DASHBOARD_BASIC_AUTH_SECRET)" ]]   || set_kv HERMES_DASHBOARD_BASIC_AUTH_SECRET "$(rand 44)"

if [[ -z "$(get_kv LLM_API_KEY)" ]]; then
  if [[ -t 0 ]]; then
    read -r -s -p "LLM_API_KEY ($(get_kv LLM_BASE_URL)) 입력 (없으면 Enter): " key; echo
    [[ -n "$key" ]] && set_kv LLM_API_KEY "$key"
  else
    warn "LLM_API_KEY 가 비어 있습니다. .env 에 채운 뒤 docker compose up -d 하세요."
  fi
fi

# 컨테이너 사용자 UID: root 로 실행하면 이미지 기본(10000), 아니면 실행한 사용자
if [[ -z "$(get_kv HERMES_UID)" ]]; then
  if [[ "$(id -u)" == 0 ]]; then set_kv HERMES_UID 10000; set_kv HERMES_GID 10000
  else set_kv HERMES_UID "$(id -u)"; set_kv HERMES_GID "$(id -g)"; fi
fi

# --- 폴더 (모든 상태는 이 폴더 안) -------------------------------------------------------
mkdir -p data workspace
set_kv HERMES_WORKSPACE "$PWD/workspace"
if [[ "$(id -u)" == 0 ]]; then
  chown "$(get_kv HERMES_UID):$(get_kv HERMES_GID)" workspace
fi

# --- compose 파일 조합 (GPU / 머신 전용 override) ----------------------------------------
files="docker-compose.yml"
gpu="$(get_kv HERMES_GPU)"; gpu="${gpu:-auto}"
case "$gpu" in
  on) files+=":compose.gpu.yml" ;;
  off) ;;
  auto)
    if docker info --format '{{json .Runtimes}}' 2>/dev/null | grep -q '"nvidia"' \
       || command -v nvidia-ctk >/dev/null 2>&1; then
      files+=":compose.gpu.yml"; log "nvidia GPU 런타임 감지 → 모든 GPU 패스스루"
    else
      log "nvidia 런타임 없음 → GPU 없이 실행"
    fi ;;
  *) die "HERMES_GPU 는 auto|on|off 중 하나여야 합니다: $gpu" ;;
esac
[[ -f docker-compose.override.yml ]] && files+=":docker-compose.override.yml" && log "docker-compose.override.yml 포함"
set_kv COMPOSE_FILE "$files"

docker compose config -q || die "compose 설정이 올바르지 않습니다."
((START)) || { log "준비 완료 (--no-start)."; exit 0; }

# --- 실행 -------------------------------------------------------------------------------
docker compose up -d
name="$(docker compose ps --format '{{.Name}}' hermes | head -n1)"
log "백엔드 대기 중..."
for _ in $(seq 1 40); do
  if status="$(docker exec "$name" curl -fsS -m 3 http://127.0.0.1:9119/api/status 2>/dev/null)"; then break; fi
  sleep 3; status=""
done
[[ -n "$status" ]] || die "백엔드가 응답하지 않습니다: docker compose logs -f"
grep -q '"basic"' <<<"$status" || warn "로그인(basic auth)이 활성화되지 않았습니다. .env 의 HERMES_DASHBOARD_BASIC_AUTH_* 확인"

port="$(get_kv HERMES_PORT)"; port="${port:-9119}"
if ((TAILSCALE)); then
  command -v tailscale >/dev/null || die "호스트에 tailscale CLI 가 없습니다."
  [[ "$(get_kv HERMES_BIND)" == "127.0.0.1" ]] || warn "HERMES_BIND 가 127.0.0.1 이 아닙니다 — tailscale serve 가 127.0.0.1:$port 로 전달합니다."
  tailscale serve --bg --tcp="$port" "tcp://127.0.0.1:$port"
  log "tailnet 노출: http://$(tailscale ip -4 | head -n1):$port"
fi

log "완료. Hermes Desktop → Settings → Gateways → Remote gateway"
log "  URL: http://<이 머신 주소>:$port   (bind=$(get_kv HERMES_BIND))"
log "  로그인: $(get_kv HERMES_DASHBOARD_BASIC_AUTH_USERNAME) / (.env 의 HERMES_DASHBOARD_BASIC_AUTH_PASSWORD)"
