import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {execFileSync} from "node:child_process"
import {isAbsent, isDefined} from "@opendaw/lib-std"
import {Item, scriptFileOf} from "./Layout.ts"
import {Author, Meta} from "./Meta.ts"
import {ProjectScripts} from "./ProjectScripts.ts"
import {ItemDetails, Report} from "./Report.ts"
import {BuiltWclap, WclapPlugin} from "./Wclaps.ts"

export const INDEX_VERSION = 1
export const API_LEVEL = 1

export type CommunityCommon = {
    readonly uuid: string
    readonly slug: string
    readonly name: string
    readonly description: string
    readonly author: Author
    readonly tags: ReadonlyArray<string>
    readonly license: string
    readonly url: string
    readonly size: number
    readonly created: number
    readonly modified: number
    readonly source: string
    readonly minApi: number
}

export type CommunityScript = CommunityCommon & {
    readonly target: string
    readonly language: "ts" | "js"
    readonly details: ItemDetails
}

export type CommunityIndex<K extends string, T> = { readonly version: number, readonly updatedAt: string } & Record<K, ReadonlyArray<T>>

export type CommunityWclap = {
    readonly uuid: string
    readonly slug: string
    readonly name: string
    readonly size: number
    readonly url: string
    readonly credits: string
    readonly license: string
    readonly plugins: ReadonlyArray<WclapPlugin>
    readonly supersedes: ReadonlyArray<string>
}

export type BuildOptions = {
    readonly root: string
    readonly out: string
    readonly repository: string
    readonly now: Date
    readonly wclaps?: ReadonlyMap<string, BuiltWclap>
    readonly previousWclaps?: ReadonlyArray<CommunityWclap>
}

// a rebuilt plugin names its older builds, the Studio offers the update to projects that still use one
const supersedesOf = (slug: string, uuid: string, previous: ReadonlyArray<CommunityWclap>): ReadonlyArray<string> => {
    const before = previous.find(entry => entry.slug === slug)
    if (isAbsent(before)) {return []}
    const older = before.uuid === uuid ? before.supersedes : [...before.supersedes, before.uuid]
    return Array.from(new Set(older)).filter(id => id !== uuid)
}

// group + slug never change after the merge, so an item keeps its uuid across updates
export const uuidOf = (item: Item): string => {
    const bytes = crypto.createHash("sha256").update(`opendaw-commons:${item.path}`).digest().subarray(0, 16)
    bytes[6] = (bytes[6] & 0x0f) | 0x80
    bytes[8] = (bytes[8] & 0x3f) | 0x80
    const hex = bytes.toString("hex")
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

const hashOf = (bytes: Uint8Array): string => crypto.createHash("sha256").update(bytes).digest("hex").slice(0, 12)

const commitTimes = (root: string, item: Item): { created: number, modified: number } => {
    const output = execFileSync("git", ["log", "--format=%ct", "--", item.path], {cwd: root, encoding: "utf8"}).trim()
    const times = output.length === 0 ? [] : output.split("\n").map(line => Number(line) * 1000)
    const fallback = Date.now()
    return {created: times.at(-1) ?? fallback, modified: times.at(0) ?? fallback}
}

const readMeta = (item: Item): Meta => JSON.parse(fs.readFileSync(path.join(item.absolute, "meta.json"), "utf8")) as Meta

const writePayload = (out: string, group: string, uuid: string, extension: string, bytes: Uint8Array): { url: string, size: number } => {
    const url = `${uuid}-${hashOf(bytes)}.${extension}`
    const directory = path.join(out, group)
    fs.mkdirSync(directory, {recursive: true})
    fs.writeFileSync(path.join(directory, url), bytes)
    return {url, size: bytes.byteLength}
}

const commonOf = (item: Item, options: BuildOptions, payload: { url: string, size: number }): CommunityCommon => {
    const {name, description, author, tags, license} = readMeta(item)
    return {
        uuid: uuidOf(item), slug: item.slug, name, description, author, tags, license, ...payload,
        ...commitTimes(options.root, item),
        source: `https://github.com/${options.repository}/tree/main/${item.path}`,
        minApi: API_LEVEL
    }
}

const writeIndex = (out: string, group: string, key: string, entries: ReadonlyArray<unknown>, now: Date): void => {
    fs.mkdirSync(path.join(out, group), {recursive: true})
    const index = {version: INDEX_VERSION, updatedAt: now.toISOString(), [key]: entries}
    fs.writeFileSync(path.join(out, group, "index.json"), JSON.stringify(index, null, 2) + "\n")
}

export namespace Build {
    // the report must come from a passing Validator.run over the same root and items
    export const run = (items: ReadonlyArray<Item>, report: Report, options: BuildOptions): void => {
        const detailsOf = (item: Item): ItemDetails => report.items.find(entry => entry.path === item.path)?.details ?? {}
        const byName = (left: { name: string }, right: { name: string }) => left.name.localeCompare(right.name)
        const scripts = items.filter(item => item.group === "scripts").flatMap((item): ReadonlyArray<CommunityScript> => {
            const file = scriptFileOf(item)
            if (!isDefined(file) || !isDefined(item.target)) {return []}
            const language = file.endsWith(".ts") ? "ts" : "js"
            const source = fs.readFileSync(path.join(item.absolute, file), "utf8")
            const code = item.target === "project" ? ProjectScripts.bodyOf(source) : source
            const payload = writePayload(options.out, "scripts", uuidOf(item), language, new TextEncoder().encode(code))
            return [{...commonOf(item, options, payload), target: item.target, language, details: detailsOf(item)}]
        })
        writeIndex(options.out, "scripts", "scripts", scripts.toSorted(byName), options.now)
        const wclaps = items.filter(item => item.group === "wclaps").flatMap((item): ReadonlyArray<CommunityWclap> => {
            const built = options.wclaps?.get(item.path)
            if (isAbsent(built)) {return []}
            const directory = path.join(options.out, "wclaps")
            fs.mkdirSync(directory, {recursive: true})
            fs.writeFileSync(path.join(directory, `${built.uuid}.wclap`), built.bytes)
            const {name, license, credits} = readMeta(item)
            return [{
                uuid: built.uuid, slug: item.slug, name, size: built.bytes.byteLength,
                url: `https://github.com/${options.repository}/tree/main/${item.path}`,
                credits: credits ?? "", license, plugins: built.plugins,
                supersedes: supersedesOf(item.slug, built.uuid, options.previousWclaps ?? [])
            }]
        })
        fs.mkdirSync(path.join(options.out, "wclaps"), {recursive: true})
        fs.writeFileSync(path.join(options.out, "wclaps", "index.json"), JSON.stringify({
            version: 1, updatedAt: options.now.toISOString(), folders: [{name: "Community", wclaps: wclaps.toSorted(byName)}]
        }, null, 2) + "\n")
    }
}
