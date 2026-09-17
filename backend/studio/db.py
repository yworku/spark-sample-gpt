from __future__ import annotations

import argparse
from functools import lru_cache

from sqlalchemy import create_engine, event, inspect, select, text
from sqlalchemy.orm import sessionmaker

from .config import get_settings
from .models import Base, SchemaVersionRow


@lru_cache(maxsize=4)
def _factory(url: str):
    kwargs = {"pool_pre_ping": True}
    if url.startswith("sqlite"):
        kwargs["connect_args"] = {"check_same_thread": False}
    engine = create_engine(url, **kwargs)
    if url.startswith("sqlite"):
        @event.listens_for(engine, "connect")
        def sqlite_foreign_keys(connection, _):
            connection.execute("PRAGMA foreign_keys=ON")
    return sessionmaker(bind=engine, expire_on_commit=False)


def SessionLocal():
    return _factory(get_settings().database_url)()


def get_session():
    with SessionLocal() as session:
        yield session


def init_schema():
    """Create the v1 baseline on a fresh database; never silently migrate later versions."""
    factory = _factory(get_settings().database_url)
    engine = factory.kw["bind"]
    with engine.begin() as connection:
        if engine.dialect.name == "postgresql":
            connection.execute(text("SELECT pg_advisory_xact_lock(73637201)"))
        tables = set(inspect(connection).get_table_names())
        expected = set(Base.metadata.tables)
        if tables:
            if "schema_versions" not in tables:
                raise RuntimeError("Refusing to initialize a nonempty, unversioned database.")
            versions = list(connection.execute(select(SchemaVersionRow.version)).scalars())
            if versions != [1] or tables != expected:
                raise RuntimeError("Unsupported or incomplete database schema; use a reviewed migration.")
            for table in Base.metadata.sorted_tables:
                existing_columns = {column["name"] for column in inspect(connection).get_columns(table.name)}
                if existing_columns != set(table.columns.keys()):
                    raise RuntimeError("Database schema does not match the v1 baseline.")
            return
        Base.metadata.create_all(connection)
        connection.execute(SchemaVersionRow.__table__.insert().values(version=1))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("command", choices=["init"])
    parser.parse_args()
    init_schema()


if __name__ == "__main__":
    main()
