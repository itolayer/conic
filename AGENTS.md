# CONIC (CKB Over Nostr Intend Coordination)

CONIC is an intention layer for CKB built on top of Nostr.

## Overview

### Stacks

- Runtime: Node 24+ or Bun 1.3+
- Package Manager: pnpm
- Language: TypeScript
- Testing: Vitest

### Preflight Check

```sh
pnpm run preflight
```

For devnet CCC config, always include the `NervosDao` script entry when normalizing OffCKB-exported scripts.
