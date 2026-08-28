# pi-fewer-models

There are too many models in unscoped, and it's annoying.

This extension trims pi's model catalogue itself, so `/model`, `Ctrl+P` cycling
and autocomplete all see the reduced list. It does not add its own picker command.

It works by re-registering each provider with a filtered `models` array
(`pi.registerProvider(provider, { models })`), which keeps the provider's auth,
baseUrl and OAuth layers intact. The original catalogue is snapshotted before
the first change and restored on `session_shutdown`, so `/reload` and `/fewer-models off`
bring everything back.

## Install

```bash
ln -s ~/Code/pi-fewer-models ~/.pi/agent/extensions/fewer-models
```

Or add the path to `~/.pi/agent/settings.json`:

```json
{ "extensions": ["/home/sponge/Code/pi-fewer-models/src/index.ts"] }
```

## Config

Global: `~/.pi/agent/fewer-models.json`
Project (trusted projects only, overlays the global one): `.pi/fewer-models.json`

```json
{
  "enabled": true,
  "providers": ["anthropic", "openai", "google", "zai*"],
  "excludeProviders": ["openrouter"],
  "allow": ["anthropic/claude-*-4-*", "gpt-5*", "gemini-2.5-*"],
  "deny": ["*-nano", "anthropic/claude-3-*"],
  "keepCurrentModel": true,
  "requireAuth": false
}
```

| Key | Meaning |
|---|---|
| `enabled` | Master switch (default `true`) |
| `providers` | Provider whitelist (globs). Absent/empty = all providers |
| `excludeProviders` | Provider blacklist, applied after the whitelist |
| `allow` | Model whitelist, matched on `provider/id` and on bare `id` |
| `deny` | Model blacklist, wins over `allow` |
| `keepCurrentModel` | Never hide the currently selected model (default `true`) |
| `requireAuth` | Also drop models whose provider has no usable credentials |

Glob rules: `*` matches within one segment, `**` matches across `/`, `?` matches
one character. Matching is case-insensitive.

Filter order per model: provider whitelist -> provider blacklist -> model
allow -> model deny. That gives the second scoping layer (provider level) plus
the whitelist/blacklist combination on top.

## Usage

- `/fewer-models` - status: counts, patched providers, config files in use
- `/fewer-models list` - visible models
- `/fewer-models hidden` - filtered-out models
- `/fewer-models reload` - re-read config files and re-apply
- `/fewer-models on` / `off` - toggle filtering for the session
- `pi --all-models` - start with filtering disabled

## Limitation

Filtering is applied on `session_start`, so `pi --list-models` (which never starts
a session) still prints the full catalogue.

## Relation to built-in scoping

pi already has `--models` / `enabledModels` scoping (`ctx.scopedModels`). This
extension is complementary: it shrinks the catalogue those settings are resolved
against, so the `all` tab of the model selector stops being a wall of text.
