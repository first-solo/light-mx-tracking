# light-mx-tracking

Small self-hosted logbook for the things that happen at the airplane between inspections:

- **Oil** — date, tach, initial dipstick reading and quarts added per engine, who added it. Shows last reading and hours per quart for each engine.
- **AD 79-12-08** — the fuel selector water-contamination check (Piper SL 851 Part B) required before the first flight of each day and after each refueling once the airplane has been exposed to below-freezing temperatures. Shows whether today's first-flight check is logged.
- **VOR checks** — 14 CFR 91.171 record: date, place, method, bearing error per receiver, signature. Flags out-of-tolerance checks and shows the date the 30-day window runs out.

Each aircraft has its own PIN. Entering a PIN opens that aircraft's logs; nobody picks the tail number. Each aircraft is defined with an engine count (1 or 2) and which of the AD and VOR logs apply. Oil is always on.

Entries are never hard-deleted. "Remove" hides an entry from the page; the CSV export still includes it with the time it was removed.

> Confirm the AD 79-12-08 requirements against the current AD text and your aircraft's records. This app records that the check was done; it doesn't decide applicability.

## Run it

Requires Docker. Nothing is installed on the host.

```sh
cp .env.example .env
# edit .env: set SESSION_SECRET and INIT_PIN (and the INIT_* aircraft details)
docker compose up -d --build
```

The app listens on `127.0.0.1:3000`. Put it behind whatever already terminates HTTPS on the server (Caddy, nginx, Cloudflare Tunnel). Example Caddyfile:

```
logs.example.com {
  reverse_proxy 127.0.0.1:3000
}
```

The first aircraft is created from the `INIT_*` values only when the database is empty. After the first start you can delete those lines from `.env`.

Data lives in `./data/logs.db` (SQLite). Back up that folder. The container creates `./data` and sets its ownership on start, so there's nothing to prepare on the host.

## Manage aircraft and PINs

```sh
docker compose exec -u node app npm run admin -- list
docker compose exec -u node app npm run admin -- add N7375Y 4821 --model PA-30 --engines 2 --ad-79-12-08
docker compose exec -u node app npm run admin -- add N12345 5150 --model C172 --engines 1 --no-vor
docker compose exec -u node app npm run admin -- set N7375Y --vor off
docker compose exec -u node app npm run admin -- set N7375Y --ad-79-12-08 on
docker compose exec -u node app npm run admin -- set-pin N7375Y 9930
docker compose exec -u node app npm run admin -- remove N12345
```

- New aircraft default to 1 engine, VOR log on, AD 79-12-08 log off.
- PINs are 4–8 digits and must be unique across aircraft.
- Changing a PIN signs out every device using the old one.
- Turning a log off hides it; existing entries are kept and come back if you turn it on again.
- An aircraft with log entries can't be removed. A twin with right-engine oil data can't be switched to a single.

## Security notes

- PINs are stored as salted scrypt hashes.
- A device stays unlocked for `SESSION_DAYS` (default 30) via a signed, HttpOnly cookie. "Lock" in the header signs that device out.
- After 8 wrong PINs from one IP in 15 minutes, logins from that IP are refused until the window passes. Keep `TRUST_PROXY=1` behind a reverse proxy so this sees real client addresses.
- A shared PIN is a convenience lock, not an identity. "Added by" and "Signature" are typed names.

## Development

```sh
docker run --rm -it -v "$PWD":/app -w /app -p 3000:3000 \
  -e SESSION_SECRET=dev-secret-dev-secret-dev-secret-dev -e INIT_TAIL=N7375Y \
  -e INIT_ENGINES=2 -e INIT_AD_79_12_08=true -e INIT_PIN=1234 \
  node:22-bookworm-slim sh -c "npm install && node src/server.js"
```

Schema changes go in `src/db.js` as a new entry at the end of `migrations`; existing entries never change.
