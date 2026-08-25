# Problem Overflow

A public problem board. Help stays on the card.

Anyone can read. Sign in to post or vote. Copy a card for Buzz if you want a hallway thread; the last line of that paste is the live public room.

## Rooms

- Public
- Chiang Mai AI
- Video

## Run locally

Node 22.22.0 or newer. No packages to install.

```
node bin/serve.js
```

Local mode binds to your machine only. Set `PO_MODE=local` (the included start script does this).

## Live host

Set these names (values belong on the host, never in git):

- `NODE_ENV`
- `NODE_VERSION`
- `PO_MODE` (`public` on the live host)
- `PO_DATA_DIR`
- `PO_PUBLIC_ORIGIN`
- `PORT` (injected by the host)

Google sign-in is optional. When used, the host also needs:

- `GOOGLE_CLIENT_ID`
- `GOOGLE_CLIENT_SECRET`
- `GOOGLE_OAUTH_REDIRECT_URL`

## Checks

```
node bin/selfcheck.js
```
