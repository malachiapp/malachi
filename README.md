# Malachi

**A private messenger for Android – peer-to-peer over Tor. No server, no account, no phone number.**

Website & download: <https://malachiapp.de> · Onion: `p75bcu4mna6lik35occlsoeoyke46zyikfuq2ugu3wdvu44e5c4wanyd.onion`
Status: 1.0 (Android 7.0+) · License: [AGPL-3.0](LICENSE) · Security: [SECURITY.md](SECURITY.md)

> Most of the internal documentation in this repository is written in German. The code comments are mostly German, too.

---

## What it is

- **No server in the data path.** Every device runs its own Tor onion service; only paired contacts know its address. There is no Malachi server that stores or relays messages or collects metadata – no relay, no TURN, no push service.
- **Tor first, then direct.** Connections start over Tor and – depending on the connection mode – are upgraded to a direct WebRTC connection.
- **Offline delivery without a server.** If a contact is unreachable, messages wait encrypted in a local queue and are delivered once both devices are online.
- **Contacts via QR code** (or optionally by matching phone numbers over Tor; the numbers are never stored or transmitted).
- Chats, groups, voice messages, pictures, files, voice/video calls, group calls, Secret Chat, disappearing messages, 18 languages.
- **Seal mode:** end-to-end encrypt text, pictures and voice messages to send them through other messengers (WhatsApp etc.).

### Connection modes
| Mode | Behaviour | Who can see your IP address |
|---|---|---|
| Fast (default) | Tor, then direct; two public STUN servers help | the two STUN servers (no content, no contacts) and your contact during a direct connection |
| Private | like Fast, without STUN | only your contact, during a direct connection |
| Maximum anonymity | Tor only, calls voice-only (Opus over Tor) | nobody, not even your contact |

## Cryptography

- **Double Ratchet** following the Signal specification, extended with a post-quantum step: **ML-KEM-768** shared secrets are mixed into the root KDF alongside the **X25519** output (PQXDH-style). See [`DoubleRatchet.js`](DoubleRatchet.js), [`RatchetSession.js`](RatchetSession.js), [`RATCHET_DESIGN.md`](RATCHET_DESIGN.md).
- KDF: HKDF-SHA256 (root), HMAC-SHA256 (chains). AEAD: XChaCha20-Poly1305 with the canonical header as associated data.
- Only established libraries, no home-made primitives: `@noble/curves`, `@noble/ciphers`, `@noble/hashes` (JavaScript) and Bouncy Castle (ML-KEM-768 and Argon2id in the Android native modules).
- Per-contact safety code against MITM. Groups are encrypted pairwise; group calls are a mesh with DTLS-SRTP.
- On the device: everything is stored locally and encrypted (per-file keys for media), Secret Chat stays in RAM only, screenshot protection (FLAG_SECURE), clipboard cleared after 60 s, app PIN, emergency (duress) PIN.
- Updates (website version) are fetched over Tor; the manifest is signed with **Ed25519** and the signing key never touches the server.

## Repository layout

| Path | Content |
|---|---|
| `/` (root), `android/` | the React Native app (React Native 0.86, Kotlin native modules) |
| `locales/` | translations (18 languages) |
| `__tests__/` | Jest test suite (unit, protocol, security, fuzzing, invariants) |
| `website/` | static website generator, signed update manifest, server deployment |
| `shop/` | onion shop for the full version (Monero/Bitcoin, view-only wallets, license signing, accounting) |
| `buchhaltung/` | local accounting tool for the operator (receipts, quarterly reports) |
| `web/` | earlier web client (not maintained) |
| `SECURITY_*.md` | internal security reviews, threat model, invariants catalog |

## Building

Requirements: Node.js 20.19+ / 22.13+ / 24.3+, JDK 17 or 21, Android SDK (compileSdk 36, NDK 27.1).

```bash
npm ci                 # also applies patches/ via patch-package
npx jest               # full test suite
cd android
./gradlew :app:assembleWebDebug        # website variant, debug-signed
./gradlew :app:assembleWebRelease      # needs your own android/keystore.properties
./gradlew :app:bundlePlayRelease       # Play variant, needs android/keystore-play.properties
```

The shop and the website have their own test suites: `cd shop && npm test`, `cd website && npm test`.

Release builds you make yourself are signed with **your** key, so Android will not install them as an update over the official app (and vice versa).

## Verifying official releases

- APK signing certificate (SHA-256): `fbd5d54b7e34af9c1b21910ba52049ad267e22d48140f3ac6a6c740846a9aec0`
- Update manifest key (Ed25519, base64url): `ETAIGUc3F9MDfCh79kCJk4FhnxSLifZqdBwqA6WZ0OM`
- Step-by-step instructions (sha256sum, apksigner, OpenSSL): <https://malachiapp.de/en/download.html#verify>

## Honest limits

- Both devices have to be online at the same time at some point – there is no store-and-forward server.
- **No independent security audit yet.** There were internal reviews (red team, crypto, fuzzing, concurrency, a pre-release audit – see `SECURITY_*.md`), but no external one.
- No encryption helps against malware on the device or an unlocked phone in someone else's hands.
- Android only for now.

## How Malachi is developed

Malachi is developed by one person. **A large part of the code and documentation was written with an AI coding assistant (Anthropic's Claude)** under the author's direction; the author defines the design, reviews and tests the changes and decides what ships. Security-relevant code is covered by the test suite and the internal reviews listed above. We mention this openly because you should know how the software you trust was made.

## License

Malachi is free software: you can redistribute it and/or modify it under the terms of the **GNU Affero General Public License, version 3** ([LICENSE](LICENSE)).

The name "Malachi" and the logo are not part of this license. If you publish a modified version, please give it a different name and icon so users are not confused about which app they are running.

## Contact

MalachiApp@proton.me · Reddit: r/Malachi_App · Security issues: see [SECURITY.md](SECURITY.md)
