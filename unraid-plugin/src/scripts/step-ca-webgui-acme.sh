#!/bin/bash

set -euo pipefail

PLUGIN_NAME="step-ca-webgui-acme"
PLUGIN_DIR="/usr/local/emhttp/plugins/${PLUGIN_NAME}"
CONFIG_DIR="/boot/config/plugins/${PLUGIN_NAME}"
CONFIG_FILE="${CONFIG_DIR}/${PLUGIN_NAME}.cfg"
STATE_FILE="${CONFIG_DIR}/${PLUGIN_NAME}.state"
LOG_DIR="${CONFIG_DIR}/logs"
LOG_FILE="${LOG_DIR}/issue.log"
ACME_HOME="${CONFIG_DIR}/acme.sh"
CERT_WORK_DIR="${CONFIG_DIR}/certs"
ROOT_CA_FILE="${CONFIG_DIR}/root-ca.pem"
IDENT_CFG="/boot/config/ident.cfg"
SSL_CERT_DIR="/boot/config/ssl/certs"
NGINX_RC="/etc/rc.d/rc.nginx"
LOCK_DIR="${CONFIG_DIR}/.lock"
CRON_MARKER="# ${PLUGIN_NAME} managed job"
ACME_SH_VERSION="${ACME_SH_VERSION:-3.1.1}"
ACME_SH_ARCHIVE_URL="${ACME_SH_ARCHIVE_URL:-https://github.com/acmesh-official/acme.sh/archive/refs/tags/${ACME_SH_VERSION}.tar.gz}"

ACME_DIRECTORY_URL_DEFAULT="https://step-ca.lan:9000/acme/acme/directory"
ROOT_CERT_URL_DEFAULT="https://step-ca.lan:9000/roots.pem"
CONTACT_EMAIL_DEFAULT=""
DOMAIN_OVERRIDE_DEFAULT=""
EXTRA_DOMAINS_DEFAULT=""
SERVER_NAME_OVERRIDE_DEFAULT=""
CHALLENGE_MODE_DEFAULT="standalone"
ACME_INSECURE_BOOTSTRAP_DEFAULT="yes"
AUTO_RENEW_DEFAULT="yes"
RENEW_CRON_DEFAULT="17 3 * * *"
ENABLE_SSL_AFTER_ISSUE_DEFAULT="yes"
STOP_WEBSERVER_FOR_CHALLENGE_DEFAULT="yes"
MIN_FORCE_RENEW_SECONDS=86400
MAX_FORCE_RENEW_SECONDS=2592000

WEBGUI_WAS_STOPPED=0
RESOLVED_DOMAIN=""
ALL_DOMAINS=()
TARGET_SERVER_NAME=""
TARGET_BUNDLE=""
CERT_NOT_AFTER=""

timestamp() {
  date '+%Y-%m-%d %H:%M:%S'
}

log() {
  echo "[$(timestamp)] $*"
}

escape_ini() {
  printf '%s' "$1" | sed 's/\\/\\\\/g; s/"/\\"/g'
}

write_state() {
  local result="${1:-unknown}"
  local message="${2:-}"
  mkdir -p "${CONFIG_DIR}"
  cat > "${STATE_FILE}" <<EOF
LAST_RUN_AT="$(date -Iseconds)"
LAST_RESULT="$(escape_ini "${result}")"
LAST_MESSAGE="$(escape_ini "${message}")"
RESOLVED_DOMAIN="$(escape_ini "${RESOLVED_DOMAIN}")"
TARGET_SERVER_NAME="$(escape_ini "${TARGET_SERVER_NAME}")"
TARGET_BUNDLE="$(escape_ini "${TARGET_BUNDLE}")"
CERT_NOT_AFTER="$(escape_ini "${CERT_NOT_AFTER}")"
EOF
}

fail() {
  local message="${1:-Unknown error}"
  write_state "error" "${message}"
  log "ERROR: ${message}"
  exit 1
}

ensure_dirs() {
  mkdir -p "${CONFIG_DIR}" "${LOG_DIR}" "${CERT_WORK_DIR}" "${SSL_CERT_DIR}"
  touch "${LOG_FILE}"
}

write_default_config() {
  umask 077
  cat > "${CONFIG_FILE}" <<EOF
ACME_DIRECTORY_URL="${ACME_DIRECTORY_URL_DEFAULT}"
ROOT_CERT_URL="${ROOT_CERT_URL_DEFAULT}"
CONTACT_EMAIL="${CONTACT_EMAIL_DEFAULT}"
DOMAIN_OVERRIDE="${DOMAIN_OVERRIDE_DEFAULT}"
EXTRA_DOMAINS="${EXTRA_DOMAINS_DEFAULT}"
SERVER_NAME_OVERRIDE="${SERVER_NAME_OVERRIDE_DEFAULT}"
CHALLENGE_MODE="${CHALLENGE_MODE_DEFAULT}"
ACME_INSECURE_BOOTSTRAP="${ACME_INSECURE_BOOTSTRAP_DEFAULT}"
AUTO_RENEW="${AUTO_RENEW_DEFAULT}"
RENEW_CRON="${RENEW_CRON_DEFAULT}"
ENABLE_SSL_AFTER_ISSUE="${ENABLE_SSL_AFTER_ISSUE_DEFAULT}"
STOP_WEBSERVER_FOR_CHALLENGE="${STOP_WEBSERVER_FOR_CHALLENGE_DEFAULT}"
EOF
}

load_config() {
  ensure_dirs

  if [ ! -f "${CONFIG_FILE}" ]; then
    write_default_config
  fi

  # shellcheck disable=SC1090
  . "${CONFIG_FILE}"

  ACME_DIRECTORY_URL="${ACME_DIRECTORY_URL:-${ACME_DIRECTORY_URL_DEFAULT}}"
  ROOT_CERT_URL="${ROOT_CERT_URL:-${ROOT_CERT_URL_DEFAULT}}"
  CONTACT_EMAIL="${CONTACT_EMAIL:-${CONTACT_EMAIL_DEFAULT}}"
  DOMAIN_OVERRIDE="${DOMAIN_OVERRIDE:-${DOMAIN_OVERRIDE_DEFAULT}}"
  EXTRA_DOMAINS="${EXTRA_DOMAINS:-${EXTRA_DOMAINS_DEFAULT}}"
  SERVER_NAME_OVERRIDE="${SERVER_NAME_OVERRIDE:-${SERVER_NAME_OVERRIDE_DEFAULT}}"
  CHALLENGE_MODE="${CHALLENGE_MODE:-${CHALLENGE_MODE_DEFAULT}}"
  ACME_INSECURE_BOOTSTRAP="${ACME_INSECURE_BOOTSTRAP:-${ACME_INSECURE_BOOTSTRAP_DEFAULT}}"
  AUTO_RENEW="${AUTO_RENEW:-${AUTO_RENEW_DEFAULT}}"
  RENEW_CRON="${RENEW_CRON:-${RENEW_CRON_DEFAULT}}"
  ENABLE_SSL_AFTER_ISSUE="${ENABLE_SSL_AFTER_ISSUE:-${ENABLE_SSL_AFTER_ISSUE_DEFAULT}}"
  STOP_WEBSERVER_FOR_CHALLENGE="${STOP_WEBSERVER_FOR_CHALLENGE:-${STOP_WEBSERVER_FOR_CHALLENGE_DEFAULT}}"
}

require_binary() {
  local name="$1"
  command -v "${name}" >/dev/null 2>&1 || fail "Required command '${name}' is not available."
}

load_ident_config() {
  local ident_name=""
  local ident_local_tld=""

  if [ -f "${IDENT_CFG}" ]; then
    while IFS='=' read -r raw_key raw_value; do
      local key="${raw_key// /}"
      local value="${raw_value:-}"
      key="${key//$'\r'/}"
      value="${value//$'\r'/}"
      value="${value%\"}"
      value="${value#\"}"

      case "${key}" in
        NAME)
          ident_name="${value}"
          ;;
        LOCAL_TLD)
          ident_local_tld="${value}"
          ;;
      esac
    done < "${IDENT_CFG}"
  fi

  IDENT_NAME="${ident_name}"
  IDENT_LOCAL_TLD="${ident_local_tld}"
}

sanitize_server_name() {
  printf '%s' "$1" | sed 's/[^A-Za-z0-9._-]/-/g; s/^-*//; s/-*$//'
}

resolve_domain() {
  load_ident_config

  if [ -n "${DOMAIN_OVERRIDE}" ]; then
    RESOLVED_DOMAIN="${DOMAIN_OVERRIDE}"
  else
    local server_name="${SERVER_NAME_OVERRIDE:-${IDENT_NAME:-}}"
    local local_tld="${IDENT_LOCAL_TLD:-}"

    [ -n "${server_name}" ] || fail "No server name found. Set 'Server name override' or configure Settings -> Identification in Unraid."
    [ -n "${local_tld}" ] || fail "No Local TLD found. Set it in Unraid Management Access or use 'Domain override'."
    RESOLVED_DOMAIN="${server_name}.${local_tld}"
  fi

  # The primary name stays first so acme.sh keeps filing the certificate under it.
  local extra existing duplicate
  ALL_DOMAINS=("${RESOLVED_DOMAIN}")
  for extra in ${EXTRA_DOMAINS//,/ }; do
    duplicate=0
    for existing in "${ALL_DOMAINS[@]}"; do
      if [ "${existing,,}" = "${extra,,}" ]; then
        duplicate=1
        break
      fi
    done
    [ "${duplicate}" -eq 1 ] || ALL_DOMAINS+=("${extra}")
  done

  if [ -n "${SERVER_NAME_OVERRIDE}" ]; then
    TARGET_SERVER_NAME="${SERVER_NAME_OVERRIDE}"
  elif [ -n "${IDENT_NAME:-}" ]; then
    TARGET_SERVER_NAME="${IDENT_NAME}"
  else
    TARGET_SERVER_NAME="${RESOLVED_DOMAIN%%.*}"
  fi

  TARGET_SERVER_NAME="$(sanitize_server_name "${TARGET_SERVER_NAME}")"
  [ -n "${TARGET_SERVER_NAME}" ] || fail "Unable to determine the target Unraid server name."
  TARGET_BUNDLE="${SSL_CERT_DIR}/${TARGET_SERVER_NAME}_unraid_bundle.pem"
}

domain_args() {
  local domain
  for domain in "${ALL_DOMAINS[@]}"; do
    printf -- '-d\n%s\n' "${domain}"
  done
}

# Prints the first configured name the installed bundle does not cover, if any.
# openssl -checkhost exits 0 either way, so its message has to be read instead.
first_uncovered_domain() {
  local domain
  for domain in "${ALL_DOMAINS[@]}"; do
    if ! openssl x509 -in "${TARGET_BUNDLE}" -noout -checkhost "${domain}" 2>/dev/null | grep -q ' does match'; then
      printf '%s\n' "${domain}"
      return 0
    fi
  done
  return 1
}

derive_root_url() {
  if [ -n "${ROOT_CERT_URL}" ]; then
    printf '%s\n' "${ROOT_CERT_URL}"
    return
  fi

  printf '%s\n' "${ACME_DIRECTORY_URL}" | sed -E 's#/acme/.*$#/roots.pem#'
}

fetch_root_ca() {
  local root_url
  local curl_args=(
    --fail
    --silent
    --show-error
    --location
  )

  root_url="$(derive_root_url)"
  [ -n "${root_url}" ] || fail "Unable to determine the Step CA root certificate URL."

  if [ "${ACME_INSECURE_BOOTSTRAP}" = "yes" ]; then
    curl_args+=(-k)
  fi

  log "Downloading Step CA root bundle from ${root_url}"
  curl "${curl_args[@]}" "${root_url}" -o "${ROOT_CA_FILE}.tmp"

  grep -q "BEGIN CERTIFICATE" "${ROOT_CA_FILE}.tmp" || fail "Downloaded root bundle does not look like PEM data."
  mv "${ROOT_CA_FILE}.tmp" "${ROOT_CA_FILE}"
}

acme_sh() {
  sh "${ACME_HOME}/acme.sh" --home "${ACME_HOME}" --config-home "${ACME_HOME}" "$@"
}

ensure_acme_client() {
  local tmp_dir source_dir

  if [ -f "${ACME_HOME}/acme.sh" ]; then
    return
  fi

  require_binary curl
  require_binary tar

  tmp_dir="$(mktemp -d)"
  trap 'rm -rf "${tmp_dir}"' RETURN

  log "Installing acme.sh ${ACME_SH_VERSION} into ${ACME_HOME}"
  curl --fail --silent --show-error --location "${ACME_SH_ARCHIVE_URL}" | tar -xz -C "${tmp_dir}"

  source_dir="${tmp_dir}/acme.sh-${ACME_SH_VERSION}"
  [ -d "${source_dir}" ] || source_dir="${tmp_dir}/acme.sh-master"
  [ -d "${source_dir}" ] || fail "Failed to locate extracted acme.sh files after download."

  mkdir -p "${ACME_HOME}"
  cp -a "${source_dir}/." "${ACME_HOME}/"

  chmod +x "${ACME_HOME}/acme.sh"
  rm -rf "${tmp_dir}"
  trap - RETURN
}

certificate_date_epoch() {
  local certificate_file="$1"
  local date_flag="$2"
  local raw_date=""

  raw_date="$(openssl x509 -in "${certificate_file}" -noout "${date_flag}" 2>/dev/null | cut -d= -f2-)"
  [ -n "${raw_date}" ] || return 1
  date -d "${raw_date}" +%s
}

force_renew_threshold_seconds() {
  local certificate_file="$1"
  local start_epoch end_epoch lifetime threshold

  start_epoch="$(certificate_date_epoch "${certificate_file}" -startdate)" || return 1
  end_epoch="$(certificate_date_epoch "${certificate_file}" -enddate)" || return 1
  [ "${end_epoch}" -gt "${start_epoch}" ] || return 1

  lifetime=$((end_epoch - start_epoch))
  threshold=$((lifetime / 3))

  if [ "${threshold}" -lt "${MIN_FORCE_RENEW_SECONDS}" ]; then
    threshold="${MIN_FORCE_RENEW_SECONDS}"
  fi

  if [ "${threshold}" -gt "${MAX_FORCE_RENEW_SECONDS}" ]; then
    threshold="${MAX_FORCE_RENEW_SECONDS}"
  fi

  printf '%s\n' "${threshold}"
}

should_force_renew() {
  local certificate_file="${TARGET_BUNDLE}"
  local now_epoch end_epoch remaining_seconds threshold_seconds

  if [ ! -f "${certificate_file}" ]; then
    log "Forcing renewal because the installed Unraid bundle does not exist yet."
    return 0
  fi

  if ! openssl x509 -in "${certificate_file}" -noout >/dev/null 2>&1; then
    log "Forcing renewal because the installed Unraid bundle is not a valid certificate."
    return 0
  fi

  now_epoch="$(date +%s)"
  end_epoch="$(certificate_date_epoch "${certificate_file}" -enddate)" || {
    log "Forcing renewal because the installed Unraid bundle expiry could not be read."
    return 0
  }

  remaining_seconds=$((end_epoch - now_epoch))
  if [ "${remaining_seconds}" -le 0 ]; then
    log "Forcing renewal because the installed Unraid bundle is already expired."
    return 0
  fi

  threshold_seconds="$(force_renew_threshold_seconds "${certificate_file}")" || threshold_seconds="${MIN_FORCE_RENEW_SECONDS}"
  if [ "${remaining_seconds}" -le "${threshold_seconds}" ]; then
    log "Forcing renewal because the installed Unraid bundle expires within ${threshold_seconds} seconds."
    return 0
  fi

  return 1
}

with_lock() {
  if ! mkdir "${LOCK_DIR}" 2>/dev/null; then
    fail "Another ${PLUGIN_NAME} action is already running."
  fi

  trap 'rm -rf "${LOCK_DIR}"' EXIT
}

stop_webgui_if_needed() {
  if [ "${STOP_WEBSERVER_FOR_CHALLENGE}" != "yes" ]; then
    return
  fi

  if [ ! -x "${NGINX_RC}" ]; then
    log "Skipping WebGUI stop because ${NGINX_RC} is unavailable."
    return
  fi

  log "Stopping Unraid WebGUI for ACME ${CHALLENGE_MODE} validation"
  "${NGINX_RC}" stop >/dev/null 2>&1 || true
  WEBGUI_WAS_STOPPED=1
}

start_webgui_if_needed() {
  if [ "${WEBGUI_WAS_STOPPED}" -ne 1 ]; then
    return
  fi

  if [ -x "${NGINX_RC}" ]; then
    log "Starting Unraid WebGUI"
    "${NGINX_RC}" start >/dev/null 2>&1 || true
  fi
}

reload_webgui() {
  if [ "${ENABLE_SSL_AFTER_ISSUE}" = "yes" ] && command -v use_ssl >/dev/null 2>&1; then
    log "Ensuring Unraid SSL is enabled"
    use_ssl yes >/dev/null 2>&1 || true
  fi

  if [ -x "${NGINX_RC}" ]; then
    log "Reloading Unraid WebGUI"
    "${NGINX_RC}" reload >/dev/null 2>&1 || "${NGINX_RC}" restart >/dev/null 2>&1 || true
  fi
}

validate_bundle() {
  require_binary openssl

  [ -f "${TARGET_BUNDLE}" ] || fail "Expected bundle was not created at ${TARGET_BUNDLE}."
  openssl x509 -in "${TARGET_BUNDLE}" -noout >/dev/null 2>&1 || fail "Installed bundle does not begin with a valid certificate."
  local uncovered
  if uncovered="$(first_uncovered_domain)"; then
    fail "Installed certificate does not match ${uncovered}."
  fi
  CERT_NOT_AFTER="$(openssl x509 -in "${TARGET_BUNDLE}" -noout -enddate | cut -d= -f2-)"
}

update_cron() {
  local tmp_file cron_line

  tmp_file="$(mktemp)"
  crontab -l 2>/dev/null | grep -F -v "${CRON_MARKER}" > "${tmp_file}" || true

  if [ "${AUTO_RENEW}" = "yes" ]; then
    cron_line="${RENEW_CRON} /usr/local/emhttp/plugins/${PLUGIN_NAME}/scripts/${PLUGIN_NAME}.sh renew > /dev/null 2>&1 ${CRON_MARKER}"
    printf '%s\n' "${cron_line}" >> "${tmp_file}"
  fi

  crontab "${tmp_file}"
  rm -f "${tmp_file}"
}

install_bundle_files() {
  local domain_dir="${CERT_WORK_DIR}/${RESOLVED_DOMAIN}"
  local cert_file="${domain_dir}/cert.pem"
  local key_file="${domain_dir}/private.key"
  local fullchain_file="${domain_dir}/fullchain.pem"
  local ca_file="${domain_dir}/ca.pem"
  local tmp_bundle="${TARGET_BUNDLE}.tmp"

  mkdir -p "${domain_dir}"

  acme_sh \
    --install-cert -d "${RESOLVED_DOMAIN}" \
    --cert-file "${cert_file}" \
    --key-file "${key_file}" \
    --fullchain-file "${fullchain_file}" \
    --ca-file "${ca_file}" >/dev/null

  [ -f "${fullchain_file}" ] || fail "acme.sh did not produce a fullchain file."
  [ -f "${key_file}" ] || fail "acme.sh did not produce a private key file."

  umask 077
  cat "${fullchain_file}" "${key_file}" > "${tmp_bundle}"
  mv "${tmp_bundle}" "${TARGET_BUNDLE}"
}

run_acme_issue() {
  local acme_cmd=(
    acme_sh
    --server "${ACME_DIRECTORY_URL}"
    --ca-bundle "${ROOT_CA_FILE}"
    --keylength 2048
  )
  local domain_flags
  mapfile -t domain_flags < <(domain_args)
  acme_cmd+=("${domain_flags[@]}")

  if [ "${CHALLENGE_MODE}" = "alpn" ]; then
    acme_cmd+=(--alpn)
  else
    acme_cmd+=(--standalone)
  fi

  log "Requesting certificate for ${ALL_DOMAINS[*]} via ${ACME_DIRECTORY_URL}"
  "${acme_cmd[@]}" --issue --force
}

run_acme_renew() {
  local acme_cmd=(
    acme_sh
    --server "${ACME_DIRECTORY_URL}"
    --ca-bundle "${ROOT_CA_FILE}"
    --keylength 2048
  )
  local domain_flags
  mapfile -t domain_flags < <(domain_args)
  acme_cmd+=("${domain_flags[@]}")

  if [ "${CHALLENGE_MODE}" = "alpn" ]; then
    acme_cmd+=(--alpn)
  else
    acme_cmd+=(--standalone)
  fi

  local uncovered=""
  if [ -f "${TARGET_BUNDLE}" ]; then
    uncovered="$(first_uncovered_domain)" || uncovered=""
  fi

  if [ -d "${ACME_HOME}/${RESOLVED_DOMAIN}" ] && [ -n "${uncovered}" ]; then
    # acme.sh --renew reuses the names stored at issue time, so a changed name list needs a fresh order.
    log "Installed certificate does not cover ${uncovered}; issuing a fresh certificate for ${ALL_DOMAINS[*]}"
    "${acme_cmd[@]}" --issue --force
  elif [ -d "${ACME_HOME}/${RESOLVED_DOMAIN}" ]; then
    if should_force_renew; then
      log "Renewing certificate for ${RESOLVED_DOMAIN} with --force"
      "${acme_cmd[@]}" --renew --force
    else
      log "Renewing certificate for ${RESOLVED_DOMAIN}"
      "${acme_cmd[@]}" --renew
    fi
  else
    log "No existing ACME material found for ${RESOLVED_DOMAIN}; issuing a fresh certificate instead"
    "${acme_cmd[@]}" --issue --force
  fi
}

run_certificate_action() {
  local mode="$1"

  require_binary curl
  require_binary openssl

  ensure_dirs
  load_config
  resolve_domain
  fetch_root_ca
  ensure_acme_client

  if [ "${CHALLENGE_MODE}" = "standalone" ] || [ "${CHALLENGE_MODE}" = "alpn" ]; then
    command -v socat >/dev/null 2>&1 || fail "acme.sh requires 'socat' for ${CHALLENGE_MODE} challenge mode, but socat is not installed on this Unraid server."
  fi
  with_lock

  if [ "${CHALLENGE_MODE}" != "standalone" ] && [ "${CHALLENGE_MODE}" != "alpn" ]; then
    fail "Unsupported challenge mode '${CHALLENGE_MODE}'. Use 'standalone' or 'alpn'."
  fi

  trap 'start_webgui_if_needed; rm -rf "${LOCK_DIR}"' EXIT
  stop_webgui_if_needed

  if [ "${mode}" = "renew" ]; then
    run_acme_renew
  else
    run_acme_issue
  fi

  install_bundle_files
  validate_bundle
  reload_webgui

  write_state "success" "Installed certificate for ${ALL_DOMAINS[*]}; expires ${CERT_NOT_AFTER}."
  log "Certificate installed at ${TARGET_BUNDLE}"
  log "Certificate expiry: ${CERT_NOT_AFTER}"
}

show_status() {
  load_config
  resolve_domain

  printf 'Resolved domain: %s\n' "${RESOLVED_DOMAIN}"
  printf 'Certificate names: %s\n' "${ALL_DOMAINS[*]}"
  printf 'Target bundle: %s\n' "${TARGET_BUNDLE}"
  printf 'ACME directory: %s\n' "${ACME_DIRECTORY_URL}"
  printf 'Challenge mode: %s\n' "${CHALLENGE_MODE}"

  if [ -f "${TARGET_BUNDLE}" ]; then
    printf 'Installed certificate:\n'
    openssl x509 -in "${TARGET_BUNDLE}" -noout -subject -ext subjectAltName -issuer -enddate
  else
    printf 'Installed certificate: none\n'
  fi
}

configure_plugin() {
  ensure_dirs
  load_config
  update_cron
  write_state "success" "Configuration saved."
  log "Configuration loaded and cron updated"
}

main() {
  local command="${1:-status}"

  ensure_dirs
  exec >> >(tee -a "${LOG_FILE}") 2>&1
  log "Starting ${PLUGIN_NAME} action: ${command}"

  case "${command}" in
    configure)
      configure_plugin
      ;;
    issue)
      run_certificate_action issue
      ;;
    renew)
      run_certificate_action renew
      ;;
    status)
      show_status
      ;;
    *)
      fail "Unknown command '${command}'. Valid commands: configure, issue, renew, status."
      ;;
  esac
}

main "$@"
