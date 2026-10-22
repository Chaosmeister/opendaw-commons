import fs from "node:fs"
import {panic} from "@opendaw/lib-std"

export type CloudSources = {
    readonly samples: string
    readonly soundfonts: string
    readonly wclaps: string
}

export const DefaultCloudSources: CloudSources = {
    samples: "https://assets.opendaw.studio/samples/index.json",
    soundfonts: "https://assets.opendaw.studio/soundfonts/index.json",
    wclaps: "https://assets.opendaw.studio/wclaps/index.json"
}

type Entry = { readonly uuid: string }

type Folder = {
    readonly folders?: ReadonlyArray<Folder>
    readonly samples?: ReadonlyArray<Entry>
    readonly soundfonts?: ReadonlyArray<Entry>
    readonly wclaps?: ReadonlyArray<Entry>
}

type Tree = { readonly version: number, readonly folders: ReadonlyArray<Folder> }

export type CloudIndex = {
    readonly samples: ReadonlySet<string>
    readonly soundfonts: ReadonlySet<string>
    readonly wclaps: ReadonlySet<string>
}

const load = async (source: string): Promise<Tree> => {
    if (!source.startsWith("https://")) {return JSON.parse(fs.readFileSync(source, "utf8")) as Tree}
    const response = await fetch(`${source}?t=${Date.now()}`, {headers: {Origin: "https://opendaw.studio"}})
    if (!response.ok) {return panic(`Could not fetch ${source}: ${response.status} ${response.statusText}`)}
    return await response.json() as Tree
}

const flatten = (tree: Tree, key: "samples" | "soundfonts" | "wclaps"): ReadonlyArray<Entry> => {
    if (tree.version !== 1 || !Array.isArray(tree.folders)) {return panic(`Unknown ${key} index format.`)}
    const entries: Array<Entry> = []
    const collect = (folder: Folder): void => {
        folder[key]?.forEach(entry => entries.push(entry))
        folder.folders?.forEach(collect)
    }
    tree.folders.forEach(collect)
    return entries
}

export namespace CloudIndex {
    export const fetchAll = async (sources: CloudSources): Promise<CloudIndex> => {
        const [samples, soundfonts, wclaps] = await Promise.all([
            load(sources.samples), load(sources.soundfonts), load(sources.wclaps)])
        return {
            samples: new Set(flatten(samples, "samples").map(entry => entry.uuid.toLowerCase())),
            soundfonts: new Set(flatten(soundfonts, "soundfonts").map(entry => entry.uuid.toLowerCase())),
            wclaps: new Set(flatten(wclaps, "wclaps").map(entry => entry.uuid.toLowerCase()))
        }
    }
}
