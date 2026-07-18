import sys
import unittest
from pathlib import Path
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tdai_swe_agent.config import SessionConfig
from tdai_swe_agent.session import make_session_id, make_session_key


class SessionTests(unittest.TestCase):
    def test_session_key_scopes(self):
        instance = SimpleNamespace(
            problem_statement=SimpleNamespace(id="django__django-12345"),
            env=SimpleNamespace(repo=SimpleNamespace(repo_name="testbed")),
        )
        self.assertEqual(
            make_session_key(SessionConfig(scope="batch"), instance, run_id="batch 1"),
            "swe-agent/batch-1",
        )
        self.assertEqual(
            make_session_key(SessionConfig(scope="per_instance"), instance, run_id="batch 1"),
            "swe-agent/batch-1/django__django-12345",
        )
        self.assertEqual(
            make_session_key(SessionConfig(scope="repo"), instance, run_id="batch 1"),
            "swe-agent/repo/testbed",
        )
        self.assertEqual(make_session_id(instance, run_id="batch 1"), "batch-1:django__django-12345")


if __name__ == "__main__":
    unittest.main()
