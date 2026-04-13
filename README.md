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
| `FLASK_SECRET_KEY` | Optional; used for sessions. Set a long random string in production. |
| `GOOGLE_OAUTH_CLIENT_ID` | Optional; Google OAuth **Web client** ID for Search Console. |
| `GOOGLE_OAUTH_CLIENT_SECRET` | Optional; matching client secret. |
| `OAUTHLIB_INSECURE_TRANSPORT` | Optional. The app defaults to `1` so OAuth works over **http://** on localhost. For a **production** HTTPS deployment, set `OAUTHLIB_INSECURE_TRANSPORT=0` in `.env`. |

**Google Search Console:** In Google Cloud Console, enable the **Search Console API**, configure the **OAuth consent screen**, create **OAuth 2.0 (Web)** credentials, and add this **authorized redirect URI**:

`http://127.0.0.1:5000/oauth/google/callback`

(Use your real HTTPS URL in production.) Then use **Connect Google** on the home page and assign a **property** per project under **Tools → Google Search Console**.

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

- **Projects** — Multiple sites (grid on the home page); each has its own prompts, WordPress settings, and optional Search Console property.
- **Articles** — Title, **focus keyphrase**, **targeting keywords** (comma-separated, max 10); generate, edit, status (pending / draft / published), WordPress post/draft, scheduled posting.
- **Bulk upload** — Download sample Excel with columns: **Title**, **Focus Keyphrase**, **Targeting Keywords**; imports rows as **pending** (no status column).
- **Writing & image prompts** — Reusable templates per project; placeholders include `{article title}`, `{targeting keywords}`, `{focus keyphrase}`.
- **Context links** — Per project, map exact **text** → **URL**; on WordPress publish, matching phrases become markdown links in the posted HTML.
- **Google account** — OAuth with **refresh token** stored in `data/google_oauth.json` (keep private; listed in `.gitignore`). After a **live** publish, optional **URL Inspection** for the post URL against the selected Search Console property.

---

## Notes

- Targeting keywords are **comma-separated**; maximum **10** keywords.
- WordPress: configure site URL, username, and application password in **project settings** when you use posting.
- Restart the server after changing `.env`.
