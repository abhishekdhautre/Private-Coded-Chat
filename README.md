# Private Coded Chat

A two-person real-time chat built with Next.js App Router, TypeScript, Tailwind CSS, Firebase Auth, Firebase Realtime Database, and the browser Web Crypto API.

## Security model

- Firebase login password is separate from the room encryption passphrase.
- The room passphrase is turned into an AES-256-GCM key with PBKDF2, 100,000 iterations, SHA-256, using the room ID as the salt.
- The derived key and display keyword exist only in JavaScript memory. They are not stored in localStorage/sessionStorage/cookies and are never written to Firebase.
- Every message gets a fresh 12-byte random AES-GCM IV.
- Firebase stores only ciphertext, IV, sender UID, timestamp, and optional expiry metadata.
- Plaintext is decrypted only in the browser and is then transformed by a separate keyed display cipher before being rendered.
- Coded text is the default display. Reveal is local and requires no network request.
- The message list blurs when the window loses focus.
- Visibility changes immediately lock the room; inactivity also locks after `NEXT_PUBLIC_AUTO_LOCK_MINUTES`.
- Production code contains no plaintext logging.

### Important limitation

This protects the database/network layer and reduces casual screen exposure. It cannot protect plaintext after the user explicitly reveals it from a compromised browser, malicious browser extension, screen recorder, OS-level malware, or a person already viewing the unlocked screen. Web apps cannot guarantee protection against a fully compromised endpoint.

## 1. Create Firebase project

1. Create a Firebase project.
2. Add a Web App and copy its configuration.
3. Enable **Authentication → Sign-in method → Email/Password**.
4. Create **Realtime Database**.
5. Put the values into `.env.local` using `.env.local.example` as the template.

## 2. Install and run

```bash
npm install
npm run dev
```

Open `https://localhost:3000` on the development computer. For another device on the same network, open `https://YOUR_COMPUTER_IP:3000`. Next.js may ask to install or trust its development certificate on the first HTTPS start. Web Crypto requires HTTPS on LAN devices; plain `http://192.168.x.x` cannot create or unlock rooms.

## 3. Deploy Realtime Database rules

Using the Firebase CLI:

```bash
npm install -g firebase-tools
firebase login
firebase use YOUR_PROJECT_ID
firebase deploy --only database --config firebase.json
```

Or paste `firebase.rules.json` into the Realtime Database Rules editor.

If using the CLI, create a minimal `firebase.json`:

```json
{
  "database": {
    "rules": "firebase.rules.json"
  }
}
```

The rules allow only participant UIDs to read a room. New messages must have `senderId == auth.uid`, preventing one participant from impersonating the other. Room metadata is immutable after creation.

## 4. Create a room

Sign in as participant A. Open **Room setup**, enter a room ID and participant B's Firebase Auth UID, then create the room. Share the room ID and the two secrets offline.

The encryption passphrase and display keyword are never put in room metadata.

## 5. Use the room

Open `/chat/<roomId>`. If locked, the app sends you to `/unlock?roomId=<roomId>`.

Enter:

1. The shared encryption passphrase.
2. The shared display keyword.

The keyword is a display-layer secret, not a replacement for AES encryption. The AES passphrase is the security-critical secret.

## 6. Vercel deployment

Import the repository into Vercel and add every `NEXT_PUBLIC_FIREBASE_*` variable from `.env.local` plus `NEXT_PUBLIC_AUTO_LOCK_MINUTES` under Project Settings → Environment Variables. Deploy.

## 7. Tests

```bash
npm test
```

## Data model

```text
/rooms/{roomId}/messages/{messageId}
  ciphertext: string
  iv: string
  senderId: string
  timestamp: number
  expiresAt: number | null

/rooms/{roomId}/meta
  participants:
    0: uid1
    1: uid2
  keyCheck:
    ciphertext: "..."
    iv: "..."
```

No plaintext message field is used anywhere in the Firebase model.
