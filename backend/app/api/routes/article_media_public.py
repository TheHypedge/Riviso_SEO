"""
Public (unauthenticated) serving route for inline article media.

Deliberately its own file, not colocated in articles.py: every other route in
that file opts into auth individually via ``Depends(...)`` — burying the one
intentionally-public route among 3500+ lines of otherwise-authenticated ones
is a real accidental-auth-bypass risk on a future copy-paste edit. A plain
`<img src>` browser GET can't carry a Bearer token, so this has to be public;
the random uuid in the path is the only "secret", which is fine given this
content is destined for a public WordPress post anyway.
"""

from __future__ import annotations

from fastapi import APIRouter, HTTPException, Response

from app.services.article_media_storage import load_article_media
from app.services.to_thread import run_sync

router = APIRouter(prefix="/public/article-media", tags=["article-media-public"])


@router.get("/{image_id}")
async def get_article_media(image_id: str) -> Response:
    loaded = await run_sync(load_article_media, image_id)
    if loaded is None:
        raise HTTPException(status_code=404, detail="Not found")
    data, content_type = loaded
    return Response(
        content=data,
        media_type=content_type,
        headers={"cache-control": "public, max-age=31536000, immutable"},
    )
