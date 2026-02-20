# UPGS Perf

Performance and insight scan tool using Google Lighthouse. Stores results in SQLite and provides user registration and login.

Scores are computed from the **median of 3 Lighthouse runs** (same methodology as PageSpeed Insights) to reduce variance. The app runs in Docker with **2 GB shared memory** for Chromium to keep Lighthouse stable and performant.

## Requirements

- **Node.js 22+** (Lighthouse requires Node 22 or later)
- **Chrome or Chromium** – Lighthouse runs audits in a real browser; the app launches headless Chrome/Chromium. Install one of these before running scans.

## Node version (22+)

The project and Lighthouse 13 require **Node.js 22 or later**. If you see `EBADENGINE` or “Unsupported engine” when running `npm install`, switch to Node 22:

**Check your version**
```bash
node -v
```

**Option 1: Debian / Ubuntu (NodeSource)**
```bash
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt-get install -y nodejs
node -v
```

**Option 2: nvm (Node Version Manager)**  
Install nvm first (one-time), then Node 22:
```bash
curl -o- https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.1/install.sh | bash
# Restart your terminal or: source ~/.bashrc  (or ~/.zshrc)
nvm install 22
nvm use 22
```

**Option 3: fnm**  
Install fnm first (one-time), then Node 22:
```bash
curl -fsSL https://fnm.vercel.app/install | bash
# Restart your terminal or: source ~/.bashrc  (or ~/.zshrc)
fnm install 22
fnm use 22
```

**Option 4: Official installer**
- Download the Node 22 LTS installer for your OS from [nodejs.org](https://nodejs.org/).

After installing, run `node -v` to confirm you’re on v22.x, then run `npm install` again.

## Installing Chromium and dependencies

Lighthouse needs a Chrome or Chromium binary. Install for your OS:

**Debian / Ubuntu**
```bash
sudo apt-get update
sudo apt-get install -y chromium-browser
# Binary is usually at /usr/bin/chromium-browser or /usr/bin/chromium
```

**Fedora / RHEL**
```bash
sudo dnf install chromium
# Or: sudo yum install chromium
```

**macOS**
```bash
# Install Chromium via Homebrew:
brew install chromium
# Or use Google Chrome (install from https://www.google.com/chrome/).
# Chrome is typically at /Applications/Google Chrome.app/Contents/MacOS/Google Chrome
```

**Windows**
- Install [Google Chrome](https://www.google.com/chrome/) or [Chromium](https://www.chromium.org/getting-involved/download-chromium/). The app will look for Chrome in common install locations.

**Custom install path**
If the binary is not on your PATH or has a non-standard path, set:
```bash
export CHROME_PATH=/path/to/chromium
# or add to .env: CHROME_PATH=/path/to/chromium
```

**Docker**
The included Dockerfile installs Chromium and sets `CHROME_PATH`; no extra steps needed when using Docker.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env: set SESSION_SECRET (see below) and optionally DB_PATH, PORT, CHROME_PATH
```

### Generating a session secret

`SESSION_SECRET` is used to sign session cookies. Use a long, random value and keep it private.

**Using OpenSSL (Linux, macOS, WSL):**
```bash
openssl rand -hex 32
```
Copy the output into `.env` as `SESSION_SECRET=...`.

**Using Node.js:**
```bash
node -e "console.log(require('crypto').randomBytes(32).toString('hex'))"
```
Copy the output into `.env` as `SESSION_SECRET=...`.

Use a different secret per environment (e.g. dev vs production) and do not commit `.env` or the secret to version control.

## Run

```bash
npm start
# or with file watching:
npm run dev
```

Open http://localhost:3000 (or your `PORT`). The home page is a landing page when not logged in; register an account, then run a scan from the dashboard.

## Running with Docker

The app runs in a container with Node 22 and Chromium. The Compose file sets **`shm_size: 2g`** so Chromium has enough shared memory for Lighthouse (avoids slowdowns or instability in the container). You need **Docker** and **Docker Compose** installed.

Host ports are **non-default** (app: **3001**, Caddy: **8080** / **8443**) so they do not conflict with nginx (80/443) or MySQL (3306) on the same server.

### Quick start (Docker Compose)

1. **Generate a session secret** (required so the app can sign cookies):

   ```bash
   export SESSION_SECRET=$(openssl rand -hex 32)
   ```

2. **Start the app:**

   ```bash
   docker compose up -d
   ```

3. **Open** [http://localhost:3001](http://localhost:3001) in your browser.

To stop: `docker compose down`.

### After deploying (rebuild and next steps)

After changing the app or Compose config (e.g. `shm_size`, median runs), rebuild and restart:

```bash
docker compose build app && docker compose up -d app
```

Then run a **desktop** scan on the same URL you use in PageSpeed Insights and compare scores and metrics (LCP, TBT, FCP). If a large gap remains, consider running the app in a region close to the site or its CDN.

### Using a .env file

If you prefer to keep the session secret in a file:

1. Copy the example file: `cp .env.example .env`
2. Edit `.env` and set `SESSION_SECRET` (e.g. paste the output of `openssl rand -hex 32`)
3. Run: `docker compose --env-file .env up -d`

### Docker without Compose

**1. Build the image** (required once; run from the project directory):

```bash
cd /path/to/upgsperformance
docker build -t upgs-perf .
```

**2. Prepare the data directory** (if using a bind mount). The container runs as user `node` (UID 1000) and must be able to write to `/app/data`. Use format `host_path:/app/data`:

```bash
mkdir -p /path/on/host   # e.g. /home/user/docker/app
sudo chown 1000:1000 /path/on/host
```

(To check the container user: `docker run --rm upgs-perf id`.)

**3. Run the container** (host port 3001 to avoid conflict with nginx/MySQL):

```bash
docker run -d --restart unless-stopped -p 3001:3000 \
  -e SESSION_SECRET=$(openssl rand -hex 32) \
  -v /path/on/host:/app/data \
  --name upgs-perf \
  upgs-perf
```

Use the same session secret each time you recreate the container if you want existing sessions to stay valid.

### What gets stored

- Database, sessions, screenshots, and filmstrips are stored in the **`upgs-data`** volume (Compose) or in the directory you mount at **`/app/data`** (bind mount). They persist when you stop or recreate the container.
- **Bind mount:** if you use `-v /path/on/host:/app/data`, create the host directory first and make it writable by the container user: `sudo chown 1000:1000 /path/on/host`. The app runs as user `node` (UID 1000). To confirm: `docker run --rm upgs-perf id`.

### Docker with HTTPS (SSL)

The app is served at **https://perf.upgservicios.com**. A Caddy reverse proxy in front of the app terminates TLS and proxies to the app over HTTP inside the network.

1. **Create a directory for certificates** and add your TLS cert and key:

   ```bash
   mkdir -p certs
   ```

   **Self-signed cert (e.g. for dev or internal use):**

   ```bash
   openssl req -x509 -nodes -days 365 -newkey rsa:2048 \
     -keyout certs/key.pem -out certs/cert.pem \
     -subj "/CN=perf.upgservicios.com"
   ```

   For production, use certs from your CA or Let’s Encrypt (e.g. certbot) for `perf.upgservicios.com`; put the PEM cert and key in `certs/cert.pem` and `certs/key.pem`.

2. **Start the stack with the SSL profile:**

   ```bash
   export SESSION_SECRET=$(openssl rand -hex 32)
   docker compose --profile ssl up -d
   ```

3. **Open** [https://perf.upgservicios.com](https://perf.upgservicios.com). Accept the browser warning if using a self-signed cert.

   Caddy listens on host **8080** (HTTP) and **8443** (HTTPS) so it does not conflict with nginx. Point nginx at `https://127.0.0.1:8443` (or at `http://127.0.0.1:3001` if nginx terminates SSL). The app is also reachable on port 3001 for plain HTTP. Leave `COOKIE_SECURE` unset so the secure cookie is used over HTTPS.

### HTTP only (no HTTPS)

If you access the app over HTTP (e.g. `http://yourserver:3001`), set `COOKIE_SECURE=0` so session cookies work. In `docker-compose.yml` you can add under `environment`: `- COOKIE_SECURE=0`, or pass it when running `docker run`.

### Reverse proxy with Apache (e.g. perf.upgservicios.com)

If the app runs in Docker on a server that already has **Apache** (e.g. Ubuntu), you can serve it at **https://perf.upgservicios.com** with Apache as reverse proxy.

1. **DNS:** In your DNS (e.g. Cloudflare), add an **A** record: name `perf`, value = IP of the server.

2. **Enable proxy modules:**
   ```bash
   sudo a2enmod proxy proxy_http headers ssl
   ```

3. **Create the site** (e.g. `/etc/apache2/sites-available/perf.upgservicios.com.conf`):
   - A `<VirtualHost *:80>` with `ServerName perf.upgservicios.com` and `ProxyPass / http://127.0.0.1:3001/`, `ProxyPassReverse / http://127.0.0.1:3001/`, `ProxyPreserveHost On`.
   - Enable it: `sudo a2ensite perf.upgservicios.com.conf`, then get the certificate (step 4).

4. **SSL with Let’s Encrypt:**
   ```bash
   sudo certbot --apache -d perf.upgservicios.com
   ```
   Certbot will create or update the HTTPS vhost. Then edit the generated SSL vhost (e.g. `perf.upgservicios.com-le-ssl.conf`) so it uses the same `ProxyPass` / `ProxyPassReverse` to `http://127.0.0.1:3001/` and add `RequestHeader set X-Forwarded-Proto "https"`. Reload Apache: `sudo systemctl reload apache2`.

5. Ensure the Docker app is running and listening on port 3001 on the host (e.g. `docker run ... -p 3001:3000 ...`).

### Docker: troubleshooting

- **`SQLITE_CANTOPEN: unable to open database file`** — The app cannot write to `/app/data`. Check: (1) Volume format is `host_path:/app/data` (two paths). (2) The host directory exists and is writable by the container user: `sudo chown 1000:1000 /path/on/host` (confirm UID with `docker run --rm upgs-perf id`). Then `docker restart upgs-perf`.
- **`Unable to find image 'upgs-perf:latest'`** — Build the image first from the project directory: `docker build -t upgs-perf .`.

### Landing page screenshots

The landing page shows three screenshot slots. To use your own captures, add these files under `public/images/`:

- `screenshot-dashboard.png` — dashboard with new scan form and recent scans
- `screenshot-report.png` — report page with scores and recommendations
- `screenshot-scans.png` — scans list with search

Recommended size: roughly 1200×800 px (or similar aspect ratio). If the files are missing, the layout still works; the image areas will be empty.

## Running in the background (always on)

To keep the app running without a terminal and restart it after reboots, use one of these.

### Option 1: PM2 (recommended)

[PM2](https://pm2.keymetrics.io/) keeps the process running and restarts it if it crashes.

**Install PM2 locally (no sudo):**

```bash
npm install
npm run pm2:start
```

Then use:

- `npm run pm2:status` – list apps
- `npm run pm2:logs` – view logs
- `npm run pm2:restart` – restart after code changes
- `npm run pm2:stop` – stop the app

The app keeps running in the background until you stop it or close the server. To have it start on system boot (optional), install PM2 globally with sudo and enable startup:

```bash
sudo npm install -g pm2
pm2 save
pm2 startup
```

(Run the command that `pm2 startup` prints.) If you prefer not to use sudo, use **Option 2: systemd** or run `npm run pm2:start` again after each reboot.

### Option 2: systemd (Linux)

Create a service file (e.g. `/etc/systemd/system/upgs-perf.service`), then enable and start it:

```ini
[Unit]
Description=UPGS Perf
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/path/to/upgsperformance
EnvironmentFile=/path/to/upgsperformance/.env
ExecStart=/usr/bin/node src/index.js
Restart=on-failure
RestartSec=5

[Install]
WantedBy=multi-user.target
```

```bash
sudo systemctl daemon-reload
sudo systemctl enable upgs-perf
sudo systemctl start upgs-perf
sudo systemctl status upgs-perf
```

Replace `YOUR_USER` and paths with your values. Use `EnvironmentFile=` only if your `.env` has no spaces in values; otherwise set `Environment=PORT=3000` etc. manually.

### Option 3: Docker with restart

Run the container with a restart policy so it stays up and restarts after a reboot. Create the data directory and set permissions first (see [Docker without Compose](#docker-without-compose)):

```bash
mkdir -p /path/to/data && sudo chown 1000:1000 /path/to/data
docker run -d --restart unless-stopped -p 3001:3000 -e SESSION_SECRET=your-secret -v /path/to/data:/app/data --name upgs-perf upgs-perf
```

`--restart unless-stopped` restarts the container on failure and after host reboot.

## Remote / Docker

The app runs remotely; no local-only assumptions. For Docker, use the included Dockerfile (installs Chromium). Build the image, then run with a volume so the DB and files persist (see [Docker without Compose](#docker-without-compose) for data directory permissions):

```bash
docker build -t upgs-perf .
mkdir -p /path/to/data && sudo chown 1000:1000 /path/to/data
docker run -d -p 3001:3000 -e SESSION_SECRET=your-secret -v /path/to/data:/app/data --name upgs-perf upgs-perf
```

## Environment

| Variable | Description |
|----------|-------------|
| `PORT` | Server port (default 3000) |
| `DB_PATH` | SQLite file path (default `./data/upgs.db`) |
| `SESSION_SECRET` | Secret for session signing (generate with `openssl rand -hex 32`; see Setup) |
| `SESSION_STORE` | Set to `sqlite` for persistent sessions in `data/sessions.db` (default: in-memory; sessions are lost on restart with default) |
| `CHROME_PATH` | Path to Chrome/Chromium binary (e.g. in Docker) |
