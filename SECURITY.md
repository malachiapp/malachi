# Security policy

Malachi protects people's private communication, so we take security reports seriously and are grateful for them.

## Reporting a vulnerability

**Please do not report security issues in public GitHub issues, Reddit posts or comments.**

Report privately instead:

- **Email:** MalachiApp@proton.me – subject line starting with `SECURITY:`
  (Proton Mail to Proton Mail is end-to-end encrypted automatically.)
- **Reddit:** modmail to r/Malachi_App

Please include:

- what is affected (app version, website, shop, update mechanism, protocol),
- how to reproduce it, and what an attacker could achieve,
- whether and how you would like to be credited.

We will acknowledge your report as soon as possible, keep you informed while we work on a fix, and publish details only after a fix is available – in agreement with you.

## Scope

In scope:

- the Android app (both the website and the Google Play variant),
- the messaging protocol and its cryptography (Double Ratchet, ML-KEM, pairing, Seal mode),
- the signed update mechanism,
- the website <https://malachiapp.de> and its onion service,
- the onion shop and license verification.

Out of scope: attacks that require an already unlocked device with malware installed, social engineering of the operator, and denial-of-service attacks against the infrastructure (please do not run them).

## Supported versions

Only the latest released version receives security fixes. The app can update itself over Tor (website version) or via Google Play.
