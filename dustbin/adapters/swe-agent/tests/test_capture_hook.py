import sys
import unittest
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from tdai_swe_agent.capture_hook import TdaiCaptureHook
from tdai_swe_agent.client import CaptureResult
from tdai_swe_agent.config import CaptureConfig


class FakeClient:
    def __init__(self):
        self.payload = None

    def capture(self, **kwargs):
        self.payload = kwargs
        return CaptureResult(l0_recorded=2, scheduler_notified=True, raw={"ok": True})


class FakeAgent:
    history = [
        {"role": "user", "content": "Fix bug", "message_type": "observation"},
        {"role": "user", "content": "Injected", "message_type": "observation", "tags": ["tdai_recall_context"]},
        {"role": "assistant", "content": "Done", "message_type": "thought"},
    ]


class CaptureHookTests(unittest.TestCase):
    def test_capture_uses_raw_history_without_injected_recall(self):
        client = FakeClient()
        hook = TdaiCaptureHook(
            client=client,
            config=CaptureConfig(),
            session_key="swe-agent/run",
            session_id="run:issue",
            user_id="swe-agent",
            instance_id="issue",
        )
        hook.on_init(agent=FakeAgent())
        hook.on_run_done(trajectory=[{"action": "submit", "observation": "ok"}], info={"exit_status": "submitted"})

        self.assertIsNotNone(client.payload)
        messages = client.payload["messages"]
        self.assertEqual(messages[0]["content"], "Fix bug")
        self.assertFalse(any(m["content"] == "Injected" for m in messages))


if __name__ == "__main__":
    unittest.main()
