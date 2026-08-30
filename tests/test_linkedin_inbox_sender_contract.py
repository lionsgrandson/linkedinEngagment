from pathlib import Path
import unittest


class LinkedInInboxSenderContract(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        root = Path(__file__).resolve().parent.parent
        cls.manifest = (root / 'chrome_extension' / 'manifest.json').read_text(encoding='utf-8')
        cls.sender = (root / 'chrome_extension' / 'linkedin_inbox_v3.js').read_text(encoding='utf-8')

    def test_dedicated_linkedin_sender_loads_before_generic_inbox(self):
        self.assertIn('"linkedin_inbox_v3.js"', self.manifest)
        self.assertLess(self.manifest.index('"linkedin_inbox_v3.js"'), self.manifest.index('"inbox_content.js"'))
        self.assertIn('"version": "3.20.17"', self.manifest)

    def test_sender_has_three_submission_paths(self):
        self.assertIn("method = 'button'", self.sender)
        self.assertIn("method = 'form'", self.sender)
        self.assertIn("form.requestSubmit()", self.sender)
        self.assertIn("method = 'enter'", self.sender)
        self.assertIn("new KeyboardEvent('keydown'", self.sender)

    def test_sender_requires_outgoing_confirmation_and_blocks_duplicate_retry(self):
        self.assertIn('waitForOutgoing(expected, previousSignature)', self.sender)
        self.assertIn('attempted.add(key)', self.sender)
        self.assertIn('Automatic retry is blocked to avoid a duplicate', self.sender)
        self.assertIn("kind: 'inbox_reply'", self.sender)

    def test_programmatic_draft_pokes_linkedin_composer_state(self):
        self.assertIn("document.execCommand('insertText', false, ' ')", self.sender)
        self.assertIn("inputType: 'deleteContentBackward'", self.sender)


if __name__ == '__main__':
    unittest.main()
