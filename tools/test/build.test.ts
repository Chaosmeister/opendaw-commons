import {describe, it} from "node:test"
import assert from "node:assert/strict"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {makeRepo, meta} from "./helpers.ts"
import {Build, CommunityScript, CommunityWclap, uuidOf} from "../src/Build.ts"
import {Wclaps} from "../src/Wclaps.ts"
import {UUID} from "@opendaw/lib-std"
import {discover, Item} from "../src/Layout.ts"
import {Report} from "../src/Report.ts"
import {Remote, Upload} from "../src/Upload.ts"
import {Validator} from "../src/Validator.ts"

const git = (root: string, args: ReadonlyArray<string>, date?: string): void => {
    const env = {...process.env, GIT_AUTHOR_DATE: date ?? "", GIT_COMMITTER_DATE: date ?? ""}
    execFileSync("git", ["-c", "user.name=Test", "-c", "user.email=test@example.com", ...args], {cwd: root, env, stdio: "pipe"})
}

const commitAll = (root: string, message: string, date: string): void => {
    git(root, ["add", "-A"])
    git(root, ["commit", "-q", "-m", message], date)
}

const build = async (root: string) => {
    const report = Validator.run(root)
    assert.deepEqual(report.errors, [])
    const out = fs.mkdtempSync(path.join(os.tmpdir(), "community-out-"))
    Build.run(discover(root, new Report()), report, {root, out, repository: "owner/repo", now: new Date("2026-10-22T12:00:00Z")})
    const read = <T>(group: string): T => JSON.parse(fs.readFileSync(path.join(out, group, "index.json"), "utf8")) as T
    return {out, read}
}

const PROJECT_SCRIPT = "import {Api} from \"@opendaw/studio-scripting\"\n\nconst openDAW: Api = undefined as never\n\n// Hello\nconsole.log(openDAW)\n"

describe("uuidOf", () => {
    const item = (itemPath: string): Item => ({group: "wclaps", target: undefined, slug: path.basename(itemPath), path: itemPath, absolute: ""})
    it("is stable, well formed and differs per path", () => {
        const first = uuidOf(item("wclaps/acid"))
        assert.equal(first, uuidOf(item("wclaps/acid")))
        assert.match(first, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
        assert.notEqual(first, uuidOf(item("wclaps/acid-2")))
        assert.notEqual(uuidOf(item("scripts/apparat/acid")), uuidOf(item("scripts/werkstatt/acid")))
    })
})

describe("Build", () => {
    it("writes scripts and an empty WebCLAP folder", async () => {
        const root = makeRepo({
            "scripts/project/hello/meta.json": meta({name: "Hello"}),
            "scripts/project/hello/script.ts": PROJECT_SCRIPT,
            "scripts/werkstatt/clip/meta.json": meta({name: "Clip"}),
            "scripts/werkstatt/clip/script.js": "// @label Clip\nclass Processor {}\n"
        })
        git(root, ["init", "-q"])
        commitAll(root, "first", "2026-01-01T00:00:00Z")
        fs.appendFileSync(path.join(root, "scripts/project/hello/script.ts"), "// more\n")
        commitAll(root, "second", "2026-02-01T00:00:00Z")
        const {out, read} = await build(root)
        const index = read<{ version: number, updatedAt: string, scripts: ReadonlyArray<CommunityScript> }>("scripts")
        assert.equal(index.version, 1)
        assert.equal(index.updatedAt, "2026-10-22T12:00:00.000Z")
        assert.ok(!fs.existsSync(path.join(out, "presets")))
        const scripts = index.scripts
        assert.deepEqual(scripts.map(script => script.name), ["Clip", "Hello"])
        const hello = scripts[1]
        assert.equal(hello.target, "project")
        assert.equal(hello.slug, "hello")
        assert.equal(hello.source, "https://github.com/owner/repo/tree/main/scripts/project/hello")
        assert.match(hello.url, new RegExp(`^${hello.uuid}-[0-9a-f]{12}\\.ts$`))
        assert.equal(scripts[0].created, Date.parse("2026-01-01T00:00:00Z"))
        assert.equal(scripts[0].modified, Date.parse("2026-01-01T00:00:00Z"))
        assert.equal(hello.language, "ts")
        assert.equal(hello.created, Date.parse("2026-01-01T00:00:00Z"))
        assert.equal(hello.modified, Date.parse("2026-02-01T00:00:00Z"))
        assert.equal(fs.readFileSync(path.join(out, "scripts", hello.url), "utf8"), "// Hello\nconsole.log(openDAW)\n// more\n")
        assert.equal(hello.size, Buffer.byteLength("// Hello\nconsole.log(openDAW)\n// more\n"))
        assert.equal(scripts[0].details.label, "Clip")
        assert.equal(fs.readFileSync(path.join(out, "scripts", scripts[0].url), "utf8"), "// @label Clip\nclass Processor {}\n")
        assert.deepEqual(read<{ folders: unknown }>("wclaps").folders, [{name: "Community", wclaps: []}])
    })
    it("keeps the uuid and changes the file name when the content changes", async () => {
        const files = (code: string) => ({"scripts/apparat/tone/meta.json": meta(), "scripts/apparat/tone/script.js": code})
        const repo = (code: string): string => {
            const root = makeRepo(files(code))
            git(root, ["init", "-q"])
            commitAll(root, "init", "2026-01-01T00:00:00Z")
            return root
        }
        const first = repo("// one\nclass Processor {}\n")
        const second = repo("// two\nclass Processor {}\n")
        const [a] = (await build(first)).read<{ scripts: ReadonlyArray<CommunityScript> }>("scripts").scripts
        const [b] = (await build(second)).read<{ scripts: ReadonlyArray<CommunityScript> }>("scripts").scripts
        assert.equal(a.uuid, b.uuid)
        assert.notEqual(a.url, b.url)
    })
})

describe("WebCLAP index", () => {
    const plugin = {clapId: "test.synth", name: "Synth", vendor: "Tester", features: ["instrument"]}
    const wclapRepo = () => {
        const root = makeRepo({
            "wclaps/synth/meta.json": meta({name: "Synth", license: "MIT", credits: "Thanks"}),
            "wclaps/synth/source/build.sh": "true"
        })
        git(root, ["init", "-q"])
        commitAll(root, "init", "2026-01-01T00:00:00Z")
        return root
    }
    const buildWith = async (root: string, bytes: Uint8Array, previousWclaps: ReadonlyArray<CommunityWclap> = []) => {
        const report = Validator.run(root)
        assert.deepEqual(report.errors, [])
        const uuid = await Wclaps.uuidOf(bytes)
        const out = fs.mkdtempSync(path.join(os.tmpdir(), "community-wclap-"))
        Build.run(discover(root, new Report()), report, {
            root, out, repository: "owner/repo", now: new Date("2026-10-22T12:00:00Z"),
            wclaps: new Map([["wclaps/synth", {uuid, bytes, plugins: [plugin]}]]), previousWclaps
        })
        const index = JSON.parse(fs.readFileSync(path.join(out, "wclaps", "index.json"), "utf8"))
        return {out, uuid, index, entry: index.folders[0].wclaps[0] as CommunityWclap}
    }
    it("ids a bundle exactly like the Studio: the first 16 bytes of its SHA-256, formatted with version 4 bits", async () => {
        const bytes = new TextEncoder().encode("bundle")
        assert.equal(await Wclaps.uuidOf(bytes), UUID.toString(await UUID.sha256(bytes.slice().buffer)))
        assert.equal(await Wclaps.uuidOf(bytes), "1e6ed65d-77d6-464e-aaed-5a745ba5c498")
    })
    it("writes a WclapIndex with one Community folder and the bundle under its id", async () => {
        const bytes = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0])
        const {out, uuid, index, entry} = await buildWith(wclapRepo(), bytes)
        assert.equal(index.version, 1)
        assert.deepEqual(index.folders.map((folder: { name: string }) => folder.name), ["Community"])
        assert.deepEqual(entry, {
            uuid, slug: "synth", name: "Synth", size: 8, url: "https://github.com/owner/repo/tree/main/wclaps/synth",
            credits: "Thanks", license: "MIT", plugins: [plugin], supersedes: []
        })
        assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(out, "wclaps", `${uuid}.wclap`))), bytes)
    })
    it("lists older builds of the same slug in supersedes, without repeats or itself", async () => {
        const root = wclapRepo()
        const bytes = new Uint8Array([1, 2, 3])
        const previous = (uuid: string, supersedes: ReadonlyArray<string>): CommunityWclap => ({
            uuid, slug: "synth", name: "Synth", size: 3, url: "", credits: "", license: "MIT", plugins: [], supersedes
        })
        const fresh = await Wclaps.uuidOf(bytes)
        assert.deepEqual((await buildWith(root, bytes, [previous("old-2", ["old-1"])])).entry.supersedes, ["old-1", "old-2"])
        assert.deepEqual((await buildWith(root, bytes, [previous(fresh, ["old-1"])])).entry.supersedes, ["old-1"])
        assert.deepEqual((await buildWith(root, bytes, [previous("old-2", ["old-1", "old-2", fresh])])).entry.supersedes, ["old-1", "old-2"])
        assert.deepEqual((await buildWith(root, bytes, [{...previous("other", []), slug: "else"}])).entry.supersedes, [])
    })
    it("leaves an item out when it was not built", async () => {
        const root = wclapRepo()
        const report = Validator.run(root)
        const out = fs.mkdtempSync(path.join(os.tmpdir(), "community-wclap-"))
        Build.run(discover(root, new Report()), report, {root, out, repository: "owner/repo", now: new Date()})
        const index = JSON.parse(fs.readFileSync(path.join(out, "wclaps", "index.json"), "utf8"))
        assert.deepEqual(index.folders, [{name: "Community", wclaps: []}])
    })
})

describe("Upload", () => {
    const memoryRemote = (initial: Record<string, ReadonlyArray<string>> = {}) => {
        const calls: Array<string> = []
        const files = new Map<string, Set<string>>(Object.entries(initial).map(([directory, names]) => [directory, new Set(names)]))
        const remote: Remote = {
            list: async directory => Array.from(files.get(directory) ?? []),
            mkdir: async directory => {
                calls.push(`mkdir ${directory}`)
                if (!files.has(directory)) {files.set(directory, new Set())}
            },
            put: async (_, target) => {
                calls.push(`put ${target}`)
                files.get(path.posix.dirname(target))?.add(path.posix.basename(target))
            }
        }
        return {remote, calls}
    }
    const local = (): string => {
        const from = fs.mkdtempSync(path.join(os.tmpdir(), "upload-"))
        for (const file of ["scripts/a.js", "scripts/b.ts", "scripts/index.json", "wclaps/c.tar.gz", "wclaps/index.json"]) {
            fs.mkdirSync(path.join(from, path.dirname(file)), {recursive: true})
            fs.writeFileSync(path.join(from, file), file)
        }
        return from
    }
    it("uploads payloads first and indices last", async () => {
        const {remote, calls} = memoryRemote()
        const result = await Upload.run(local(), "/community", remote)
        assert.equal(result.skipped, 0)
        const puts = calls.filter(call => call.startsWith("put "))
        assert.deepEqual(puts.slice(-2), ["put /community/scripts/index.json", "put /community/wclaps/index.json"])
        assert.equal(puts.length, 5)
        assert.ok(calls.includes("mkdir /community/scripts"))
    })
    it("skips payloads that are already there but always replaces the indices", async () => {
        const {remote, calls} = memoryRemote({"/community/scripts": ["a.js", "index.json"]})
        const result = await Upload.run(local(), "/community", remote)
        assert.equal(result.skipped, 1)
        assert.ok(!calls.includes("put /community/scripts/a.js"))
        assert.ok(calls.includes("put /community/scripts/index.json"))
    })
})
