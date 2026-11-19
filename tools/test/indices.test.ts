import {describe, it} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {makeRepo, RepoRoot} from "./helpers.ts"
import {Build} from "../src/Build.ts"
import {Indices} from "../src/Indices.ts"
import {discover} from "../src/Layout.ts"
import {Report} from "../src/Report.ts"
import {Validator} from "../src/Validator.ts"

const DELAY = new Uint8Array(fs.readFileSync(path.join(RepoRoot, "presets", "delay", "flanger", "preset.odp")))

const repo = () => {
    const root = makeRepo({
        "presets/delay/flanger/meta.json": JSON.stringify({
            name: "Flanger", description: "A flanger.", author: {name: "T"}, tags: [], license: "CC0-1.0", device: "Delay"
        }),
        "presets/delay/flanger/preset.odp": DELAY,
        "scripts/werkstatt/clip/meta.json": JSON.stringify({name: "Clip", description: "Clips.", author: {name: "T"}, tags: [], license: "CC0-1.0"}),
        "scripts/werkstatt/clip/script.js": "// @label Clip\nclass Processor {}\n"
    })
    const git = (args: ReadonlyArray<string>) => execFileSync("git", ["-c", "user.name=T", "-c", "user.email=t@example.com", ...args], {cwd: root, stdio: "pipe"})
    git(["init", "-q"])
    git(["add", "-A"])
    git(["commit", "-q", "-m", "init"])
    return root
}

const build = (presetsOnly: boolean, now: Date) => {
    const root = repo()
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "indices-out-"))
    Build.run(discover(root, new Report()), Validator.run(root), {root, out, repository: "owner/repo", now, presetsOnly})
    return out
}

const read = (out: string, group: string): unknown => JSON.parse(fs.readFileSync(path.join(out, group, "index.json"), "utf8"))

describe("Presets only build", () => {
    it("writes the preset indices and nothing else", () => {
        const out = build(true, new Date("2026-11-19T12:00:00Z"))
        assert.ok(fs.existsSync(path.join(out, "presets", "index.json")))
        assert.ok(fs.existsSync(path.join(out, "dev", "presets", "index.json")))
        assert.ok(!fs.existsSync(path.join(out, "scripts")))
        assert.ok(!fs.existsSync(path.join(out, "wclaps")))
    })
    it("writes the same preset index as a full build", () => {
        const now = new Date("2026-11-19T12:00:00Z")
        assert.deepEqual(read(build(true, now), "presets"), read(build(false, now), "presets"))
    })
})

describe("Unchanged indices", () => {
    it("drops an index that only differs in updatedAt and keeps a changed one", () => {
        const before = build(false, new Date("2026-11-18T12:00:00Z"))
        const live = new Map(Indices.Groups.map(group => [group, read(before, group)]))
        const changedScripts = read(before, "scripts") as { scripts: Array<unknown> }
        live.set("scripts", {...changedScripts, scripts: []})
        const out = build(false, new Date("2026-11-19T12:00:00Z"))
        const dropped = Indices.dropUnchanged(out, live)
        assert.deepEqual(dropped.toSorted(), ["dev/presets", "presets", "wclaps"])
        assert.ok(fs.existsSync(path.join(out, "scripts", "index.json")))
        assert.ok(!fs.existsSync(path.join(out, "presets", "index.json")))
        assert.ok(fs.readdirSync(path.join(out, "presets")).some(name => name.endsWith(".odp")))
    })
    it("keeps an index the server does not have yet", () => {
        const out = build(true, new Date())
        assert.deepEqual(Indices.dropUnchanged(out, new Map()), [])
        assert.ok(fs.existsSync(path.join(out, "presets", "index.json")))
    })
})
