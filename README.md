# FLO Print Desk

Print PDFs and photos on the office printer from any phone or laptop, through one private link.

```
Browser (React)  ->  Vercel (API + web)  ->  Neon Postgres (queue + files)  <-  Windows Print Agent  ->  Epson L6270
```

Vercel cannot talk to a printer in your office, so a small **Print Agent** runs on the Windows PC that the printer is connected to.
It only makes *outgoing* HTTPS calls to your portal (no ports to open, no router changes).

* Staff sign in, drop PDF/JPG files, choose copies, colour/B&W, portrait/landscape, pages, and print.
* Jobs wait in a queue and print one by one (first come, first served). Users can cancel, see status, and "print again".
* Admins manage printers, printer PCs, users and limits from the **Manage** tab.
* Only the Epson L6270 is added by default. Add more printers later from **Manage > Printers** (no code change).

## 1. Deploy the portal on Vercel (about 10 minutes)

1. Put this folder on GitHub (a private repository is best).
2. Create a free Postgres database at <https://neon.tech> (or add *Neon* from the Vercel Marketplace). Copy the connection string.
3. In Vercel: **Add New > Project**, import the GitHub repository. Framework: *Vite* (detected automatically).
4. Before deploying, open **Settings > Environment Variables** and add:

   | Name | Value |
   |---|---|
   | `DATABASE_URL` | the Neon connection string |
   | `SESSION_SECRET` | a long random text, 32+ characters |
   | `ADMIN_USERNAME` | for example `admin` |
   | `ADMIN_PASSWORD` | a strong password (creates the first admin account) |

5. Deploy. Open the link, sign in with the admin account. Tables are created automatically on first use.
6. Share the link only with people who should print. Everyone needs their own account (Manage > Users).

> Change `ADMIN_PASSWORD` later from **Manage > Users** (the environment variable is used only when no users exist).

## 2. Set up the printer PC (Windows 10/11)

1. Install the Epson L6270 driver and make sure a normal print from Word/Notepad works.
2. Install Python 3.10+ from python.org (tick "Add Python to PATH").
3. Copy the `print-agent` folder to the PC (for example `C:\FLO\print-agent`).
4. In the portal open **Manage > Printer PCs**, create a connection key (name it e.g. "Office PC") and copy it.
5. Double-click `setup.bat`. Enter your portal link, paste the key, choose the Epson printer from the list.
6. If the setup tells you the printer name differs, open **Manage > Printers** and set *Windows printer name* to the exact name shown.
7. Double-click `test-page.bat` to print a test page.
8. Double-click `start.bat` and keep that window open. To start automatically after Windows sign-in, run `start-with-windows.bat` once.
9. In the portal the printer should now show **Ready** (green dot). Print a real file.

Keep the PC switched on and signed in whenever you want to print. If it is off, jobs simply wait and print when it is back.

## Everyday notes

* **Printer shows "unavailable"**: the printer is paused, out of paper/ink, has a message on its screen, or is switched off. Press OK on the printer's screen (for example after refilling ink the L6270 asks you to confirm) and the queue continues.
* **"Needs review"**: the system cannot be sure whether paper came out (for example the PC lost power mid-print). Look at the printer, then an admin clicks *It printed* or *It did not print*. This is on purpose, so nothing is ever printed twice by accident.
* Uploaded files are deleted automatically after 24 hours (failed jobs after 72 hours). Change this in **Manage > Settings**.
* Supported: **PDF, JPG/JPEG**, A4 paper, up to 20 MB per file (adjustable up to 25 MB).

## Run locally (optional, for developers)

```bash
npm install
npm run dev:api     # API on :3001 using a local SQLite file (login: admin / admin12345)
npm run dev         # web UI on :5173
npm test            # backend tests (no database server needed)
```
Agent tests: `cd print-agent && python -m unittest discover -s tests -t .` (needs Node 22 + `pip install requests Pillow`).

## Adding another printer later

1. Install it on the printer PC (or another PC running the agent).
2. Run `setup.bat` again and tick both printers, or edit nothing and just run `python main.py printers` to see exact names.
3. **Manage > Printers > Add a printer**: give a display name and the exact Windows printer name.

## Security summary

* Passwords are hashed (scrypt); sessions are signed, HttpOnly, Secure cookies; sign-in is rate limited.
* Every state-changing request needs a custom header and same-origin check (CSRF protection).
* Printer PCs use a separate secret key (stored hashed on the server, encrypted with Windows DPAPI on the PC). Disable or rotate it any time.
* Files are stored in the database only until the retention time, are never publicly reachable, and every download is checked by SHA-256.

## Project layout

```
api/[...path].js   Vercel serverless entry
server/            backend (auth, queue, admin, agent protocol), SQL schema
shared/            code shared by browser and server (page-range parsing)
src/               React app (animated FLO intro, Print, Queue, Manage)
print-agent/       Windows print agent (Python)
tests/             backend tests + browser end-to-end test
```
