# Run Beti Bachao on GitHub (Codespaces)

Use this to run the **real app** straight from GitHub, before you deploy it on a permanent server.

## Start it
1. Open **https://codespaces.new/vjitintech/Beti-Bachao** (or on the repo page: **Code → Codespaces → Create codespace on main**).
2. Wait 1–2 minutes. The terminal prints a box like:
   ```
   Beti Bachao is running.
   Open on any phone:  https://<your-codespace>-8080.app.github.dev
   [setup] No admin yet. Open https://…/#/setup?code=XXXXXXXX
   ```
   If you miss it, type `cat /workspaces/.beti-bachao-data/START_HERE.txt` in the terminal.
3. Open the **setup link** once to create the administrator (name, email, 12+ character password). Then log in and scan the two-step key into an authenticator app.
4. Share the **app link** with the women and volunteers in your test group.

If a phone shows "not found" or asks for a GitHub login, open the **PORTS** tab in the Codespace, right-click port **8080** → **Port Visibility → Public**.

## Important limits (Codespaces is for trying and testing, not for live emergencies)
- **It stops when idle.** GitHub stops a Codespace after about 30 minutes without activity (you can raise this to 4 hours in GitHub → Settings → Codespaces). While it's stopped the app is **offline** and an SOS can't reach anyone.
- To restart: open https://github.com/codespaces and click your codespace. The app restarts automatically, at the **same link**.
- The free allowance is limited monthly hours (see GitHub's Codespaces billing page).
- Data stays inside that Codespace. Deleting the Codespace deletes all accounts. Admins can **Download backup** first.

For real, 24×7 use, deploy it permanently: [DEPLOY.md](DEPLOY.md).
