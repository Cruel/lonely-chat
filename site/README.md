# Lonely Chat website

Static Astro landing page for Cloudflare Pages. This site has an independent pnpm workspace and lockfile: installing or building it does not require the Electron app's dependencies.

## Local development

Requires Node.js 24.18+ and pnpm 11.15.0.

```sh
cd site
pnpm install --frozen-lockfile
pnpm dev
pnpm test
pnpm build
```

The site checks the latest *published* GitHub release in the visitor's browser. Until the first published release, download links show a coming-soon state. The site does not require Cloudflare credentials, GitHub API tokens, server-side rendering or a redeploy on each desktop release. GitHub API failures fall back to a link to the releases page.

## CI

`.github/workflows/site.yml` runs a frozen install, download tests, and the Astro production build for pushes and pull requests changing `site/**` (or the website workflow itself). It can also be run manually. Routine desktop-only changes do not run website CI; website-only changes skip desktop CI. Desktop release certification continues to call the reusable application workflow independently.

## Cloudflare Pages

Connect the `Cruel/lonely-chat` GitHub repository after pushing this directory.

| Setting | Value |
| --- | --- |
| Production branch | `master` |
| Root directory | `site` |
| Framework preset | Astro |
| Build command | `pnpm build` |
| Output directory | `dist` |
| Build watch paths (include) | `site/*` |
| Build watch paths (exclude) | empty |

Use Node.js 24.18+ and pnpm 11.15.0 (the version in `site/package.json`). The `site/*` include rule covers nested files and the site's own lockfile; routine application changes do not rebuild the Pages site. Cloudflare may still build for events exempt from Build Watch Paths, such as very large pushes.

## Releases

`.github/workflows/release.yml` publishes versioned installers using the version in the root `package.json`. The browser chooses the appropriate asset by its filename suffix:

- Windows x64: `lonely-chat-<version>-windows-x64.exe`
- Linux x64: `lonely-chat-<version>-linux-x86_64.AppImage`
- macOS Apple Silicon: `lonely-chat-<version>-macos-arm64.dmg`

This page only offers an installer when it actually appears on GitHub Releases; it does not link to CI artifacts or promise unsupported architectures. Releases are currently unsigned. If filenames change, update `src/lib/downloads.mjs` and its tests.
