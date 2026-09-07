"""Exercise deployment boundaries with real archives/files and a simulated Docker host."""
import importlib.util
import io
import json
from pathlib import Path
import tarfile
import tempfile
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location("demo_update", Path(__file__).parents[1] / "scripts/demo-update-host.py")
demo = importlib.util.module_from_spec(spec)
spec.loader.exec_module(demo)
BASE, NEXT = "a" * 40, "b" * 40
ENV = b'LEMMACOMPUTER_INSTALLATION_KIND=worktree\nLEMMACOMPUTER_RUNTIME_ENVIRONMENT=development\nLEMMACOMPUTER_COMPOSE_PROJECT_NAME=onecomputer-demo\nLEMMACOMPUTER_PUBLIC_WEB_URL=https://demo.example\nCUSTOM_SECRET="keep $literal and spaces"\nOLD_SETTING=retained\n'


def archive(path, files, sha=None):
    with tarfile.open(path, "w", format=tarfile.PAX_FORMAT, pax_headers={"comment": sha} if sha else {}) as tar:
        for name, value in files.items():
            data = value if isinstance(value, bytes) else value.encode()
            item = tarfile.TarInfo(name)
            item.size = len(data)
            tar.addfile(item, io.BytesIO(data))


class DemoUpdates(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.root = Path(self.temp.name)
        demo.TARGET = {"project": "onecomputer-demo", "controlContainer": "onecomputer-demo-control-api"}
        self.previous = self.root / "releases" / BASE
        self.previous.mkdir(parents=True)
        (self.root / "current").symlink_to(self.previous)
        self.base = {"compose.yaml": "services: {}\n", "README.md": "old\n", "apps/web/src/App.jsx": "old ui\n"}
        for name, value in self.base.items():
            p = self.previous / name
            p.parent.mkdir(parents=True, exist_ok=True)
            p.write_text(value)
        (self.previous / ".env").write_bytes(ENV)
        (self.previous / ".runtime-env").mkdir()
        (self.previous / ".runtime-env/web.env").write_text("SECRET=retained\n")
        self.before = {"onecomputer-demo-postgres-1": {"id": "db", "image": "dbimg", "mounts": [("data", "/db")]},
                       "lemmacomputer-sandbox-1": {"id": "ws", "image": "wsimg", "mounts": [("home", "/home")]}}

    def bundle(self, changes, verified=True):
        archive(self.root / "base.tar", self.base, BASE)
        candidate = {**self.base, **changes}
        archive(self.root / "candidate.tar", candidate, NEXT)
        archive(self.root / "bundle.tar", {
            "base.tar": (self.root / "base.tar").read_bytes(),
            "candidate.tar": (self.root / "candidate.tar").read_bytes(),
            "metadata.json": json.dumps({"sha": NEXT, "base": BASE, "verified": verified})})
        return self.root / "bundle.tar"

    def patches(self, health_effect=None):
        from contextlib import ExitStack
        stack = ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(patch.object(demo, "compose_files", return_value=[self.previous / "compose.yaml"]))
        def model(root, files):
            return {"services": {s: {"image": "old", "environment": {"SECRET": "retained"}} for s in demo.NODE_SERVICES}}
        stack.enter_context(patch.object(demo, "model", side_effect=model))
        self.compose = stack.enter_context(patch.object(demo, "compose", return_value=""))
        self.command = stack.enter_context(patch.object(demo, "command", return_value="sha256:" + "c" * 64))
        stack.enter_context(patch.object(demo, "inventory", return_value=self.before))
        stack.enter_context(patch.object(demo, "health", side_effect=health_effect))

    def test_metadata_update_and_rollback_preserve_environment_and_data(self):
        self.patches()
        result = demo.update(self.root, self.bundle({"README.md": "new"}), True)
        candidate = self.root / "releases" / NEXT
        self.assertEqual(result["servicesUpdated"], [])
        self.assertEqual((candidate / ".env").read_bytes(), ENV)
        self.assertEqual((self.previous / ".env").read_bytes(), ENV)
        self.assertEqual((candidate / ".env").stat().st_mode & 0o777, 0o600)
        self.assertEqual((candidate / ".runtime-env/web.env").read_bytes(), b"SECRET=retained\n")
        self.assertEqual((self.root / "current").resolve(), candidate)
        self.compose.assert_not_called()
        self.command.assert_not_called()
        demo.rollback(self.root)
        self.assertEqual((self.root / "current").resolve(), self.previous)

    def test_ui_update_builds_only_node_image_and_skips_dependencies(self):
        self.patches()
        result = demo.update(self.root, self.bundle({"apps/web/src/App.jsx": "new ui"}), True)
        self.assertFalse(result["snapshotCreated"])
        calls = [c.args[0] for c in self.command.call_args_list]
        self.assertEqual(calls[0][:2], ["docker", "build"])
        # The pristine build directory never contains the deployed .env.
        self.assertNotEqual(Path(self.command.call_args_list[0].kwargs["cwd"]), self.previous)
        argv = self.compose.call_args.args[2]
        self.assertIn("--no-deps", argv)
        self.assertIn("--no-build", argv)
        self.assertNotIn("db-migrate", argv)
        self.assertNotIn("postgres", argv)
        self.assertEqual((self.previous / ".env").read_bytes(), ENV)

    def test_failed_health_restores_previous_application(self):
        self.patches([RuntimeError("unhealthy"), None])
        with self.assertRaisesRegex(RuntimeError, "unhealthy"):
            demo.update(self.root, self.bundle({"apps/web/src/App.jsx": "bad ui"}), True)
        self.assertEqual(self.compose.call_count, 2)
        self.assertEqual(self.compose.call_args.args[0], self.previous)
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertEqual((self.previous / ".env").read_bytes(), ENV)

    def test_sensitive_changes_refused_before_staging(self):
        for path in ["packages/workspace-store/migrations/new.sql", "package-lock.json", "docker/Dockerfile.workspace",
                     "scripts/deployment-config.mjs", "apps/control-api/src/migrate.ts", "apps/control-api/src/auth.ts",
                     "packages/auth-store/src/index.ts", "compose.yaml"]:
            with self.subTest(path=path):
                bundle = self.bundle({path: "changed"})
                plan = demo.update(self.root, bundle)
                self.assertIn(path, plan["blocked"])
                with self.assertRaisesRegex(RuntimeError, "Non-routine"):
                    demo.update(self.root, bundle, True)
                self.assertFalse((self.root / "releases" / NEXT).exists())

    def test_source_drift_and_unverified_candidate_refused(self):
        bundle = self.bundle({"README.md": "new"}, verified=False)
        with self.assertRaisesRegex(RuntimeError, "exact commit"):
            demo.update(self.root, bundle, True)
        (self.previous / "README.md").write_text("manual fix")
        with self.assertRaisesRegex(RuntimeError, "source drift"):
            demo.update(self.root, bundle)

    def test_rollback_refuses_new_environment_values(self):
        self.patches()
        demo.update(self.root, self.bundle({"README.md": "new"}), True)
        current = (self.root / "current").resolve()
        (current / ".env").write_bytes(ENV + b"NEW_SETTING=keep\n")
        with self.assertRaisesRegex(RuntimeError, "Environment changed"):
            demo.rollback(self.root)
        self.assertEqual((self.root / "current").resolve(), current)
        self.assertTrue((current / ".env").read_bytes().endswith(b"NEW_SETTING=keep\n"))

    def test_interrupted_cutover_can_be_recovered(self):
        self.patches()
        demo.update(self.root, self.bundle({"README.md": "new"}), True)
        candidate = self.root / "releases" / NEXT
        demo.switch(self.root, self.previous)
        demo.save(self.root / ".demo-update-pending.json", {"candidate": str(candidate)})
        with self.assertRaisesRegex(RuntimeError, "interrupted cutover"):
            demo.update(self.root, self.bundle({"README.md": "next"}))
        demo.rollback(self.root)
        self.assertFalse((self.root / ".demo-update-pending.json").exists())
        self.assertEqual((self.root / "current").resolve(), self.previous)
        self.assertEqual((self.previous / ".env").read_bytes(), ENV)

    def test_failed_manual_rollback_keeps_recovery_journal(self):
        self.patches()
        demo.update(self.root, self.bundle({"README.md": "new"}), True)
        with patch.object(demo, "health", side_effect=RuntimeError("offline")):
            with self.assertRaisesRegex(RuntimeError, "offline"):
                demo.rollback(self.root)
        self.assertTrue((self.root / ".demo-update-pending.json").exists())
        demo.rollback(self.root)
        self.assertFalse((self.root / ".demo-update-pending.json").exists())

    def test_failures_do_not_echo_process_secrets(self):
        import subprocess
        failure = subprocess.CompletedProcess(["docker", "compose"], 1, "SECRET=private", "password=private")
        with patch.object(demo.subprocess, "run", return_value=failure):
            with self.assertRaisesRegex(RuntimeError, "withheld") as error:
                demo.command(["docker", "compose", "config"])
        self.assertNotIn("private", str(error.exception))

    def test_archive_path_links_secrets_and_identity(self):
        for name in ["../escape", "/absolute", ".env", ".runtime-env/web.env"]:
            archive(self.root / "bad.tar", {name: "bad"})
            with self.assertRaises(RuntimeError):
                demo.unpack(self.root / "bad.tar", self.root / "extract")
        archive(self.root / "bad.tar", {"safe": "ok"}, BASE)
        with self.assertRaisesRegex(RuntimeError, "Git commit"):
            demo.unpack(self.root / "bad.tar", self.root / "extract", NEXT)
        with tarfile.open(self.root / "bad.tar", "w") as tar:
            link = tarfile.TarInfo("link")
            link.type, link.linkname = tarfile.SYMTYPE, "/etc/passwd"
            tar.addfile(link)
        with self.assertRaisesRegex(RuntimeError, "links"):
            demo.unpack(self.root / "bad.tar", self.root / "extract")

    def test_continuity_detects_volume_or_container_replacement(self):
        with self.assertRaisesRegex(RuntimeError, "Unrelated"):
            demo.verify_continuity(self.before, {**self.before, "onecomputer-demo-postgres-1": {
                **self.before["onecomputer-demo-postgres-1"], "id": "new"}}, demo.NODE_SERVICES)
        with self.assertRaisesRegex(RuntimeError, "mounts"):
            demo.verify_continuity(self.before, {**self.before, "lemmacomputer-sandbox-1": {
                **self.before["lemmacomputer-sandbox-1"], "mounts": []}}, demo.NODE_SERVICES)

    def test_production_profile_is_refused(self):
        (self.previous / ".env").write_bytes(ENV.replace(b"=development", b"=production"))
        with self.assertRaisesRegex(RuntimeError, "development demo"):
            demo.active(self.root)

    def test_model_comparison_checks_secrets_networks_and_mounts(self):
        old = {"services": {s: {"image": "old", "environment": {"SECRET": "kept"}} for s in demo.NODE_SERVICES}}
        new = json.loads(json.dumps(old))
        new["services"]["web"]["image"] = "new"
        self.assertEqual(demo.normalize_model(old, "/old"), demo.normalize_model(new, "/new"))
        new["services"]["web"]["environment"]["SECRET"] = "erased"
        self.assertNotEqual(demo.normalize_model(old, "/old"), demo.normalize_model(new, "/new"))


if __name__ == "__main__":
    unittest.main()
