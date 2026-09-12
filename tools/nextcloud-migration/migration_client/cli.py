import argparse
import base64
import json
import platform
import shlex
import socket
import sqlite3
from pathlib import Path

from . import VERSION
from .backup import plan, restore_spec, verify_restore
from .core import Failure, atomic_write, canonical, digest, inside, read_json
from .http import Http
from .manifest import Manifest
from .pipeline import dry_run, reconcile, run_pilot
from .source import WebDavSource, seed_audit
from .target import Target


def private_file(path, limit=64 * 1024):
    path = Path(path)
    if path.is_symlink() or not path.is_file() or path.stat().st_mode & 0o077:
        raise Failure("configuration_file_not_private")
    if path.stat().st_size > limit:
        raise Failure("configuration_size_limit")
    return path


def load_config(path):
    config = read_json(private_file(path))
    if (platform.system() != "Linux" or not config.get("expectedHostname")
            or socket.gethostname() != config["expectedHostname"]):
        raise Failure("server_only_execution_required")
    if not isinstance(config.get("accountScope"), str) or not config["accountScope"]:
        raise Failure("account_scope_required")
    for name in ("stateDirectory", "auditDirectory", "syncDatabase"):
        if not isinstance(config.get(name), str) or not Path(config[name]).is_absolute():
            raise Failure("absolute_server_paths_required")
    return config


def connections(config):
    source_cfg = config["source"]
    env = {}
    for line in private_file(source_cfg["envFile"]).read_text().splitlines():
        if "=" in line and not line.lstrip().startswith("#"):
            key, value = line.split("=", 1)
            env[key.strip()] = " ".join(shlex.split(value))
    # The owner/user/origin/root must agree with the known export configuration.
    if (source_cfg["user"] != env.get("NEXTCLOUD_USER")
            or source_cfg["origin"] != env.get("NEXTCLOUD_BASE_URL", "").rstrip("/")
            or source_cfg["root"] != env.get("NEXTCLOUD_FOLDER", "MyMind").strip("/")):
        raise Failure("source_configuration_mismatch")
    password = env.get("NEXTCLOUD_APP_PASSWORD")
    if not password:
        raise Failure("source_credential_missing")
    auth = "Basic " + base64.b64encode((source_cfg["user"] + ":" + password).encode()).decode()
    source = WebDavSource(Http(source_cfg["origin"], auth), source_cfg["user"], source_cfg["root"])
    token = private_file(config["target"]["tokenFile"]).read_text().strip()
    if not token or "\n" in token or "\r" in token:
        raise Failure("target_credential_invalid")
    target = Target(Http(config["target"]["origin"], "Bearer " + token))
    return source, target


def pilot_approval(manifest, config, approval_path, limit, max_bytes):
    if not approval_path:
        raise Failure("concrete_pilot_approval_required")
    approval = read_json(private_file(approval_path))
    backup = read_json(private_file(config["backupPlanFile"]))
    # Owner accepted a verified temporary other-disk snapshot for preparation of
    # this bounded copy pilot. This does not grant cleanup or processing release.
    temporary = backup.get("temporaryBackup")
    backup_accepted = (backup.get("state") == "local_other_disk_verified"
                       and isinstance(temporary, dict)
                       and temporary.get("state") == "local_other_disk_verified"
                       and temporary.get("restoreMappingVerified") is True
                       and type(temporary.get("membersVerified")) is int
                       and temporary["membersVerified"] > 0
                       and backup.get("offHost") is False)
    if (not backup_accepted
            or backup.get("manifestDigest") != manifest.snapshot_digest()
            or approval.get("phase") != "bounded-pilot"
            or approval.get("manifestDigest") != manifest.snapshot_digest()
            or approval.get("targetOrigin") != config["target"]["origin"]
            or approval.get("backupPlanDigest") != digest(backup)
            or approval.get("approvedByOwner") is not True
            or type(approval.get("maxItems")) is not int or not limit <= approval["maxItems"] <= 12
            or type(approval.get("maxBytes")) is not int or not max_bytes <= approval["maxBytes"] <= 256 * 1024**2):
        raise Failure("pilot_approval_or_backup_plan_mismatch")
    keys = approval.get("itemKeys")
    if (not isinstance(keys, list) or not 1 <= len(keys) <= approval["maxItems"]
            or any(not isinstance(key, str) for key in keys) or len(set(keys)) != len(keys)):
        raise Failure("exact_pilot_selection_required")
    selected = [manifest.get(key) for key in keys]
    if (any(item["hold"] for item in selected)
            or sum(item["document"]["observed"]["size"] for item in selected) > approval["maxBytes"]):
        raise Failure("approved_pilot_selection_mismatch")
    return keys


def main(argv=None):
    parser = argparse.ArgumentParser(description="Server-only, bounded Nextcloud migration client; no AI or cleanup.")
    parser.add_argument("--version", action="version", version=VERSION)
    parser.add_argument("--config", required=True, help="Private server JSON configuration file (0600)")
    sub = parser.add_subparsers(dest="command", required=True)
    sub.add_parser("seed", help="Use existing audit evidence and sync.db, without network")
    sub.add_parser("status", help="Aggregate journal status, without network")
    for name in ("dry-run", "pilot", "reconcile"):
        command = sub.add_parser(name)
        command.add_argument("--limit", type=int, default=1, choices=range(1, 13))
        if name == "pilot":
            command.add_argument("--max-bytes", type=int, default=50 * 1024**2)
            command.add_argument("--approval", help="Private approved pilot plan bound to this manifest/backup plan")
    sub.add_parser("backup-plan", help="Plan only; no off-host connection or transfer")
    sub.add_parser("restore-spec", help="Prepare expected members; no source/media/target writes")
    restore = sub.add_parser("verify-restore", help="Read and hash an already restored server directory")
    restore.add_argument("--spec", required=True)
    restore.add_argument("--restored-root", required=True)
    args = parser.parse_args(argv)
    try:
        config = load_config(args.config)
        namespace = {"accountScope": config["accountScope"], "sourceOrigin": config["source"]["origin"],
                     "sourceUser": config["source"]["user"], "root": config["source"]["root"],
                     "targetOrigin": config["target"]["origin"]}
        with Manifest(config["stateDirectory"], namespace) as manifest:
            if args.command == "seed":
                result = seed_audit(manifest, config["auditDirectory"], config["syncDatabase"],
                                    config["accountScope"], config["source"]["root"])
            elif args.command == "status":
                result = manifest.summary()
            elif args.command == "backup-plan":
                private_plan = plan(manifest, config.get("backupDestination"))
                atomic_write(manifest.root / "backup-plan.json", canonical(private_plan))
                result = {k: v for k, v in private_plan.items()
                          if k not in ("destinationDeclaration", "manifestDigest")}
            elif args.command == "restore-spec":
                result = restore_spec(manifest, manifest.root / "restore-spec.json")
            elif args.command == "verify-restore":
                result = verify_restore(args.spec, args.restored_root, manifest.root / "restore-check.json")
                if not result["memberBytesVerified"]:
                    print(json.dumps(result))
                    return 2
            else:
                if args.command == "pilot":
                    approved_keys = pilot_approval(manifest, config, args.approval, args.limit, args.max_bytes)
                source, target = connections(config)
                if args.command == "dry-run":
                    result = dry_run(manifest, source, target, args.limit)
                elif args.command == "pilot":
                    result = run_pilot(manifest, source, target, args.limit, args.max_bytes,
                                       item_keys=approved_keys)
                else:
                    result = reconcile(manifest, source, target, args.limit)
        print(json.dumps(result, ensure_ascii=False, sort_keys=True))
        return 0
    except Failure as error:
        print(json.dumps({"error": error.code, "retryable": error.retryable}))
        return 2
    except (OSError, ValueError, KeyError, TypeError, sqlite3.Error):
        # No traceback: config and file errors can contain credentials/private paths.
        print(json.dumps({"error": "local_configuration_or_state_error", "retryable": False}))
        return 2
    except KeyboardInterrupt:
        print(json.dumps({"error": "interrupted_resume_available", "retryable": True}))
        return 130
