# Pacman Multiplayer

[![Deploy to Render](https://render.com/images/deploy-to-render-button.svg)](https://render.com/deploy?repo=https://github.com/richthofen911/Pac-man_multiplayer)

Real-time Pacman for up to 5 players (1 Pacman vs 4 ghosts), plus a 3v3 team mode.
The server is authoritative; clients render either classic 2D or neon 3D with three.js.

## Run locally

```bash
npm install
npm start
```

Open <http://localhost:3000>. Other players on the same network can use
`http://<your-ip>:3000`. Set `PORT` to use a different port.

## Deploy to Render

The repo includes a [`render.yaml`](render.yaml) Blueprint that creates one Node
web service on the free plan:

| Setting | Value |
| --- | --- |
| Build command | `npm ci` |
| Start command | `npm start` |
| Health check | `/healthz` |
| Node version | pinned by [`.node-version`](.node-version) |

### Option A: Blueprint (recommended)

1. Push this repository to GitHub.
2. Open the [Render Dashboard](https://dashboard.render.com) and choose
   **New -> Blueprint**.
3. Connect the repo and select its `main` branch, then click **Apply**.
4. Render creates the service and deploys it at
   `https://<service-name>.onrender.com`. If that name is already taken, edit
   `name:` in `render.yaml` (or the service name in the dashboard) and re-sync.

Every push to `main` then redeploys automatically.

### Option B: Manual web service

Create a **New -> Web Service** from the repo with:

- Runtime: **Node**
- Build command: `npm ci`
- Start command: `npm start`
- Health check path: `/healthz`
- Instance count: **1**

Render injects `PORT` automatically; the server already binds to `0.0.0.0`.

### Notes

- **Keep it at one instance.** Lobbies, games, and scores are held in memory,
  and Socket.IO needs every player on the same server. Horizontal scaling would
  require sticky sessions plus a Redis adapter.
- **Free plan sleeps.** After ~15 minutes without traffic the instance spins
  down; the next visit takes up to a minute to wake and the previous lobby is
  gone. Upgrade the plan for an always-on server.
- No database or environment variables are required.
