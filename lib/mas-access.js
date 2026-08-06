// Mac App Store sandbox support. Sandboxed apps can't read ~/.claude, ~/.codex,
// ~/.grok, ~/.hermes-chat, or ~/.cursor — and os.homedir() resolves to the app
// CONTAINER, not the real home. The user grants access once by selecting their
// home folder; we persist the security-scoped bookmark (plus the chosen path)
// in the kv store and re-open it on every launch before the watchers start.
//
// In non-MAS builds this is a no-op that returns the real home dir.
const { app, dialog } = require('electron');
const os = require('os');

const KV_BOOKMARK = 'mas_home_bookmark';
const KV_PATH = 'mas_home_path';

// Returns the directory the watchers should treat as "home", or null if the
// user hasn't granted access (MAS only). Never throws.
async function ensureHomeAccess(kv) {
  if (!process.mas) return os.homedir();

  const savedBookmark = kv.kvGet(KV_BOOKMARK);
  const savedPath = kv.kvGet(KV_PATH);
  if (savedBookmark && savedPath) {
    try {
      // Returned stop-function is intentionally never called — access must
      // last for the app's whole lifetime.
      app.startAccessingSecurityScopedResource(savedBookmark);
      return savedPath;
    } catch (err) {
      console.error('[mas-access] stale bookmark, re-prompting:', err.message);
    }
  }

  const res = await dialog.showOpenDialog({
    title: 'Grant Prompt Vault access to your home folder',
    message: 'Prompt Vault captures prompts by reading agent session files in your home folder (e.g. ~/.claude, ~/.codex, ~/.cursor). Select your home folder to enable capture. You can skip this — clipboard and hotkey capture still work.',
    buttonLabel: 'Grant Access',
    defaultPath: '/Users',
    properties: ['openDirectory'],
    securityScopedBookmarks: true
  });
  if (res.canceled || !res.filePaths.length) return null;

  const dir = res.filePaths[0];
  const bookmark = (res.bookmarks && res.bookmarks[0]) || '';
  if (bookmark) {
    kv.kvSet(KV_BOOKMARK, bookmark);
    kv.kvSet(KV_PATH, dir);
    try { app.startAccessingSecurityScopedResource(bookmark); } catch {}
  }
  return dir;
}

function hasAccess(kv) {
  return !process.mas || !!kv.kvGet(KV_BOOKMARK);
}

module.exports = { ensureHomeAccess, hasAccess };
