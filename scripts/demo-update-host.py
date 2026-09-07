#!/usr/bin/env python3
"""Routine demo deployments. Standard library only; never migrates or snapshots."""
import argparse
import copy
import fcntl
import hashlib
import json
import os
from pathlib import Path
import re
import shutil
import subprocess
import sys
import tarfile
import tempfile
import time
import urllib.request

TARGET = {}

NODE_SERVICES = ["control-api", "web", "channel-broker", "scheduler-worker",
                 "workspace-controller", "workspace-ingress", "gateway-egress-proxy",
                 "remote-mcp-egress-proxy", "litellm-admin-proxy"]
METADATA_FILES = {"config/demo-target.json", "AGENTS.md", "CONTRIBUTING.md", "README.md", "scripts/demo-update.mjs",
                  "scripts/demo-update-host.py", "tests/demo-update-host-test.py"}


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def command(args, cwd=None):
    # Compose models and diagnostic output may contain credentials. Never echo them.
    result = subprocess.run(args, cwd=cwd, capture_output=True, text=True)
    require(result.returncode == 0, f"{args[0]} {args[1] if len(args) > 1 else ''} failed; output withheld to protect environment values")
    return result.stdout.strip()


def digest(path):
    return hashlib.sha256(Path(path).read_bytes()).hexdigest()


def manifest(root):
    return {str(p.relative_to(root)): digest(p) for p in sorted(Path(root).rglob("*")) if p.is_file()}


def unpack(archive, target, expected_sha=None):
    with tarfile.open(archive) as source:
        if expected_sha is not None:
            require(source.pax_headers.get("comment") == expected_sha, "Archive does not match its Git commit")
        for item in source.getmembers():
            parts = Path(item.name).parts
            require(parts and not item.name.startswith("/") and ".." not in parts,
                    "Unsafe archive path")
            require(item.isfile() or item.isdir(), "Archive links and special files are forbidden")
            require(".env" not in parts and ".runtime-env" not in parts, "Archive contains deployment secrets")
        source.extractall(target, filter="data")


def classification(before, after, base_dir, candidate_dir):
    changed = sorted(k for k in before.keys() | after.keys() if before.get(k) != after.get(k))
    blocked, runtime = [], False
    for path in changed:
        if path in METADATA_FILES or path.startswith(("docs/", "tests/")):
            continue
        if path == "package.json":
            a, b = (json.loads((Path(d) / path).read_text()) for d in (base_dir, candidate_dir))
            a.get("scripts", {}).pop("demo:update", None)
            b.get("scripts", {}).pop("demo:update", None)
            if a == b:
                continue
        # Dependency, auth, schema, provider and workspace-runtime contracts take the full path.
        safe_app = path.startswith(("apps/web/", "apps/control-api/src/", "apps/channel-broker/src/",
                                    "apps/scheduler-worker/src/"))
        sensitive = re.search(r"(?:auth|migrat|schema|provider|credential|bootstrap|onboarding)", path, re.I)
        if safe_app and not sensitive and not path.endswith(("package.json", "package-lock.json")):
            runtime = True
        else:
            blocked.append(path)
    return {"changed": changed, "blocked": blocked, "services": NODE_SERVICES if runtime else [],
            "snapshot": False, "migrations": False, "environment": "preserve exact bytes"}


def verify_source(root, expected):
    for name, checksum in expected.items():
        file = Path(root) / name
        require(file.is_file() and not file.is_symlink() and digest(file) == checksum,
                f"Deployed source drift: {name}; reconcile before a routine update")


def preserve_environment(previous, candidate):
    source, target = Path(previous) / ".env", Path(candidate) / ".env"
    require(source.is_file() and not source.is_symlink(), "Expected a regular server-owned .env")
    require(not target.exists(), "Refusing to overwrite candidate .env")
    shutil.copy2(source, target)
    os.chmod(target, 0o600)
    require(digest(source) == digest(target), "Environment preservation failed")
    return digest(source)


def read_env(root):
    values = {}
    for line in (Path(root) / ".env").read_text().splitlines():
        match = re.match(r"^([A-Za-z_][A-Za-z0-9_]*)=(.*)$", line)
        if match:
            values[match[1]] = match[2].strip().strip("\"'")
    require(values.get("LEMMACOMPUTER_INSTALLATION_KIND") == "worktree" and
            values.get("LEMMACOMPUTER_RUNTIME_ENVIRONMENT") == "development",
            "Routine updates are only enabled for a worktree/development demo")
    require(values.get("LEMMACOMPUTER_COMPOSE_PROJECT_NAME") == TARGET["project"],
            "Refusing a stack other than the configured demo project")
    return values


def active(root):
    current = (root / "current").resolve(strict=True)
    require(current.parent == root / "releases" and re.fullmatch(r"[a-f0-9]{40}", current.name),
            "current must select a commit directory under releases")
    read_env(current)
    return current


def compose_files(current):
    record = current / "demo-update.json"
    if record.exists():
        data = json.loads(record.read_text())
        require(data["status"] == "active", "Current release is not recorded as active")
        return [Path(p) for p in data["files"]]
    labels = json.loads(command(["docker", "inspect", TARGET["controlContainer"], "--format", "{{json .Config.Labels}}"] ))
    require(labels.get("com.docker.compose.project") == TARGET["project"], "Unexpected Control Compose project")
    files = [Path(p) for p in labels["com.docker.compose.project.config_files"].split(",")]
    # The controller can retain the previous directory on a metadata-only update.
    require(files[0].parent.parent == current.parent, "Unexpected Compose source directory")
    return files


def compose(root, files, args):
    return command(["docker", "compose", "--project-directory", str(root), "--env-file", str(root / ".env"),
                    "-p", TARGET["project"], *[arg for f in files for arg in ("-f", str(f))], *args], cwd=root)


def model(root, files):
    return json.loads(compose(root, files, ["config", "--format", "json"]))


def normalize_model(config, directory):
    # The only permitted model changes are application image IDs and release-relative file paths.
    result = copy.deepcopy(config)
    for service in NODE_SERVICES:
        result["services"][service].pop("image", None)
    return json.dumps(result, sort_keys=True).replace(str(directory), "<release>")


def inventory():
    ids = command(["docker", "ps", "-q"]).splitlines()
    containers = json.loads(command(["docker", "inspect", *ids])) if ids else []
    return {c["Name"].lstrip("/"): {"id": c["Id"], "image": c["Image"],
            "mounts": sorted((m.get("Name", m["Source"]), m["Destination"]) for m in c["Mounts"] if m["Type"] == "volume")}
            for c in containers}


def verify_continuity(before, after, services):
    for name, old in before.items():
        new = after.get(name)
        require(new is not None, f"Container disappeared: {name}")
        affected = any(name in (f"{TARGET['project']}-{s}", f"{TARGET['project']}-{s}-1") for s in services)
        require(old["mounts"] == new["mounts"], f"Persistent mounts changed: {name}")
        if not affected:
            require(old["id"] == new["id"], f"Unrelated container changed: {name}")


def health(current):
    url = read_env(current)["LEMMACOMPUTER_PUBLIC_WEB_URL"].rstrip("/") + "/__lemmacomputer/healthz"
    require(url.startswith("https://"), "Demo health check requires HTTPS")
    for attempt in range(12):
        try:
            with urllib.request.urlopen(url, timeout=10) as response:
                if response.status == 200 and json.load(response).get("status") == "ok":
                    return
        except Exception:
            pass
        time.sleep(2)
    raise RuntimeError("Demo health endpoint did not become healthy")


def switch(root, target):
    temporary = root / ".current-demo-update"
    require(not temporary.exists() and not temporary.is_symlink(), "Stale current switch; inspect before retrying")
    temporary.symlink_to(target)
    temporary.replace(root / "current")


def save(path, data):
    Path(path).write_text(json.dumps(data, indent=2) + "\n")
    os.chmod(path, 0o600)


def update(root, bundle, apply=False):
    previous = active(root)
    require(not (root / ".demo-update-pending.json").exists(),
            "An interrupted cutover needs demo:update rollback before another update")
    with tempfile.TemporaryDirectory(prefix="lemma-demo-check-") as temporary:
        temp = Path(temporary)
        unpack(bundle, temp)
        meta = json.loads((temp / "metadata.json").read_text())
        require(meta["base"] == previous.name, "Demo changed since planning; generate a fresh plan")
        require(re.fullmatch(r"[a-f0-9]{40}", meta["sha"]) is not None, "Invalid candidate SHA")
        for name in ("base", "candidate"):
            unpack(temp / f"{name}.tar", temp / name, meta["base"] if name == "base" else meta["sha"])
        before, after = manifest(temp / "base"), manifest(temp / "candidate")
        verify_source(previous, before)
        plan = classification(before, after, temp / "base", temp / "candidate")
        plan.update({"base": previous.name, "sha": meta["sha"]})
        if not apply:
            return plan
        require(meta.get("verified") is True, "Run through demo:update apply to verify the exact commit first")
        require(not plan["blocked"], "Non-routine changes require the full release path")
        require(meta["sha"] != previous.name, "Candidate is already deployed")
        candidate = root / "releases" / meta["sha"]
        require(not candidate.exists(), "Candidate directory exists; inspect it rather than overwrite a release")
        shutil.copytree(temp / "candidate", candidate)
        env_hash = preserve_environment(previous, candidate)
        files = compose_files(previous)
        # Retain every operator override, including the existing LiteLLM health override.
        new_files = []
        for source in files:
            if source.parent == files[0].parent:
                destination = candidate / source.name
                if source.name != "compose.yaml":
                    require(not destination.exists(), "Archive collides with operator override")
                    shutil.copy2(source, destination)
                new_files.append(destination)
            else:
                require(source.is_file() and source.is_relative_to(root / "overrides"), "Unexpected external Compose override")
                new_files.append(source)
        shutil.copytree(previous / ".runtime-env", candidate / ".runtime-env")
        old_model = model(previous, files)
        services = plan["services"]
        old_state = inventory()
        if services:
            # No server secrets enter the build context: build the pristine archived tree in /tmp.
            tag = f"lemmacomputer/demo-control:{meta['sha']}"
            print("Building the shared application image; existing demo remains running.", file=sys.stderr, flush=True)
            command(["docker", "build", "-f", "docker/Dockerfile.node", "-t", tag, "."], cwd=temp / "candidate")
            image = command(["docker", "image", "inspect", tag, "--format", "{{.Id}}"])
            require(re.fullmatch(r"sha256:[a-f0-9]{64}", image) is not None, "Build did not produce an immutable image ID")
        else:
            image = None
        # Pin every service's existing image, changing only the shared Node runtime if rebuilt.
        images = {name: {"image": image if image and name in NODE_SERVICES else service["image"]}
                  for name, service in old_model["services"].items() if "image" in service}
        override = candidate / "compose.demo-update.json"
        save(override, {"services": images})
        new_files = [p for p in new_files if p.name != override.name] + [override]
        new_model = model(candidate, new_files)
        require(normalize_model(old_model, files[0].parent) == normalize_model(new_model, candidate),
                "Compose configuration changed beyond application images; use the full release path")
        require(digest(previous / ".env") == env_hash and digest(candidate / ".env") == env_hash,
                "Environment changed during staging; aborting before cutover")
        record = {"sha": meta["sha"], "previous": str(previous), "environmentSha256": env_hash,
                  "services": services, "files": [str(f) for f in new_files],
                  "previousFiles": [str(f) for f in files], "source": after, "previousSource": before,
                  "configuration": {str(f): digest(f) for f in set(files + new_files)},
                  "projections": manifest(candidate / ".runtime-env"),
                  "snapshot": False, "migrations": False, "image": image, "status": "staged"}
        save(candidate / "demo-update.json", record)
        save(root / ".demo-update-pending.json", {"candidate": str(candidate)})
        try:
            if services:
                compose(candidate, new_files, ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "300", *services])
            health(candidate)
            verify_continuity(old_state, inventory(), services)
            require(digest(previous / ".env") == env_hash and digest(candidate / ".env") == env_hash, "Environment changed during cutover")
            switch(root, candidate)
            record["status"] = "active"
            save(candidate / "demo-update.json", record)
            (root / ".demo-update-pending.json").unlink()
        except Exception:
            require(digest(previous / ".env") == env_hash and digest(candidate / ".env") == env_hash,
                    "Environment changed during failure; journal retained for operator recovery")
            # No migrations or database replacement took place, so old images remain usable.
            if services:
                compose(previous, files, ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "300", *services])
            health(previous)
            if (root / "current").resolve() != previous:
                switch(root, previous)
            record["status"] = "rolled-back-after-failure"
            save(candidate / "demo-update.json", record)
            (root / ".demo-update-pending.json").unlink()
            raise
        return {"sha": meta["sha"], "status": "active", "environmentUnchanged": True,
                "snapshotCreated": False, "servicesUpdated": services, "previous": previous.name}


def rollback(root):
    current = active(root)
    pending = root / ".demo-update-pending.json"
    if pending.exists():
        candidate = Path(json.loads(pending.read_text())["candidate"])
        require(candidate.parent == root / "releases", "Invalid interrupted candidate")
        current = candidate
    record = json.loads((current / "demo-update.json").read_text())
    previous = Path(record["previous"])
    require(previous.parent == root / "releases", "Invalid previous release")
    require(digest(current / ".env") == digest(previous / ".env") == record["environmentSha256"],
            "Environment changed since deployment; refusing to restore stale settings")
    verify_source(current, record["source"])
    verify_source(previous, record["previousSource"])
    for file, checksum in record["configuration"].items():
        require(digest(file) == checksum, "Compose configuration changed since update")
    verify_source(current / ".runtime-env", record["projections"])
    verify_source(previous / ".runtime-env", record["projections"])
    before = inventory()
    services = record["services"]
    save(pending, {"candidate": str(current)})
    if services:
        compose(previous, [Path(f) for f in record["previousFiles"]],
                ["up", "-d", "--no-deps", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "300", *services])
    health(previous)
    verify_continuity(before, inventory(), services)
    require(digest(current / ".env") == digest(previous / ".env") == record["environmentSha256"],
            "Environment changed during rollback; inspect before switching current")
    switch(root, previous)
    if pending.exists():
        pending.unlink()
    return {"status": "rolled-back", "sha": previous.name, "environmentUnchanged": True}


def main():
    global TARGET
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("action", choices=["status", "plan", "apply", "rollback"])
    parser.add_argument("--target-json", help="Deployment identity; defaults to config/demo-target.json beside the installed source")
    parser.add_argument("--bundle", type=Path)
    args = parser.parse_args()
    TARGET = json.loads(args.target_json) if args.target_json else json.loads(
        (Path(__file__).resolve().parents[1] / "config/demo-target.json").read_text())
    require(set(TARGET) == {"root", "project", "controlContainer"}, "Invalid demo target")
    require(re.fullmatch(r"[a-z0-9][a-z0-9_-]*", TARGET["project"]) is not None, "Invalid Compose project")
    root = Path(TARGET["root"]).resolve(strict=True)
    if args.action == "status":
        current = active(root)
        print(json.dumps({"sha": current.name, "directory": str(current), "profile": "worktree/development",
                          "interruptedUpdate": (root / ".demo-update-pending.json").exists()}))
        return
    # Serialize plans, cutovers and rollbacks. Never break a held deployment lock.
    with (root / ".demo-update.lock").open("a") as lock:
        fcntl.flock(lock, fcntl.LOCK_EX | fcntl.LOCK_NB)
        if args.action == "rollback":
            result = rollback(root)
        else:
            require(args.bundle is not None, "--bundle is required")
            result = update(root, args.bundle, args.action == "apply")
        print(json.dumps(result))


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"Demo update refused/failed: {error}", file=sys.stderr)
        sys.exit(1)
