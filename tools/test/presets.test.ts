import {describe, it} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {makeRepo, messages, RepoRoot, validate} from "./helpers.ts"
import {Build, CommunityPreset} from "../src/Build.ts"
import {discover} from "../src/Layout.ts"
import {CloudAssets, Presets} from "../src/Presets.ts"
import {Report} from "../src/Report.ts"
import {Remote, Upload} from "../src/Upload.ts"
import {Summary} from "../src/Summary.ts"
import {Validator} from "../src/Validator.ts"

// real stock presets: Delay without samples, Playfield with cloud samples
const stock = (device: string, slug: string): Uint8Array =>
    new Uint8Array(fs.readFileSync(path.join(RepoRoot, "presets", device, slug, "preset.odp")))
const DELAY = stock("Delay", "flanger")
const PLAYFIELD = stock("Playfield", "tr-909")

const presetMeta = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    uuid: "11111111-2222-4333-8444-555555555555",
    name: "Test Preset",
    description: "A test preset.",
    author: {name: "Tester"},
    tags: ["test"],
    license: "CC0-1.0",
    category: "audio-effect",
    device: "Delay",
    ...overrides
})

const delayAt = (folder: string, overrides: Record<string, unknown> = {}) => ({
    [`${folder}/meta.json`]: presetMeta(overrides),
    [`${folder}/preset.odp`]: DELAY
})

const fakeAssets = (samples: ReadonlyArray<string>): CloudAssets => ({
    hasSample: async uuid => samples.includes(uuid),
    hasSoundfont: async () => true
})

describe("Preset layout and meta", () => {
    it("accepts a stock preset", () => {
        const report = validate(delayAt("presets/Delay/flanger"))
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].group, "presets/Delay")
        assert.equal(report.items[0].details.timeline, false)
    })
    it("accepts every stock preset in the repo", () => {
        const report = Validator.run(RepoRoot)
        assert.deepEqual(messages(report), [])
        assert.equal(report.items.filter(item => item.group.startsWith("presets/")).length, 71)
    })
    it("needs a device folder named after the device key", () => {
        assert.match(messages(validate(delayAt("presets/delay/flanger"))).join(), /folder named after their device key/)
        assert.match(messages(validate({"presets/flanger.odp": DELAY})).join(), /folder named after their device key/)
    })
    it("rejects a device that differs from its folder", () => {
        assert.match(messages(validate(delayAt("presets/Crusher/flanger"))).join(), /device is Delay but the preset lies in the Crusher folder/)
    })
    it("rejects a preset that holds another device", () => {
        assert.match(messages(validate(delayAt("presets/Crusher/flanger", {device: "Crusher"}))).join(), /holds no Crusher device/)
    })
    it("needs preset.odp and rejects other files", () => {
        assert.match(messages(validate({"presets/Delay/flanger/meta.json": presetMeta()})).join(), /Missing preset.odp/)
        const extra = validate({...delayAt("presets/Delay/flanger"), "presets/Delay/flanger/notes.txt": "x"})
        assert.match(messages(extra).join(), /Unexpected file/)
    })
    it("rejects a file that is no preset", () => {
        const report = validate({"presets/Delay/flanger/meta.json": presetMeta(), "presets/Delay/flanger/preset.odp": "not a preset"})
        assert.match(messages(report).join(), /not an openDAW preset/)
        const short = validate({"presets/Delay/flanger/meta.json": presetMeta(), "presets/Delay/flanger/preset.odp": "abc"})
        assert.match(messages(short).join(), /too short/)
    })
    it("needs credits for CC-BY-SA and allows them for CC0", () => {
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {license: "CC-BY-SA-4.0"}))).join(), /credits/)
        assert.deepEqual(messages(validate(delayAt("presets/Delay/flanger", {license: "CC-BY-SA-4.0", credits: "Someone"}))), [])
        assert.deepEqual(messages(validate(delayAt("presets/Delay/flanger", {credits: "Someone"}))), [])
    })
    it("rejects other licenses, categories and unknown fields", () => {
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {license: "MIT"}))).join(), /license/)
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {category: "audio-effect-chain"}))).join(), /category/)
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {minApi: 1}))).join(), /minApi/)
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {uuid: "not-a-uuid"}))).join(), /uuid/)
    })
    it("needs a description and allows a folder", () => {
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {description: ""}))).join(), /description/)
        const report = validate(delayAt("presets/Delay/flanger", {folder: "Modulation/Flangers"}))
        assert.deepEqual(messages(report), [])
        assert.match(messages(validate(delayAt("presets/Delay/flanger", {folder: "/Modulation"}))).join(), /folder/)
    })
    it("rejects a uuid used twice, also across presets and dev/presets", () => {
        const twice = validate({...delayAt("presets/Delay/flanger"), ...delayAt("presets/Delay/flanger-2")})
        assert.match(messages(twice).join(), /already used by presets\/Delay\/flanger/)
        const across = validate({...delayAt("presets/Delay/flanger"), ...delayAt("dev/presets/Delay/flanger-2")})
        assert.match(messages(across).join(), /already used/)
    })
})

describe("Dev presets", () => {
    it("checks only meta.json", () => {
        const report = validate({"dev/presets/Delay/new/meta.json": presetMeta(), "dev/presets/Delay/new/preset.odp": "future boxes"})
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].group, "dev/presets/Delay")
        assert.equal(report.items[0].details.stage, "dev")
    })
    it("still checks the meta.json", () => {
        const report = validate({"dev/presets/Delay/new/meta.json": presetMeta({license: "MIT"}), "dev/presets/Delay/new/preset.odp": "x"})
        assert.match(messages(report).join(), /license/)
    })
    it("allows only presets in dev", () => {
        assert.match(messages(validate({"dev/scripts/x/meta.json": "{}"})).join(), /Only presets\/ belongs into dev/)
    })
})

describe("Preset cloud assets", () => {
    const samples = (): ReadonlyArray<string> => {
        const decoded = Presets.decode(PLAYFIELD)
        assert.ok(decoded.ok)
        return decoded.value.samples
    }
    it("passes when every sample is in the cloud", async () => {
        const root = makeRepo({
            "presets/Playfield/kit/meta.json": presetMeta({device: "Playfield", category: "instrument"}),
            "presets/Playfield/kit/preset.odp": PLAYFIELD
        })
        const report = Validator.run(root)
        await Validator.checkPresetAssets(root, report, fakeAssets(samples()))
        assert.deepEqual(messages(report), [])
    })
    it("names every sample that is not in the cloud", async () => {
        const root = makeRepo({
            "presets/Playfield/kit/meta.json": presetMeta({device: "Playfield", category: "instrument"}),
            "presets/Playfield/kit/preset.odp": PLAYFIELD
        })
        const report = Validator.run(root)
        await Validator.checkPresetAssets(root, report, fakeAssets(samples().slice(1)))
        assert.equal(report.errors.length, 1)
        assert.match(messages(report).join(), new RegExp(`Sample ${samples()[0]} is not a cloud sample`))
    })
    it("skips dev presets", async () => {
        const root = makeRepo({
            "dev/presets/Playfield/kit/meta.json": presetMeta({device: "Playfield", category: "instrument"}),
            "dev/presets/Playfield/kit/preset.odp": PLAYFIELD
        })
        const report = Validator.run(root)
        await Validator.checkPresetAssets(root, report, fakeAssets([]))
        assert.deepEqual(messages(report), [])
    })
})

const git = (root: string, args: ReadonlyArray<string>): void => {
    const env = {...process.env, GIT_AUTHOR_DATE: "2026-01-01T00:00:00Z", GIT_COMMITTER_DATE: "2026-01-01T00:00:00Z"}
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {cwd: root, env, stdio: "pipe"})
}

const buildOf = (files: Record<string, string | Uint8Array>) => {
    const root = makeRepo(files)
    git(root, ["init", "-q"])
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "init"])
    const report = Validator.run(root)
    assert.deepEqual(messages(report), [])
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "presets-out-"))
    Build.run(discover(root, new Report()), report, {root, out, repository: "owner/repo", now: new Date("2026-11-19T12:00:00Z")})
    return out
}

describe("Preset build", () => {
    const script = {
        "scripts/werkstatt/clip/meta.json": JSON.stringify({name: "Clip", description: "Clips.", author: {name: "T"}, tags: [], license: "CC0-1.0"}),
        "scripts/werkstatt/clip/script.js": "// @label Clip\nclass Processor {}\n"
    }
    it("writes one index per folder with the payloads next to it", () => {
        const out = buildOf({
            ...delayAt("presets/Delay/flanger", {folder: "Modulation"}),
            ...delayAt("dev/presets/Delay/next", {uuid: "99999999-2222-4333-8444-555555555555", name: "Next"})
        })
        const read = (group: string) => JSON.parse(fs.readFileSync(path.join(out, group, "index.json"), "utf8")) as { presets: ReadonlyArray<CommunityPreset> }
        const [release] = read("presets").presets
        assert.equal(release.uuid, "11111111-2222-4333-8444-555555555555")
        assert.equal(release.device, "Delay")
        assert.equal(release.folder, "Modulation")
        assert.equal(release.hasTimeline, false)
        assert.equal(release.source, "https://github.com/owner/repo/tree/main/presets/Delay/flanger")
        assert.match(release.url, /^11111111-2222-4333-8444-555555555555-[0-9a-f]{12}\.odp$/)
        assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, "presets", release.url))), DELAY)
        const [dev] = read("dev/presets").presets
        assert.equal(dev.name, "Next")
        assert.ok(fs.existsSync(path.join(out, "dev/presets", dev.url)))
    })
    it("leaves the scripts and WebCLAP indices byte identical", () => {
        const without = buildOf(script)
        const withPresets = buildOf({...script, ...delayAt("presets/Delay/flanger"), ...delayAt("dev/presets/Delay/next", {uuid: "99999999-2222-4333-8444-555555555555"})})
        for (const file of ["scripts/index.json", "wclaps/index.json"]) {
            assert.equal(fs.readFileSync(path.join(withPresets, file), "utf8"), fs.readFileSync(path.join(without, file), "utf8"))
        }
    })
    it("writes empty preset indices without presets", () => {
        const out = buildOf(script)
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "presets/index.json"), "utf8")).presets, [])
        assert.deepEqual(JSON.parse(fs.readFileSync(path.join(out, "dev/presets/index.json"), "utf8")).presets, [])
    })
})

describe("Preset upload", () => {
    it("uploads dev/presets as its own group, indices last", async () => {
        const from = fs.mkdtempSync(path.join(os.tmpdir(), "upload-presets-"))
        for (const file of ["presets/a.odp", "presets/index.json", "dev/presets/b.odp", "dev/presets/index.json", "scripts/index.json"]) {
            fs.mkdirSync(path.join(from, path.dirname(file)), {recursive: true})
            fs.writeFileSync(path.join(from, file), file)
        }
        const puts: Array<string> = []
        const remote: Remote = {list: async () => [], mkdir: async () => {}, put: async (_, target) => {puts.push(target)}}
        await Upload.run(from, "/community", remote)
        assert.deepEqual(puts.slice(0, 2).toSorted(), ["/community/dev/presets/b.odp", "/community/presets/a.odp"])
        assert.deepEqual(puts.slice(2).toSorted(), ["/community/dev/presets/index.json", "/community/presets/index.json", "/community/scripts/index.json"])
    })
})

describe("Preset summary", () => {
    it("lists presets and dev presets a pull request touches", () => {
        const report = validate({...delayAt("presets/Delay/flanger"), ...delayAt("dev/presets/Delay/next", {uuid: "99999999-2222-4333-8444-555555555555"})})
        const markdown = Summary.markdown(report, ["presets/Delay/flanger/meta.json", "dev/presets/Delay/next/preset.odp", "presets/Delay/gone/meta.json"])
        assert.match(markdown, /`presets\/Delay\/flanger`/)
        assert.match(markdown, /`dev\/presets\/Delay\/next`/)
        assert.match(markdown, /### Removed\n\n- `presets\/Delay\/gone`/)
    })
})

describe("Launch", () => {
    it("moves dev presets into presets and validates", () => {
        const root = makeRepo({...delayAt("dev/presets/Delay/next")})
        const output = execFileSync("npx", ["tsx", path.join(RepoRoot, "tools/src/launch.ts"), "--root", root], {cwd: path.join(RepoRoot, "tools"), encoding: "utf8"})
        assert.match(output, /→ presets\/Delay\/next/)
        assert.match(output, /1 presets moved, 0 errors/)
        assert.ok(fs.existsSync(path.join(root, "presets/Delay/next/preset.odp")))
        assert.ok(!fs.existsSync(path.join(root, "dev")))
    })
    it("refuses to overwrite a preset", () => {
        const root = makeRepo({...delayAt("dev/presets/Delay/next"), ...delayAt("presets/Delay/next", {uuid: "99999999-2222-4333-8444-555555555555"})})
        assert.throws(() => execFileSync("npx", ["tsx", path.join(RepoRoot, "tools/src/launch.ts"), "--root", root], {cwd: path.join(RepoRoot, "tools"), stdio: "pipe"}))
        assert.ok(fs.existsSync(path.join(root, "dev/presets/Delay/next/preset.odp")))
    })
})
