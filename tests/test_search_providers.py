import os
import unittest
from unittest.mock import Mock, patch

from opportunity_hunter import engine
from opportunity_hunter import search_providers


class SearchProviderTests(unittest.TestCase):
    def test_tavily_is_default_when_configured(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "results": [{
                "title": "Backend Developer",
                "url": "https://jobs.example.com/backend",
                "content": "Python backend role",
            }]
        }
        with patch.dict(os.environ, {
            "TAVILY_API_KEY": "tvly-test",
            "HUNTER_SEARCH_PROVIDER": "auto",
        }, clear=False), patch("opportunity_hunter.search_providers.requests.post", return_value=response) as post:
            rows = search_providers.search_web("python developer", count=5)
        self.assertEqual(rows[0]["source"], "tavily")
        self.assertEqual(search_providers.last_provider(), "tavily")
        self.assertEqual(post.call_args.args[0], "https://api.tavily.com/search")

    def test_searxng_works_without_search_api_key(self):
        response = Mock()
        response.raise_for_status.return_value = None
        response.json.return_value = {
            "results": [{
                "title": "Example Company",
                "url": "https://example.com/",
                "content": "Company website",
            }]
        }
        env = {
            "TAVILY_API_KEY": "",
            "BRAVE_SEARCH_API_KEY": "",
            "SEARXNG_URL": "http://127.0.0.1:8888",
            "HUNTER_SEARCH_PROVIDER": "auto",
        }
        with patch.dict(os.environ, env, clear=False), patch("opportunity_hunter.search_providers.requests.get", return_value=response) as get:
            rows = search_providers.search_web("example company", count=5)
        self.assertEqual(rows[0]["source"], "searxng")
        self.assertEqual(search_providers.last_provider(), "searxng")
        self.assertTrue(get.call_args.args[0].endswith("/search"))
        self.assertEqual(get.call_args.kwargs["params"]["format"], "json")

    def test_hunter_status_exposes_new_search_providers(self):
        env = {
            "TAVILY_API_KEY": "tvly-test",
            "SEARXNG_URL": "",
            "BRAVE_SEARCH_API_KEY": "",
            "HUNTER_SEARCH_PROVIDER": "auto",
        }
        with patch.dict(os.environ, env, clear=False):
            status = engine.integration_status()
        self.assertTrue(status["tavilySearch"]["configured"])
        self.assertFalse(status["searxng"]["configured"])
        self.assertEqual(status["webSearch"]["provider"], "tavily")
        self.assertTrue(status["webSearch"]["configured"])

    def test_specific_tavily_selection_does_not_use_brave(self):
        fake_tavily = [{"title": "Role", "url": "https://example.com/job", "description": "", "source": "tavily"}]
        with patch.dict(os.environ, {"TAVILY_API_KEY": "tvly-test"}, clear=False), \
                patch("opportunity_hunter.search_providers.tavily_search", return_value=fake_tavily) as tavily, \
                patch("opportunity_hunter.search_providers.searxng_search") as searxng:
            with search_providers.requested_provider("tavily"):
                rows = search_providers.search_web("developer")
        self.assertEqual(rows, fake_tavily)
        tavily.assert_called_once()
        searxng.assert_not_called()


if __name__ == "__main__":
    unittest.main()
