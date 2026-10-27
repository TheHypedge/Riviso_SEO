"""What the user sees in the Share-to-LinkedIn preview is exactly what LinkedIn renders:
same characters, same line breaks and blank lines, hashtags still live, nothing appended.

LinkedIn's Posts API parses `commentary` as "little text format": a backslash makes the
next reserved character literal, and an unescaped reserved character starts a template.
`_render_like_linkedin` applies those rules, so round-tripping proves fidelity without
publishing anything to a real account."""

import asyncio
import json
import os
import re

os.environ.setdefault("SECRET_KEY", "test-secret-key-not-used-in-production-0123456789")

import httpx

from app.services import linkedin_client

RESERVED = set("\\|{}@[]()<>*_~")

CAPTION = (
    "Most couples don't know this 👇\n"
    "\n"
    "A mutual divorce in India takes 6–18 months (not 6 weeks).\n"
    "\n"
    "• Step 1: file the joint petition [Section 13B]\n"
    "• Step 2: wait the cooling-off period — it *can* be waived\n"
    "• Step 3: second motion & final decree\n"
    "\n"
    "Ask @your_lawyer about {timelines} <before> you sign ~ really.\n"
    "Read more: https://legalpedia.in/mutual_divorce-timeline/?ref=li_share\n"
    "\n"
    "#MutualDivorce #FamilyLaw #India"
)


def _render_like_linkedin(commentary: str) -> str:
    out, i = [], 0
    while i < len(commentary):
        ch = commentary[i]
        if ch == "\\" and i + 1 < len(commentary) and commentary[i + 1] in RESERVED:
            out.append(commentary[i + 1])
            i += 2
            continue
        assert ch not in RESERVED, f"unescaped reserved char {ch!r} at {i} would be parsed as a template"
        out.append(ch)
        i += 1
    return "".join(out)


def _post(commentary: str, **kw) -> dict:
    sent: list[dict] = []

    def handler(req: httpx.Request) -> httpx.Response:
        sent.append(json.loads(req.content))
        return httpx.Response(201, headers={"x-restli-id": "urn:li:share:1"})

    real = httpx.AsyncClient

    def fake(*a, **k):
        k["transport"] = httpx.MockTransport(handler)
        return real(*a, **k)

    linkedin_client.httpx.AsyncClient = fake
    try:
        asyncio.run(linkedin_client.create_post(access_token="t", author_urn="urn:li:person:x", commentary=commentary, **kw))
    finally:
        linkedin_client.httpx.AsyncClient = real
    return sent[0]


def test_rendered_post_is_identical_to_the_preview():
    body = _post(CAPTION, image_urn="urn:li:image:1", article_url="https://legalpedia.in/mutual_divorce-timeline/")
    assert _render_like_linkedin(body["commentary"]) == CAPTION


def test_line_breaks_and_blank_lines_survive_exactly():
    rendered = _render_like_linkedin(_post(CAPTION)["commentary"])
    assert rendered.split("\n") == CAPTION.split("\n")
    assert rendered.count("\n\n") == CAPTION.count("\n\n")


def test_hashtags_stay_live_and_nothing_is_appended():
    commentary = _post("Short tip.\n\n#SEO #Content", image_urn="urn:li:image:1", article_url="https://x.com/a")["commentary"]
    assert commentary == "Short tip.\n\n#SEO #Content"
    assert re.findall(r"(?<!\\)#\w+", commentary) == ["#SEO", "#Content"]
