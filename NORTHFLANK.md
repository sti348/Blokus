# BlockTurf multiplayer deployment on Northflank

This repository contains a complete Node.js game server: `server.js` serves the website, room API and Server-Sent Events (SSE) streams on one port. It has no third-party runtime dependencies. You do not need Vercel or a separate backend.

## Deploy from GitHub

1. Log in at https://app.northflank.com/ and choose the free **Sandbox** plan (if available on your account).
2. Link GitHub and grant Northflank access to `sti348/Blokus`.
3. Create a **Project** (e.g. `blockturf`) in a region close to your players.
4. In that project choose **Create Service → Combined**.
5. Name the service `blockturf-online`.
6. Under **Repository**, choose `sti348/Blokus` and the branch `deploy/northflank-20261102` (or your default branch after this PR is merged).
7. Set build option to **Dockerfile**, build context to repository root, Dockerfile path `Dockerfile`.
8. Under **Networking**, ensure port **8080**, protocol **HTTP**, access **Public** (the Dockerfile's `EXPOSE 8080` may auto-configure it). No custom domain required.
9. Under **Resources**, leave the Sandbox-eligible plan selected and set exactly **one instance**. Enable both **CI** and **CD** to redeploy future GitHub changes automatically.
10. Under **Advanced → Health checks**, if you set an HTTP health check, use path `/api/info` on port 8080.
11. Click **Create Service**, then open the HTTPS `*.code.run` URL assigned to the public port.

No secrets or environment variables are required. The Dockerfile sets `PORT=8080`, `HOST=0.0.0.0` and `NODE_ENV=production`.

## Verify actual multiplayer

- Open `https://YOUR-SERVICE.code.run/api/info`. It should return JSON that includes `"blokus":1`.
- Open the main URL in two separate browsers or devices.
- In browser A, select online multiplayer and create a room.
- In browser B, join using the five-character room code.
- Start the game and make a legal move in A. Confirm that B receives the updated board without refreshing.
- Confirm move previews, computer turns, reconnecting, and joining the same room after a transient network interruption.

## Important constraints

- The server keeps rooms in a process-local `Map`. **One replica only**; multiple replicas cannot share rooms and will cause random-looking join failures.
- A service restart or GitHub-triggered redeployment clears existing rooms and active games. Production-quality persistence/recovery is a separate feature.
- Room entries with no connected clients are cleaned up after 30 minutes.
- The Docker HEALTHCHECK probes the existing `/api/info` endpoint locally.
- Leave `LLM_PROXY` unset (default disabled) until the LLM proxy has appropriate destination restrictions and abuse protection.
- Northflank Sandbox is intended for hobby and evaluation, not guaranteed production availability.
- When this pull request is merged and the deployed service switches to your default branch, disable any unneeded old deployment (e.g. Vercel/Render) to avoid confusing endpoints.

Useful docs:
- https://northflank.com/docs/v1/application/getting-started/build-and-deploy-your-code
- https://northflank.com/docs/v1/application/network/configure-ports
- https://northflank.com/pricing
