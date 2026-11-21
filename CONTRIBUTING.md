# Contributing

Open an issue describing the problem or send a focused pull request. Include
reproduction steps and the Chrome version when reporting browser behavior.

Use a current Node.js LTS release, pnpm 12.21.0, Bash and curl. Python 3 is needed for
the test server; ImageMagick and browser-harness are needed for browser tests.

```bash
pnpm install --frozen-lockfile
pnpm run setup
pnpm run check
pnpm run setup:fixtures
pnpm run serve
# In another terminal, after loading extension/ into Chrome:
pnpm run verify
pnpm run verify:early
```

Run browser commands from the repository root. Keep changes to detection,
discovery and screenshot fallback covered by the existing local test cases.
The timing benchmark is optional and depends on the page and hardware used.

Keep credentials, browser profiles, screenshots, logs, benchmark reports and
personal browsing information out of commits and issue attachments. Use the
local test page for reproducible reports. Review `git diff --cached` before
committing. Contributions to original project code are made under the MIT
license; retain applicable third-party notices.
