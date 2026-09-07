# arkadia-wiedza-uploader

Arkadia Web Client plugin that uploads a character's known wiedza entries to
the Arkadia CMS via OAuth (Authorization Code + PKCE). Supports manual upload,
auto-upload-on-change for a locked character, and silent token refresh.

## Files

- `plugin.ts` — the plugin module; built into `dist/plugin.js`.
- `plugin.json` — package manifest for the plugin registry (entry point +
  metadata). Keep its `version` in sync with `package.json` and `plugin.ts`.
- `DESCRIPTION.md` — the plugin's page in the registry, in Polish; published
  as the readme by the release workflow.
- `oauth-callback.html` — OAuth redirect target; copied to `dist/` next to
  the bundle so `import.meta.url` resolves it to the same origin.

## Build

```
yarn install
yarn build
```

Outputs `dist/plugin.js` and `dist/oauth-callback.html`. Host the `dist/`
directory anywhere reachable from the Arkadia client.

## Develop

```
yarn dev
```

Watches sources and serves `dist/` on `http://localhost:5174`. The plugin
entry will be at `http://localhost:5174/plugin.js`, callback at
`http://localhost:5174/oauth-callback.html`.

## OAuth registration

On the CMS side, the `wiedza-tracker` OAuth client must include the callback
URL in its `redirect_uris` array. The plugin computes the callback URL from
`import.meta.url`, so it always resolves to whatever URL the bundle is
served from. For the default dev setup that is:

```
http://localhost:5174/oauth-callback.html
```

Register that URL in
`themes/arkadia/src/Controllers/OAuthController.php::getClients()`.

## Hosted build

The `master` branch is auto-published to GitHub Pages from
[Delwing/arkadia-ethel-knowledge-upload](https://github.com/Delwing/arkadia-ethel-knowledge-upload):

- Plugin: `https://delwing.github.io/arkadia-ethel-knowledge-upload/plugin.js`
- Callback: `https://delwing.github.io/arkadia-ethel-knowledge-upload/oauth-callback.html`

## Publishing to the plugin registry

`.github/workflows/publish.yml` publishes to
[Arkadia Plugins](https://arkadia-package-repository.vercel.app) on every `v*`
tag (or via *Run workflow*). It uploads **sources** — a ZIP of `plugin.json` +
`plugin.ts` — and the registry compiles them with esbuild, so the plugin page
shows the real code instead of a build artifact.

Authentication is GitHub OIDC (audience `arkadia-plugins`); there are no
secrets to configure. One-time setup in the registry dashboard:

1. Create the plugin under the slug `ethel-wiedza-upload`.
2. Under *Zaufany wydawca*, set repository
   `Delwing/arkadia-ethel-knowledge-upload` and workflow `publish.yml`.

Then release with:

```
git tag v0.3.0 && git push origin v0.3.0
```

The version comes out of the package, not out of the tag: the registry
rejects a release whose tag, `plugin.json` and `PluginInfo` disagree, so all
three have to be bumped together. The workflow only checks `package.json`
itself, which the registry never sees.

The registry listing's readme is `DESCRIPTION.md` — the Polish, player-facing
text. `README.md` (this file) is developer documentation and is not published.

Note that a bundle installed from the registry has no sibling
`oauth-callback.html`, so `callbackUrl()` falls back to the GitHub Pages copy
above — that is the URL the CMS must whitelist.

## Install in the Arkadia client

1. Open the Arkadia Web Client.
2. In the plugin manager, add a plugin URL pointing to `plugin.js`. Use the
   hosted build above, or `http://localhost:5174/plugin.js` for local dev.
3. Open the `⋮` popup menu → "Wyslij wiedze do CMS".
4. Click "Zaloguj" to complete the OAuth flow once.
5. Optionally enable "Wysylaj automatycznie wiedze tej postaci" to auto-upload
   whenever the selected character's wiedza changes.
