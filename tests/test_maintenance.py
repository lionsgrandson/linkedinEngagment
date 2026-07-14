import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

import linkedin_bot
import manage
import requests


class MaintenanceTests(unittest.TestCase):
    def test_comment_sanitizer_removes_narration_and_moshe_labels(self):
        cases = {
            'Here\'s a proposed comment:\n\n"Actual comment."': "Actual comment.",
            'Here\'s a potential response as Moshe Schwartzberg:\n\n"Useful response."':
                "Useful response.",
            'This is a good comment as Moshe: Clear point.': "Clear point.",
            'Moshe Schwartzberg: "Direct comment."': "Direct comment.",
            'Moshe S: Another direct comment.': "Another direct comment.",
            'Comment as Moshe: No label remains.': "No label remains.",
        }
        for raw, expected in cases.items():
            with self.subTest(raw=raw):
                self.assertEqual(linkedin_bot.sanitize_comment(raw), expected)

    def test_all_version_surfaces_match(self):
        expected = manage.version()
        self.assertEqual(linkedin_bot.APP_VERSION, expected)
        self.assertIn(f'version = "{expected}"', Path("pyproject.toml").read_text(encoding="utf-8"))
        for name in ("content.js", "instagram_content.js"):
            content = (Path("chrome_extension") / name).read_text(encoding="utf-8")
            self.assertIn(f"const EXTENSION_VERSION = '{expected}'", content)

    def test_extension_build_markers_match_source_fingerprint(self):
        expected = manage.extension_build()
        info = json.loads(Path("chrome_extension/build_info.json").read_text(encoding="utf-8"))
        self.assertEqual(info["build"], expected)
        for name in ("content.js", "instagram_content.js"):
            content = (Path("chrome_extension") / name).read_text(encoding="utf-8")
            self.assertIn(f"const EXTENSION_BUILD = '{expected}'", content)

    def test_linkedin_connection_queue_and_confirmation_are_present(self):
        content = Path("chrome_extension/content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        self.assertIn("urls: [url]", content)
        self.assertNotIn("connectionBatch", content)
        self.assertIn("waitForConnectionConfirmation", content)
        self.assertIn("LinkedIn shows the invitation as pending", content)
        self.assertIn("openNextProfile", worker)
        self.assertIn('status: "queued"', worker)
        self.assertIn('task.status === "processing"', worker)
        self.assertIn("clearProfileTask", worker)
        get_task = worker.split('message?.type === "getProfileTask"', 1)[1].split(
            'message?.type === "clearProfileTask"', 1
        )[0]
        self.assertNotIn("chrome.storage.local.remove", get_task)

    def test_daily_posting_is_removed(self):
        paths = (
            Path("chrome_extension/content.js"),
            Path("extension_server.py"),
            Path("linkedin_bot.py"),
            Path("README.md"),
        )
        combined = "\n".join(path.read_text(encoding="utf-8") for path in paths).lower()
        for removed in ("/daily-post", "generated_daily_post", "generate_daily_post",
                        "research_daily_post", "dailypostchecked", "daily post"):
            self.assertNotIn(removed, combined)

    def test_daily_followup_claim_runs_once_per_day(self):
        state = {"last_followup_day": ""}
        self.assertTrue(linkedin_bot.begin_daily_followups(state))
        self.assertFalse(linkedin_bot.begin_daily_followups(state))

    def test_notification_reply_is_drafted_and_reviewed(self):
        with patch.object(linkedin_bot, "ollama", side_effect=[
            json.dumps({"allowed": True, "reason": "answers the question",
                        "reply": "That tradeoff is exactly the interesting part."}),
            json.dumps({"pass": True, "reason": "specific and natural", "confidence": 92}),
        ]):
            result = linkedin_bot.draft_notification_reply(
                "Dana asked whether the simpler implementation scales.",
                "Dana replied to your comment",
            )
        self.assertTrue(result["allowed"])
        self.assertEqual(result["reply"], "That tradeoff is exactly the interesting part.")

    def test_daily_notification_and_accepted_connection_flows_are_present(self):
        content = Path("chrome_extension/content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        server = Path("extension_server.py").read_text(encoding="utf-8")
        self.assertIn("maybeRunDailyFollowups", content)
        self.assertIn("handleNotificationsPage", content)
        self.assertIn("handleNotificationReply", content)
        self.assertIn("waitForEditorClear", content)
        self.assertNotIn("/next-pending-connection", content + server)
        self.assertIn("queueNotificationReplies", worker)
        self.assertIn("openDailyNotifications", worker)
        self.assertIn("/draft-notification-reply", server)
        self.assertIn('mode: \'acceptedCheck\'', content)

    def test_reset_today_preserves_pending_connections(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "state.json").write_text(json.dumps({
                "day": "2000-01-01", "likes": 99,
                "pending_connections": [{"url": "https://example.test/profile"}],
                "replied_notification_ids": ["notification-1"],
                "instagram_likes_since_stories": 73,
            }), encoding="utf-8")
            with patch.object(manage, "ROOT", root):
                manage.reset_today()
            state = json.loads((root / "state.json").read_text(encoding="utf-8"))
            self.assertEqual(state["likes"], 0)
            self.assertEqual(state["instagram_likes"], 0)
            self.assertEqual(state["instagram_story_views"], 0)
            self.assertEqual(state["instagram_likes_since_stories"], 73)
            self.assertNotIn("instagram_comments", state)
            self.assertNotIn("instagram_messages", state)
            self.assertNotIn("instagram_follows", state)
            self.assertEqual(len(state["pending_connections"]), 1)
            self.assertEqual(state["replied_notification_ids"], ["notification-1"])
            self.assertEqual(state["last_followup_day"], "")

    def test_skipped_log_records_detected_topics(self):
        with tempfile.TemporaryDirectory() as directory:
            destination = Path(directory) / "skipped.txt"
            with patch.object(linkedin_bot, "SKIPPED_POST_TOPICS_FILE", destination):
                linkedin_bot.record_skipped_post(
                    "A thoughtful post about sustainable architecture.",
                    {"reason": "outside configured topics", "score": 31,
                     "topics": ["sustainable architecture"]},
                )
            content = destination.read_text(encoding="utf-8")
            self.assertIn("detected_topics=sustainable architecture", content)
            self.assertIn("score=31", content)

    def test_instagram_only_likes_and_views_stories(self):
        instagram = Path("chrome_extension/instagram_content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        server = Path("extension_server.py").read_text(encoding="utf-8")
        manifest = json.loads(Path("chrome_extension/manifest.json").read_text(encoding="utf-8"))
        strategy = json.loads(Path("linkedin_strategy.json").read_text(encoding="utf-8"))
        dependencies = (Path("requirements.txt").read_text(encoding="utf-8") +
                        Path("pyproject.toml").read_text(encoding="utf-8")).lower()
        self.assertIn("startStoryBatch", instagram)
        self.assertIn("viewStory", instagram)
        self.assertIn("instagram_story_view", instagram)
        self.assertIn("instagram-story-batch-complete", instagram)
        self.assertIn("/instagram-status", instagram)
        self.assertIn("shouldWatchStories", server)
        self.assertIn("instagram_likes_since_stories", server)
        self.assertNotIn("canLike", server)
        self.assertNotIn("canViewStory", server)
        for removed in ("capturevisible", "addcomment", "instagram_comment", "ocr", "follow"):
            self.assertNotIn(removed, (instagram + worker).lower())
        for removed in ("instagram-decide", "instagram_comment", "instagram_ocr"):
            self.assertNotIn(removed, server.lower())
        self.assertNotIn("activeTab", manifest.get("permissions", []))
        self.assertEqual(strategy["instagram"]["story_interval_likes"], 100)
        self.assertNotIn("daily_limits", strategy["instagram"])
        self.assertNotIn("pytesseract", dependencies)
        self.assertNotIn("pillow", dependencies)

    def test_instagram_story_cycle_survives_day_rollover(self):
        with tempfile.TemporaryDirectory() as directory:
            state_file = Path(directory) / "state.json"
            state_file.write_text(json.dumps({
                "day": "2000-01-01",
                "instagram_likes_since_stories": 99,
            }), encoding="utf-8")
            with patch.object(linkedin_bot, "STATE_FILE", state_file):
                state = linkedin_bot.load_state()
            self.assertEqual(state["instagram_likes_since_stories"], 99)

    def test_bridge_health_cycle_and_extension_status(self):
        with socket.socket() as reservation:
            reservation.bind(("127.0.0.1", 0))
            port = reservation.getsockname()[1]
        environment = {**os.environ, "BRIDGE_PORT": str(port)}
        process = subprocess.Popen(
            [sys.executable, "-c",
             "import linkedin_bot; from extension_server import run_server; run_server(linkedin_bot)"],
            cwd=Path.cwd(), env=environment,
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        try:
            for _ in range(30):
                try:
                    health = requests.get(f"http://127.0.0.1:{port}/", timeout=0.3).json()
                    break
                except requests.RequestException:
                    time.sleep(0.1)
            else:
                self.fail("local bridge did not start")
            self.assertEqual(health["version"], manage.version())
            payload = {
                "posts": [],
                "diagnostics": {
                    "extensionVersion": manage.version(),
                    "extensionBuild": manage.extension_build(),
                    "url": "smoke-test",
                },
            }
            cycle = requests.post(f"http://127.0.0.1:{port}/cycle", json=payload, timeout=2).json()
            self.assertEqual(cycle["received"], 0)
            status = requests.get(f"http://127.0.0.1:{port}/extension-status", timeout=2).json()
            self.assertEqual(status["build"], manage.extension_build())
        finally:
            process.terminate()
            process.wait(timeout=5)


if __name__ == "__main__":
    unittest.main()
