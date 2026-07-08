import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tdai_swe_agent.client import MemorySearchResult, RecallResult
from tdai_swe_agent.config import RecallConfig
from tdai_swe_agent.history_processor import TdaiRecallHistoryProcessor


class FakeClient:
    def __init__(self):
        self.recall_calls = 0
        self.search_calls = 0

    def recall(self, *, query, session_key, user_id):
        self.recall_calls += 1
        return RecallResult(
            context="<user-persona>\nprefer tests first\n</user-persona>\n- **tdai_memory_search**: unavailable here",
            strategy="hybrid",
            memory_count=1,
            raw={"context": "prefer tests first"},
        )

    def search_memories(self, *, query, limit):
        self.search_calls += 1
        return MemorySearchResult(
            results="- [instruction] remember prior fix",
            total=1,
            strategy="hybrid",
            raw={"results": "- [instruction] remember prior fix"},
        )


class HistoryProcessorTests(unittest.TestCase):
    def test_injects_cached_recall_after_instance_prompt(self):
        client = FakeClient()
        processor = TdaiRecallHistoryProcessor(
            client=client,
            config=RecallConfig(max_context_chars=1000),
            session_key="swe-agent/run",
            user_id="swe-agent",
            instance_id="repo__issue-1",
        )
        history = [
            {"role": "system", "content": "sys", "agent": "repo__issue-1", "message_type": "observation"},
            {
                "role": "user",
                "content": "Fix the issue",
                "agent": "repo__issue-1",
                "message_type": "observation",
            },
            {"role": "assistant", "content": "thinking", "agent": "repo__issue-1", "message_type": "thought"},
        ]

        out1 = processor(history)
        out2 = processor(history)

        self.assertEqual(client.recall_calls, 1)
        self.assertEqual(client.search_calls, 1)
        self.assertEqual(out1[2]["tags"][0], "tdai_recall_context")
        self.assertIn("remember prior fix", out1[2]["content"])
        self.assertIn("prefer tests first", out1[2]["content"])
        self.assertIn("<relevant-memories>", out1[2]["content"])
        self.assertNotIn("tdai_memory_search", out1[2]["content"])
        self.assertEqual(out2[2]["tags"][0], "tdai_recall_context")

    def test_can_use_legacy_recall_without_l1_search(self):
        client = FakeClient()
        processor = TdaiRecallHistoryProcessor(
            client=client,
            config=RecallConfig(include_l1_search=False),
            session_key="swe-agent/run",
            user_id="swe-agent",
            instance_id="repo__issue-1",
        )
        history = [
            {"role": "user", "content": "Fix the issue", "agent": "repo__issue-1", "message_type": "observation"},
        ]

        out = processor(history)

        self.assertEqual(client.recall_calls, 1)
        self.assertEqual(client.search_calls, 0)
        self.assertIn("prefer tests first", out[1]["content"])
        self.assertNotIn("<relevant-memories>", out[1]["content"])


if __name__ == "__main__":
    unittest.main()
