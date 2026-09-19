"""One way to version a sqlite store, instead of four.

Every store in this package kept its schema current differently: some read
``PRAGMA user_version``, some probed ``table_info`` and ALTERed, most did
``CREATE TABLE IF NOT EXISTS`` and hoped. That is fine until an update/downgrade
cycle, at which point nobody can say what shape a file is in.

``migrate(connection, steps)`` is the whole contract: ``steps[i]`` takes the
connection from version ``i`` to version ``i + 1``, runs at most once, in order,
inside the caller's transaction, and stamps ``PRAGMA user_version`` as it goes.
Appending a step is how the schema changes; steps are never reordered or
removed, because a file on disk may be at any version below the current one.
"""

from __future__ import annotations

import sqlite3
from typing import Callable, Sequence

MigrationStep = Callable[[sqlite3.Connection], None]


def schema_version(connection: sqlite3.Connection) -> int:
    return int(connection.execute("PRAGMA user_version").fetchone()[0])


def migrate(connection: sqlite3.Connection, steps: Sequence[MigrationStep]) -> int:
    """Run the steps this file has not seen yet; return the resulting version.

    A file stamped NEWER than ``len(steps)`` is left alone and reported as-is —
    the caller decides whether that is fatal. Downgrading a schema by running
    older code against it is the one thing this helper will not do silently.
    """
    current = schema_version(connection)
    for index in range(current, len(steps)):
        steps[index](connection)
        # PRAGMA takes no parameters, and index is an int from range().
        connection.execute(f"PRAGMA user_version = {index + 1}")
    return max(current, len(steps))
