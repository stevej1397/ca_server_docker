#!/bin/bash

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
SRC_DIR="${ROOT_DIR}/src"
OUT_FILE="${ROOT_DIR}/step-ca-webgui-acme.plg"

PLUGIN_NAME="step-ca-webgui-acme"
PLUGIN_VERSION="${PLUGIN_VERSION:-2026.09.22}"
PLUGIN_AUTHOR="${PLUGIN_AUTHOR:-OpenAI Codex}"
PLUGIN_MIN_VERSION="${PLUGIN_MIN_VERSION:-6.12.0}"
PLUGIN_URL="${PLUGIN_URL:-https://raw.githubusercontent.com/REPLACE_ME/ca_server_docker/main/unraid-plugin/step-ca-webgui-acme.plg}"
SUPPORT_URL="${SUPPORT_URL:-https://github.com/REPLACE_ME/ca_server_docker}"
LAUNCH_PATH="Settings/${PLUGIN_NAME}"
EMHTTP_DIR="/usr/local/emhttp/plugins/${PLUGIN_NAME}"
CONFIG_DIR="/boot/config/plugins/${PLUGIN_NAME}"

SCRIPT_FILE="${SRC_DIR}/scripts/${PLUGIN_NAME}.sh"
PAGE_FILE="${SRC_DIR}/${PLUGIN_NAME}.page"
README_FILE="${ROOT_DIR}/README.md"

# Only text files may be emitted here. A .plg is XML, and XML forbids NUL bytes
# even inside CDATA, so binary payloads must never be cat'd into the document.
emit_cdata_file() {
  local path="$1"

  if [ "$(LC_ALL=C tr -dc '\000' < "${path}" | wc -c)" -ne 0 ]; then
    printf 'ERROR: %s contains NUL bytes and cannot be embedded in XML CDATA.\n' "${path}" >&2
    exit 1
  fi

  if LC_ALL=C grep -qaF ']]>' "${path}"; then
    printf 'ERROR: %s contains "]]>" and would terminate its CDATA block early.\n' "${path}" >&2
    exit 1
  fi

  cat "${path}" >> "${OUT_FILE}"
}

cat > "${OUT_FILE}" <<EOF
<?xml version='1.0' standalone='yes'?>
<PLUGIN
  name="${PLUGIN_NAME}"
  author="${PLUGIN_AUTHOR}"
  version="${PLUGIN_VERSION}"
  launch="${LAUNCH_PATH}"
  pluginURL="${PLUGIN_URL}"
  min="${PLUGIN_MIN_VERSION}"
  support="${SUPPORT_URL}">

<CHANGES>
### ${PLUGIN_VERSION}
- Stop the renewal cron job from also appending to issue.log. The script already tees its own output there, so every line was logged twice.
- Remove previously installed plugin files before installing, since Unraid never overwrites an existing file and in-place updates otherwise only took effect after a reboot.

### 2026.09.09
- Detect the bundled acme.sh with a plain file test so renewal is not retried from scratch on every run, since /boot is vfat and can never carry an executable bit.
- Install acme.sh by copying the extracted tree directly instead of invoking its own installer, which depended on the current working directory and failed under cron.
- Drop the bundled OpenSSL 1.1 libraries. They were emitted as raw binary into XML CDATA, which corrupted the plugin file, and Unraid already ships OpenSSL 3.

### 2026.04.12
- Fix renewal for short-lived ACME certificates by forcing renewals based on the real installed certificate expiry.
- Run the bundled acme.sh client through \`sh\` so renewal still works when the script lives on \`/boot\`.
</CHANGES>

<!-- Unraid skips any FILE that already exists, so clear the old install first or updates never land. -->
<FILE Run="/bin/bash">
<INLINE><![CDATA[
rm -rf "${EMHTTP_DIR}"
]]></INLINE>
</FILE>

<FILE Name="${EMHTTP_DIR}/README.md">
<INLINE><![CDATA[
EOF

emit_cdata_file "${README_FILE}"

cat >> "${OUT_FILE}" <<EOF
]]></INLINE>
</FILE>

<FILE Name="${EMHTTP_DIR}/scripts/${PLUGIN_NAME}.sh">
<INLINE><![CDATA[
EOF

emit_cdata_file "${SCRIPT_FILE}"

cat >> "${OUT_FILE}" <<EOF
]]></INLINE>
</FILE>

<FILE Name="${EMHTTP_DIR}/${PLUGIN_NAME}.page">
<INLINE><![CDATA[
EOF

emit_cdata_file "${PAGE_FILE}"

cat >> "${OUT_FILE}" <<EOF
]]></INLINE>
</FILE>

<FILE Run="/bin/bash">
<INLINE><![CDATA[
chmod +x "${EMHTTP_DIR}/scripts/${PLUGIN_NAME}.sh"
mkdir -p "${CONFIG_DIR}" "${CONFIG_DIR}/logs"
"${EMHTTP_DIR}/scripts/${PLUGIN_NAME}.sh" configure
]]></INLINE>
</FILE>

<FILE Run="/bin/bash" Method="remove">
<INLINE><![CDATA[
if crontab -l 2>/dev/null | grep -F -q "# ${PLUGIN_NAME} managed job"; then
  tmp_file="\$(mktemp)"
  crontab -l 2>/dev/null | grep -F -v "# ${PLUGIN_NAME} managed job" > "\${tmp_file}" || true
  crontab "\${tmp_file}"
  rm -f "\${tmp_file}"
fi
rm -rf "${EMHTTP_DIR}"
echo "${PLUGIN_NAME} removed. Configuration in ${CONFIG_DIR} was preserved."
]]></INLINE>
</FILE>

</PLUGIN>
EOF

printf 'Wrote %s\n' "${OUT_FILE}"
