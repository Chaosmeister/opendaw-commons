# openDAW Commons

Community content for [openDAW](https://opendaw.studio): scripts and WebCLAP plugins.

Anyone can contribute with a pull request. After a merge the content shows up in the Studio in the "Community"
folder, with no Studio release needed.

## How it goes live

1. You open a pull request that adds or changes one item folder.
2. The CI validates the item and posts a summary of what goes live.
3. A maintainer reviews it. Scripts and plugins run in other people's browsers, so a human review is always required.
4. On merge the CI builds the indices and uploads everything to `assets.opendaw.studio/community`.

The Studio never reads this repo directly. It only reads the generated indices.

## Layout

```
scripts/<target>/<slug>/             meta.json, script.ts or script.js
wclaps/<slug>/                       meta.json, source/
schemas/                             JSON schemas for every meta.json
```

`<target>` is one of `project`, `werkstatt`, `apparat` or `spielwerk`.

## License

Everything in this repo is [CC0 1.0](LICENSE), except WebCLAP source code, which may use any OSI approved
license. Sounds a WebCLAP ships are always CC0.

To add your own, follow the step by step guide in the
[Community Scripts manual](https://opendaw.studio/manuals/community-scripts). [CONTRIBUTING.md](CONTRIBUTING.md) has
the details.
