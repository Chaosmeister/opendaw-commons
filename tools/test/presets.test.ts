import {describe, it} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {makeRepo, messages, RepoRoot, validate} from "./helpers.ts"
import {Build, CommunityPreset, uuidOf} from "../src/Build.ts"
import {deviceFolderOf, discover} from "../src/Layout.ts"
import {CloudAssets, Presets} from "../src/Presets.ts"
import {Report} from "../src/Report.ts"
import {Remote, Upload} from "../src/Upload.ts"
import {Summary} from "../src/Summary.ts"
import {Validator} from "../src/Validator.ts"
import {ByteArrayOutput, UUID} from "@opendaw/lib-std"
import {PresetHeader} from "@opendaw/studio-adapters"

// real stock presets: Delay without samples, Playfield with cloud samples
const stock = (device: string, slug: string): Uint8Array =>
    new Uint8Array(fs.readFileSync(path.join(RepoRoot, "presets", device, slug, "preset.odp")))
const DELAY = stock("delay", "flanger")
const PLAYFIELD = stock("playfield", "tr-909")

const presetMeta = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    name: "Test Preset",
    description: "A test preset.",
    author: {name: "Tester"},
    tags: ["test"],
    license: "CC0-1.0",
    device: "Delay",
    ...overrides
})

const delayAt = (folder: string, overrides: Record<string, unknown> = {}) => ({
    [`${folder}/meta.json`]: presetMeta(overrides),
    [`${folder}/preset.odp`]: DELAY
})

const fakeAssets = (samples: ReadonlyArray<string>): CloudAssets => ({
    hasSample: async uuid => samples.includes(uuid),
    hasSoundfont: async () => true,
    sizeOf: async () => 1000
})

describe("Preset layout and meta", () => {
    it("accepts a stock preset", () => {
        const report = validate(delayAt("presets/delay/flanger"))
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].group, "presets/delay")
        assert.equal(report.items[0].details.timeline, false)
    })
    it("accepts every stock preset in the repo", () => {
        const report = Validator.run(RepoRoot)
        assert.deepEqual(messages(report), [])
        assert.equal(report.items.filter(item => item.group.startsWith("presets/")).length, 71)
    })
    it("names device folders in lowercase with hyphens", () => {
        assert.match(messages(validate(delayAt("presets/Delay/flanger"))).join(), /folder named after their device in lowercase/)
        assert.match(messages(validate({"presets/flanger.odp": DELAY})).join(), /folder named after their device in lowercase/)
        assert.deepEqual(["MIDIOutput", "DattorroReverb", "StereoTool", "OpenDrumKick", "Delay"].map(deviceFolderOf),
            ["midi-output", "dattorro-reverb", "stereo-tool", "open-drum-kick", "delay"])
    })
    it("rejects a device that differs from its folder", () => {
        assert.match(messages(validate(delayAt("presets/crusher/flanger"))).join(), /device Delay belongs into the delay folder, not into crusher/)
        assert.match(messages(validate(delayAt("presets/delay/flanger", {device: undefined}))).join(), /device is missing/)
    })
    it("rejects a preset that holds another device", () => {
        assert.match(messages(validate(delayAt("presets/crusher/flanger", {device: "Crusher"}))).join(), /holds no Crusher device/)
    })
    it("needs preset.odp and rejects other files", () => {
        assert.match(messages(validate({"presets/delay/flanger/meta.json": presetMeta()})).join(), /Missing preset.odp/)
        const extra = validate({...delayAt("presets/delay/flanger"), "presets/delay/flanger/notes.txt": "x"})
        assert.match(messages(extra).join(), /Unexpected file/)
    })
    it("rejects a file that is no preset", () => {
        const report = validate({"presets/delay/flanger/meta.json": presetMeta(), "presets/delay/flanger/preset.odp": "not a preset"})
        assert.match(messages(report).join(), /not an openDAW preset/)
        const short = validate({"presets/delay/flanger/meta.json": presetMeta(), "presets/delay/flanger/preset.odp": "abc"})
        assert.match(messages(short).join(), /too short/)
    })
    it("needs credits for CC-BY-SA and allows them for CC0", () => {
        assert.match(messages(validate(delayAt("presets/delay/flanger", {license: "CC-BY-SA-4.0"}))).join(), /credits/)
        assert.deepEqual(messages(validate(delayAt("presets/delay/flanger", {license: "CC-BY-SA-4.0", credits: "Someone"}))), [])
        assert.deepEqual(messages(validate(delayAt("presets/delay/flanger", {credits: "Someone"}))), [])
    })
    it("rejects other licenses and fields the CI computes", () => {
        assert.match(messages(validate(delayAt("presets/delay/flanger", {license: "MIT"}))).join(), /license/)
        assert.match(messages(validate(delayAt("presets/delay/flanger", {category: "audio-effect"}))).join(), /category/)
        assert.match(messages(validate(delayAt("presets/delay/flanger", {minApi: 1}))).join(), /minApi/)
        assert.match(messages(validate(delayAt("presets/delay/flanger", {uuid: "11111111-2222-4333-8444-555555555555"}))).join(), /uuid/)
    })
    it("takes racks with their instrument and chains without a device", () => {
        assert.match(messages(validate(delayAt("presets/racks/dub", {device: undefined}))).join(), /A rack needs its instrument as device/)
        assert.match(messages(validate(delayAt("presets/racks/dub", {device: "Vaporisateur"}))).join(), /holds no Vaporisateur device/)
        assert.match(messages(validate(delayAt("presets/audio-effect-chains/dub"))).join(), /A chain has no device/)
        const chain = validate(delayAt("presets/audio-effect-chains/dub", {device: undefined}))
        assert.deepEqual(messages(chain), [])
        assert.equal(chain.items[0].details.kind, "audio-effect-chain")
    })
    it("needs a description and allows a folder", () => {
        assert.match(messages(validate(delayAt("presets/delay/flanger", {description: ""}))).join(), /description/)
        const report = validate(delayAt("presets/delay/flanger", {folder: "Modulation/Flangers"}))
        assert.deepEqual(messages(report), [])
        assert.match(messages(validate(delayAt("presets/delay/flanger", {folder: "/Modulation"}))).join(), /folder/)
    })
    it("rejects a dev preset whose path exists in presets", () => {
        const both = validate({...delayAt("presets/delay/flanger"), ...delayAt("dev/presets/delay/flanger")})
        assert.match(messages(both).join(), /presets\/delay\/flanger exists already/)
    })
    it("gives a dev preset the id it keeps in presets", () => {
        const dev = validate(delayAt("dev/presets/delay/flanger")).items[0].details.id
        const release = validate(delayAt("presets/delay/flanger")).items[0].details.id
        assert.equal(dev, release)
        assert.equal(release, uuidOf({path: "presets/delay/flanger"}))
    })
})

describe("Dev presets", () => {
    it("checks only meta.json", () => {
        const report = validate({"dev/presets/delay/new/meta.json": presetMeta(), "dev/presets/delay/new/preset.odp": "future boxes"})
        assert.deepEqual(messages(report), [])
        assert.equal(report.items[0].group, "dev/presets/delay")
        assert.equal(report.items[0].details.stage, "dev")
    })
    it("still checks the meta.json", () => {
        const report = validate({"dev/presets/delay/new/meta.json": presetMeta({license: "MIT"}), "dev/presets/delay/new/preset.odp": "x"})
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
            "presets/playfield/kit/meta.json": presetMeta({device: "Playfield"}),
            "presets/playfield/kit/preset.odp": PLAYFIELD
        })
        const report = Validator.run(root)
        await Validator.checkPresetAssets(root, report, fakeAssets(samples()))
        assert.deepEqual(messages(report), [])
    })
    it("names every sample that is not in the cloud", async () => {
        const root = makeRepo({
            "presets/playfield/kit/meta.json": presetMeta({device: "Playfield"}),
            "presets/playfield/kit/preset.odp": PLAYFIELD
        })
        const report = Validator.run(root)
        await Validator.checkPresetAssets(root, report, fakeAssets(samples().slice(1)))
        assert.equal(report.errors.length, 1)
        assert.match(messages(report).join(), new RegExp(`Sample ${samples()[0]} is not a cloud sample`))
    })
    it("skips dev presets", async () => {
        const root = makeRepo({
            "dev/presets/playfield/kit/meta.json": presetMeta({device: "Playfield"}),
            "dev/presets/playfield/kit/preset.odp": PLAYFIELD
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

const buildOf = (files: Record<string, string | Uint8Array>, assetSizes?: ReadonlyMap<string, number>) => {
    const root = makeRepo(files)
    git(root, ["init", "-q"])
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", "init"])
    const report = Validator.run(root)
    assert.deepEqual(messages(report), [])
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "presets-out-"))
    Build.run(discover(root, new Report()), report, {root, out, repository: "owner/repo", now: new Date("2026-11-19T12:00:00Z"), assetSizes})
    return out
}

describe("Preset build", () => {
    const script = {
        "scripts/werkstatt/clip/meta.json": JSON.stringify({name: "Clip", description: "Clips.", author: {name: "T"}, tags: [], license: "CC0-1.0"}),
        "scripts/werkstatt/clip/script.js": "// @label Clip\nclass Processor {}\n"
    }
    it("writes one index per folder with the payloads next to it", () => {
        const out = buildOf({
            ...delayAt("presets/delay/flanger", {folder: "Modulation"}),
            ...delayAt("dev/presets/delay/next", {name: "Next"})
        })
        const read = (group: string) => JSON.parse(fs.readFileSync(path.join(out, group, "index.json"), "utf8")) as { presets: ReadonlyArray<CommunityPreset> }
        const [release] = read("presets").presets
        assert.equal(release.uuid, uuidOf({path: "presets/delay/flanger"}))
        assert.equal(release.kind, "device")
        assert.equal(release.device, "Delay")
        assert.equal(release.folder, "Modulation")
        assert.equal(release.hasTimeline, false)
        assert.equal(release.source, "https://github.com/owner/repo/tree/main/presets/delay/flanger")
        assert.match(release.url, new RegExp(`^${release.uuid}-[0-9a-f]{12}\\.odp$`))
        assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, "presets", release.url))), DELAY)
        const [dev] = read("dev/presets").presets
        assert.equal(dev.name, "Next")
        assert.equal(dev.uuid, uuidOf({path: "presets/delay/next"}))
        assert.ok(fs.existsSync(path.join(out, "dev/presets", dev.url)))
    })
    it("leaves the scripts and WebCLAP indices byte identical", () => {
        const without = buildOf(script)
        const withPresets = buildOf({...script, ...delayAt("presets/delay/flanger"), ...delayAt("dev/presets/delay/next")})
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

// a preset holding one box the SDK does not know and one AudioFileBox, written the way BoxGraph writes boxes
const unknownBoxesPreset = (sample: string): Uint8Array => {
    const boxes = [["FutureSamplerBox", "11111111-2222-4333-8444-555555555555"], ["AudioFileBox", sample]].map(([name, uuid]) => {
        const output = ByteArrayOutput.create()
        output.writeInt(0)
        output.writeString(name)
        output.writeBytes(new Int8Array(UUID.parse(uuid).buffer))
        output.writeInt(42)
        return new Int8Array(output.toArrayBuffer())
    })
    const output = ByteArrayOutput.create()
    output.writeInt(PresetHeader.MAGIC_HEADER_OPEN)
    output.writeInt(PresetHeader.FORMAT_VERSION)
    output.writeInt(boxes.length)
    boxes.forEach(box => {
        output.writeInt(box.byteLength)
        output.writeBytes(box)
    })
    return new Uint8Array(output.toArrayBuffer())
}

describe("Preset download size", () => {
    it("scans the same samples the decoder finds", () => {
        const decoded = Presets.decode(PLAYFIELD)
        const scanned = Presets.scan(PLAYFIELD)
        assert.ok(decoded.ok && scanned.ok)
        assert.ok(scanned.value.samples.length > 0)
        assert.deepEqual(scanned.value.samples.toSorted(), decoded.value.samples.toSorted())
        assert.deepEqual(Presets.scan(DELAY), {ok: true, value: {samples: [], soundfonts: []}})
    })
    it("scans boxes the SDK does not know", () => {
        const sample = "0f0e0d0c-0b0a-4908-8706-050403020100"
        assert.ok(!Presets.decode(unknownBoxesPreset(sample)).ok)
        assert.deepEqual(Presets.scan(unknownBoxesPreset(sample)), {ok: true, value: {samples: [sample], soundfonts: []}})
        assert.match(String((Presets.scan(new TextEncoder().encode("not a preset at all")) as { error: string }).error), /not an openDAW preset/)
    })
    it("asks the cloud once per file", async () => {
        const root = makeRepo({
            "presets/playfield/a/meta.json": presetMeta({device: "Playfield"}), "presets/playfield/a/preset.odp": PLAYFIELD,
            "dev/presets/playfield/b/meta.json": presetMeta({device: "Playfield"}), "dev/presets/playfield/b/preset.odp": PLAYFIELD
        })
        const asked: Array<string> = []
        const sizes = await Presets.sizes(discover(root, new Report()), {
            ...fakeAssets([]), sizeOf: async (kind, uuid) => {
                asked.push(`${kind}/${uuid}`)
                return 1000
            }
        })
        const samples = (Presets.scan(PLAYFIELD) as { value: { samples: ReadonlyArray<string> } }).value.samples
        assert.equal(asked.length, new Set(samples).size)
        assert.equal(sizes.size, new Set(samples).size)
    })
    it("writes samples, soundfonts and the download size into the index", () => {
        const samples = (Presets.scan(PLAYFIELD) as { value: { samples: ReadonlyArray<string> } }).value.samples
        const sample = "0f0e0d0c-0b0a-4908-8706-050403020100"
        const known = new Map([...samples.map(uuid => [uuid, 1000] as const), [sample, 5000]])
        const out = buildOf({
            ...delayAt("presets/delay/flanger"),
            "presets/playfield/kit/meta.json": presetMeta({device: "Playfield", name: "Kit"}),
            "presets/playfield/kit/preset.odp": PLAYFIELD,
            "dev/presets/sampler/next/meta.json": presetMeta({device: "Sampler", name: "Next"}),
            "dev/presets/sampler/next/preset.odp": unknownBoxesPreset(sample)
        }, known)
        const read = (group: string) => JSON.parse(fs.readFileSync(path.join(out, group, "index.json"), "utf8")) as { presets: ReadonlyArray<CommunityPreset> }
        const [kit, flanger] = read("presets").presets
        assert.deepEqual([flanger.samples, flanger.soundfonts, flanger.downloadSize], [[], [], 0])
        assert.equal(kit.samples.length, samples.length)
        assert.equal(kit.downloadSize, samples.length * 1000)
        const [next] = read("dev/presets").presets
        assert.deepEqual([next.samples, next.downloadSize], [[sample], 5000])
    })
    it("writes 0 when a size is unknown", () => {
        const out = buildOf({"presets/playfield/kit/meta.json": presetMeta({device: "Playfield"}), "presets/playfield/kit/preset.odp": PLAYFIELD})
        const [kit] = JSON.parse(fs.readFileSync(path.join(out, "presets/index.json"), "utf8")).presets as ReadonlyArray<CommunityPreset>
        assert.ok(kit.samples.length > 0)
        assert.equal(kit.downloadSize, 0)
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
        const report = validate({...delayAt("presets/delay/flanger"), ...delayAt("dev/presets/delay/next")})
        const markdown = Summary.markdown(report, ["presets/delay/flanger/meta.json", "dev/presets/delay/next/preset.odp", "presets/delay/gone/meta.json"])
        assert.match(markdown, /`presets\/delay\/flanger`/)
        assert.match(markdown, /`dev\/presets\/delay\/next`/)
        assert.match(markdown, /### Removed\n\n- `presets\/delay\/gone`/)
    })
})

describe("Launch", () => {
    it("moves dev presets into presets and validates", () => {
        const root = makeRepo({...delayAt("dev/presets/delay/next")})
        const output = execFileSync("npx", ["tsx", path.join(RepoRoot, "tools/src/launch.ts"), "--root", root], {cwd: path.join(RepoRoot, "tools"), encoding: "utf8"})
        assert.match(output, /→ presets\/delay\/next/)
        assert.match(output, /1 presets moved, 0 errors/)
        assert.ok(fs.existsSync(path.join(root, "presets/delay/next/preset.odp")))
        assert.ok(!fs.existsSync(path.join(root, "dev")))
    })
    it("refuses to overwrite a preset", () => {
        const root = makeRepo({...delayAt("dev/presets/delay/next"), ...delayAt("presets/delay/next")})
        assert.throws(() => execFileSync("npx", ["tsx", path.join(RepoRoot, "tools/src/launch.ts"), "--root", root], {cwd: path.join(RepoRoot, "tools"), stdio: "pipe"}))
        assert.ok(fs.existsSync(path.join(root, "dev/presets/delay/next/preset.odp")))
    })
})
