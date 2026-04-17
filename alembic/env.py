"""Alembic is not used: this app persists to MongoDB (see database.py / storage.py)."""

raise RuntimeError(
    "Auto Articles uses MongoDB. SQL/Alembic migrations are not applicable. "
    "Remove the alembic/ folder or restore a SQL branch if you need migrations."
)
