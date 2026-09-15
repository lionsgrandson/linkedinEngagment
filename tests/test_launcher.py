from __future__ import annotations

import json
import subprocess
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class LauncherConfigTests(unittest.TestCase):
    def test_npm_start_points_to_stack_launcher(self) -> None:
        package = json.loads((ROOT / "package.json").read_text(encoding="utf-8"))
        self.assertEqual(package["scripts"]["start"], "node scripts/start.js")
        self.assertEqual(package["scripts"]["stop"], "node scripts/stop.js")

    def test_searxng_is_local_only_and_persistent(self) -> None:
        compose = (ROOT / "docker-compose.yml").read_text(encoding="utf-8")
        self.assertIn("ghcr.io/searxng/searxng:latest", compose)
        self.assertIn('127.0.0.1:8888:8080', compose)
        self.assertIn("searxng-cache:/var/cache/searxng", compose)

    def test_searxng_json_api_is_enabled(self) -> None:
        settings = (ROOT / "searxng" / "settings.yml").read_text(encoding="utf-8")
        self.assertIn("formats:", settings)
        self.assertIn("- json", settings)
        self.assertIn("limiter: false", settings)

    def test_launcher_bootstraps_local_dependencies(self) -> None:
        launcher = (ROOT / "scripts" / "start.js").read_text(encoding="utf-8")
        for expected in (
            "docker-compose.yml",
            "HUNTER_SEARCH_PROVIDER=searxng",
            "SEARXNG_URL",
            "OLLAMA_MODEL=qwen3.5:9b",
            "pip",
            "opportunity_hunter.server",
        ):
            with self.subTest(expected=expected):
                self.assertIn(expected, launcher)

    def test_node_launchers_parse(self) -> None:
        for script in (ROOT / "scripts" / "start.js", ROOT / "scripts" / "stop.js"):
            with self.subTest(script=script.name):
                result = subprocess.run(
                    ["node", "--check", str(script)],
                    cwd=ROOT,
                    capture_output=True,
                    text=True,
                    check=False,
                )
                self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == "__main__":
    unittest.main()
