# Contributing

Thanks for sharing your work with the openDAW community.

## One item per folder

Every item lives in its own folder. The folder name is the item's slug.

1. Lowercase letters, digits and single hyphens, for example `acid-bassline` or `tape-delay`.
2. Unique within its group.
3. Never renamed after the merge. The Studio derives the item's id from the slug, so a renamed folder becomes a new
   item. The display name lives in `meta.json` and can be changed any time.

## Groups

### Presets

```
presets/<slug>/meta.json
presets/<slug>/preset.odp
```

Save the preset from the Studio and rename it to `preset.odp`. The device and category are read from the file.

### Scripts

```
scripts/<target>/<slug>/meta.json
scripts/<target>/<slug>/script.ts   or script.js
```

`<target>` is where the script runs.

1. `project` for project scripts in the code editor.
2. `werkstatt` for audio effect scripts.
3. `apparat` for instrument scripts.
4. `spielwerk` for MIDI effect scripts.

Device scripts (`werkstatt`, `apparat`, `spielwerk`) are always `script.js`. Project scripts can be `script.ts` or
`script.js` and are checked against the same API types as the Studio code editor.

Paste a project script as it is in the Studio editor. If you want type checks in your own editor, you may start the
file with imports, for example `import {Api} from "@opendaw/studio-scripting"`. Everything before the first comment
line is dropped, so put a comment line where your code starts.

### WebCLAP plugins

```
wclaps/<slug>/meta.json
wclaps/<slug>/source/
```

Only source code goes into git, never a built binary. The CI builds the bundle from `source/` with a pinned
toolchain, so the plugin people load always matches the reviewed code.

## meta.json

You only write what a human knows. The CI computes everything else (id, devices, used samples, size).

```json
{
  "name": "Acid Bassline",
  "description": "A squelchy 303 line with a slow cutoff sweep.",
  "author": {"name": "Jane Doe", "github": "janedoe"},
  "tags": ["acid", "bass"],
  "license": "CC0-1.0"
}
```

1. `name` up to 64 characters.
2. `description` up to 1000 characters.
3. `author.name` is required. `author.github` and `author.url` (https only) are optional.
4. `tags` up to 8, lowercase words joined by hyphens.
5. `license` is always `CC0-1.0`. WebCLAPs use the SPDX id of their source license instead, for example `MIT`, and
   add a `credits` field.

The schemas are in [schemas/](schemas).

## Samples and soundfonts

Presets may only use samples, soundfonts and WebCLAPs from the openDAW cloud library. A file that uses your
own local sample fails the check, and the message names the box and sample id. Uploading your own samples and
soundfonts comes in a later iteration.

## Size limits

GitHub refuses files over 100 MB and warns at 50 MB. Git keeps every replaced file in its history forever, so keep
items small. The validator enforces these limits per item.

1. Preset `preset.odp`: 1 MB
2. Script: 256 KB
3. WebCLAP `source/`: 20 MB

## License

By opening a pull request you agree that your contribution is released under [CC0 1.0](LICENSE). WebCLAP source
code may use any OSI approved license. Sounds a WebCLAP ships are always CC0.

## Check locally

```
cd tools
npm ci
npm run validate
```

## Review

1. Every pull request runs the validator. A failing check blocks the merge.
2. The CI comments a summary of what the pull request adds.
3. A maintainer reviews every change. Scripts and plugins run in other people's browsers, so this review is never
   skipped.

To improve an existing item, edit its folder and open a pull request. The Studio links every community item to its
folder here.
