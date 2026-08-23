#!/usr/bin/env python3
"""Durable, replayable deployment-authority transactions.

Application and ingress acceptance happen in the shell drivers.  This helper
owns the small filesystem transactions that publish accepted authority pointers,
bind the Center channel-key metadata migration to its backup contract, and prove
that staged and live device trust roots are identical.  Durable journals make a
crash between publications replayable and reject unrelated state.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import stat
import sys
import tempfile
from pathlib import Path


RELEASE_ID = re.compile(r"^[0-9a-f]{64}$")
NAMESPACES = ("deploy", "rollback")


def namespace_paths(record: Path, namespace: str) -> dict[str, Path]:
    stem = "POINTER_TRANSACTION" if namespace == "deploy" else f"{namespace.upper().replace('-', '_')}_POINTER_TRANSACTION"
    return {
        "journal": record / f"{stem}.json",
        "prepared": record / f"{stem}_PREPARED",
        "committed": record / f"{stem}_COMMITTED",
        "aborted": record / f"{stem}_ABORTED",
        "success": record / ("SUCCEEDED" if namespace == "deploy" else "MANUAL_ROLLBACK"),
    }


def operation_paths(record: Path, namespace: str) -> dict[str, Path]:
    stem = "OPERATION_TRANSACTION" if namespace == "deploy" else "ROLLBACK_OPERATION_TRANSACTION"
    return {
        "journal": record / f"{stem}.json",
        "prepared": record / f"{stem}_PREPARED",
        "quiescing": record / f"{stem}_QUIESCING",
        "quiesced": record / f"{stem}_QUIESCED",
        "completed": record / f"{stem}_COMPLETED",
        "aborted": record / f"{stem}_ABORTED",
    }


def die(message: str) -> "NoReturn":
    raise SystemExit(f"transaction error: {message}")


def fsync_directory(path: Path) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_DIRECTORY", 0))
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def atomic_regular(path: Path, content: bytes, mode: int = 0o600) -> None:
    descriptor, temporary = tempfile.mkstemp(prefix=f".{path.name}.", dir=path.parent)
    temporary_path = Path(temporary)
    try:
        os.fchmod(descriptor, mode)
        with os.fdopen(descriptor, "wb", closefd=True) as output:
            output.write(content)
            output.flush()
            os.fsync(output.fileno())
        os.replace(temporary_path, path)
        fsync_directory(path.parent)
    finally:
        if temporary_path.exists() or temporary_path.is_symlink():
            temporary_path.unlink()


def atomic_symlink(path: Path, target: Path | None) -> None:
    if target is None:
        if path.exists() or path.is_symlink():
            path.unlink()
            fsync_directory(path.parent)
        return
    temporary = path.parent / f".{path.name}.transaction-{os.getpid()}"
    if temporary.exists() or temporary.is_symlink():
        temporary.unlink()
    os.symlink(str(target), temporary)
    os.replace(temporary, path)
    fsync_directory(path.parent)


def marker_state(path: Path, label: str) -> bool:
    if not path.exists() and not path.is_symlink():
        return False
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die(f"{label} marker is unsafe")
    return True


def regular_json(path: Path, label: str) -> dict[str, object]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die(f"{label} is unsafe")
    try:
        value = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, UnicodeError, json.JSONDecodeError) as error:
        die(f"{label} is unreadable: {error}")
    if not isinstance(value, dict):
        die(f"{label} is not an object")
    return value


def validate_journal_schema(raw: dict[str, object], record: Path, namespace: str) -> None:
    expected_keys = {
        "schemaVersion", "namespace", "record", "oldCurrent", "oldPrevious",
        "oldCurrentDeployment", "desiredCurrent", "desiredPrevious", "desiredCurrentDeployment",
    }
    if (
        set(raw) != expected_keys
        or raw.get("schemaVersion") != 1
        or raw.get("record") != str(record)
        or raw.get("namespace") != namespace
        or any(not isinstance(raw.get(key), str) for key in expected_keys - {"schemaVersion"})
    ):
        die("transaction journal schema is invalid")


def validate_namespace(namespace: str) -> None:
    if namespace not in NAMESPACES:
        die("invalid transaction namespace")


def operation_ingress_path(record: Path, raw: str) -> Path:
    candidate = Path(raw)
    if not candidate.is_absolute():
        die("operation ingress evidence path is not absolute")
    try:
        relative = candidate.relative_to(record)
    except ValueError:
        die("operation ingress evidence is outside its deployment record")
    if relative == Path(".") or ".." in relative.parts:
        die("operation ingress evidence is not a file")
    current = record
    for part in relative.parts:
        current = current / part
        metadata = current.lstat()
        if stat.S_ISLNK(metadata.st_mode):
            die("operation ingress evidence traverses a symbolic link")
    metadata = candidate.lstat()
    if not stat.S_ISREG(metadata.st_mode):
        die("operation ingress evidence is not a regular file")
    return candidate


def validate_operation_journal(raw: dict[str, object], record: Path, namespace: str) -> Path:
    expected = {
        "schemaVersion", "namespace", "record", "ingressEvidence", "ingressEvidenceSha256",
    }
    if (
        set(raw) != expected
        or raw.get("schemaVersion") != 1
        or raw.get("namespace") != namespace
        or raw.get("record") != str(record)
        or not isinstance(raw.get("ingressEvidence"), str)
        or not isinstance(raw.get("ingressEvidenceSha256"), str)
        or not re.fullmatch(r"[0-9a-f]{64}", str(raw.get("ingressEvidenceSha256")))
    ):
        die("operation transaction journal schema is invalid")
    evidence = operation_ingress_path(record, str(raw["ingressEvidence"]))
    if sha256_file(evidence) != raw["ingressEvidenceSha256"]:
        die("operation ingress evidence changed after authority preparation")
    return evidence


def operation_marker_state(record: Path, namespace: str) -> tuple[dict[str, Path], dict[str, bool]]:
    paths = operation_paths(record, namespace)
    state = {
        key: marker_state(paths[key], f"{namespace} operation {key}")
        for key in ("prepared", "quiescing", "quiesced", "completed", "aborted")
    }
    if not any(state.values()):
        return paths, state
    if not state["prepared"] or not paths["journal"].exists() or paths["journal"].is_symlink():
        die(f"stale {namespace} operation markers exist without a safe prepared journal")
    raw = regular_json(paths["journal"], f"{namespace} operation transaction journal")
    validate_operation_journal(raw, record, namespace)
    if state["completed"] and state["aborted"]:
        die(f"{namespace} operation transaction is both completed and aborted")
    if state["quiesced"] and not state["quiescing"]:
        die(f"{namespace} operation reached quiesced before quiescing")
    if (state["quiescing"] or state["quiesced"]) and (state["completed"] or state["aborted"]):
        # Historical phase markers intentionally remain after a terminal
        # marker, so only the terminal conflict above is invalid.
        pass
    return paths, state


def pending_inventory(root: Path) -> list[dict[str, str]]:
    """Return the one global inventory of unfinished deploy/rollback authority.

    A prepared namespace remains globally authoritative until its abort marker or
    its namespace's final success marker is durable.  Merely leaving an
    unprepared JSON file has never acquired authority and is intentionally not
    treated as a transaction; every marker-bearing record is validated.
    """
    deployments = root / "deployments"
    if not deployments.exists():
        return []
    metadata = deployments.lstat()
    if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die("deployments directory is unsafe")
    active: dict[tuple[str, str], dict[str, str]] = {}
    for record in sorted(deployments.iterdir(), key=lambda item: item.name):
        record_metadata = record.lstat()
        if not stat.S_ISDIR(record_metadata.st_mode) or stat.S_ISLNK(record_metadata.st_mode):
            continue
        for namespace in NAMESPACES:
            operation, operation_state = operation_marker_state(record, namespace)
            if operation_state["prepared"] and not (
                operation_state["completed"] or operation_state["aborted"]
            ):
                identity = (namespace, str(record))
                active[identity] = {"namespace": namespace, "record": str(record)}
            paths = namespace_paths(record, namespace)
            prepared = marker_state(paths["prepared"], f"{namespace} prepared transaction")
            committed = marker_state(paths["committed"], f"{namespace} committed transaction")
            aborted = marker_state(paths["aborted"], f"{namespace} aborted transaction")
            success = marker_state(paths["success"], f"{namespace} success")
            # A historical or interrupted file written before PREPARED never
            # acquired authority. Any marker does, and therefore requires the
            # complete journal and a coherent terminal state.
            if not (prepared or committed or aborted):
                continue
            if not prepared or not paths["journal"].exists() or paths["journal"].is_symlink():
                die(f"stale {namespace} transaction markers exist without a safe prepared journal")
            raw = regular_json(paths["journal"], f"{namespace} transaction journal")
            validate_journal_schema(raw, record, namespace)
            if aborted and committed:
                die(f"{namespace} transaction is both aborted and committed")
            if aborted:
                if success:
                    die(f"aborted {namespace} transaction has a success marker")
                continue
            if success and not committed:
                die(f"{namespace} success exists before authority commitment")
            if committed and success:
                continue
            identity = (namespace, str(record))
            active[identity] = {"namespace": namespace, "record": str(record)}
    return [active[key] for key in sorted(active)]


def direct_child(path: Path, parent: Path, label: str, must_exist: bool = True) -> Path:
    if must_exist:
        path = Path(os.path.realpath(path))
        parent = Path(os.path.realpath(parent))
    if not path.is_absolute() or path.parent != parent:
        die(f"{label} is outside its guarded directory")
    if must_exist:
        metadata = path.lstat()
        if not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            die(f"{label} is not a regular directory")
    return path


def optional_target(raw: str, parent: Path, label: str) -> Path | None:
    if raw == "":
        return None
    return direct_child(Path(raw), parent, label)


def pointer_target(pointer: Path) -> Path | None:
    if not pointer.is_symlink():
        if pointer.exists():
            die(f"authority pointer is not a symbolic link: {pointer.name}")
        return None
    raw = os.readlink(pointer)
    target = Path(raw)
    if not target.is_absolute():
        target = pointer.parent / target
    return Path(os.path.realpath(target))


def failpoint(root: Path, name: str, requested: str) -> None:
    if requested != name:
        return
    # Fault injection is deliberately impossible against the production root.
    if root == Path("/home/anders/ai-pin-revival"):
        die("fault injection is disabled for the production root")
    raise SystemExit(86)


def validate_current(
    root: Path,
    journal: dict[str, object],
    releases: Path,
    deployments: Path,
) -> None:
    old_previous = optional_target(str(journal["oldPrevious"]), releases, "journal old previous")
    old_current = optional_target(str(journal["oldCurrent"]), releases, "journal old current")
    old_deployment = optional_target(
        str(journal["oldCurrentDeployment"]), deployments, "journal old deployment"
    )
    desired_previous = optional_target(
        str(journal["desiredPrevious"]), releases, "journal desired previous"
    )
    desired_current = optional_target(
        str(journal["desiredCurrent"]), releases, "journal desired current"
    )
    desired_deployment = optional_target(
        str(journal["desiredCurrentDeployment"]), deployments, "journal desired deployment"
    )
    actual = (
        pointer_target(root / "previous"),
        pointer_target(root / "current"),
        pointer_target(root / "current-deployment"),
    )
    # These are the only legal crash states because publication order is fixed.
    legal = {
        (old_previous, old_current, old_deployment),
        (desired_previous, old_current, old_deployment),
        (desired_previous, desired_current, old_deployment),
        (desired_previous, desired_current, desired_deployment),
    }
    if actual not in legal:
        die("authority pointers do not match any exact prepared publication boundary")


def validate_old_precondition(root: Path, journal: dict[str, object], releases: Path, deployments: Path) -> None:
    expected = (
        optional_target(str(journal["oldPrevious"]), releases, "old previous"),
        optional_target(str(journal["oldCurrent"]), releases, "old current"),
        optional_target(str(journal["oldCurrentDeployment"]), deployments, "old deployment"),
    )
    actual = (
        pointer_target(root / "previous"),
        pointer_target(root / "current"),
        pointer_target(root / "current-deployment"),
    )
    if actual != expected:
        die("new transaction does not match the exact current authority pointers")


def load_or_create_journal(args: argparse.Namespace, record: Path, root: Path) -> tuple[Path, dict[str, object]]:
    deployments = root / "deployments"
    releases = root / "releases"
    namespace = args.namespace
    paths = namespace_paths(record, namespace)
    journal_path = paths["journal"]
    prepared = paths["prepared"]
    committed = paths["committed"]
    aborted = paths["aborted"]
    if marker_state(aborted, "aborted transaction"):
        die("transaction was durably aborted")
    def normalized(raw: str, parent: Path, label: str) -> str:
        value = optional_target(raw, parent, label)
        return "" if value is None else str(value)

    old_current = normalized(args.old_current, releases, "oldCurrent")
    old_previous = normalized(args.old_previous, releases, "oldPrevious")
    old_deployment = normalized(args.old_current_deployment, deployments, "oldCurrentDeployment")
    desired_current = normalized(args.desired_current, releases, "desiredCurrent")
    desired_deployment = normalized(args.desired_current_deployment, deployments, "desiredCurrentDeployment")
    desired_previous = normalized(args.desired_previous, releases, "desiredPrevious")
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "namespace": namespace,
        "record": str(record),
        "oldCurrent": old_current,
        "oldPrevious": old_previous,
        "oldCurrentDeployment": old_deployment,
        "desiredCurrent": desired_current,
        "desiredPrevious": desired_previous,
        "desiredCurrentDeployment": desired_deployment,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    if journal_path.exists():
        metadata = journal_path.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            die("transaction journal is unsafe")
        existing = journal_path.read_bytes()
        if existing != encoded:
            die("transaction journal conflicts with the requested publication")
    else:
        validate_old_precondition(root, payload, releases, deployments)
        atomic_regular(journal_path, encoded)
    if not marker_state(prepared, "prepared transaction"):
        atomic_regular(prepared, b"prepared\n")
    if marker_state(committed, "committed transaction"):
        expected_previous = optional_target(desired_previous, releases, "desired previous")
        expected_current = optional_target(desired_current, releases, "desired current")
        expected_deployment = optional_target(desired_deployment, deployments, "desired deployment")
        if pointer_target(root / "previous") != expected_previous:
            die("committed previous pointer drifted")
        if pointer_target(root / "current") != expected_current:
            die("committed current pointer drifted")
        if pointer_target(root / "current-deployment") != expected_deployment:
            die("committed deployment pointer drifted")
    return committed, payload


def commit(args: argparse.Namespace) -> None:
    root = Path(args.root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        die("root is unsafe")
    root = Path(os.path.realpath(root))
    deployments = root / "deployments"
    releases = root / "releases"
    for path, label in ((deployments, "deployments"), (releases, "releases")):
        if not path.is_dir() or path.is_symlink():
            die(f"{label} directory is unsafe")
    record = direct_child(Path(args.record), deployments, "deployment record")
    validate_namespace(args.namespace)
    active = pending_inventory(root)
    if len(active) > 1:
        die("multiple unfinished authority transactions exist globally")
    expected_identity = {"namespace": args.namespace, "record": str(record)}
    if active and active[0] != expected_identity:
        die(
            "a foreign authority transaction is pending: "
            f"{active[0]['namespace']} {active[0]['record']}"
        )
    if args.reconcile:
        requested_namespace = args.namespace
        stem = "POINTER_TRANSACTION" if args.namespace == "deploy" else f"{args.namespace.upper().replace('-', '_')}_POINTER_TRANSACTION"
        journal = record / f"{stem}.json"
        if not journal.exists() and not journal.is_symlink():
            die("reconciliation transaction journal is missing")
        metadata = journal.lstat()
        if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
            die("transaction journal is unsafe")
        raw = regular_json(journal, "transaction journal")
        validate_journal_schema(raw, record, requested_namespace)
        args.namespace = requested_namespace
        args.old_current = raw["oldCurrent"]
        args.old_previous = raw["oldPrevious"]
        args.old_current_deployment = raw["oldCurrentDeployment"]
        args.desired_current = raw["desiredCurrent"]
        args.desired_previous = raw["desiredPrevious"]
        args.desired_current_deployment = raw["desiredCurrentDeployment"]
    committed, journal = load_or_create_journal(args, record, root)
    validate_current(root, journal, releases, deployments)
    if args.namespace == "deploy":
        release_id_path = record / "release-id"
        if not release_id_path.is_file() or release_id_path.is_symlink():
            die("deployment release identity is missing")
        release_id = release_id_path.read_text(encoding="ascii").strip()
        if not RELEASE_ID.fullmatch(release_id):
            die("deployment release identity is invalid")
        expected_release = releases / release_id
        if journal["desiredCurrent"] != str(expected_release) or journal["desiredCurrentDeployment"] != str(record):
            die("deployment journal does not publish its own accepted release")
    if args.prepare_only:
        return
    acceptance_name = "INGRESS_ACTIVATED" if args.namespace == "deploy" else "ROLLBACK_INGRESS_ACTIVATED"
    acceptance = record / acceptance_name
    if not acceptance.is_file() or acceptance.is_symlink():
        die("completed ingress and public acceptance evidence is missing")
    if args.namespace == "deploy":
        application_committed = record / "APPLICATION_COMMITTED"
        if not marker_state(application_committed, "application committed"):
            atomic_regular(application_committed, b"accepted\n")
    failpoint(root, "after-application-committed", args.failpoint)

    if marker_state(committed, "committed transaction"):
        if args.namespace == "deploy" and not marker_state(record / "SUCCEEDED", "success"):
            atomic_regular(record / "SUCCEEDED", b"accepted\n")
        return
    atomic_symlink(root / "previous", optional_target(str(journal["desiredPrevious"]), releases, "desired previous"))
    failpoint(root, "after-previous", args.failpoint)
    atomic_symlink(root / "current", optional_target(str(journal["desiredCurrent"]), releases, "desired current"))
    failpoint(root, "after-current", args.failpoint)
    atomic_symlink(
        root / "current-deployment",
        optional_target(str(journal["desiredCurrentDeployment"]), deployments, "desired deployment"),
    )
    failpoint(root, "after-current-deployment", args.failpoint)

    if pointer_target(root / "previous") != optional_target(str(journal["desiredPrevious"]), releases, "desired previous"):
        die("previous pointer publication failed")
    if pointer_target(root / "current") != optional_target(str(journal["desiredCurrent"]), releases, "desired current"):
        die("current pointer publication failed")
    if pointer_target(root / "current-deployment") != optional_target(
        str(journal["desiredCurrentDeployment"]), deployments, "desired deployment"
    ):
        die("current deployment pointer publication failed")
    failpoint(root, "before-committed", args.failpoint)
    atomic_regular(committed, b"committed\n")
    failpoint(root, "after-committed", args.failpoint)
    if args.namespace == "deploy" and not marker_state(record / "SUCCEEDED", "success"):
        atomic_regular(record / "SUCCEEDED", b"accepted\n")
    failpoint(root, "after-success", args.failpoint)


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def operation_action(args: argparse.Namespace) -> None:
    root = Path(args.root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        die("root is unsafe")
    root = Path(os.path.realpath(root))
    deployments = root / "deployments"
    if not deployments.is_dir() or deployments.is_symlink():
        die("deployments directory is unsafe")
    record = direct_child(Path(args.record), deployments, "deployment record")
    validate_namespace(args.namespace)
    identity = {"namespace": args.namespace, "record": str(record)}
    active = pending_inventory(root)
    if len(active) > 1:
        die("multiple unfinished authority transactions exist globally")
    if active and active[0] != identity:
        die(
            "a foreign authority transaction is pending: "
            f"{active[0]['namespace']} {active[0]['record']}"
        )

    paths = operation_paths(record, args.namespace)
    if args.operation_action == "prepare":
        _, existing_state = operation_marker_state(record, args.namespace)
        if existing_state["completed"] or existing_state["aborted"]:
            die("terminal operation transaction cannot be prepared again")
        if not args.operation_ingress_evidence:
            die("operation preparation requires ingress evidence")
        evidence = operation_ingress_path(record, args.operation_ingress_evidence)
        payload: dict[str, object] = {
            "schemaVersion": 1,
            "namespace": args.namespace,
            "record": str(record),
            "ingressEvidence": str(evidence),
            "ingressEvidenceSha256": sha256_file(evidence),
        }
        encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode() + b"\n"
        if paths["journal"].exists():
            if paths["journal"].is_symlink() or paths["journal"].read_bytes() != encoded:
                die("operation transaction journal conflicts with the requested operation")
        else:
            atomic_regular(paths["journal"], encoded)
        failpoint(root, "after-operation-journal", args.failpoint)
        if not marker_state(paths["prepared"], "operation prepared"):
            atomic_regular(paths["prepared"], b"prepared\n")
        failpoint(root, "after-operation-prepared", args.failpoint)
        return

    operation, state = operation_marker_state(record, args.namespace)
    if not state["prepared"]:
        die("operation transaction is not durably prepared")
    if state["completed"] or state["aborted"]:
        if args.operation_action == "verify":
            return
        expected = "completed" if state["completed"] else "aborted"
        if (state["completed"] and args.operation_action == "complete") or (
            state["aborted"] and args.operation_action == "abort"
        ):
            return
        die(f"operation transaction is already {expected}")
    if args.operation_action == "verify":
        return
    if args.operation_action == "quiescing":
        if not marker_state(operation["quiescing"], "operation quiescing"):
            atomic_regular(operation["quiescing"], b"quiescing\n")
        failpoint(root, "after-operation-quiescing", args.failpoint)
        return
    if args.operation_action == "quiesced":
        if not state["quiescing"]:
            die("operation cannot reach quiesced before quiescing")
        if not marker_state(operation["quiesced"], "operation quiesced"):
            atomic_regular(operation["quiesced"], b"quiesced\n")
        failpoint(root, "after-operation-quiesced", args.failpoint)
        return

    failpoint(root, "before-operation-terminal", args.failpoint)
    if args.operation_action == "complete":
        success = namespace_paths(record, args.namespace)["success"]
        if not marker_state(success, f"{args.namespace} success"):
            die("operation cannot complete before final authority success")
        atomic_regular(operation["completed"], b"completed\n")
    elif args.operation_action == "abort":
        pointer = namespace_paths(record, args.namespace)
        if marker_state(pointer["committed"], f"{args.namespace} committed transaction"):
            die("committed authority operation cannot be aborted")
        atomic_regular(operation["aborted"], b"aborted\n")
    else:
        die("unsupported operation transaction action")
    failpoint(root, "after-operation-terminal", args.failpoint)


def channel_contract(path: Path) -> dict[str, str]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die("channel-key backup contract is unsafe")
    values: dict[str, str] = {}
    for number, raw in enumerate(path.read_text(encoding="utf-8").splitlines(), 1):
        fields = raw.split("\t")
        if len(fields) != 2:
            die(f"malformed channel-key backup contract at line {number}")
        key, value = fields
        if not key.startswith("center.channel_key."):
            continue
        if key in values:
            die("duplicate channel-key backup contract field")
        values[key] = value
    expected = {
        "center.channel_key.presence", "center.channel_key.sha256",
        "center.channel_key.mode", "center.channel_key.owner",
    }
    if set(values) != expected or values["center.channel_key.presence"] != "present":
        die("channel-key backup contract is incomplete or absent")
    if not re.fullmatch(r"[0-9a-f]{64}", values["center.channel_key.sha256"]):
        die("channel-key backup digest is invalid")
    if not re.fullmatch(r"[0-7]{3,4}", values["center.channel_key.mode"]):
        die("channel-key backup mode is invalid")
    if not re.fullmatch(r"[0-9]+:[0-9]+", values["center.channel_key.owner"]):
        die("channel-key backup owner is invalid")
    return values


def channel_key_state(path: Path) -> tuple[str, int, int, int]:
    metadata = path.lstat()
    if not stat.S_ISREG(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode):
        die("live Center channel key is not a regular non-symlink file")
    return (
        sha256_file(path),
        stat.S_IMODE(metadata.st_mode),
        metadata.st_uid,
        metadata.st_gid,
    )


def load_channel_journal(record: Path) -> dict[str, object]:
    path = record / "CHANNEL_KEY_METADATA_TRANSACTION.json"
    raw = regular_json(path, "channel-key metadata journal")
    expected = {
        "schemaVersion", "record", "keyPath", "backupContract", "backupContractSha256",
        "contentSha256", "oldMode", "oldUid", "oldGid", "desiredMode", "desiredUid", "desiredGid",
    }
    if (
        set(raw) != expected
        or raw.get("schemaVersion") != 1
        or raw.get("record") != str(record)
        or not isinstance(raw.get("keyPath"), str)
        or not isinstance(raw.get("backupContract"), str)
        or any(not isinstance(raw.get(key), int) for key in ("oldMode", "oldUid", "oldGid", "desiredMode", "desiredUid", "desiredGid"))
        or not isinstance(raw.get("contentSha256"), str)
        or not isinstance(raw.get("backupContractSha256"), str)
    ):
        die("channel-key metadata journal schema is invalid")
    key_path = Path(str(raw["keyPath"]))
    contract_path = Path(str(raw["backupContract"]))
    if not key_path.is_absolute() or not contract_path.is_absolute():
        die("channel-key journal paths are not absolute")
    values = channel_contract(contract_path)
    if sha256_file(contract_path) != raw["backupContractSha256"]:
        die("channel-key backup contract changed after migration preparation")
    transaction_root = record.parent.parent
    if transaction_root == Path("/home/anders/ai-pin-revival"):
        expected_key = Path("/home/anders/carry-center-data/channel-key.json")
        expected_contract = transaction_root / "backups" / record.name / "invariants.tsv"
        if key_path != expected_key or contract_path != expected_contract:
            die("production channel-key journal is outside its exact guarded paths")
        if (raw["desiredMode"], raw["desiredUid"], raw["desiredGid"]) != (0o600, 1000, 1001):
            die("production channel-key journal has an invalid metadata target")
    if (
        values["center.channel_key.sha256"] != raw["contentSha256"]
        or int(values["center.channel_key.mode"], 8) != raw["oldMode"]
        or tuple(map(int, values["center.channel_key.owner"].split(":"))) != (raw["oldUid"], raw["oldGid"])
    ):
        die("channel-key journal is not bound to its backup contract")
    return raw


def prepare_channel_key(args: argparse.Namespace, root: Path, record: Path) -> None:
    if not args.channel_key_path or not args.channel_key_contract:
        die("channel-key prepare requires the live path and backup contract")
    key_path = Path(args.channel_key_path)
    contract_path = Path(args.channel_key_contract)
    if not key_path.is_absolute() or not contract_path.is_absolute():
        die("channel-key paths must be absolute")
    values = channel_contract(contract_path)
    digest, mode, uid, gid = channel_key_state(key_path)
    expected_owner = tuple(map(int, values["center.channel_key.owner"].split(":")))
    if (
        digest != values["center.channel_key.sha256"]
        or mode != int(values["center.channel_key.mode"], 8)
        or (uid, gid) != expected_owner
    ):
        die("live Center channel key differs from its restore-tested backup contract")
    if mode != 0o600:
        die("Center channel-key migration requires mode 0600")
    production = root == Path("/home/anders/ai-pin-revival")
    if production and (uid, gid) not in ((0, 0), (1000, 1001)):
        die("Center channel-key migration found an unreviewed owner")
    try:
        desired_mode = int(args.channel_key_desired_mode, 8)
    except ValueError:
        die("channel-key desired mode is invalid")
    desired_uid = args.channel_key_desired_uid
    desired_gid = args.channel_key_desired_gid
    if desired_uid < 0 or desired_gid < 0 or desired_mode not in (0o600, 0o640):
        die("channel-key desired metadata is invalid")
    if production and (desired_mode, desired_uid, desired_gid) != (0o600, 1000, 1001):
        die("production channel-key metadata target is fixed to 1000:1001 mode 0600")
    payload: dict[str, object] = {
        "schemaVersion": 1,
        "record": str(record),
        "keyPath": str(key_path),
        "backupContract": str(contract_path),
        "backupContractSha256": sha256_file(contract_path),
        "contentSha256": digest,
        "oldMode": mode,
        "oldUid": uid,
        "oldGid": gid,
        "desiredMode": desired_mode,
        "desiredUid": desired_uid,
        "desiredGid": desired_gid,
    }
    encoded = json.dumps(payload, sort_keys=True, separators=(",", ":")).encode() + b"\n"
    journal_path = record / "CHANNEL_KEY_METADATA_TRANSACTION.json"
    if journal_path.exists():
        if journal_path.read_bytes() != encoded:
            die("channel-key metadata journal conflicts with the requested migration")
    else:
        atomic_regular(journal_path, encoded)
    prepared = record / "CHANNEL_KEY_METADATA_PREPARED"
    if not marker_state(prepared, "channel-key metadata prepared"):
        atomic_regular(prepared, b"prepared\n")


def set_channel_key_metadata(path: Path, mode: int, uid: int, gid: int) -> None:
    descriptor = os.open(path, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0))
    try:
        metadata = os.fstat(descriptor)
        if not stat.S_ISREG(metadata.st_mode):
            die("Center channel key changed type before metadata publication")
        os.fchown(descriptor, uid, gid)
        os.fchmod(descriptor, mode)
        os.fsync(descriptor)
    finally:
        os.close(descriptor)
    fsync_directory(path.parent)


def channel_key_action(args: argparse.Namespace) -> None:
    root = Path(args.root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        die("root is unsafe")
    root = Path(os.path.realpath(root))
    deployments = root / "deployments"
    record = direct_child(Path(args.record), deployments, "deployment record")
    if args.channel_key_action == "prepare":
        prepare_channel_key(args, root, record)
        return
    journal = load_channel_journal(record)
    key_path = Path(str(journal["keyPath"]))
    digest, mode, uid, gid = channel_key_state(key_path)
    if digest != journal["contentSha256"]:
        die("Center channel-key bytes changed during metadata transaction")
    old = (int(journal["oldMode"]), int(journal["oldUid"]), int(journal["oldGid"]))
    desired = (int(journal["desiredMode"]), int(journal["desiredUid"]), int(journal["desiredGid"]))
    current = (mode, uid, gid)
    if current not in (old, desired):
        die("Center channel-key metadata changed outside the prepared transaction")
    if args.channel_key_action in ("apply", "restore"):
        target = desired if args.channel_key_action == "apply" else old
        set_channel_key_metadata(key_path, *target)
        digest, mode, uid, gid = channel_key_state(key_path)
        if digest != journal["contentSha256"] or (mode, uid, gid) != target:
            die("Center channel-key metadata publication failed")
        marker = record / (
            "CHANNEL_KEY_METADATA_COMMITTED" if args.channel_key_action == "apply" else "CHANNEL_KEY_METADATA_RESTORED"
        )
        if not marker_state(marker, "channel-key metadata result"):
            atomic_regular(marker, (args.channel_key_action + "\n").encode())
        return
    expected = desired if args.channel_key_action == "verify-desired" else old
    if current != expected:
        die(f"Center channel-key metadata is not in the expected {args.channel_key_action.removeprefix('verify-')} state")


def security_tree_identity(path: Path, expected_owner: tuple[int, int] | None = None) -> str:
    """Hash one stable, non-symlink security tree including inode identity.

    Production calls this under sudo because its mode-0600 keys belong to the
    container uid.  Traversal is descriptor-relative and O_NOFOLLOW throughout:
    a pathname swap, owner/mode change, relabel, hard link, truncation, or content
    rewrite therefore refuses instead of becoming the next accepted baseline.
    """
    raw = str(path)
    if (not path.is_absolute() or os.path.normpath(raw) != raw or
            os.path.realpath(raw) != raw):
        die("trust-root path must be one exact absolute non-symlink path")
    digest = hashlib.sha256()
    members = 0
    total_bytes = 0

    def identity(value: os.stat_result) -> tuple[int, ...]:
        return (value.st_dev, value.st_ino, stat.S_IFMT(value.st_mode),
                stat.S_IMODE(value.st_mode), value.st_uid, value.st_gid,
                value.st_nlink, value.st_size, value.st_mtime_ns, value.st_ctime_ns)

    def add(value: str | bytes | int) -> None:
        data = value if isinstance(value, bytes) else str(value).encode()
        digest.update(len(data).to_bytes(8, "big"))
        digest.update(data)

    def check(metadata: os.stat_result, relative: str) -> None:
        nonlocal members
        if (expected_owner is not None and
                (metadata.st_uid, metadata.st_gid) != expected_owner):
            die(f"trust-root object has the wrong deployed owner: {relative}")
        if stat.S_IMODE(metadata.st_mode) & 0o022:
            die(f"trust-root object is group/world writable: {relative}")
        if stat.S_ISREG(metadata.st_mode) and metadata.st_nlink != 1:
            die(f"trust-root file has an alternate hard-link writer: {relative}")
        if not (stat.S_ISDIR(metadata.st_mode) or stat.S_ISREG(metadata.st_mode)):
            die(f"unsupported or aliased trust-root object: {relative}")
        members += 1
        if members > 10_000:
            die("trust-root member bound exceeded")

    def add_xattrs(descriptor: int, relative: str) -> None:
        if not (hasattr(os, "listxattr") and hasattr(os, "getxattr")):
            # The production runtime is Linux and always provides descriptor
            # xattr APIs. Test platforms without them bind that absence rather
            # than invoking a path-based helper that could follow a swap.
            add("xattrs-unavailable")
            return
        try:
            names = sorted(os.listxattr(descriptor))
            for name in names:
                add(name)
                add(os.getxattr(descriptor, name))
        except OSError as error:
            die(f"could not inspect trust-root extended metadata: {relative}: {error}")

    def visit(parent: int, name: str, relative: str) -> None:
        nonlocal total_bytes
        before = os.stat(name, dir_fd=parent, follow_symlinks=False)
        check(before, relative)
        flags = os.O_RDONLY | os.O_NOFOLLOW
        if stat.S_ISDIR(before.st_mode):
            flags |= os.O_DIRECTORY
        descriptor = os.open(name, flags, dir_fd=parent)
        try:
            opened = os.fstat(descriptor)
            if identity(opened) != identity(before):
                die(f"trust-root object moved before open: {relative}")
            add(relative)
            for field in identity(opened):
                add(field)
            add_xattrs(descriptor, relative)
            if stat.S_ISREG(opened.st_mode):
                total_bytes += opened.st_size
                if total_bytes > 256 * 1024 * 1024:
                    die("trust-root byte bound exceeded")
                offset = 0
                while offset < opened.st_size:
                    block = os.pread(descriptor, min(1024 * 1024, opened.st_size - offset), offset)
                    if not block:
                        die(f"trust-root file truncated while read: {relative}")
                    digest.update(block)
                    offset += len(block)
            else:
                names = sorted(os.listdir(descriptor))
                for child in names:
                    if child in ("", ".", "..") or "/" in child:
                        die("trust-root directory returned an unsafe member")
                    child_relative = child if relative == "." else os.path.join(relative, child)
                    visit(descriptor, child, child_relative)
                if sorted(os.listdir(descriptor)) != names:
                    die(f"trust-root directory changed while read: {relative}")
            if (identity(os.fstat(descriptor)) != identity(opened) or
                    identity(os.stat(name, dir_fd=parent, follow_symlinks=False)) != identity(before)):
                die(f"trust-root object changed while read: {relative}")
        finally:
            os.close(descriptor)

    parent = os.open("/", os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW)
    descriptors = [parent]
    try:
        components = raw.split("/")[1:]
        for component in components[:-1]:
            before = os.stat(component, dir_fd=parent, follow_symlinks=False)
            if not stat.S_ISDIR(before.st_mode) or stat.S_ISLNK(before.st_mode):
                die("trust-root parent path is aliased")
            child = os.open(component, os.O_RDONLY | os.O_DIRECTORY | os.O_NOFOLLOW,
                            dir_fd=parent)
            opened = os.fstat(child)
            if identity(opened) != identity(before):
                os.close(child)
                die("trust-root parent path moved during traversal")
            descriptors.append(child)
            parent = child
        visit(parent, components[-1], ".")
    finally:
        for descriptor in reversed(descriptors):
            os.close(descriptor)
    return digest.hexdigest()


def trust_root_action(args: argparse.Namespace) -> None:
    root = Path(args.root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        die("root is unsafe")
    root = Path(os.path.realpath(root))
    record = direct_child(Path(args.record), root / "deployments", "deployment record")
    if not args.live_attest or not args.live_duc:
        die("trust-root verification requires both live roots")
    live_attest = Path(args.live_attest)
    live_duc = Path(args.live_duc)
    staged_attest = Path(args.staged_attest) if args.staged_attest else None
    staged_duc = Path(args.staged_duc) if args.staged_duc else None

    def require_directory(value: Path, label: str) -> Path:
        if not value.is_absolute():
            die(f"{label} path must be absolute")
        metadata = value.lstat()
        if (not stat.S_ISDIR(metadata.st_mode) or stat.S_ISLNK(metadata.st_mode) or
                os.path.normpath(str(value)) != str(value) or os.path.realpath(value) != str(value)):
            die(f"{label} must be a non-symlink directory")
        return value

    live_attest = require_directory(live_attest, "live attestation trust root")
    live_duc = require_directory(live_duc, "live device-user trust root")
    production_attest = Path("/home/anders/carry-attest")
    production_duc = Path("/home/anders/carry-duc")
    if root == Path("/home/anders/ai-pin-revival") and (
        live_attest != production_attest or live_duc != production_duc
    ):
        die("production live trust roots are outside their exact guarded paths")
    if args.trust_root_action == "record":
        if staged_attest is None or staged_duc is None:
            die("trust-root recording requires both staged roots")
        staged_attest = require_directory(staged_attest, "staged attestation trust root")
        staged_duc = require_directory(staged_duc, "staged device-user trust root")
        if root == Path("/home/anders/ai-pin-revival") and (
            staged_attest != production_attest or staged_duc != production_duc
        ):
            die("production trust roots must be observed directly at the immutable legacy paths")
    production = root == Path("/home/anders/ai-pin-revival")
    expected_owner = (65532, 65532) if production else None
    live = {
        "attestation": security_tree_identity(live_attest, expected_owner),
        "device-user": security_tree_identity(live_duc, expected_owner),
    }
    evidence = record / "trust-root-zero-delta.tsv"
    if args.trust_root_action == "record":
        assert staged_attest is not None and staged_duc is not None
        staged = {
            "attestation": security_tree_identity(staged_attest, expected_owner),
            "device-user": security_tree_identity(staged_duc, expected_owner),
        }
        if staged != live:
            die("staged and live trust roots differ in bytes or metadata")
        rows = ["contract\tdk.andersmadsen.ai-pin-revival.trust-root-zero-delta-v1\n"]
        rows.extend(f"{label}\t{staged[label]}\t{live[label]}\n" for label in sorted(live))
        encoded = "".join(rows).encode()
        if evidence.exists():
            if evidence.is_symlink() or evidence.read_bytes() != encoded:
                die("trust-root zero-delta evidence conflicts with the staged roots")
        else:
            atomic_regular(evidence, encoded)
    if not evidence.exists() or evidence.is_symlink():
        die("trust-root zero-delta evidence is missing or unsafe")
    rows: dict[str, str] = {}
    for number, raw in enumerate(evidence.read_text(encoding="utf-8").splitlines(), 1):
        fields = raw.split("\t")
        if number == 1:
            if fields != ["contract", "dk.andersmadsen.ai-pin-revival.trust-root-zero-delta-v1"]:
                die("trust-root evidence contract is invalid")
            continue
        if (
            len(fields) != 3
            or fields[0] in rows
            or fields[1] != fields[2]
            or not re.fullmatch(r"[0-9a-f]{64}", fields[1])
        ):
            die("trust-root evidence row is invalid")
        rows[fields[0]] = fields[1]
    if rows != live:
        die("live trust roots drifted from the staged zero-delta evidence")


def inventory(args: argparse.Namespace) -> None:
    root = Path(args.root)
    if not root.is_absolute() or not root.is_dir() or root.is_symlink():
        die("root is unsafe")
    root = Path(os.path.realpath(root))
    active = pending_inventory(root)
    if len(active) > 1:
        die("multiple unfinished authority transactions exist globally")
    print(json.dumps({"schemaVersion": 1, "active": active}, sort_keys=True, separators=(",", ":")))


def parser() -> argparse.ArgumentParser:
    result = argparse.ArgumentParser()
    result.add_argument("--root", required=True)
    result.add_argument("--record", default="")
    result.add_argument("--namespace", default="deploy")
    result.add_argument("--inventory", action="store_true")
    result.add_argument(
        "--operation-action",
        choices=("prepare", "verify", "quiescing", "quiesced", "complete", "abort"),
    )
    result.add_argument("--operation-ingress-evidence", default="")
    result.add_argument(
        "--channel-key-action",
        choices=("prepare", "apply", "restore", "verify-desired", "verify-old"),
    )
    result.add_argument("--channel-key-path", default="")
    result.add_argument("--channel-key-contract", default="")
    result.add_argument("--channel-key-desired-mode", default="600")
    result.add_argument("--channel-key-desired-uid", type=int, default=1000)
    result.add_argument("--channel-key-desired-gid", type=int, default=1001)
    result.add_argument("--trust-root-action", choices=("record", "verify"))
    result.add_argument("--staged-attest", default="")
    result.add_argument("--staged-duc", default="")
    result.add_argument("--live-attest", default="")
    result.add_argument("--live-duc", default="")
    result.add_argument("--reconcile", action="store_true")
    result.add_argument("--prepare-only", action="store_true")
    result.add_argument("--old-current", default="")
    result.add_argument("--old-previous", default="")
    result.add_argument("--old-current-deployment", default="")
    result.add_argument("--desired-current", default="")
    result.add_argument("--desired-previous", default="")
    result.add_argument("--desired-current-deployment", default="")
    result.add_argument(
        "--failpoint",
        default="",
        choices=(
            "", "after-application-committed", "after-previous", "after-current",
            "after-current-deployment", "before-committed", "after-committed", "after-success",
            "after-operation-journal", "after-operation-prepared", "after-operation-quiescing",
            "after-operation-quiesced", "before-operation-terminal", "after-operation-terminal",
        ),
    )
    return result


if __name__ == "__main__":
    arguments = parser().parse_args()
    if arguments.inventory:
        inventory(arguments)
    elif arguments.operation_action:
        if not arguments.record:
            die("operation action requires --record")
        operation_action(arguments)
    elif arguments.channel_key_action:
        if not arguments.record:
            die("channel-key action requires --record")
        channel_key_action(arguments)
    elif arguments.trust_root_action:
        if not arguments.record:
            die("trust-root action requires --record")
        trust_root_action(arguments)
    else:
        if not arguments.record:
            die("pointer transaction requires --record")
        commit(arguments)
