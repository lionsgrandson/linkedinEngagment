from pathlib import Path
import shutil
import subprocess
import unittest


class BrowserRuntimeContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.root = Path(__file__).resolve().parent.parent
        cls.native = (cls.root / 'chrome_extension' / 'native_backend.js').read_text(encoding='utf-8')
        cls.settings = (cls.root / 'chrome_extension' / 'settings.js').read_text(encoding='utf-8')
        cls.manifest = (cls.root / 'chrome_extension' / 'manifest.json').read_text(encoding='utf-8')
        cls.fast_feed = (cls.root / 'chrome_extension' / 'linkedin_feed_fast.js').read_text(encoding='utf-8')
        cls.inbox = (cls.root / 'chrome_extension' / 'inbox_content.js').read_text(encoding='utf-8')
        cls.startup = (cls.root / 'start_social_bot.cmd').read_text(encoding='utf-8')

    def test_linkedin_comments_have_meta_narration_guard_and_review(self):
        self.assertIn('META_NARRATION', self.native)
        self.assertIn('metaNarration', self.native)
        self.assertIn('Post/comment relevance confirmed', self.native)
        self.assertNotIn("if (feedComment)\n        return {allowed: true, comment", self.native)

    def test_linkedin_revalidates_selected_post_after_ai_delay(self):
        self.assertIn('installLinkedInActionGuard', self.settings)
        self.assertIn("message?.path !== '/cycle'", self.settings)
        self.assertIn('Selected LinkedIn post moved before the action', self.settings)
        self.assertIn('action.index = index', self.settings)
        self.assertIn('findActionNode(action)', self.fast_feed)
        self.assertIn('LinkedIn moved the selected post', self.fast_feed)

    def test_fast_feed_replaces_long_legacy_pacing(self):
        self.assertIn('linkedin_feed_fast.js', self.manifest)
        self.assertIn('const CYCLE_MS = 3500', self.fast_feed)
        self.assertIn('const SUBMIT_COUNTDOWN_MS = 2500', self.fast_feed)
        self.assertIn('const ACTION_SETTLE_MIN_MS = 1200', self.fast_feed)
        self.assertNotIn('remaining = 5000 + Math.random() * 5000', self.fast_feed)
        self.assertNotIn('remaining = 10000', self.fast_feed)

    def test_linkedin_inbox_is_persistent_and_retries_transient_failures(self):
        self.assertIn('const SCAN_INTERVAL_MS = 2000', self.inbox)
        self.assertIn('Starting persistent inbox watcher', self.inbox)
        self.assertIn('Watching for new messages', self.inbox)
        self.assertIn('Retrying this message', self.inbox)
        self.assertNotIn("closeAutomationTab", self.inbox)
        self.assertNotIn('emptyScans >= 3', self.inbox)

    def test_linkedin_inbox_has_broader_dom_and_direction_detection(self):
        self.assertIn("[data-view-name='message-list-item']", self.inbox)
        self.assertIn("a[href*='/messaging/thread/']", self.inbox)
        self.assertIn('function eventDirection(event)', self.inbox)
        self.assertIn('You sent', self.inbox)
        self.assertIn('Moshe Schwartzberg sent the following message', self.inbox)
        self.assertIn('function latestIsInbound()', self.inbox)

    def test_notification_replies_are_not_discarded(self):
        self.assertIn("ccLinkedInRepliedNotifications", self.native)
        self.assertIn("available.slice(0, 25)", self.native)
        self.assertNotIn("if (path === '/notification-replies') return {candidates: []}", self.native)

    def test_connection_followups_persist(self):
        self.assertIn('ccLinkedInPendingConnections', self.native)
        self.assertIn('rememberPendingConnection', self.native)
        self.assertIn('forgetPendingConnection', self.native)
        self.assertIn('pendingConnections:', self.native)

    def test_whatsapp_is_transparent_and_crm_followup_is_explicit(self):
        self.assertIn('This is an automated reply. Moshe will get back to you personally soon.', self.native)
        self.assertIn('humanFollowUpRequired', self.native)
        self.assertIn('automationDisclosureIncluded', self.native)
        self.assertIn("sourceLabel: 'WhatsApp automated reply'", self.native)

    def test_requested_automations_are_enabled_by_migration(self):
        self.assertIn('SETTINGS_SCHEMA_VERSION = 4', self.settings)
        self.assertIn('result.platforms.linkedin.messages = true', self.settings)
        self.assertIn('result.platforms.whatsapp.messages = true', self.settings)
        self.assertIn('result.platforms.whatsapp.optedIn = true', self.settings)

    def test_cmd_starts_ollama_and_does_not_duplicate_background_tabs(self):
        ollama = self.startup.index('Starting Ollama if needed')
        feed = self.startup.index('Opening LinkedIn feed')
        self.assertLess(ollama, feed)
        self.assertIn('qwen3.5:9b', self.startup)
        self.assertIn('chrome://extensions', self.startup)
        self.assertNotIn('https://www.linkedin.com/messaging/?cc_auto_messages=1', self.startup)
        self.assertNotIn('https://web.whatsapp.com/?cc_auto_messages=1', self.startup)
        self.assertIn('click Run Messages once', self.startup)

    def test_changed_javascript_parses_when_node_is_available(self):
        node = shutil.which('node')
        if not node:
            self.skipTest('Node.js is not available')
        for relative in ['chrome_extension/linkedin_feed_fast.js', 'chrome_extension/inbox_content.js']:
            result = subprocess.run(
                [node, '--check', str(self.root / relative)],
                capture_output=True,
                text=True,
                check=False,
            )
            self.assertEqual(result.returncode, 0, result.stderr)


if __name__ == '__main__':
    unittest.main()
