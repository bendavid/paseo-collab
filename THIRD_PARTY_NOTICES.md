# Third-party notices

This repository contains no third-party code apart from `third-party/paseo-LICENSE.txt`, a copy of
[Paseo's license](https://github.com/getpaseo/paseo/blob/main/LICENSE).

**The plugin** installs its runtime dependencies from npm with the committed `package-lock.json`:
[`ws`](https://www.npmjs.com/package/ws) (MIT) and Paseo's `@getpaseo/relay` and
`@getpaseo/protocol` (Apache-2.0, per Paseo's license), with their own dependencies. Their license
texts ship in those packages.

**The guest page** published to GitHub Pages bundles React, assistant-ui, react-markdown and its
unified/remark ecosystem, Paseo's `@getpaseo/highlight` with CodeMirror and Lezer grammars, and
`@getpaseo/relay` with the `@noble` cryptography libraries and TweetNaCl, among about 200 packages.
`scripts/build-guest.mjs` collects the license text of every bundled package into
`site/third-party-licenses.txt`, published at
<https://bendavid.github.io/paseo-collab/third-party-licenses.txt> and linked from the page
header. Paseo's packages ship without a license file, so the build uses
`third-party/paseo-LICENSE.txt` for them.

Almost all of them are MIT licensed; the rest use Apache-2.0, BSD-3-Clause, ISC, 0BSD, or the
Unlicense.
