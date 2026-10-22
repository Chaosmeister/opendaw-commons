import "../src/NodeEnvironment.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {CloudIndex} from "../src/CloudIndex.ts"
import {Report} from "../src/Report.ts"
import {Validator} from "../src/Validator.ts"

export const RepoRoot = path.resolve(import.meta.dirname, "../..")
export const Assets = path.resolve(import.meta.dirname, "assets")

export type Files = Record<string, string | Uint8Array>

export const EmptyCloud: CloudIndex = {samples: new Set(), soundfonts: new Set(), wclaps: new Set()}

export const meta = (overrides: Record<string, unknown> = {}): string => JSON.stringify({
    name: "Test Item",
    description: "A test item.",
    author: {name: "Tester", github: "tester"},
    tags: ["test"],
    license: "CC0-1.0",
    ...overrides
})

export const makeRepo = (files: Files): string => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "commons-"))
    fs.cpSync(path.join(RepoRoot, "schemas"), path.join(root, "schemas"), {recursive: true})
    for (const [file, content] of Object.entries(files)) {
        const absolute = path.join(root, file)
        fs.mkdirSync(path.dirname(absolute), {recursive: true})
        fs.writeFileSync(absolute, content)
    }
    return root
}

export const validate = (files: Files, cloud: CloudIndex = EmptyCloud): Promise<Report> =>
    Validator.run(makeRepo(files), cloud)

export const messages = (report: Report): ReadonlyArray<string> =>
    report.errors.map(({path, message}) => `${path}: ${message}`)

export const asset = (name: string): Uint8Array => new Uint8Array(fs.readFileSync(path.join(Assets, name)))

export const exampleScript = (target: string, slug: string): string =>
    fs.readFileSync(path.join(RepoRoot, "scripts", target, slug, target === "project" ? "script.ts" : "script.js"), "utf8")
