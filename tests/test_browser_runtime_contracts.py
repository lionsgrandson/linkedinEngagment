from pathlib import Path
import unittest


class BrowserRuntimeContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent
        cls.native = (root / 'chrome_extension' / 'native_backend.js').read_text(encoding='utf-8')
        cls.settings = (root / 'chrome_extension' / 'settings.js').read_text(encoding='utf-8')
        cls.startup = (root / 'start_social_bot.cmd').read_text(encoding='utf-8')

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

    def test_cmd_starts_ollama_before_live_pages(self):
        ollama = self.startup.index('Starting Ollama if needed')
        pages = self.startup.index('Opening the live automation pages')
        self.assertLess(ollama, pages)
        self.assertIn('qwen3.5:9b', self.startup)
        self.assertIn('chrome://extensions', self.startup)


if __name__ == '__main__':
    unittest.main()
