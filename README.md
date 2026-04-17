# Auto Articles (Flask)

Web app for **projects** (brands/sites), **AI-generated articles** (title, focus keyphrase, targeting keywords), **WordPress posting**, **bulk Excel import**, **project-level context links** (auto-link phrases when posting), and optional **Google Search Console** (URL Inspection after live publishes).

---

## Quick start (comma-separated)

**Clone or open the project → create a virtual environment → install dependencies → copy/configure `.env` → run the app → open the app in your browser.**

In short: `venv`, `pip install -r requirements.txt`, `.env` with `OPENAI_API_KEY` (and optional `GOOGLE_OAUTH_*`), `python app.py`, then `http://127.0.0.1:5000`.

---

## Start the system (step by step)

1. **Go to the project folder** (the directory that contains `app.py`).
2. **Create and activate a virtual environment** (recommended).
3. **Install Python packages:** `pip install -r requirements.txt`
4. **Configure environment:** copy `.env` or create one next to `app.py` (see below). The app loads `.env` from that folder automatically.
5. **Run:** `python app.py` (or `flask run` if you configure `FLASK_APP=app.py`).
6. **Open:** [http://127.0.0.1:5000](http://127.0.0.1:5000)

---

## Environment (`.env`)

Place `.env` in the **same folder as `app.py`**.

| Variable | Purpose |
| -------- | ------- |
| `OPENAI_API_KEY` | Required for article generation (unless you use another supported provider configured in code). |
| `OPENAI_MODEL` | Optional; chat model for article/Yoast text (default in code: `gpt-4.1-mini`). |
| `OPENAI_IMAGE_MODEL` | Optional; OpenAI **Images** model for featured images (default: `gpt-image-1.5`). Set to `dall-e-3` if your account still uses it. |
| `OPENAI_IMAGE_QUALITY` | Optional; quality tier. For GPT Image models: `low` / `medium` / `high` / `auto`. For DALL·E 3: `standard` or `hd` (aliases like `high` map to `hd`). |
| `OPENAI_IMAGE_SIZE` | Optional; must match the model. **GPT Image** models: `1024x1024`, `1024x1536`, `1536x1024`, or `auto` (default when unset: `1536x1024` for wide heroes). **DALL·E 3**: e.g. `1792x1024` (default when unset for that model). |
| `OPENAI_IMAGE_RESPONSE_FORMAT` | Optional; `b64_json` (default) or `url` if the API returns URLs instead of base64. |
| `OPENAI_IMAGE_PROMPT_MODEL` | Optional; ChatGPT model used to **rewrite/optimize** the image prompt before generation (falls back to `OPENAI_MODEL`). Not used with Groq-only keys. |
| `FLASK_SECRET_KEY` | Optional; used for sessions. Set a long random string in production. |
| `GOOGLE_OAUTH_CLIENT_ID` | Optional; Google OAuth **Web client** ID for Search Console. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Optional; matching client secret. |
| `OAUTHLIB_INSECURE_TRANSPORT` | Optional. The app defaults to `1` so OAuth works over **http://** on localhost. For a **production** HTTPS deployment, set `OAUTHLIB_INSECURE_TRANSPORT=0` in `.env`. |
| `MONGODB_URI` | **Required** for persistence. Connection string, e.g. `mongodb://127.0.0.1:27017/` (local) or your Atlas URI. |
| `MONGODB_DB_NAME` | Optional database name (default: `auto_articles`). |
| `AUTO_IMPORT_JSON` | Optional. Set to **`1`** only for a **one-time** import from `data/projects.json` + `data/articles.json` when MongoDB is empty. **Default (unset or anything else):** the app never reads those JSON files on startup. |

**Google Search Console:** In Google Cloud Console, enable the **Search Console API**, configure the **OAuth consent screen**, create **OAuth 2.0 (Web)** credentials, and add this **authorized redirect URI**:

`http://127.0.0.1:5000/oauth/google/callback`

(Use your real HTTPS URL in production.) Then use **Connect Google** on the home page and assign a **property** per project under **Tools → Google Search Console**.

---

## Database (MongoDB)

Projects and articles are stored in **MongoDB** only at runtime (the app does not read or write `data/projects.json` / `data/articles.json` from web routes).

- **Setup:** run MongoDB locally or use a hosted cluster (e.g. Atlas). Set `MONGODB_URI` in `.env` and optionally `MONGODB_DB_NAME` (default `auto_articles`).
- **Dependencies:** `pip install -r requirements.txt` (includes `pymongo`).
- **Migration / restore:** Use `python scripts/import_json_to_db.py` (add `--force` to replace existing documents). **Optional:** set `AUTO_IMPORT_JSON=1` once to auto-import from JSON on startup when MongoDB has no projects.

---

## Setup examples

### Windows (PowerShell)

```powershell
cd "path\to\Auto Articles"
python -m venv .venv
.\.venv\Scripts\Activate.ps1
pip install -r requirements.txt
python app.py
```

### macOS / Linux

```bash
cd "/path/to/Auto Articles"
python3 -m venv .venv
source .venv/bin/activate
pip install -r requirements.txt
python app.py
```

---

## Main features

- **Projects** — Multiple sites (grid on the home page); each has its own prompts, WordPress settings, and optional Search Console property. Data lives in **MongoDB** (`MONGODB_URI`).
- **Articles** — Title, **focus keyphrase**, **targeting keywords** (comma-separated, max 10); generate, edit, status (pending / draft / published), WordPress post/draft, scheduled posting.
- **Bulk upload** — Download sample Excel with columns: **Title**, **Focus Keyphrase**, **Targeting Keywords**; imports rows as **pending** (no status column).
- **Writing & image prompts** — Reusable templates per project; placeholders include `{article title}`, `{targeting keywords}`, `{focus keyphrase}`. Featured images use the OpenAI Images API (model configurable via env); each project can set **style** (semi-realistic / photorealistic / illustration) and toggle **prompt optimization** with ChatGPT before generating the image.
- **Context links** — Per project, map exact **text** → **URL**; on WordPress publish, matching phrases become markdown links in the posted HTML.
- **Google account** — OAuth with **refresh token** stored in `data/google_oauth.json` (keep private; listed in `.gitignore`). After a **live** publish, optional **URL Inspection** for the post URL against the selected Search Console property.

---

## Notes

- Targeting keywords are **comma-separated**; maximum **10** keywords.
- WordPress: configure site URL, username, and application password in **project settings** when you use posting.
- Restart the server after changing `.env`.
