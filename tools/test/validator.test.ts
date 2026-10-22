import {describe, it} from "node:test"
import assert from "node:assert/strict"
import {asset, EmptyCloud, exampleScript, messages, meta, validate} from "./helpers.ts"
import {CloudIndex} from "../src/CloudIndex.ts"
import {ProjectScripts} from "../src/ProjectScripts.ts"
import {Summary} from "../src/Summary.ts"

const expectErrors = (report: { ok: boolean }, list: ReadonlyArray<string>, ...patterns: ReadonlyArray<RegExp>): void => {
    assert.equal(report.ok, false, "expected the check to fail")
    for (const pattern of patterns) {
        assert.ok(list.some(message => pattern.test(message)), `no error matches ${pattern}\n${list.join("\n")}`)
    }
}

describe("layout", () => {
    it("accepts an empty repo", async () => {
        const report = await validate({})
        assert.deepEqual(messages(report), [])
        assert.equal(report.items.length, 0)
    })
    it("ignores .gitkeep in empty group folders", async () => {
        const report = await validate({"presets/.gitkeep": "", "scripts/project/.gitkeep": ""})
        assert.deepEqual(messages(report), [])
    })
    it("rejects slugs that are not lowercase-hyphenated", async () => {
        for (const slug of ["Acid", "acid_bass", "acid--bass", "-acid", "acid-", "a".repeat(65)]) {
            const report = await validate({[`presets/${slug}/meta.json`]: meta()})
            expectErrors(report, messages(report), /not a valid slug/)
        }
    })
    it("accepts a slug of 64 characters", async () => {
        const slug = "a".repeat(64)
        const report = await validate({[`scripts/project/${slug}/meta.json`]: meta(), [`scripts/project/${slug}/script.ts`]: "// ok\n"})
        assert.deepEqual(messages(report), [])
    })
    it("rejects unknown script targets and loose files", async () => {
        const report = await validate({"scripts/vst/thing/meta.json": meta(), "presets/readme.txt": "hello"})
        const list = messages(report)
        expectErrors(report, list, /scripts\/vst: Unknown script target/, /presets\/readme.txt: Only item folders/)
    })
    it("requires meta.json and the payload", async () => {
        const report = await validate({"presets/empty/.keep": "", "presets/bare/meta.json": meta()})
        expectErrors(report, messages(report), /presets\/empty: Missing meta.json/, /presets\/bare: Missing preset.odp/)
    })
    it("rejects unexpected files inside an item", async () => {
        const report = await validate({
            "scripts/project/demo/meta.json": meta(),
            "scripts/project/demo/script.ts": "// demo\n",
            "scripts/project/demo/notes.md": "no"
        })
        expectErrors(report, messages(report), /demo\/notes.md: Unexpected file/)
    })
    it("needs exactly one script file", async () => {
        const both = await validate({
            "scripts/project/demo/meta.json": meta(),
            "scripts/project/demo/script.ts": "// a\n",
            "scripts/project/demo/script.js": "// b\n"
        })
        expectErrors(both, messages(both), /Needs exactly one of script.ts or script.js/)
        const none = await validate({"scripts/apparat/demo/meta.json": meta()})
        expectErrors(none, messages(none), /Needs exactly one of script.js/)
    })
    it("device scripts must be JavaScript", async () => {
        const report = await validate({"scripts/werkstatt/demo/meta.json": meta(), "scripts/werkstatt/demo/script.ts": "// ts\n"})
        expectErrors(report, messages(report), /Needs exactly one of script.js/, /script.ts: Unexpected file/)
    })
    it("enforces size limits at the boundary", async () => {
        const limit = 256 * 1024
        const body = (size: number): string => "// " + "x".repeat(size - 4) + "\n"
        const atLimit = await validate({"scripts/project/big/meta.json": meta(), "scripts/project/big/script.js": body(limit)})
        assert.deepEqual(messages(atLimit), [])
        const overLimit = await validate({"scripts/project/big/meta.json": meta(), "scripts/project/big/script.js": body(limit + 1)})
        expectErrors(overLimit, messages(overLimit), /exceeds the limit of 256.0 KB/)
    })
})

describe("meta.json", () => {
    const withMeta = (content: string) => validate({"scripts/project/demo/meta.json": content, "scripts/project/demo/script.ts": "// demo\n"})
    it("accepts the documented example", async () => {
        const report = await withMeta(meta({author: {name: "Jane Doe", github: "janedoe", url: "https://example.com"}}))
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].name, "Test Item")
    })
    it("rejects invalid JSON", async () => {
        const report = await withMeta("{name: nope}")
        expectErrors(report, messages(report), /Not valid JSON/)
    })
    it("rejects fields the CI computes", async () => {
        const report = await withMeta(meta({uuid: "4f7f2d0e-0000-4000-8000-000000000000"}))
        expectErrors(report, messages(report), /uuid is computed by the CI or unknown/)
    })
    it("rejects every license but CC0", async () => {
        const report = await withMeta(meta({license: "MIT"}))
        expectErrors(report, messages(report), /license must be equal to constant/)
    })
    it("rejects missing fields, empty names and long descriptions", async () => {
        const report = await withMeta(JSON.stringify({name: "", description: "x".repeat(1001), tags: []}))
        expectErrors(report, messages(report), /must have required property 'author'/, /license/, /name must NOT have fewer/,
            /description must NOT have more than 1000/)
    })
    it("rejects bad tags", async () => {
        for (const tags of [["Bass"], ["a", "a"], ["one", "two", "three", "four", "five", "six", "seven", "eight", "nine"]]) {
            const report = await withMeta(meta({tags}))
            assert.equal(report.ok, false, JSON.stringify(tags))
        }
    })
    it("rejects non-https author urls and bad GitHub handles", async () => {
        for (const author of [{name: "A", url: "http://example.com"}, {name: "A", github: "-bad"}, {name: "A", twitter: "x"}]) {
            const report = await withMeta(meta({author}))
            assert.equal(report.ok, false, JSON.stringify(author))
        }
    })
    it("WebCLAPs take an SPDX license and credits", async () => {
        const files = (overrides: Record<string, unknown>) => ({
            "wclaps/synth/meta.json": meta(overrides),
            "wclaps/synth/source/main.cpp": "int main() {}"
        })
        assert.deepEqual(messages(await validate(files({license: "MIT", credits: "Jane"}))), [])
        const noCredits = await validate(files({license: "MIT"}))
        expectErrors(noCredits, messages(noCredits), /must have required property 'credits'/)
    })
})

describe("device scripts", () => {
    const device = (target: string, code: string) =>
        validate({[`scripts/${target}/demo/meta.json`]: meta(), [`scripts/${target}/demo/script.js`]: code})
    it("accepts every bundled example", async () => {
        const examples: Record<string, ReadonlyArray<string>> = {
            werkstatt: ["parametric-eq", "alienator", "sidechain-mixer"],
            apparat: ["wavetable", "grain-synthesizer", "tonematrix"],
            spielwerk: ["step-arp", "chord-generator", "pulsate"]
        }
        for (const [target, slugs] of Object.entries(examples)) {
            for (const slug of slugs) {
                const report = await device(target, exampleScript(target, slug))
                assert.deepEqual(messages(report), [], `${target}/${slug}`)
            }
        }
    })
    it("reports what the script declares", async () => {
        const report = await device("werkstatt", exampleScript("werkstatt", "sidechain-mixer"))
        assert.deepEqual(report.items[0].details, {label: "Sidechain Mixer", params: 3, samples: 0, sidechains: 2, view: false})
    })
    it("rejects syntax errors", async () => {
        const report = await device("werkstatt", "class Processor {\n process( {}\n}")
        expectErrors(report, messages(report), /script.js: /)
    })
    it("rejects a script without a Processor class", async () => {
        const report = await device("apparat", "// @label Nothing\nclass Synth {}\n")
        expectErrors(report, messages(report), /Processor/)
    })
    it("rejects a malformed declaration", async () => {
        const report = await device("spielwerk", "// @collection steps\n// @field steps.on nope\nclass Processor {}\n")
        expectErrors(report, messages(report), /Malformed @field/)
    })
    it("rejects top-level code that never finishes", async () => {
        const report = await device("werkstatt", "while (true) {}\nclass Processor {}\n")
        expectErrors(report, messages(report), /timed out/)
    })
    it("rejects top-level state in a script with a view", async () => {
        const report = await device("werkstatt", "// @view 2 1 4 3\nlet counter = 0\nclass Processor {}\nclass View {}\n")
        expectErrors(report, messages(report), /Top-level 'let counter' would exist separately/)
    })
})

describe("project scripts", () => {
    it("accepts every bundled example", async () => {
        for (const slug of ["acid", "audio-region", "cleanup", "inventory", "mixdown", "nano-wavetable"]) {
            const report = await validate({
                [`scripts/project/${slug}/meta.json`]: meta(),
                [`scripts/project/${slug}/script.ts`]: exampleScript("project", slug)
            })
            assert.deepEqual(messages(report), [], slug)
        }
    })
    it("allows a top-level return and await, as the Studio runs a function body", async () => {
        const report = await validate({
            "scripts/project/early/meta.json": meta(),
            "scripts/project/early/script.ts": "// early\nif (!await openDAW.hasProject()) {return}\nconst project = await openDAW.getProject()\nproject.openInStudio()\n"
        })
        assert.deepEqual(messages(report), [])
    })
    it("reports type errors with the line in the original file", async () => {
        const source = "import {Api} from \"@opendaw/studio-scripting\"\n\nconst openDAW: Api = undefined as never\n\n// body\nconst bpm: number = \"fast\"\nopenDAW.nope()\n"
        const report = await validate({"scripts/project/bad/meta.json": meta(), "scripts/project/bad/script.ts": source})
        expectErrors(report, messages(report), /line 6:7 Type 'string' is not assignable to type 'number'/,
            /line 7:9 Property 'nope' does not exist on type 'Api'/)
    })
    it("rejects imports in the body", async () => {
        const report = await validate({
            "scripts/project/imports/meta.json": meta(),
            "scripts/project/imports/script.ts": "// body\nimport {x} from \"y\"\n"
        })
        expectErrors(report, messages(report), /Imports only work in the preamble/)
    })
    it("rejects a preamble without a body", async () => {
        const report = await validate({
            "scripts/project/empty/meta.json": meta(),
            "scripts/project/empty/script.ts": "import {Api} from \"@opendaw/studio-scripting\"\n"
        })
        expectErrors(report, messages(report), /empty after its import preamble/)
    })
    it("syntax checks JavaScript project scripts", async () => {
        const report = await validate({"scripts/project/js/meta.json": meta(), "scripts/project/js/script.js": "// js\nconst = 1\n"})
        expectErrors(report, messages(report), /scripts\/project\/js\/script.js: SyntaxError/)
    })
    it("strips the preamble exactly like the Studio", () => {
        assert.equal(ProjectScripts.bodyOf("import a from \"b\"\nconst x = 1\n// start\ncode()"), "// start\ncode()")
        assert.equal(ProjectScripts.bodyOf("// no imports\ncode()"), "// no imports\ncode()")
        assert.equal(ProjectScripts.bodyOf("code() // trailing"), "code() // trailing")
    })
})

describe("presets", () => {
    const preset = (bytes: Uint8Array, cloud: CloudIndex = EmptyCloud) =>
        validate({"presets/demo/meta.json": meta(), "presets/demo/preset.odp": bytes}, cloud)
    it("accepts a stock effect preset and reports its device", async () => {
        const report = await preset(asset("delay.odp"))
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].details.category, "audio-effect")
        assert.equal(report.items[0].details.device, "Delay")
    })
    it("checks scripts embedded in a preset", async () => {
        const report = await preset(asset("werkstatt.odp"))
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].details.scripts, 1)
    })
    it("rejects samples that are not in the cloud and accepts them once they are", async () => {
        const missing = await preset(asset("playfield.odp"))
        const list = messages(missing)
        expectErrors(missing, list, /AudioFileBox [0-9a-f-]{36} \(".*"\) is not an openDAW cloud sample/)
        const uuids = list.map(message => /AudioFileBox ([0-9a-f-]{36})/.exec(message)?.[1]).filter(uuid => uuid !== undefined)
        assert.equal(uuids.length, 16)
        const present = await preset(asset("playfield.odp"), {...EmptyCloud, samples: new Set(uuids)})
        assert.deepEqual(messages(present), [])
    })
    it("rejects soundfonts and WebCLAPs that are not in the cloud", async () => {
        const soundfont = await preset(asset("soundfont.odp"))
        expectErrors(soundfont, messages(soundfont), /SoundfontFileBox .* is not an openDAW cloud soundfont/)
        const wclap = await preset(asset("wclap.odp"))
        expectErrors(wclap, messages(wclap), /WclapInstrumentBox .* uses the WebCLAP "opfs:74309023/)
        const known = await preset(asset("wclap.odp"), {...EmptyCloud, wclaps: new Set(["74309023-461a-4633-8f54-39727eb8c260"])})
        assert.deepEqual(messages(known), [])
    })
    it("rejects files that are not presets", async () => {
        const garbage = await preset(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9]))
        expectErrors(garbage, messages(garbage), /Not an openDAW preset/)
        const empty = await preset(new Uint8Array())
        expectErrors(empty, messages(empty), /Not an openDAW preset/)
    })
    it("rejects a truncated preset", async () => {
        const bytes = asset("delay.odp")
        const report = await preset(bytes.slice(0, bytes.length - 100))
        expectErrors(report, messages(report), /Could not decode the preset/)
    })
})

describe("wclaps", () => {
    it("needs a non-empty source folder", async () => {
        const missing = await validate({"wclaps/synth/meta.json": meta({license: "MIT", credits: ""})})
        expectErrors(missing, messages(missing), /Needs a source\/ folder/)
        const empty = await validate({"wclaps/synth/meta.json": meta({license: "MIT", credits: ""}), "wclaps/synth/source/.gitkeep": ""})
        expectErrors(empty, messages(empty), /source folder is empty/)
    })
})

describe("summary", () => {
    it("lists only the items the pull request touches, plus removed ones", async () => {
        const report = await validate({
            "scripts/project/one/meta.json": meta({name: "One"}),
            "scripts/project/one/script.ts": "// one\n",
            "scripts/project/two/meta.json": meta({name: "Two | Pipe"}),
            "scripts/project/two/script.ts": "// two\n"
        })
        const markdown = Summary.markdown(report, ["scripts/project/two/meta.json", "presets/gone/preset.odp", "README.md"])
        assert.ok(markdown.startsWith(Summary.MARKER))
        assert.match(markdown, /✅ openDAW Commons check passed/)
        assert.match(markdown, /`scripts\/project\/two` \| Two \\\| Pipe/)
        assert.doesNotMatch(markdown, /scripts\/project\/one/)
        assert.match(markdown, /### Removed\n\n- `presets\/gone`/)
    })
    it("lists every error when the check fails", async () => {
        const report = await validate({"presets/Bad/meta.json": meta()})
        const markdown = Summary.markdown(report, [])
        assert.match(markdown, /❌ openDAW Commons check failed/)
        assert.match(markdown, /- `presets\/Bad` "Bad" is not a valid slug/)
    })
})
