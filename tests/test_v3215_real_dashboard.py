from pathlib import Path
import unittest


class RealDashboardAndReplyContracts(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent / 'chrome_extension'
        cls.manifest = (root / 'manifest.json').read_text(encoding='utf-8')
        cls.worker = (root / 'service_worker_v2.js').read_text(encoding='utf-8')
        cls.backend = (root / 'inbox_backend_v2.js').read_text(encoding='utf-8')
        cls.dashboard = (root / 'dashboard.js').read_text(encoding='utf-8')
        cls.dashboard_html = (root / 'dashboard.html').read_text(encoding='utf-8')

    def test_reply_paths_do_not_request_json(self):
        self.assertIn("path === '/draft-inbox-reply'", self.backend)
        self.assertIn("path === '/draft-notification-reply'", self.backend)
        self.assertIn('Do not return JSON.', self.backend)
        self.assertNotIn('JSON.parse', self.backend)
        self.assertNotIn("format: 'json'", self.backend)

    def test_worker_loads_reply_patch_after_existing_worker(self):
        self.assertLess(self.worker.index("service_worker.js"), self.worker.index("inbox_backend_v2.js"))
        self.assertIn('service_worker_v2.js', self.manifest)
        self.assertIn('"version": "3.20.15"', self.manifest)

    def test_real_activity_is_recorded_from_confirmed_results(self):
        self.assertIn("path === '/result'", self.backend)
        self.assertIn('ccRealActivityLog', self.backend)
        self.assertIn('ccLifetimeMetrics', self.backend)
        self.assertIn('if (success && !duplicate)', self.backend)

    def test_dashboard_reads_storage_instead_of_hardcoded_vanity_cards(self):
        self.assertIn('chrome.storage.local.get(null)', self.dashboard)
        self.assertIn('ccNativeMetrics', self.dashboard)
        self.assertIn('ccLifetimeMetrics', self.dashboard)
        self.assertIn('ccExtensionStatus', self.dashboard)
        self.assertIn('ccLastBrowserResult', self.dashboard)
        self.assertIn('No estimates and no invented engagement numbers', self.dashboard_html)
        self.assertNotIn("linkedin_like: 'LinkedIn likes'", self.dashboard)


if __name__ == '__main__':
    unittest.main()
