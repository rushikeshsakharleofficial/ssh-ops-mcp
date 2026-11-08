import json
import os
import stat
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch
from ssh_ops import core


class CoreTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        self.env = patch.dict(os.environ, {"SSH_OPS_HOME": self.temp.name}, clear=False)
        self.env.start()
        self.addCleanup(self.env.stop)
        os.environ.pop("SSH_OPS_ALLOW_WRITE", None)
        core.save_profile("lab", "example.org", "ops")

    def test_private_state(self):
        if os.name != "nt":
            self.assertEqual(stat.S_IMODE(core.home().stat().st_mode), 0o700)
            self.assertEqual(stat.S_IMODE((core.home() / "profiles.sqlite3").stat().st_mode), 0o600)
        self.assertNotIn("password", (core.home() / "profiles.sqlite3").read_bytes().decode("utf-8", "ignore"))

    def test_invalid_profile_and_sql_injection(self):
        with self.assertRaises(ValueError):
            core.save_profile("bad';DROP", "example.org", "ops")
        with self.assertRaises(ValueError):
            core.save_profile("lab", "-oProxyCommand=evil", "ops")
        self.assertEqual(len(core.profiles()), 1)

    def test_arbitrary_run_disabled(self):
        with self.assertRaises(PermissionError):
            core.execute("lab", "rm -rf /", confirm=True)

    def test_explicit_write_enable(self):
        with patch.dict(os.environ, {"SSH_OPS_ALLOW_WRITE": "1"}):
            with patch.object(core, "_run", return_value={"exit_code": 0, "stdout": "ok", "stderr": "", "timeout": False}) as run:
                core.execute("lab", "touch /tmp/example", confirm=True)
                self.assertEqual(run.call_args.kwargs["stdin"], b"touch /tmp/example\n")
                self.assertEqual(run.call_args.args[0][0], "ssh")

    def test_health_pressure_logs_incident(self):
        with patch.object(core, "_run", return_value={"exit_code": 0, "stdout": "Filesystem 1K-blocks Used Available Use% Mounted on\n/dev/vda1 100 95 5 95% /", "stderr": "", "timeout": False}):
            result = core.health("lab")
        self.assertTrue(result["warnings"])
        self.assertEqual(core.incidents(1)[0]["event"], "disk_pressure")

    def test_scp_upload_disabled(self):
        src = Path(self.temp.name) / "file"
        src.write_text("hello")
        with self.assertRaises(PermissionError):
            core.copy("lab", str(src), "/var/tmp/file", "upload", confirm=True)

    def test_scp_path_safety(self):
        with self.assertRaises(ValueError):
            core.copy("lab", "/tmp/local", "/tmp/test;touch /tmp/pwn", "download", confirm=True)
        with self.assertRaises(ValueError):
            core.copy("lab", "/tmp/../etc/shadow", str(Path(self.temp.name) / "out"), "download", confirm=True)

    def test_download_refuses_overwrite(self):
        local = Path(self.temp.name) / "out"
        local.write_text("safeguard")
        with self.assertRaises(FileExistsError):
            core.copy("lab", "/tmp/source", str(local), "download", confirm=True)

    def test_ssh_options_keepalive_private_socket(self):
        options = core.ssh_options(core.profile("lab"))
        self.assertIn("ServerAliveInterval=30", options)
        self.assertIn("StrictHostKeyChecking=yes", options)
        self.assertIn("ForwardAgent=no", options)
        if os.name != "nt":
            self.assertIn("ControlMaster=auto", options)
            self.assertEqual(stat.S_IMODE((core.home() / "cm").stat().st_mode), 0o700)

    def test_incident_does_not_log_sensitive_data(self):
        core.incident("ssh_failure", "lab", 255)
        log = (core.home() / "incidents.jsonl").read_text()
        self.assertEqual(json.loads(log.splitlines()[-1])["code"], "255")
        self.assertNotIn("example.org", log)


if __name__ == "__main__":
    unittest.main()
