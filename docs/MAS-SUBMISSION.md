# Mac App Store Submission Guide

The repo is fully wired for a Mac App Store (MAS) build: sandbox entitlements
(`build/entitlements.mas.plist`), a security-scoped home-folder grant flow
(`lib/mas-access.js`), and the `mas` electron-builder target (`npm run dist:mas`).

Two artifacts must come from the Apple Developer portal and can't be generated
locally. Everything below assumes team **DV6XM8624F** and the Apple ID
**devgwardo@icloud.com** (the account the existing certs live under).

## One-time setup (Apple Developer portal)

1. **App ID** — [developer.apple.com → Identifiers](https://developer.apple.com/account/resources/identifiers/list)
   → `+` → App IDs → App → Bundle ID **exact**: `com.promptvault.app`.
   Capabilities: enable **App Groups**, and add/assign the group
   `DV6XM8624F.com.promptvault.app` (Identifiers → App Groups → `+` if it
   doesn't exist yet).
2. **Mac Installer Distribution certificate** — [Certificates](https://developer.apple.com/account/resources/certificates/list)
   → `+` → **Mac Installer Distribution**. Create a CSR via Keychain Access
   (Certificate Assistant → Request a Certificate From a CA), upload, download
   the cert, double-click to install. (The **Apple Distribution** cert that
   signs the .app is already in the keychain.)
3. **Provisioning profile** — [Profiles](https://developer.apple.com/account/resources/profiles/list)
   → `+` → Distribution → **Mac App Store Connect** → select the
   `com.promptvault.app` App ID → select the Apple Distribution certificate →
   name it (e.g. `Prompt Vault MAS`) → download, then save it into this repo as:

   ```
   build/embedded.provisionprofile
   ```

   (gitignored — do not commit it.)
4. **App Store Connect record** — [appstoreconnect.apple.com](https://appstoreconnect.apple.com)
   → My Apps → `+` → New App → platform macOS, bundle ID `com.promptvault.app`,
   SKU e.g. `prompt-vault`.

## Build & upload

```bash
npm run dist:mas          # produces dist/mas-arm64/Prompt Vault-<version>.pkg
```

Upload the `.pkg` with the **Transporter** app (free, Mac App Store) signed in
as devgwardo@icloud.com, or:

```bash
xcrun altool --upload-package ... # deprecated; prefer Transporter
```

Then in App Store Connect: pick the build, fill in the listing
(screenshots at 1280×800/2560×1600, description, keywords, support URL,
privacy policy URL), and complete **App Privacy** — declare *no data
collected* (everything is local; nothing leaves the machine).

## Review notes (important)

In "Notes for Review", explain the sandbox grant up front — this is the most
likely rejection point:

> Prompt Vault is a local-first developer tool that saves the prompts a user
> sends to AI CLI tools (Claude Code, Codex, Grok). On first launch it asks the
> user to select their home folder (standard NSOpenPanel + security-scoped
> bookmark) so it can read those tools' session transcript files. No data is
> transmitted anywhere; the app has no analytics, accounts, or network backend.
> The local HTTP listener on 127.0.0.1:8765 only accepts prompt submissions
> from the user's own shell hooks.

If review rejects the home-folder grant, the fallback plan is a MAS variant
with watchers disabled (clipboard + hotkey + HTTP capture only).

## MAS build behavior differences

- `os.homedir()` resolves to the app container
  (`~/Library/Containers/com.promptvault.app/Data`), so the vault DB lives
  inside the container instead of `~/.prompt-vault`.
- Watchers only start after the user grants home-folder access (startup dialog,
  or later via tray → "Enable Session Capture…"). Skipping the grant leaves
  clipboard/hotkey/HTTP capture fully functional.
- The build is signed with Apple Distribution + the embedded provisioning
  profile; no notarization step.

## Sanity checks before upload

```bash
codesign -dv --entitlements - "dist/mas-arm64/Prompt Vault.app"   # sandbox=true
pkgutil --check-signature "dist/mas-arm64/Prompt Vault-"*.pkg
```
