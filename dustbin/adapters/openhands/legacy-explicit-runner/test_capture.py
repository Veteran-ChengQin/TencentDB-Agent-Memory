from tdai_openhands.capture import read_optional_json


def test_read_optional_json_with_bom(tmp_path) -> None:
    path = tmp_path / "metadata.json"
    path.write_bytes('\ufeff{"ok": true}'.encode("utf-8"))
    assert read_optional_json(path) == {"ok": True}
