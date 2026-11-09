"""Regression tests for bounded subprocess execution and compact diagnostics."""
import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from ssh_ops import core


class ProcessSafetyTests(unittest.TestCase):
    def test_timeout_when_child_does_not_read_stdin(self):
        # The outer timeout is deliberately short so a regression cannot hang CI.
        code = (
            "import sys; from ssh_ops.core import _run; "
            "r = _run([sys.executable, '-c', 'import time; time.sleep(30)'], "
            "stdin=b'x' * 1_000_000, timeout=1); print(r['timeout'])"
        )
        completed = subprocess.run(
            [sys.executable, "-c", code], text=True, capture_output=True,
            check=True, timeout=5,
        )
        self.assertEqual(completed.stdout.strip(), "True")

    def test_output_truncation_is_reported(self):
        result = core._run(
            [sys.executable, "-c", "import sys; sys.stdout.write('x'*100000)"],
            timeout=5,
        )
        self.assertEqual(result["exit_code"], 0)
        self.assertTrue(result["stdout_truncated"])
        self.assertFalse(result["stderr_truncated"])
        self.assertLessEqual(len(result["stdout"].encode()), core.MAX_BYTES)


class DiagnosticTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        env = patch.dict(os.environ, {"SSH_OPS_HOME": self.temp.name}, clear=False)
        env.start()
        self.addCleanup(env.stop)
        core.save_profile("lab", "example.org", "ops")

    def test_log_search_uses_fixed_bounded_command(self):
        with patch.object(core, "execute", return_value={"exit_code": 0}) as run:
            core.log_search("lab", pattern="error; touch /tmp/hacked", unit="nginx.service", lines=25)
        cmd = run.call_args.args[1]
        self.assertIn("journalctl", cmd)
        self.assertIn("--no-pager", cmd)
        self.assertIn("-n 25", cmd)
        self.assertIn("'error; touch /tmp/hacked'", cmd)
        self.assertEqual(run.call_args.kwargs["authorised"], True)

    def test_log_search_rejects_unbounded_or_bad_inputs(self):
        with self.assertRaises(ValueError):
            core.log_search("lab", lines=100000)
        with self.assertRaises(ValueError):
            core.log_search("lab", unit="nginx.service; touch /tmp/hacked")

    def test_fleet_health_returns_compact_results_in_requested_order(self):
        core.save_profile("lab2", "example.net", "ops")
        def fake_health(target):
            return {"exit_code": 0, "stdout": "hostname\nuptime\n" + "x"*10000,
                    "warnings": []}
        with patch.object(core, "health", side_effect=fake_health):
            result = core.fleet_health(["lab", "lab2"])
        self.assertEqual([r["target"] for r in result], ["lab", "lab2"])
        self.assertTrue(all(r["ok"] for r in result))
        self.assertTrue(all(len(str(r)) < 500 for r in result))

    def test_fleet_health_rejects_duplicate_or_excessive_targets(self):
        with self.assertRaises(ValueError):
            core.fleet_health(["lab", "lab"])
        with self.assertRaises(ValueError):
            core.fleet_health(["lab"] * 21)


if __name__ == "__main__":
    unittest.main()
