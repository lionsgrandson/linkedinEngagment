import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from opportunity_hunter import engine
from opportunity_hunter.server import _edit_pending_approval


class OpportunityHunterTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.state_file = Path(self.directory.name) / "hunter_state.json"
        self.state_patch = patch.object(engine, "STATE_FILE", self.state_file)
        self.state_patch.start()

    def tearDown(self):
        self.state_patch.stop()
        self.directory.cleanup()

    def test_pasted_resume_stays_in_local_state(self):
        text = "Software developer with Python, JavaScript, React, Node.js, SQL and client-facing experience."
        result = engine.set_resume_text("resume.txt", text)
        self.assertEqual(result["name"], "resume.txt")
        self.assertTrue(self.state_file.exists())
        state = engine.load_state()
        self.assertEqual(state["resume"]["text"], text)
        self.assertNotIn("resume", engine.integration_status())

    def test_private_research_addresses_are_rejected_before_fetch(self):
        for url in (
            "http://127.0.0.1:8765/",
            "http://localhost:8765/",
            "http://192.168.1.10/",
            "http://10.0.0.5/",
        ):
            with self.subTest(url=url):
                with patch("opportunity_hunter.engine.requests.get") as request:
                    with self.assertRaises(ValueError):
                        engine.fetch_public_page(url)
                    request.assert_not_called()

    def test_job_ranking_has_deterministic_fallback_without_resume(self):
        jobs = [
            {"id": "1", "title": "Python Developer", "description": "Python APIs SQL backend"},
            {"id": "2", "title": "Accountant", "description": "Tax bookkeeping payroll"},
        ]
        ranked = engine.rank_jobs(jobs, "Python developer")
        self.assertEqual(ranked[0]["id"], "1")
        self.assertGreater(ranked[0]["matchScore"], ranked[1]["matchScore"])
        self.assertIn("Resume not loaded", ranked[0]["matchReason"])

    def test_approval_can_be_edited_then_consumed_only_once(self):
        approval = engine.create_approval("whatsapp", {
            "phone": "+972501111111",
            "message": "Original draft",
        })
        _edit_pending_approval(approval["id"], "whatsapp", {
            "phone": "+972502222222",
            "message": "Edited and approved",
        })
        result = engine.approved_whatsapp_link(approval["id"])
        self.assertIn("972502222222", result["url"])
        self.assertIn("Edited%20and%20approved", result["url"])
        with self.assertRaises(ValueError):
            engine.approved_whatsapp_link(approval["id"])

    def test_failed_email_validation_restores_approval(self):
        approval = engine.create_approval("email", {
            "to": "not-an-email",
            "subject": "Hello",
            "body": "Body",
        })
        with self.assertRaises(ValueError):
            engine.send_approved_email(approval["id"])
        pending = {item["id"] for item in engine.list_approvals()}
        self.assertIn(approval["id"], pending)

    def test_call_provider_is_not_invoked_without_explicit_approval(self):
        with patch("opportunity_hunter.engine.requests.post") as post:
            approval = engine.create_approval("call", {
                "phone": "+972501111111",
                "script": "Hello, this is a test call.",
            })
            self.assertTrue(approval["id"])
            post.assert_not_called()

    def test_mismatched_approval_kind_cannot_be_used(self):
        approval = engine.create_approval("email", {
            "to": "person@example.com",
            "subject": "Hello",
            "body": "Body",
        })
        with self.assertRaises(ValueError):
            engine.approved_whatsapp_link(approval["id"])
        self.assertEqual(len(engine.list_approvals()), 1)


if __name__ == "__main__":
    unittest.main()
