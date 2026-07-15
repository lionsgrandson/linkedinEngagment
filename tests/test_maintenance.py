import json
import os
import socket
import subprocess
import sys
import tempfile
import time
import unittest
from datetime import datetime
from pathlib import Path
from unittest.mock import patch

import linkedin_bot
import manage
import requests
import reporting


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
        for name in ("content.js", "instagram_content.js", "facebook_content.js",
                     "inbox_content.js"):
            content = (Path("chrome_extension") / name).read_text(encoding="utf-8")
            self.assertIn(f"const EXTENSION_VERSION = '{expected}'", content)

    def test_extension_build_markers_match_source_fingerprint(self):
        expected = manage.extension_build()
        info = json.loads(Path("chrome_extension/build_info.json").read_text(encoding="utf-8"))
        self.assertEqual(info["build"], expected)
        for name in ("content.js", "instagram_content.js", "facebook_content.js",
                     "inbox_content.js"):
            content = (Path("chrome_extension") / name).read_text(encoding="utf-8")
            self.assertIn(f"const EXTENSION_BUILD = '{expected}'", content)

    def test_linkedin_connection_queue_and_confirmation_are_present(self):
        content = Path("chrome_extension/content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        self.assertIn("urls: [url]", content)
        self.assertNotIn("connectionBatch", content)
        self.assertIn("waitForConnectionConfirmation", content)
        self.assertIn("LinkedIn shows the invitation as pending", content)
        self.assertNotIn("LinkedIn closed the invitation dialog after Send", content)
        self.assertIn("blockingFeedback", content)
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
        self.assertIn("replied|responded) to your (?:comment|reply)", content)
        self.assertIn("[...threadComments].reverse()", content)
        self.assertIn("slice(-10000)", content)
        self.assertIn("waitForExactComment", content)
        self.assertIn("handleIncomingInvitations", content)
        self.assertIn("openIncomingInvitations", worker)
        self.assertIn("connection_accept", server)

    def test_linkedin_inbox_scans_rows_and_requires_exact_outgoing_message(self):
        inbox = Path("chrome_extension/inbox_content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        self.assertIn("li.msg-conversation-listitem", inbox)
        self.assertIn("new notifications", inbox)
        self.assertIn("openConversation", inbox)
        self.assertIn("latestIsInbound", inbox)
        self.assertIn("exactOutgoingMessage", inbox)
        self.assertIn("displayed the exact outgoing reply", inbox)
        self.assertNotIn("confirmed = !text(input)", inbox)
        self.assertIn("periodInMinutes: 5", worker)
        self.assertIn("ccMessageAutomationTabs", worker)
        self.assertIn("ccLastLinkedInPriorityAt", worker)

    def test_linkedin_comment_duplicate_and_exact_confirmation_are_required(self):
        content = Path("chrome_extension/content.js").read_text(encoding="utf-8")
        self.assertIn("expandComments", content)
        self.assertIn("hasOwnComment", content)
        self.assertIn("duplicate prevented: this account already commented", content)
        self.assertIn("LinkedIn shows the submitted comment signature", content)
        self.assertNotIn("after > before || !node.contains(editor)", content)

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
            self.assertEqual(state["instagram_follows"], 0)
            self.assertEqual(state["facebook_follows"], 0)
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

    def test_instagram_likes_follows_visual_topics_and_views_stories(self):
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
        self.assertIn("canLike", server)
        self.assertIn("instagram_follow", server)
        self.assertNotIn("canViewStory", server)
        for removed in ("capturevisible", "addcomment", "instagram_comment"):
            self.assertNotIn(removed, (instagram + worker).lower())
        for removed in ("instagram-decide", "instagram_comment", "instagram_ocr"):
            self.assertNotIn(removed, server.lower())
        self.assertNotIn("activeTab", manifest.get("permissions", []))
        self.assertEqual(strategy["instagram"]["story_interval_likes"], 100)
        self.assertNotIn("daily_limits", strategy["instagram"])
        self.assertNotIn("pytesseract", dependencies)
        self.assertNotIn("pillow", dependencies)

    def test_visual_analysis_rejects_appearance_based_gender_inference(self):
        result = linkedin_bot.analyze_social_images(
            "instagram", ["https://example.com/image.jpg"], ["female accounts"])
        self.assertFalse(result["allowed"])
        self.assertIn("protected-trait", result["reason"])

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

    def test_instagram_story_cycle_scrolls_top_and_returns_without_reload_loop(self):
        instagram = Path("chrome_extension/instagram_content.js").read_text(encoding="utf-8")
        self.assertIn("window.scrollTo({top: 0", instagram)
        self.assertIn("nextStoryEntry", instagram)
        self.assertIn("finishStoryBatch", instagram)
        self.assertNotIn("location.reload()", instagram)
        self.assertIn("location.assign('https://www.instagram.com/')", instagram)
        self.assertIn("view as codesite", instagram.lower())
        self.assertIn("naturalWidth >= 300", instagram)
        self.assertIn("storyWatchTimeMs", instagram)
        self.assertIn("video.duration - video.currentTime", instagram)
        self.assertIn("config.stories", instagram)
        self.assertIn("config.likes", instagram)
        self.assertIn("storyBatchLimit", instagram)
        start_story = instagram.split("async function startStoryBatch()", 1)[1].split(
            "function storyFrameKey()", 1)[0]
        self.assertNotIn("instagram-story-batch-complete", start_story)
        self.assertIn("trigger remains pending", start_story)

    def test_shared_settings_topics_toggles_and_ui_states(self):
        settings = Path("chrome_extension/settings.js").read_text(encoding="utf-8")
        options = Path("chrome_extension/options.js").read_text(encoding="utf-8")
        styles = Path("chrome_extension/options.css").read_text(encoding="utf-8")
        manifest = json.loads(Path("chrome_extension/manifest.json").read_text(encoding="utf-8"))
        for platform in ("linkedin", "instagram", "facebook"):
            self.assertIn(f"{platform}:", settings)
            self.assertIn(platform, options)
        for feature in ("likes", "comments", "connections", "incomingInvites", "notificationReplies",
                        "stories", "messages", "profileLikes", "profileLikeCount",
                        "follows", "imageRecognition", "dailyFollowLimit",
                        "dailyLikeLimit", "storyIntervalLikes", "storyBatchLimit"):
            self.assertIn(feature, settings)
        for phase in ("loading", "success", "failure", "blank", "filled"):
            self.assertIn(phase, options + styles)
        self.assertIn("button:hover", styles)
        self.assertIn("Edit ${topic}", options)
        self.assertIn("cc-ig-skeleton", Path("chrome_extension/instagram_content.js").read_text(encoding="utf-8"))
        self.assertEqual(manifest["options_ui"]["page"], "options.html")
        self.assertIn("https://www.facebook.com/*", manifest["host_permissions"])
        self.assertIn("/analyze-social-images", Path("extension_server.py").read_text(encoding="utf-8"))
        for script in ("content.js", "instagram_content.js", "facebook_content.js"):
            self.assertIn("mediaUrls", Path("chrome_extension", script).read_text(encoding="utf-8"))

    def test_instagram_and_facebook_profile_batches_use_configured_x(self):
        instagram = Path("chrome_extension/instagram_content.js").read_text(encoding="utf-8")
        facebook = Path("chrome_extension/facebook_content.js").read_text(encoding="utf-8")
        options = Path("chrome_extension/options.js").read_text(encoding="utf-8")
        for source in (instagram, facebook):
            self.assertIn("profileLikeCount", source)
            self.assertIn("profileLikes", source)
            self.assertIn("phase === 'top'", source)
            self.assertIn("phase === 'bottom'", source)
            self.assertIn("scrollTo({top:", source)
            self.assertIn("stable >= 3", source)
            self.assertIn("returning home", source)
        self.assertIn("Posts per profile section (X)", options)
        self.assertIn("runProfileBatch", instagram)
        self.assertIn("runFacebookProfileBatch", facebook)

    def test_facebook_feed_and_opt_in_inbox_workers_are_wired(self):
        facebook = Path("chrome_extension/facebook_content.js").read_text(encoding="utf-8")
        inbox = Path("chrome_extension/inbox_content.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        server = Path("extension_server.py").read_text(encoding="utf-8")
        self.assertIn("draft-social-comment", facebook)
        self.assertIn("facebookPostNodes", facebook)
        self.assertIn("Actions for this post", facebook)
        self.assertIn("Leave a comment", facebook)
        self.assertIn("facebook_like", facebook)
        self.assertIn("facebook_comment", facebook)
        self.assertIn("draft-inbox-reply", inbox)
        self.assertIn("config.messages", inbox)
        self.assertIn("openEnabledMessageTabs", worker)
        self.assertIn("runMessageRepliesNow", worker)
        self.assertIn("ccDailyMessages", worker)
        self.assertIn("draft_social_comment", server)
        self.assertIn("draft_inbox_reply", server)

    def test_linkedin_topics_can_be_overridden_from_settings(self):
        whatsapp = Path("chrome_extension/whatsapp_content.js").read_text(encoding="utf-8")
        settings = Path("chrome_extension/settings.js").read_text(encoding="utf-8")
        options = Path("chrome_extension/options.js").read_text(encoding="utf-8")
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        linkedin = Path("chrome_extension/content.js").read_text(encoding="utf-8")
        manifest = json.loads(Path("chrome_extension/manifest.json").read_text(encoding="utf-8"))
        self.assertIn("https://web.whatsapp.com/*", manifest["host_permissions"])
        self.assertIn("whatsapp_content.js", json.dumps(manifest))
        self.assertIn("INBOUND:", whatsapp)
        self.assertIn("latest message is not inbound", whatsapp)
        self.assertIn("leaveWhatsAppChat", whatsapp + worker)
        self.assertIn("ccLinkedInPriorityActive", whatsapp + worker)
        self.assertIn("triggerLinkedInPriority", linkedin + worker)
        self.assertIn("notificationInterrupts", settings + options + linkedin)
        self.assertIn("clearStaleNotificationAutomation", worker)
        self.assertIn("active: false", worker)
        self.assertNotIn("active: true", worker)
        self.assertIn("Unread notification", linkedin)
        self.assertIn("writingStyle", settings + options + whatsapp)
        self.assertIn("optedIn", settings + options + whatsapp + worker)
        self.assertIn("consentRevision", settings + options + whatsapp + worker)
        self.assertIn("Automatic clients", options)
        self.assertIn("automaticClient", whatsapp)
        self.assertIn("tail-in", whatsapp)
        self.assertIn("tail-out", whatsapp)
        self.assertIn("conv-msg-", whatsapp)
        self.assertIn("cell-frame-container", whatsapp)
        self.assertIn("waitForConversationOpen", whatsapp)
        self.assertIn("async function openConversation", whatsapp)
        self.assertIn("[role='contentinfo']", whatsapp)
        self.assertIn("compose-btn-send", whatsapp)
        self.assertNotIn("#main .message-in", whatsapp)
        self.assertNotIn("#main footer", whatsapp)
        self.assertIn("style-file", Path("chrome_extension/options.html").read_text(encoding="utf-8"))
        for phase in ("loading", "success", "failure", "blank", "filled"):
            self.assertIn(phase, whatsapp)

    def test_background_concurrency_dashboard_overlay_and_autostart_are_wired(self):
        worker = Path("chrome_extension/service_worker.js").read_text(encoding="utf-8")
        settings = Path("chrome_extension/settings.js").read_text(encoding="utf-8")
        options = Path("chrome_extension/options.html").read_text(encoding="utf-8")
        server = Path("extension_server.py").read_text(encoding="utf-8")
        manage_source = Path("manage.py").read_text(encoding="utf-8")
        starter = Path("scripts/start_bridge.ps1").read_text(encoding="utf-8")
        self.assertIn("LINKEDIN_TASK_CONCURRENCY = 3", worker)
        self.assertIn("ccLinkedInFollowups", worker)
        self.assertIn("ensureLinkedInFollowupTabs", worker)
        self.assertNotIn("active: true", worker)
        for token in ("showOverlay", "compactOverlay"):
            self.assertIn(token, settings)
        for token in ("show-overlay", "compact-overlay", "open-dashboard"):
            self.assertIn(token, options)
        self.assertIn('self.path in {"/dashboard", "/dashboard/"}', server)
        self.assertIn("install-bridge-task", manage_source)
        self.assertIn("CurrentVersion\\Run", manage_source)
        self.assertIn("linkedin_bot.py", starter)
        self.assertIn("ollama", starter.lower())

    def test_whatsapp_retries_open_unanswered_chat_and_confirms_message_bubble(self):
        whatsapp = Path("chrome_extension/whatsapp_content.js").read_text(encoding="utf-8")
        self.assertIn("activeConversation", whatsapp)
        self.assertIn("[data-testid='msg-container']", whatsapp)
        self.assertIn("exactOutgoingMessage", whatsapp)
        self.assertIn("waitForExactOutgoingMessage", whatsapp)
        self.assertNotIn("confirmed = !text(input)", whatsapp)
        self.assertNotIn("type: 'leaveWhatsAppChat'", whatsapp)

    def test_imported_writing_style_is_tone_only(self):
        with patch.object(linkedin_bot, "ollama", side_effect=[
            json.dumps({"allowed": True, "reason": "latest turn is inbound", "message": "Got it - I will check."}),
            json.dumps({"pass": True, "reason": "specific and safe", "confidence": 95}),
        ]) as model:
            result = linkedin_bot.draft_inbox_reply(
                "whatsapp", "INBOUND: Can you check this?",
                {"sourceType": "samples", "content": "Short sentences. Warm and direct."},
            )
        self.assertTrue(result["allowed"])
        prompt = model.call_args_list[0].args[0]
        self.assertIn("Imported writing samples", prompt)
        self.assertIn("Never copy claims", prompt)

    def test_reply_safeguards_block_contacts_and_enforce_scope_before_ai(self):
        safeguards = {
            "businessFacts": "Opening hours: Sunday-Thursday, 09:00-17:00.",
            "conversationScope": "groups",
            "contactMode": "all",
            "allowedContacts": [],
            "blockedContacts": ["Do Not Reply"],
        }
        with patch.object(linkedin_bot, "ollama") as model:
            blocked = linkedin_bot.draft_inbox_reply(
                "whatsapp", "INBOUND: What time are you open?", None,
                safeguards, "Do Not Reply", True,
            )
            direct = linkedin_bot.draft_inbox_reply(
                "whatsapp", "INBOUND: What time are you open?", None,
                safeguards, "Client", False,
            )
        self.assertFalse(blocked["allowed"])
        self.assertIn("blocked", blocked["reason"])
        self.assertFalse(direct["allowed"])
        self.assertIn("only group", direct["reason"])
        model.assert_not_called()

    def test_verified_business_facts_are_used_and_fact_checked(self):
        safeguards = {
            "businessFacts": "Opening hours: Sunday-Thursday, 09:00-17:00.",
            "conversationScope": "all", "contactMode": "all",
            "allowedContacts": [], "blockedContacts": [],
        }
        with patch.object(linkedin_bot, "ollama", side_effect=[
            json.dumps({"allowed": True, "reason": "hours are verified",
                        "message": "We are open Sunday through Thursday, 09:00-17:00."}),
            json.dumps({"pass": True, "reason": "matches verified facts", "confidence": 99}),
        ]) as model:
            result = linkedin_bot.draft_inbox_reply(
                "whatsapp", "INBOUND: What are your opening hours?", None,
                safeguards, "Client", False,
            )
        self.assertTrue(result["allowed"])
        self.assertIn("VERIFIED_COMPANY_INFORMATION", model.call_args_list[0].args[0])
        self.assertIn("Sunday-Thursday", model.call_args_list[1].args[0])

    def test_options_and_content_scripts_wire_reply_safeguards(self):
        html = Path("chrome_extension/options.html").read_text(encoding="utf-8")
        options = Path("chrome_extension/options.js").read_text(encoding="utf-8")
        settings = Path("chrome_extension/settings.js").read_text(encoding="utf-8")
        inbox = Path("chrome_extension/inbox_content.js").read_text(encoding="utf-8")
        whatsapp = Path("chrome_extension/whatsapp_content.js").read_text(encoding="utf-8")
        server = Path("extension_server.py").read_text(encoding="utf-8")
        for field in ("business-facts", "conversation-scope", "contact-mode",
                      "allowed-contacts", "blocked-contacts"):
            self.assertIn(field, html)
        for token in ("replySafeguards", "replyDecision", "blockedContacts",
                      "allowedContacts", "conversationScope"):
            self.assertIn(token, settings + options)
        for source in (inbox, whatsapp):
            self.assertIn("replyDecision", source)
            self.assertIn("safeguards", source)
            self.assertIn("isGroup", source)
            self.assertIn("contact", source)
        self.assertIn('data.get("safeguards")', server)

    def test_linkedin_topics_can_be_overridden_from_settings(self):
        with patch.object(linkedin_bot, "ollama", return_value=json.dumps({
            "relevant": True, "reason": "matches HR", "score": 90, "topics": ["HR"],
        })) as model:
            result = linkedin_bot.relevant_post("Hiring leaders in hightech", ["hightech", "HR"])
        self.assertTrue(result["relevant"])
        self.assertEqual(result["configured_topics"], ["hightech", "HR"])
        self.assertIn('"HR"', model.call_args.args[0])

    def test_empty_topic_list_does_not_restore_default_topics(self):
        with patch.object(linkedin_bot, "ollama", return_value=json.dumps({
            "relevant": True, "reason": "all topics allowed", "score": 80, "topics": [],
        })) as model:
            result = linkedin_bot.relevant_post("A substantive post", [])
        self.assertEqual(result["configured_topics"], [])
        self.assertIn("Engagement topics: []", model.call_args.args[0])

    def test_report_has_all_windows_snapshots_and_correlation(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / "linkedin_metrics.jsonl").write_text(
                '\n'.join(json.dumps(row) for row in (
                    {"at": "2026-07-15T10:00:00", "event": "confirmed_like"},
                    {"at": "2026-07-15T11:00:00", "event": "confirmed_facebook_comment"},
                )) + '\n', encoding="utf-8")
            snapshots = []
            for day, social, sessions in ((13, 2, 10), (14, 4, 20), (15, 6, 30)):
                captured = f"2026-07-{day:02d}T12:00:00"
                snapshots.extend((
                    {"captured_at": captured, "source": "linkedin",
                     "metrics": {"likes": social}},
                    {"captured_at": captured, "source": "ga4:code-site.tech",
                     "metrics": {"sessions": sessions}},
                ))
            (root / "account_metrics.jsonl").write_text(
                '\n'.join(json.dumps(row) for row in snapshots) + '\n', encoding="utf-8")
            report = reporting.build_report(root, datetime(2026, 7, 16, 0, 0, 0))
            self.assertEqual(set(report["windows"]), {"day", "week", "month", "year"})
            self.assertEqual(report["windows"]["day"]["actions"], {})
            self.assertEqual(report["windows"]["week"]["actions"]["linkedin"]["likes"], 1)
            self.assertEqual(report["correlation"]["coefficient"], 1.0)
            self.assertIn("code-site.tech", report["website_analytics"])
            self.assertIn("Social + Website Report", reporting.render_html(report))

    def test_snapshot_metrics_support_powershell_safe_key_values(self):
        self.assertEqual(manage.parse_metrics("sessions=24,views=25"),
                         {"sessions": 24, "views": 25})

    def test_account_metrics_capture_is_conservative_and_reported(self):
        manifest = json.loads(Path("chrome_extension/manifest.json").read_text(encoding="utf-8"))
        metrics = Path("chrome_extension/metrics_content.js").read_text(encoding="utf-8")
        self.assertIn("metrics_content.js", json.dumps(manifest))
        self.assertIn("/account-snapshot", metrics)
        self.assertIn("profile viewers", metrics)
        self.assertIn("post impressions", metrics)
        self.assertIn("document.querySelector('header')", metrics)
        self.assertNotIn("[role='article']", metrics)

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
