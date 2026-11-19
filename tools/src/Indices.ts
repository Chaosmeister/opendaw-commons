import fs from "node:fs"
import path from "node:path"
import {isDefined, isRecord, panic} from "@opendaw/lib-std"

const Live = "https://assets.opendaw.studio/community"

const contentOf = (json: unknown): string => JSON.stringify(isRecord(json) ? {...json, updatedAt: null} : json)

export namespace Indices {
    export const Groups: ReadonlyArray<string> = ["scripts", "wclaps", "presets", "dev/presets"]

    // the indices the server holds now, a group without one is left out
    export const live = async (): Promise<ReadonlyMap<string, unknown>> => {
        const indices = new Map<string, unknown>()
        for (const group of Groups) {
            const url = `${Live}/${group}/index.json?t=${Date.now()}`
            const response = await fetch(url, {headers: {Origin: "https://opendaw.studio"}})
            if (response.status === 404) {continue}
            if (!response.ok) {return panic(`Could not read ${url}: ${response.status}`)}
            indices.set(group, await response.json())
        }
        return indices
    }

    // an index that only differs from the live one in updatedAt is removed from the build, so it is not uploaded
    export const dropUnchanged = (out: string, live: ReadonlyMap<string, unknown>): ReadonlyArray<string> =>
        Groups.filter(group => {
            const file = path.join(out, group, "index.json")
            const before = live.get(group)
            if (!fs.existsSync(file) || !isDefined(before)) {return false}
            if (contentOf(JSON.parse(fs.readFileSync(file, "utf8"))) !== contentOf(before)) {return false}
            fs.rmSync(file)
            return true
        })
}
