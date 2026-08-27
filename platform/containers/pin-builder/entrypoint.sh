#!/usr/bin/env bash
set -euo pipefail

readonly SOURCE_ROOT="${REVIVAL_HELD_PIN_SOURCE_ROOT:-/workspace/pin}"
readonly TOOL_ROOT="${REVIVAL_HELD_TOOL_ROOT:-/workspace/platform/containers/pin-builder}"
readonly BOOTSTRAP_ALIUHOOK="${REVIVAL_HELD_BOOTSTRAP_ALIUHOOK:-${TOOL_ROOT}/bootstrap-aliuhook.sh}"
readonly CREDENTIAL_FREE_TOOL_ROOT="${REVIVAL_HELD_CREDENTIAL_FREE_TOOL_ROOT:-/tmp/revival-pin-credential-free}"
readonly CACHE_CARGO_REGISTRY="/cache-data/cargo-registry"
readonly CACHE_CARGO_GIT="/cache-data/cargo-git"
readonly CACHE_GRADLE_CACHES="/cache-data/gradle-caches"
readonly CACHE_GRADLE_WRAPPER="/cache-data/gradle-wrapper"
readonly CACHE_NPM_CACACHE="/cache-data/npm-cacache"
readonly STATE_ROOT="${REVIVAL_HELD_STATE_ROOT:-/state/device-build}"
readonly WORK_ROOT="${REVIVAL_HELD_WORK_ROOT:-${STATE_ROOT}/worktree}"
readonly ARTIFACT_ROOT="/state/artifacts/device"
readonly DEBUG_ARTIFACT_ROOT="${REVIVAL_HELD_DEBUG_ARTIFACT_ROOT:-/state/artifacts/device-debug}"
readonly RELEASE_ROOT="/state/release-output"
readonly SIGNING_ENV_FILE="/run/secrets/pin/signing.env"
readonly COMPATIBILITY_SIGNING_STORE="/run/secrets/pin/compatibility.keystore"
readonly EMBEDDED_PATCH_SIGNING_STORE="/run/secrets/pin/embedded-patch.keystore"
readonly PRIVATE_ASSETS_ROOT="/run/private-assets"
readonly COMPATIBILITY_CERT_SHA256="d8a64e1c3a1afdc340c4b86feaacb88e2d81d66972afbd58e743b7c5b8d1cbdb"

# The private-assets mount is a fixed absolute container path. Export it at the
# top level so every child — including the Gradle build in its own subshell —
# inherits it; validate_release_inputs also re-exports it after proving the
# mount exists, but the build must never see it unset.
export REVIVAL_PIN_PRIVATE_ASSETS_DIR="${PRIVATE_ASSETS_ROOT}"

die() {
  printf 'device-builder: %s\n' "$*" >&2
  exit 2
}

show_help() {
  cat <<'EOF'
Ai Pin Revival device builder

Usage:
  device-builder help
  device-builder versions
  device-builder doctor [doctor options]
  device-builder build-cli
  device-builder build-android
  device-builder build-debug
  device-builder build-debug-role --role installer|bootstrap|hook|server|hook-injector [--role ...]
  device-builder check-unit
  device-builder prefetch-release --version YYYY-MM-DD.N --version-code INTEGER
  device-builder build-release --version YYYY-MM-DD.N --version-code INTEGER
  device-builder shell

The product source is read from /workspace/pin. Builds happen only
in /state/device-build/worktree; results are copied to
/state/artifacts/device. The source mount is never modified.

The host first runs prefetch-release without signing material. The release build
then consumes externally mounted signing inputs and emits exactly five APKs.
The image never runs ADB, provisions a Pin, or installs anything on hardware.
Role-scoped debug outputs are compile-only developer artifacts. They are never
signed with release credentials, published to the release store, or installable
by the repository's device installer.
EOF
}

show_versions() {
  printf 'java: '
  java -version 2>&1 | head -n 1
  printf 'node: %s\n' "$(node --version)"
  printf 'rust: %s\n' "$(rustc --version)"
  printf 'cargo-ndk: %s\n' "$(cargo ndk --version)"
  printf 'protoc: %s\n' "$(protoc --version)"
  printf 'android command-line tools: %s\n' "$(sdkmanager --version | head -n 1)"
  printf 'android platform: android-%s\n' "${AI_PIN_ANDROID_PLATFORM_VERSION:-34}"
  printf 'android build tools: %s\n' "${AI_PIN_ANDROID_BUILD_TOOLS_VERSION:-35.0.0}"
  printf 'android ndk: %s\n' "${AI_PIN_ANDROID_NDK_VERSION:-28.2.13676358}"
}

require_source() {
  [[ -r "${SOURCE_ROOT}/settings.gradle.kts" ]] ||
    die "mount the isolated device source at ${SOURCE_ROOT} (read-only is recommended)"
  [[ -x "${SOURCE_ROOT}/gradlew" ]] ||
    die "${SOURCE_ROOT}/gradlew is missing or not executable"
}

reject_signing_material() {
  local name
  local -a names=(
    PIN_SIGNING_STORE_FILE
    PIN_SIGNING_STORE_PASSWORD
    PIN_SIGNING_KEY_ALIAS
    PIN_SIGNING_KEY_PASSWORD
    CMU_RELEASE_STORE_FILE
    CMU_RELEASE_STORE_PASSWORD
    CMU_RELEASE_KEY_ALIAS
    CMU_RELEASE_KEY_PASSWORD
    REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE
  )

  for name in "${names[@]}"; do
    if [[ -n "${!name:-}" ]]; then
      die "${name} is set; this debug builder refuses signing material"
    fi
  done
  for name in \
    "${SIGNING_ENV_FILE}" \
    "${COMPATIBILITY_SIGNING_STORE}" \
    "${EMBEDDED_PATCH_SIGNING_STORE}"; do
    if [[ -e "${name}" ]]; then
      die "signing mount ${name} is present outside the release build path"
    fi
  done
}

prepare_workspace() {
  require_source
  reject_signing_material
  mkdir -p "${WORK_ROOT}" "${ARTIFACT_ROOT}"

  # The destination is a fixed ignored state directory. Secret, proprietary,
  # release, and generated material is never copied into the build worktree.
  # Archive-mode quick-check compares size and mtime only. A fast same-size
  # rewrite can retain the same timestamp quantum and otherwise leave a stale
  # warm worktree, so source staging is content-authoritative.
  rsync -a --checksum --delete \
    --chmod=D0700,Fgo=,Fu=rwX \
    --exclude='.git/' \
    --exclude='.gradle/' \
    --exclude='.idea/' \
    --exclude='.ci/' \
    --exclude='build/' \
    --exclude='target/' \
    --exclude='node_modules/' \
    --exclude='local.properties' \
    --exclude='secrets/' \
    --exclude='release-assets/' \
    --exclude='decompile-workspace/' \
    --exclude='*.apk' \
    --exclude='*.aab' \
    --exclude='*.jks' \
    --exclude='*.keystore' \
    "${SOURCE_ROOT}/" "${WORK_ROOT}/"
}

prepare_credential_free_lane() {
  local lane="$1"
  [[ "${lane}" == check || "${lane}" == debug ]] ||
    die "credential-free lane must be check or debug"
  require_source
  reject_signing_material
  umask 077
  mkdir -p "${CARGO_HOME}" "${GRADLE_USER_HOME}" "${NPM_CONFIG_CACHE}" \
    "${ANDROID_USER_HOME}" "${STATE_ROOT}"
}

prepare_release_workspace() {
  require_source
  mkdir -p "${WORK_ROOT}" "${RELEASE_ROOT}"
  # The staged APKs are already written 0600, but the host refuses to publish
  # from a staging directory any other user could read, so the directory itself
  # has to be owner-only too — `mkdir` alone leaves it at the ambient umask.
  chmod 0700 "${RELEASE_ROOT}"

  rsync -a --delete \
    --exclude='.git/' \
    --exclude='.gradle/' \
    --exclude='.idea/' \
    --exclude='.ci/' \
    --exclude='build/' \
    --exclude='target/' \
    --exclude='node_modules/' \
    --exclude='local.properties' \
    --exclude='secrets/' \
    --exclude='release-assets/' \
    --exclude='decompile-workspace/' \
    --exclude='*.apk' \
    --exclude='*.aab' \
    --exclude='*.jks' \
    --exclude='*.keystore' \
    "${SOURCE_ROOT}/" "${WORK_ROOT}/"

  find "${RELEASE_ROOT}" -mindepth 1 -maxdepth 1 -type f -delete
}

require_mounted_file() {
  local file="$1" label="$2"
  [[ -f "${file}" && ! -L "${file}" && -s "${file}" ]] ||
    die "${label} must be a nonempty read-only regular-file mount"
}

load_literal_signing_environment() {
  local line name raw value body part
  local single_quote_separator="'\\''"
  local -a expected=(
    PIN_SIGNING_STORE_FILE
    PIN_SIGNING_STORE_PASSWORD
    PIN_SIGNING_KEY_ALIAS
    PIN_SIGNING_KEY_PASSWORD
  )
  local -A seen=()

  while IFS= read -r line || [[ -n "${line}" ]]; do
    line="${line#"${line%%[![:space:]]*}"}"
    line="${line%"${line##*[![:space:]]}"}"
    [[ -z "${line}" || "${line}" == \#* ]] && continue
    [[ "${line}" == export\ * ]] || die "signing.env contains a non-literal export"
    line="${line#export }"
    name="${line%%=*}"
    raw="${line#*=}"
    [[ "${name}" != "${line}" && "${name}" =~ ^PIN_SIGNING_(STORE_FILE|STORE_PASSWORD|KEY_ALIAS|KEY_PASSWORD)$ ]] ||
      die "signing.env contains an unsupported name"
    [[ -z "${seen[${name}]:-}" ]] || die "signing.env repeats ${name}"

    if [[ "${raw}" == \'*\' && "${raw}" == *\' && ${#raw} -ge 2 ]]; then
      body="${raw:1:${#raw}-2}"
      value=''
      while [[ "${body}" == *"${single_quote_separator}"* ]]; do
        part="${body%%"${single_quote_separator}"*}"
        [[ "${part}" != *\'* ]] || die "signing.env contains an invalid single-quoted literal"
        value+="${part}'"
        body="${body#*"${single_quote_separator}"}"
      done
      [[ "${body}" != *\'* ]] || die "signing.env contains an invalid single-quoted literal"
      value+="${body}"
    elif [[ "${raw}" == \"*\" && "${raw}" == *\" && ${#raw} -ge 2 ]]; then
      value="${raw:1:${#raw}-2}"
      [[ "${value}" != *\"* && "${value}" != *\\* ]] ||
        die "signing.env contains an invalid double-quoted literal"
    else
      [[ "${raw}" =~ ^[^[:space:]#]+$ ]] || die "signing.env contains a non-literal value"
      value="${raw}"
    fi
    [[ -n "${value}" ]] || die "signing.env contains a blank ${name}"
    printf -v "${name}" '%s' "${value}"
    export "${name}"
    seen["${name}"]=1
  done < "${SIGNING_ENV_FILE}"

  for name in "${expected[@]}"; do
    [[ -n "${seen[${name}]:-}" ]] || die "signing.env is missing ${name}"
  done

  # A host path inside signing.env is never trusted inside the build sandbox.
  PIN_SIGNING_STORE_FILE="${COMPATIBILITY_SIGNING_STORE}"
  export PIN_SIGNING_STORE_FILE
}

keystore_fingerprint() {
  local store="$1" alias="$2" password_environment="$3"
  local output fingerprint
  output="$(keytool -list -v \
    -keystore "${store}" \
    -alias "${alias}" \
    -storepass:env "${password_environment}" 2>/dev/null)" ||
    die "a mounted signing store could not be opened"
  fingerprint="$(printf '%s\n' "${output}" |
    sed -n 's/^[[:space:]]*SHA256:[[:space:]]*//p' |
    tr -d ':' |
    tr '[:upper:]' '[:lower:]')"
  [[ "${fingerprint}" =~ ^[0-9a-f]{64}$ ]] ||
    die "a mounted signing store did not expose one SHA-256 certificate identity"
  printf '%s' "${fingerprint}"
}

validate_release_inputs() {
  local compatibility_fingerprint embedded_fingerprint
  require_mounted_file "${SIGNING_ENV_FILE}" "Pin signing environment"
  require_mounted_file "${COMPATIBILITY_SIGNING_STORE}" "Pin compatibility signing store"
  require_mounted_file "${EMBEDDED_PATCH_SIGNING_STORE}" "Pin embedded-patch signing store"
  [[ -d "${PRIVATE_ASSETS_ROOT}" && ! -L "${PRIVATE_ASSETS_ROOT}" ]] ||
    die "Pin private assets must be an external read-only directory mount"

  load_literal_signing_environment
  export EMBEDDED_PATCH_STORE_PASSWORD='abxdroppedapk'

  compatibility_fingerprint="$(keystore_fingerprint \
    "${COMPATIBILITY_SIGNING_STORE}" "${PIN_SIGNING_KEY_ALIAS}" PIN_SIGNING_STORE_PASSWORD)"
  embedded_fingerprint="$(keystore_fingerprint \
    "${EMBEDDED_PATCH_SIGNING_STORE}" abxdroppedapk EMBEDDED_PATCH_STORE_PASSWORD)"
  [[ "${compatibility_fingerprint}" == "${COMPATIBILITY_CERT_SHA256}" ]] ||
    die "Pin compatibility signing store has the wrong certificate identity"
  [[ "${embedded_fingerprint}" == "${COMPATIBILITY_CERT_SHA256}" ]] ||
    die "Pin embedded-patch signing store has the wrong certificate identity"

  unset EMBEDDED_PATCH_STORE_PASSWORD
  export REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE="${EMBEDDED_PATCH_SIGNING_STORE}"
  export REVIVAL_PIN_PRIVATE_ASSETS_DIR="${PRIVATE_ASSETS_ROOT}"
}

read_apk_metadata() {
  local apk="$1" field="$2"
  apkanalyzer manifest "${field}" "${apk}" 2>/dev/null | sed -n '1p'
}

discover_release_apk() {
  local role="$1" expected_package="$2" output_directory="$3"
  local apk package selected='' matches=0
  local -a candidates=()
  [[ -d "${output_directory}" ]] || die "${role} release output directory is missing"
  while IFS= read -r -d '' apk; do
    candidates+=("${apk}")
  done < <(find "${output_directory}" -maxdepth 1 -type f -name '*.apk' -print0)
  for apk in "${candidates[@]}"; do
    package="$(read_apk_metadata "${apk}" application-id)"
    if [[ "${package}" == "${expected_package}" ]]; then
      selected="${apk}"
      matches=$((matches + 1))
    fi
  done
  [[ ${matches} -eq 1 ]] ||
    die "${role} output must contain exactly one APK with package ${expected_package}"
  printf '%s' "${selected}"
}

verify_native_contract() {
  local role="$1" apk="$2" entry required header extracted
  local entries
  local -a required_entries=()
  case "${role}" in
    hook)
      required_entries=(
        lib/arm64-v8a/libaliuhook.so
        lib/arm64-v8a/libc++_shared.so
        lib/arm64-v8a/liblsplant.so
      )
      ;;
    server)
      required_entries=(
        lib/arm64-v8a/libonnxruntime.so
        lib/arm64-v8a/libonnxruntime4j_jni.so
        lib/arm64-v8a/libpenumbra_server_android.so
        lib/arm64-v8a/libtensorflowlite_jni.so
      )
      ;;
  esac
  entries="$(unzip -Z1 "${apk}")" || die "${role} APK ZIP inventory is unreadable"
  while IFS= read -r entry; do
    [[ -n "${entry}" ]] || continue
    [[ "${entry}" == lib/arm64-v8a/*.so ]] ||
      die "${role} APK contains a native library outside the Pin's arm64-v8a ABI"
    extracted="$(mktemp /tmp/revival-elf.XXXXXX)"
    unzip -p "${apk}" "${entry}" > "${extracted}" || die "${role} native payload ${entry} is unreadable"
    [[ "$(stat -c '%s' "${extracted}")" -le 536870912 ]] ||
      die "${role} native payload ${entry} exceeds the verification bound"
    header="$(readelf -h "${extracted}" 2>/dev/null)" ||
      die "${role} native payload ${entry} is not an ELF file"
    rm -f "${extracted}"
    grep -Eq '^[[:space:]]*Class:[[:space:]]*ELF64[[:space:]]*$' <<< "${header}" ||
      die "${role} native payload ${entry} is not ELF64"
    grep -Eq '^[[:space:]]*Machine:[[:space:]]*AArch64[[:space:]]*$' <<< "${header}" ||
      die "${role} native payload ${entry} is not AArch64"
    grep -Eq '^[[:space:]]*Type:[[:space:]]*DYN[[:space:]]' <<< "${header}" ||
      die "${role} native payload ${entry} is not a shared object or PIE executable"
  done < <(grep -E '^lib/.*\.so$' <<< "${entries}" || true)
  for required in "${required_entries[@]}"; do
    grep -Fxq "${required}" <<< "${entries}" ||
      die "${role} APK is missing required native payload ${required}"
  done
}

verify_and_stage_release_apk() {
  local role="$1" expected_package="$2" output_directory="$3" version="$4" version_code="$5"
  local apk package actual_version actual_code min_sdk target_sdk signer embedded_cert_sha private_public_sha cert_public_sha
  apk="$(discover_release_apk "${role}" "${expected_package}" "${output_directory}")"
  package="$(read_apk_metadata "${apk}" application-id)"
  actual_version="$(read_apk_metadata "${apk}" version-name)"
  actual_code="$(read_apk_metadata "${apk}" version-code)"
  min_sdk="$(read_apk_metadata "${apk}" min-sdk)"
  target_sdk="$(read_apk_metadata "${apk}" target-sdk)"
  [[ "${package}" == "${expected_package}" ]] || die "${role} package identity changed"
  [[ "${actual_version}" == "${version}" ]] || die "${role} versionName changed"
  [[ "${actual_code}" == "${version_code}" ]] || die "${role} versionCode changed"
  [[ "${min_sdk}" == '31' ]] || die "${role} minSdk changed"
  [[ "${target_sdk}" == '32' ]] || die "${role} targetSdk changed"
  apksigner verify --Werr "${apk}" >/dev/null || die "${role} APK signature verification failed"
  signer="$(apksigner verify --print-certs "${apk}" 2>/dev/null |
    sed -n 's/^Signer #1 certificate SHA-256 digest: //p' |
    tr -d ':' |
    tr '[:upper:]' '[:lower:]')"
  [[ "${signer}" == "${COMPATIBILITY_CERT_SHA256}" ]] ||
    die "${role} APK signer is not the compatibility identity"
  zipalign -c -P 16 4 "${apk}" >/dev/null || die "${role} APK alignment verification failed"
  verify_native_contract "${role}" "${apk}"
  if [[ "${role}" == installer ]]; then
    embedded_cert_sha="$(unzip -p "${apk}" assets/abxdroppedapk-certificate.der |
      sha256sum | cut -d' ' -f1)" ||
      die "installer APK is missing its embedded patch-signing certificate"
    [[ "${embedded_cert_sha}" == "${COMPATIBILITY_CERT_SHA256}" ]] ||
      die "installer APK embedded the wrong patch-signing certificate"
    private_public_sha="$(unzip -p "${apk}" assets/abxdroppedapk-private-key.pk8 |
      openssl pkey -inform DER -pubout -outform DER 2>/dev/null |
      sha256sum | cut -d' ' -f1)" ||
      die "installer APK has no readable embedded PKCS#8 patch-signing key"
    cert_public_sha="$(unzip -p "${apk}" assets/abxdroppedapk-certificate.der |
      openssl x509 -inform DER -pubkey -noout 2>/dev/null |
      openssl pkey -pubin -outform DER 2>/dev/null |
      sha256sum | cut -d' ' -f1)" ||
      die "installer APK has no readable embedded patch-signing certificate"
    [[ "${private_public_sha}" == "${cert_public_sha}" ]] ||
      die "installer APK embedded a patch-signing key/certificate mismatch"
    if unzip -Z1 "${apk}" | grep -qx 'assets/abxdroppedapk.keystore'; then
      die "installer APK still embeds the Android-incompatible PKCS#12 store"
    fi
  fi
  install -m 0600 "${apk}" "${RELEASE_ROOT}/${role}.apk"
}

run_release_gradle() {
  local version="$1" version_code="$2" offline="$3"
  local -a gradle_mode=()
  [[ "${offline}" != true ]] || gradle_mode+=(--offline)
  (
    cd "${WORK_ROOT}"
    ./gradlew --no-daemon "${gradle_mode[@]}" \
      -PversionName="${version}" \
      -PversionCode="${version_code}" \
      :hook:payload:assembleRelease \
      :hook:loader:assembleRelease \
      :runtime:android:assembleRelease
    ./injector/gradlew --no-daemon "${gradle_mode[@]}" -p injector \
      -PversionName="${version}" \
      -PversionCode="${version_code}" \
      :installer:assembleRelease \
      :exploit:assembleRelease
  )
}

# runtime/core's build script embeds a pinned sentence-embedding model that it
# pulls from the Hugging Face hub, and `cargo fetch` never runs build scripts —
# so the offline phase used to reach the network for it and fail. Populate the
# hub's on-disk cache here, where the network exists, in the exact layout
# `hf-hub` reads back: a `refs/<revision>` file naming the commit, and the files
# themselves under `snapshots/<commit>/`. Because the pin is a commit SHA rather
# than a branch, the ref simply names itself. The build script re-verifies every
# file's SHA-256, so a warmed cache is no weaker an input than a fresh download.
prefetch_embedding_model() {
  local repo='Qdrant/all-MiniLM-L6-v2-onnx'
  local revision='5f1b8cd78bc4fb444dd171e59b18f3a3af89a079'
  local cache="${EMBED_MODEL_CACHE_DIR:-}"
  [[ -n "${cache}" ]] || die 'EMBED_MODEL_CACHE_DIR must name the shared model cache'

  local folder="models--${repo//\//--}"
  local snapshot="${cache}/${folder}/snapshots/${revision}"
  mkdir -p "${snapshot}" "${cache}/${folder}/refs"
  printf '%s' "${revision}" >"${cache}/${folder}/refs/${revision}"

  local file
  for file in $(model_file_names); do
    [[ -s "${snapshot}/${file}" ]] && continue
    curl --fail --silent --show-error --location --retry 3 \
      "https://huggingface.co/${repo}/resolve/${revision}/${file}" \
      --output "${snapshot}/${file}" ||
      die "failed to prefetch embedding model file ${file}"
  done
  echo "Prefetched ${repo}@${revision} into ${cache}"
}

# The build script is the single source of truth for which files are embedded;
# read the names straight out of it so the two cannot drift apart.
model_file_names() {
  # The table alternates file name and expected digest, so drop the digests.
  sed -n '/^const MODEL_FILES/,/^];/p' "${WORK_ROOT}/runtime/core/build.rs" |
    sed -n 's/^ *"\([A-Za-z0-9_.-]*\)",$/\1/p' |
    grep -vE '^[0-9a-f]{64}$'
}

prefetch_release() {
  local version='' version_code=''
  while (( $# > 0 )); do
    case "$1" in
      --version)
        (( $# >= 2 )) || die "--version requires YYYY-MM-DD.N"
        version="$2"
        shift 2
        ;;
      --version-code)
        (( $# >= 2 )) || die "--version-code requires a positive integer"
        version_code="$2"
        shift 2
        ;;
      *) die "unknown prefetch-release option '$1'" ;;
    esac
  done
  [[ "${version}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$ ]] ||
    die "--version must use YYYY-MM-DD.N"
  [[ "${version_code}" =~ ^[1-9][0-9]*$ ]] ||
    die "--version-code must be a positive decimal integer"
  (( version_code <= 2147483647 )) || die "--version-code exceeds Android's limit"

  prepare_release_workspace
  AI_PIN_SOURCE_ROOT="${WORK_ROOT}" bash "${BOOTSTRAP_ALIUHOOK}"
  (
    cd "${WORK_ROOT}"
    # Warm the shared caches. Gradle dependency resolution downloads the
    # declared jars; the signed build phase runs Gradle online (it holds the
    # signing inputs that packaging requires) so it can also execute the Android
    # artifact transforms these :dependencies passes do not. Cargo is fetched
    # here so the Rust build can stay offline.
    for task in \
      :hook:payload:dependencies \
      :hook:loader:dependencies \
      :runtime:android:dependencies; do
      ./gradlew --no-daemon "${task}" --configuration releaseRuntimeClasspath
    done
    for task in :installer:dependencies :exploit:dependencies; do
      ./injector/gradlew --no-daemon -p injector "${task}" \
        --configuration releaseRuntimeClasspath
    done
    # Compiling online resolves every module's release COMPILE classpath and
    # executes the AGP artifact transforms (jar -> android-classes-jar) into the
    # shared cache. `:dependencies` above only downloads runtime jars; without
    # this the hermetic offline build could not transform kotlin-stdlib for the
    # transitive contracts modules. These compile anchors pull in the contracts
    # and common submodules transitively and never enter the packaging graph,
    # so the release signing gate does not apply here.
    # The lint-vital model tasks are what force the release RUNTIME classpath to
    # be downloaded. `:dependencies` resolves a configuration from metadata only
    # and never fetches the jars themselves, and compiling pulls the COMPILE
    # classpath — so grpc-core, okio and friends stayed absent until the offline
    # phase asked for them. Any later consumer of that configuration is satisfied
    # once the artifacts are in the shared module cache, so warming it here once
    # per application module covers packaging too. These tasks are not in any
    # project's packaging set, so the release signing gate does not apply.
    #
    # Assembling the library modules here is not redundant with the compile
    # anchors: `extractReleaseAnnotations` resolves lint-gradle through a
    # DETACHED configuration that no `:dependencies` or compile task ever walks,
    # so the offline phase used to reach the network for it and fail. Warming it
    # once populates the shared module cache for every module that later needs
    # it, and library assembly never enters an app project's packaging graph, so
    # the release signing gate — which only inspects its own project's tasks —
    # does not apply.
    #
    # `preBuild` depends on the native staging Sync, so a plain compile anchor
    # would drag the Rust cross-build — and with it the operator-held TFLite and
    # codex binaries — into this networked phase, where they are deliberately not
    # mounted. Excluding the staging task drops `buildRustServerAndroid` with it,
    # since nothing else depends on it. The Rust build belongs to the offline
    # phase, which holds those inputs; `cargo fetch` below is what lets it work
    # there without a network.
    ./gradlew --no-daemon \
      -PversionName="${version}" \
      -PversionCode="${version_code}" \
      -x :runtime:android:stageRustServerJniLibs \
      :hook:payload:compileReleaseSources \
      :hook:loader:compileReleaseSources \
      :runtime:android:compileReleaseSources \
      :contracts:stock-aibus:assembleRelease \
      :contracts:penumbra-ipc:assembleRelease \
      :hook:payload:generateReleaseLintVitalReportModel \
      :hook:loader:generateReleaseLintVitalReportModel \
      :runtime:android:generateReleaseLintVitalReportModel
    ./injector/gradlew --no-daemon -p injector \
      -PversionName="${version}" \
      -PversionCode="${version_code}" \
      -x :installer:stageBootstrapAsset \
      :installer:compileReleaseSources \
      :exploit:compileReleaseSources \
      :common:assembleRelease \
      :installer:generateReleaseLintVitalReportModel \
      :exploit:generateReleaseLintVitalReportModel
    cargo fetch --locked --manifest-path runtime/core/Cargo.toml
    prefetch_embedding_model
  )
}

build_release() {
  local version='' version_code=''
  while (( $# > 0 )); do
    case "$1" in
      --version)
        (( $# >= 2 )) || die "--version requires YYYY-MM-DD.N"
        version="$2"
        shift 2
        ;;
      --version-code)
        (( $# >= 2 )) || die "--version-code requires a positive integer"
        version_code="$2"
        shift 2
        ;;
      *) die "unknown build-release option '$1'" ;;
    esac
  done
  [[ "${version}" =~ ^[0-9]{4}-[0-9]{2}-[0-9]{2}\.[0-9]+$ ]] ||
    die "--version must use YYYY-MM-DD.N"
  [[ "${version_code}" =~ ^[1-9][0-9]*$ ]] ||
    die "--version-code must be a positive decimal integer"
  (( version_code <= 2147483647 )) || die "--version-code exceeds Android's limit"

  validate_release_inputs
  prepare_release_workspace
  AI_PIN_SOURCE_ROOT="${WORK_ROOT}" bash "${BOOTSTRAP_ALIUHOOK}" --verify-only
  export CARGO_NET_OFFLINE=true
  run_release_gradle "${version}" "${version_code}" true

  verify_and_stage_release_apk installer com.penumbraos.systeminjector \
    "${WORK_ROOT}/injector/installer/build/outputs/apk/release" "${version}" "${version_code}"
  verify_and_stage_release_apk bootstrap com.penumbraos.systeminjector.exploit \
    "${WORK_ROOT}/injector/exploit/build/outputs/apk/release" "${version}" "${version_code}"
  verify_and_stage_release_apk hook com.penumbraos.hook \
    "${WORK_ROOT}/hook/payload/build/outputs/apk/release" "${version}" "${version_code}"
  verify_and_stage_release_apk server com.penumbraos.server \
    "${WORK_ROOT}/runtime/android/build/outputs/apk/release" "${version}" "${version_code}"
  verify_and_stage_release_apk hook-injector com.penumbraos.hook.injector \
    "${WORK_ROOT}/hook/loader/build/outputs/apk/release" "${version}" "${version_code}"
  write_release_checksums
}

# There is no browser build here. `build-web` used to compile the standalone
# Setup SPA out of `pin/setup` and stage it as a device artifact. That console is
# part of Center now and is built by Center's own image, so this container has
# nothing web-shaped left to produce — its outputs are the CLI and the APKs.
# The Pin's on-device setup page is committed static assets under
# `runtime/core/assets/setup-page` and is packed, not built.

build_cli() {
  (
    cd "${WORK_ROOT}/injector/cli"
    npm ci
    npm run build
  )
  mkdir -p "${ARTIFACT_ROOT}/system-injector-cli"
  rsync -a --delete \
    "${WORK_ROOT}/injector/cli/dist/" \
    "${ARTIFACT_ROOT}/system-injector-cli/"
  cp "${WORK_ROOT}/injector/cli/package.json" \
    "${ARTIFACT_ROOT}/system-injector-cli/package.json"
}

copy_debug_apks() {
  local apk relative safe_name
  mkdir -p "${ARTIFACT_ROOT}/android-debug"
  find "${ARTIFACT_ROOT}/android-debug" -maxdepth 1 -type f -name '*.apk' -delete
  find "${WORK_ROOT}" -type f -path '*/build/outputs/apk/debug/*.apk' -print0 |
    while IFS= read -r -d '' apk; do
      relative="${apk#"${WORK_ROOT}/"}"
      safe_name="${relative//\//-}"
      cp "${apk}" "${ARTIFACT_ROOT}/android-debug/${safe_name}"
    done
}

build_android() {
  (
    cd "${WORK_ROOT}"
    AI_PIN_SOURCE_ROOT="${WORK_ROOT}" \
      bash "${BOOTSTRAP_ALIUHOOK}"
    ./gradlew --no-daemon \
      :hook:payload:assembleDebug \
      :hook:loader:assembleDebug \
      :runtime:android:assembleDebug
    ./injector/gradlew \
      --no-daemon \
      -p injector \
      :installer:assembleDebug \
      :exploit:assembleDebug
  )
  copy_debug_apks
}

debug_role_contract() {
  case "$1" in
    installer) printf '%s\t%s\t%s\t%s' ':installer:assembleDebug' 'injector' 'com.penumbraos.systeminjector' 'injector/installer/build/outputs/apk/debug' ;;
    bootstrap) printf '%s\t%s\t%s\t%s' ':exploit:assembleDebug' 'injector' 'com.penumbraos.systeminjector.exploit' 'injector/exploit/build/outputs/apk/debug' ;;
    hook) printf '%s\t%s\t%s\t%s' ':hook:payload:assembleDebug' 'root' 'com.penumbraos.hook' 'hook/payload/build/outputs/apk/debug' ;;
    server) printf '%s\t%s\t%s\t%s' ':runtime:android:assembleDebug' 'root' 'com.penumbraos.server' 'runtime/android/build/outputs/apk/debug' ;;
    hook-injector) printf '%s\t%s\t%s\t%s' ':hook:loader:assembleDebug' 'root' 'com.penumbraos.hook.injector' 'hook/loader/build/outputs/apk/debug' ;;
    *) die "unknown debug role '$1'" ;;
  esac
}

build_debug_role() {
  local role contract task project package output
  local -a roles=() root_tasks=() injector_tasks=() matches=()
  while (( $# > 0 )); do
    case "$1" in
      --role)
        (( $# >= 2 )) || die "--role requires installer, bootstrap, hook, server, or hook-injector"
        debug_role_contract "$2" >/dev/null
        roles+=("$2")
        shift 2
        ;;
      *) die "unknown build-debug-role option '$1'" ;;
    esac
  done
  (( ${#roles[@]} > 0 )) || die "build-debug-role requires at least one --role"

  # Reject duplicates and reordered roles before any state is prepared. The
  # host always emits the fixed global order; accepting a different direct
  # invocation would make receipts for the same selection non-deterministic.
  [[ "$(printf '%s\n' "${roles[@]}" | sort -u | wc -l)" -eq "${#roles[@]}" ]] ||
    die "build-debug-role repeats a role"
  [[ " ${roles[*]} " == " $(printf '%s\n' installer bootstrap hook server hook-injector | grep -Fxf <(printf '%s\n' "${roles[@]}") | tr '\n' ' ')" ]] ||
    die "build-debug-role roles must use installer, bootstrap, hook, server, hook-injector order"

  prepare_credential_free_lane debug
  prepare_workspace
  REVIVAL_PIN_PRIVATE_ASSETS_DIR="${STATE_ROOT}/empty-private-assets"
  export REVIVAL_PIN_PRIVATE_ASSETS_DIR
  mkdir -p "${REVIVAL_PIN_PRIVATE_ASSETS_DIR}"
  unset REVIVAL_PIN_EMBEDDED_PATCH_SIGNING_STORE_FILE
  unset REVIVAL_TFLITE_RUNTIME_BINARY
  for role in "${roles[@]}"; do
    if [[ "${role}" == hook ]]; then
      AI_PIN_SOURCE_ROOT="${WORK_ROOT}" bash "${BOOTSTRAP_ALIUHOOK}"
      break
    fi
  done
  for role in "${roles[@]}"; do
    IFS=$'\t' read -r task project package output <<< "$(debug_role_contract "${role}")"
    if [[ "${project}" == root ]]; then root_tasks+=("${task}"); else injector_tasks+=("${task}"); fi
  done
  if (( ${#root_tasks[@]} > 0 )); then
    (cd "${WORK_ROOT}" && ./gradlew --no-daemon --project-cache-dir "${STATE_ROOT}/gradle-debug-root" -PrevivalCompileOnlyDebug=true "${root_tasks[@]}")
  fi
  if (( ${#injector_tasks[@]} > 0 )); then
    (cd "${WORK_ROOT}" && ./injector/gradlew --no-daemon --project-cache-dir "${STATE_ROOT}/gradle-debug-injector" -p injector -PrevivalCompileOnlyDebug=true "${injector_tasks[@]}")
  fi
  mkdir -p "${DEBUG_ARTIFACT_ROOT}"
  find "${DEBUG_ARTIFACT_ROOT}" -mindepth 1 -maxdepth 1 -type f -delete
  for role in "${roles[@]}"; do
    IFS=$'\t' read -r task project package output <<< "$(debug_role_contract "${role}")"
    mapfile -d '' -t matches < <(find "${WORK_ROOT}/${output}" -maxdepth 1 -type f -name '*.apk' -print0)
    [[ ${#matches[@]} -eq 1 ]] || die "${role} debug build did not produce exactly one APK"
    install -m 0600 "${matches[0]}" "${DEBUG_ARTIFACT_ROOT}/${role}.apk"
  done
  (
    cd "${DEBUG_ARTIFACT_ROOT}"
    sha256sum -- *.apk > SHA256SUMS
  )
  printf 'device-builder: compile-only debug APKs written to %s\n' "${DEBUG_ARTIFACT_ROOT}"
}

check_unit() {
  # This contributor lane compiles only credential-free contract/common code.
  # The image's release-oriented default path is not an input and no signing,
  # private-asset, USB, or device surface is mounted by the caller.
  unset REVIVAL_PIN_PRIVATE_ASSETS_DIR
  prepare_credential_free_lane check
  prepare_workspace
  # The Server module resolves its operator-supplied assets during
  # configuration, so its JVM tests need an absolute external directory even
  # though this lane never reads a byte out of it.
  REVIVAL_PIN_PRIVATE_ASSETS_DIR="${STATE_ROOT}/empty-private-assets"
  export REVIVAL_PIN_PRIVATE_ASSETS_DIR
  mkdir -p "${REVIVAL_PIN_PRIVATE_ASSETS_DIR}"
  unset REVIVAL_TFLITE_RUNTIME_BINARY
  (
    cd "${WORK_ROOT}/runtime/core"
    CARGO_TARGET_DIR="${STATE_ROOT}/cargo-runtime-target" \
      cargo test --locked
  )
  (
    cd "${WORK_ROOT}/bridge"
    CARGO_TARGET_DIR="${STATE_ROOT}/cargo-bridge-target" \
      cargo test --locked
  )
  (
    cd "${WORK_ROOT}"
    ./gradlew --no-daemon \
      --project-cache-dir "${STATE_ROOT}/gradle-contracts" \
      :contracts:stock-aibus:testDebugUnitTest \
      :contracts:penumbra-ipc:testDebugUnitTest \
      :hook:payload:testDebugUnitTest \
      :runtime:android:testDebugUnitTest \
      -x :runtime:android:buildRustServerAndroid
    ./injector/gradlew --no-daemon \
      --project-cache-dir "${STATE_ROOT}/gradle-injector" \
      -p injector \
      :common:testDebugUnitTest
  )
}

write_checksums() {
  (
    cd "${ARTIFACT_ROOT}"
    find . -type f ! -name SHA256SUMS -print0 |
      sort -z |
      xargs -0 sha256sum > SHA256SUMS
  )
}

write_release_checksums() {
  (
    cd "${RELEASE_ROOT}"
    find . -type f -name '*.apk' -print0 |
      sort -z |
      xargs -0 sha256sum > SHA256SUMS
  )
  chmod 0600 "${RELEASE_ROOT}/SHA256SUMS"

  local role apk package version version_code signer digest size
  local metadata="${RELEASE_ROOT}/release-metadata.tsv"
  : > "${metadata}"
  for role in installer bootstrap hook server hook-injector; do
    apk="${RELEASE_ROOT}/${role}.apk"
    case "${role}" in
      installer) package='com.penumbraos.systeminjector' ;;
      bootstrap) package='com.penumbraos.systeminjector.exploit' ;;
      hook) package='com.penumbraos.hook' ;;
      server) package='com.penumbraos.server' ;;
      hook-injector) package='com.penumbraos.hook.injector' ;;
    esac
    version="$(read_apk_metadata "${apk}" version-name)"
    version_code="$(read_apk_metadata "${apk}" version-code)"
    signer="$(apksigner verify --print-certs --Werr "${apk}" 2>/dev/null |
      sed -n 's/^Signer #1 certificate SHA-256 digest: //p' |
      tr -d ':' |
      tr '[:upper:]' '[:lower:]')"
    digest="$(sha256sum "${apk}" | cut -d' ' -f1)"
    size="$(stat -c '%s' "${apk}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\n' \
      "${role}" "${package}" "${version}" "${version_code}" \
      "${signer}" "${digest}" "${size}" >> "${metadata}"
  done
  chmod 0600 "${metadata}"
}

command="${1:-help}"
if (( $# > 0 )); then
  shift
fi

case "${command}" in
  help|-h|--help)
    show_help
    ;;
  versions)
    show_versions
    ;;
  doctor)
    require_source
    reject_signing_material
    cd "${SOURCE_ROOT}"
    REVIVAL_INSIDE_PIN_BUILDER=true exec node "${TOOL_ROOT}/doctor.mjs" "$@"
    ;;
  build-cli)
    prepare_workspace
    build_cli
    write_checksums
    ;;
  build-android)
    prepare_workspace
    build_android
    write_checksums
    ;;
  build-debug)
    prepare_workspace
    build_cli
    build_android
    write_checksums
    ;;
  build-debug-role)
    build_debug_role "$@"
    ;;
  check-unit)
    check_unit
    ;;
  prefetch-release)
    reject_signing_material
    prefetch_release "$@"
    ;;
  build-release)
    build_release "$@"
    ;;
  shell)
    require_source
    reject_signing_material
    exec /bin/bash "$@"
    ;;
  *)
    die "unknown command '${command}'; run 'device-builder help'"
    ;;
esac
