# arkadia-wiedza-uploader

Arkadia Web Client plugin that uploads a character's known wiedza entries to
the Arkadia CMS via OAuth (Authorization Code + PKCE). Supports manual upload,
auto-upload-on-change for a locked character, and silent token refresh.

## Files

- `plugin.ts` — the plugin module; built into `dist/plugin.js`.
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

## Install in the Arkadia client

1. Open the Arkadia Web Client.
2. In the plugin manager, add a plugin URL pointing to `plugin.js`. Use the
   hosted build above, or `http://localhost:5174/plugin.js` for local dev.
3. Open the `⋮` popup menu → "Wyslij wiedze do CMS".
4. Click "Zaloguj" to complete the OAuth flow once.
5. Optionally enable "Wysylaj automatycznie wiedze tej postaci" to auto-upload
   whenever the selected character's wiedza changes.
