# @akshaykarle/pi-tools

Pi coding agent extensions for security hardening and productivity.

## Installation

```bash
pi install @akshaykarle/pi-tools
```

Or add to your `~/.pi/agent/settings.json`:

```json
{
  "packages": ["@akshaykarle/pi-tools"]
}
```

## Development

This repo uses [nix-direnv](https://github.com/nix-community/nix-direnv). Once installed, run `direnv allow` once — deps from `flake.nix` auto-load on `cd`.

Without direnv: `nix develop` then `npm install && npx tsc`.

## Extensions

### security.ts

Defense-in-depth security extension that intercepts tool calls and results:

**Hard blocks (no override):**
- Destructive filesystem commands (`rm -rf /`, `mkfs`, `dd of=/dev`, fork bombs)
- Secret exfiltration (posting env vars to network, piping credential files to `curl`/`nc`)
- Self-protection (cannot remove/modify security extension files or settings)

**Confirmation required:**
- `sudo` commands
- Permission changes (`chmod`, `chown`)
- Destructive git operations (`push --force`, `reset --hard`, `clean -f`)
- Privileged Docker containers
- Network listeners

**Secret masking:**
- Redacts known secret env var values from tool output
- Covers `*_SECRET`, `*_TOKEN`, `*_KEY`, `*_PASSWORD`, `*_CREDENTIAL` patterns

**Prompt injection detection:**
- Flags instruction hijacking attempts in file contents
- Detects hidden text via zero-width Unicode characters
- Catches markdown image/link exfiltration patterns
- Warns (doesn't block) to avoid false positives on legitimate files

### plannotator

Bundled from [@plannotator/pi-extension](https://github.com/backnotprop/plannotator). Interactive plan review for coding agents — annotate plans visually, share with your team, and automatically send feedback.

## License

MIT
