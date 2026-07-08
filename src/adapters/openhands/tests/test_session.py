from tdai_openhands.config import SessionConfig
from tdai_openhands.prompt import OpenHandsTask
from tdai_openhands.session import make_session_id, make_session_key


def test_make_session_key_per_instance() -> None:
    task = OpenHandsTask(instance_id="pylint-dev__pylint-4551", repo="pylint-dev/pylint", problem_statement="bug")
    key = make_session_key(SessionConfig(scope="per_instance"), task, run_id="run 1")
    assert key == "openhands/run-1/pylint-dev__pylint-4551"


def test_make_session_key_repo() -> None:
    task = OpenHandsTask(instance_id="x", repo="pylint-dev/pylint", problem_statement="bug")
    key = make_session_key(SessionConfig(scope="repo"), task, run_id="run")
    assert key == "openhands/repo/pylint-dev-pylint"


def test_make_session_id() -> None:
    task = OpenHandsTask(instance_id="pylint-dev__pylint-4551", problem_statement="bug")
    assert make_session_id(task, run_id="run 1") == "run-1:pylint-dev__pylint-4551"
