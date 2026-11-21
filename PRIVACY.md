# Privacy

Safe runs image inference locally in Chrome. It does not contain analytics,
telemetry, a remote inference service or an account system.

The extension requests access to all sites so it can find images in pages and
frames and fetch their bytes from its offscreen document. These image requests
go to the image hosts and can include site cookies. Hosts can therefore observe
the additional requests. Installing dependencies and the model also requires
network downloads during setup.

When an image cannot be fetched, the screenshot fallback captures the visible
tab and crops the relevant regions locally. The original screenshot can include
other visible page content. The offscreen document retains the last capture for
debugging and keeps an in-memory URL cache and log; these clear when that
document is destroyed. Settings are stored in `chrome.storage.local`, and tab
statistics use `chrome.storage.session`.

Debug mode exposes detection labels and state in the page DOM and console.
Browser test tools can save local screenshots and reports under `test/`. These
outputs are ignored by Git. Real-site probing saves screenshots only when
`SAFE_CAPTURE=1`; use public test pages and review any output before sharing it.
