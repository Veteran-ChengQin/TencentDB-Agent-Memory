import json

from tdai_openhands.events import load_events_from_path, messages_from_events, summarize_events


def test_load_events_from_jsonl(tmp_path) -> None:
    path = tmp_path / "events.jsonl"
    path.write_text(
        json.dumps({"source": "user", "content": "hello"}) + "\n"
        + json.dumps({"source": "agent", "message": "hi"}) + "\n",
        encoding="utf-8",
    )
    events = load_events_from_path(path)
    assert len(events) == 2


def test_load_events_from_json_with_bom(tmp_path) -> None:
    path = tmp_path / "events.json"
    path.write_bytes('\ufeff{"events": [{"source": "agent", "content": "done"}]}'.encode("utf-8"))
    events = load_events_from_path(path)
    assert events == [{"source": "agent", "content": "done"}]


def test_messages_from_events_skips_injected_recall() -> None:
    messages = messages_from_events(
        [
            {"source": "user", "content": "<tdai_recall_context>x</tdai_recall_context>"},
            {"source": "agent", "content": "work"},
        ]
    )
    assert messages == [{"role": "assistant", "content": "work"}]


def test_summarize_events() -> None:
    summary = summarize_events([{"source": "agent", "content": "done"}], max_chars=1000)
    assert "OpenHands run finished" in summary
    assert "done" in summary
