# GitHub Actions deploy to VPS

Pushing to **`main`** runs `.github/workflows/deploy.yml`, which SSHs into the server, updates the repo to **`origin/main`**, installs Python deps, and restarts **`auto-articles`**.

## What the workflow preserves (no manual steps)

- **`.env`**: Before `git fetch` / `git checkout`, the workflow copies `/var/www/auto-articles/.env` to a temp file. After checkout, it **restores** that copy so server secrets are never replaced by anything in git (even if `.env` were ever tracked by mistake).
- **`data/`**: If `/var/www/auto-articles/data` exists, it is backed up the same way and restored after checkout (local DB/files stay on the VPS).

`.env` remains listed in **`.gitignore`**; do not commit real secrets.

## Prerequisites (one-time)

### 1. GitHub repository

- Code lives in a GitHub repo (e.g. **TheHypedge/Auto-Article-Generator**).
- Default deploy branch is **`main`** — rename or edit the workflow if you use another branch.

### 2. VPS layout (already in place for you)

- App directory: **`/var/www/auto-articles`**
- Clone is a **git** checkout of this repo (`origin` points at GitHub).
- **`.env`** lives only on the server; the workflow restores it after every deploy (see above).
- **systemd** unit **`auto-articles.service`** runs Gunicorn.

### 3. SSH access for GitHub Actions

1. On your laptop (or the VPS), create a **dedicated** key pair for deploys (do not reuse your personal key):
   ```bash
   ssh-keygen -t ed25519 -f ./gha_deploy_ed25519 -N "" -C "github-actions-deploy"
   ```
2. On the **VPS**, append the **public** key to the user that will run deploy (often **`root`** or a **`deploy`** user):
   ```bash
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   cat >> ~/.ssh/authorized_keys << 'EOF'
   <paste contents of gha_deploy_ed25519.pub>
   EOF
   chmod 600 ~/.ssh/authorized_keys
   ```
3. Confirm login works from your machine:
   ```bash
   ssh -i ./gha_deploy_ed25519 root@YOUR_VPS_IP
   ```

### 4. `git pull` on the server

The deploy user must be able to **`git pull`** without typing a password:

- **HTTPS:** configure a [Personal Access Token](https://github.com/settings/tokens) with `repo` scope, or use a fine-grained token for this repo, and on the server run `git config credential.helper store` once after a manual `git pull`, **or**
- **SSH:** add a **deploy key** (read-only) to the GitHub repo (**Settings → Deploy keys**) and use `git@github.com:ORG/REPO.git` as `origin` on the VPS.

### 5. `sudo` for systemd

The workflow runs `sudo -n true` before `deploy/deploy.sh`. The deploy user must be able to run **`sudo` without a password** for the commands in `deploy/deploy.sh` (at minimum **`systemctl restart`** and **`systemctl is-active`**). Example for user **`deploy`**:

```bash
echo 'deploy ALL=(ALL) NOPASSWD: /bin/systemctl restart auto-articles, /bin/systemctl is-active auto-articles, /bin/systemctl status auto-articles, /usr/bin/journalctl' | sudo tee /etc/sudoers.d/auto-articles-deploy
sudo chmod 440 /etc/sudoers.d/auto-articles-deploy
```

(`journalctl` is listed so failure diagnostics in `deploy/deploy.sh` work for a non-root deploy user. Restrict further if your security policy requires it.)

If you SSH as **`root`**, `sudo` in `deploy.sh` is usually fine as-is.

### 6. GitHub Actions secrets

In the repo: **Settings → Secrets and variables → Actions → New repository secret**:

| Secret        | Example / notes |
|---------------|------------------|
| `VPS_HOST`    | `82.29.162.233` or `riviso.cloud` |
| `VPS_USER`    | `root` or `deploy` |
| `VPS_SSH_KEY` | **Private** key (full PEM/ed25519 text from `gha_deploy_ed25519`, including `BEGIN`/`END` lines) |
| `VPS_PORT`    | Not used by default. If SSH is not on **22**, add `port: YOUR_PORT` under `with:` in `.github/workflows/deploy.yml`. |

### 7. First deploy after adding the workflow

- Merge/push the workflow and `deploy/deploy.sh` to **`main`** once (manual `git pull` on the VPS if needed so `deploy/deploy.sh` exists).
- Re-run failed jobs from the **Actions** tab if the first run was before those files existed.

## Manual deploy (same steps as CI)

```bash
cd /var/www/auto-articles
git fetch origin main
git checkout -B main origin/main
sed -i 's/\r$//' deploy/deploy.sh
bash deploy/deploy.sh
```

`git checkout -B main origin/main` resets local **`main`** to match **`origin/main`**. Shell scripts in the repo must use **LF** line endings (see `.gitattributes`); `sed` strips stray CR characters if a file was saved with CRLF.

## Troubleshooting

### `git@github.com: Permission denied (publickey)` on the VPS

GitHub Actions can SSH **into** your server, but **`git fetch` / `git pull` run on the VPS** and talk to GitHub separately. If `origin` uses **`git@github.com:...`**, the server must have its **own** GitHub credentials (different from the Actions deploy key).

Pick **one** of these:

#### A. Deploy key (recommended if `origin` stays as SSH)

1. On the **VPS**, as the same user that runs deploy (e.g. `root`):

   ```bash
   sudo -u root bash  # or your deploy user
   mkdir -p ~/.ssh && chmod 700 ~/.ssh
   ssh-keygen -t ed25519 -f ~/.ssh/github_auto_articles -N "" -C "vps-deploy-readonly"
   cat ~/.ssh/github_auto_articles.pub
   ```

2. In GitHub: **Repository → Settings → Deploy keys → Add deploy key**  
   - Paste the **public** key, enable **Allow read access** only (no write needed for `pull`).

3. On the VPS, use this key for `github.com`:

   ```bash
   printf '%s\n' \
     'Host github.com' \
     '  HostName github.com' \
     '  User git' \
     '  IdentityFile ~/.ssh/github_auto_articles' \
     '  IdentitiesOnly yes' >> ~/.ssh/config
   chmod 600 ~/.ssh/config
   ```

4. Test: `ssh -T git@github.com` (should say “Hi … You’ve successfully authenticated…”).

5. Re-run the **Deploy to VPS** workflow.

#### B. HTTPS + token (switch `origin` away from SSH)

1. Create a [Personal Access Token](https://github.com/settings/tokens) with **`Contents: Read`** (classic: `repo` scope) for this repository.

2. On the **VPS**:

   ```bash
   cd /var/www/auto-articles
   git remote set-url origin https://github.com/TheHypedge/Auto-Article-Generator.git
   git config credential.helper store
   git pull origin main
   ```

3. When prompted: **Username** = your GitHub username; **Password** = the **token** (not your GitHub password).

After either A or B, `git fetch` / `git pull` in the deploy script should succeed.

### `fatal: Not possible to fast-forward` / diverged branches

The VPS clone must not keep its own commits on `main` or dirty tracked files. The workflow uses **`git checkout -B main origin/main`** so the server matches GitHub.

### `deploy/deploy.sh: $'\r': command not found` / `set: pipefail: invalid option name`

The script was saved with **Windows (CRLF)** line endings. The repo enforces **LF** for `*.sh` via `.gitattributes`; redeploy after pulling. On the server you can run `sed -i 's/\r$//' deploy/deploy.sh` once, or `git checkout -B main origin/main` after the fix is pushed.

## Security notes

- Rotate the deploy SSH key if it is ever exposed.
- Restrict **`VPS_SSH_KEY`** to deploy-only; use a dedicated Linux user with minimal rights where possible.
- Keep **`.env`**, OAuth secrets, and API keys only on the server.
