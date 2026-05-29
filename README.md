<p align="center">
  <img src="assets/branding/banner.svg" alt="Prompt Vault banner" width="100%">
</p>

<p align="center">
  <img src="https://img.shields.io/badge/license-MIT-50e3a4?style=flat-square" alt="MIT License">
  <img src="https://img.shields.io/badge/platform-macOS-181818?style=flat-square" alt="macOS">
  <img src="https://img.shields.io/badge/built%20with-Electron-50e3a4?style=flat-square" alt="Built with Electron">
  <a href="https://github.com/DevvGwardo/prompt-vault/releases"><img src="https://img.shields.io/github/v/release/DevvGwardo/prompt-vault?display_name=release&style=flat-square" alt="Latest release"></a>
</p>

Prompt Vault is a local-first macOS desktop app for capturing the prompts you send through agent tooling, scoring them offline, and making them searchable later. It stores data in SQLite with `better-sqlite3`, analyzes prompt quality in `analyzer.js`, and surfaces everything in an Electron renderer built for fast keyboard-heavy browsing.

## Features

| | |
| --- | --- |
| <img src="assets/branding/feature-capture.svg" alt="Capture icon" width="72"> | **Capture from your real workflow**. Prompt Vault accepts prompts through its local hook flow, including Claude Code hook wiring and active watchers for Codex and Grok sessions. |
| <img src="assets/branding/feature-score.svg" alt="Score icon" width="72"> | **Score prompts offline**. `analyzer.js` assigns a score, verdict, and reasons so you can separate strong prompts from throwaways. |
| <img src="assets/branding/feature-search.svg" alt="Search icon" width="72"> | **Search fast**. Prompts are stored in SQLite and indexed with FTS5 for quick search across text, title, and tags. |
| <img src="assets/branding/feature-local-first.svg" alt="Local-first icon" width="72"> | **Stay local-first**. The vault lives in `~/.prompt-vault/vault.db` by default, with no cloud service required. |

## Supported Agents

- Claude Code
- Codex
- Grok
- Cursor-agent

## Install

Download the latest macOS DMG from [GitHub Releases](https://github.com/DevvGwardo/prompt-vault/releases).

## Build From Source

```bash
npm install
npm start
npm run dist
```

Current package version: `0.1.1`

## How It Works

1. A local hook or watcher captures a prompt from your agent workflow.
2. Prompt Vault stores the prompt, metadata, and recent activity in SQLite.
3. `analyzer.js` scores the prompt and attaches a verdict plus reasons.
4. The Electron renderer lets you search, inspect, pin, and revisit prompts in the vault UI.

## Screenshots

<p align="center">
  <img src="assets/branding/screenshot-overview.png" alt="Prompt Vault overview" width="100%">
</p>
<p>
  <img src="assets/branding/screenshot-detail.png" alt="Prompt Vault detail view" width="48%">
  <img src="assets/branding/screenshot-search.png" alt="Prompt Vault search" width="48%">
</p>

## License

MIT
