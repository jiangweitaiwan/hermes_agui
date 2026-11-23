"""Exercise the real Host migration command against disposable PostgreSQL databases."""

import os
from pathlib import Path
from uuid import uuid4

import pytest

from hermes_agui.storage import migrate


@pytest.mark.parametrize("prefix", [0, 1, 6])
def test_legacy_prefix_and_rerun(prefix, monkeypatch, capsys):
    psycopg = pytest.importorskip("psycopg")
    socket = os.environ.get("HERMES_AGUI_TEST_DB_SOCKET")
    if not socket:
        pytest.skip("requires a disposable PostgreSQL server")
    from psycopg.conninfo import make_conninfo

    url = make_conninfo(host=socket, dbname="postgres", user="hermes")
    database = "migration_" + uuid4().hex
    with psycopg.connect(url, autocommit=True) as admin:
        admin.execute(f"CREATE DATABASE {database}")
        try:
            target = make_conninfo(url, dbname=database, client_encoding="UTF8")
            paths = sorted(Path(migrate.__file__).with_name("migrations").glob("*.sql"))
            with psycopg.connect(target, autocommit=True) as connection:
                for path in paths[:prefix]:
                    connection.execute(path.read_text(), prepare=False)
                if prefix:
                    connection.execute("""INSERT INTO hermes_agui_host.bot_state
                        (project,principal,bot) VALUES ('p','u','bot')""")
            monkeypatch.setenv("AGUI_HOST_DATABASE_URL", target)
            migrate.main()
            capsys.readouterr()
            migrate.main()
            assert capsys.readouterr().out == ""
            with psycopg.connect(target) as connection:
                assert [row[0] for row in connection.execute(
                    "SELECT name FROM hermes_agui_host_migrations.host ORDER BY name"
                )] == [path.name for path in paths]
                if prefix:
                    assert connection.execute(
                        "SELECT bot FROM hermes_agui_host.bot_state"
                    ).fetchall() == [("bot",)]
        finally:
            admin.execute(f"DROP DATABASE {database} WITH (FORCE)")
