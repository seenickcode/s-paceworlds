# Voice Lobby

Browser-based voice chat room. Visit the site, type a name, allow mic access, talk to everyone else who's there.

## Stack

- Node.js + Express + Socket.IO (signaling and presence)
- WebRTC mesh (peer-to-peer audio, no media server)
- Vanilla HTML/JS — no build step

## Setup

```
npm install
```

## Run

```
node server.js
```

Server listens on `http://localhost:3000`.

## Test

**One laptop, two browsers:** Open Chrome and Safari (or one regular + one private window) at `http://localhost:3000`. Use headphones to avoid feedback.

**Two laptops:** Browsers require HTTPS for mic access, so expose localhost with a tunnel:

```
brew install cloudflared            # once
cloudflared tunnel --url http://localhost:3000
```

Share the printed `https://*.trycloudflare.com` URL with the other laptop.

## How it works

1. Client connects via Socket.IO, sends name
2. Server tells the new client about existing peers, tells existing peers about the new one
3. New client creates a WebRTC offer to each existing peer; server only relays the handshake
4. Audio flows directly between browsers
5. On disconnect, server broadcasts `user-left` and tiles/audio are removed

Mesh works well up to ~6–8 users. Beyond that, swap to an SFU (e.g. LiveKit).
