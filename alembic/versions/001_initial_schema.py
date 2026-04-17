"""Legacy SQL revision (unused): data is stored in MongoDB."""

from __future__ import annotations

revision = "001_initial"
down_revision = None
branch_labels = None
depends_on = None


def upgrade() -> None:
    raise RuntimeError(
        "This project uses MongoDB; Alembic SQL migrations are not used. "
        "See database.py / storage.py."
    )


def downgrade() -> None:
    raise RuntimeError(
        "This project uses MongoDB; Alembic SQL migrations are not used. "
        "See database.py / storage.py."
    )
