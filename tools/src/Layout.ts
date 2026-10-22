import fs from "node:fs"
import path from "node:path"
import {isDefined, Optional} from "@opendaw/lib-std"
import {Report} from "./Report.ts"

export type Group = "scripts" | "wclaps"

export type ScriptTarget = "project" | "werkstatt" | "apparat" | "spielwerk"

export const Groups: ReadonlyArray<Group> = ["scripts", "wclaps"]

export const ScriptTargets: ReadonlyArray<ScriptTarget> = ["project", "werkstatt", "apparat", "spielwerk"]

export type Item = {
    readonly group: Group
    readonly target: Optional<ScriptTarget>
    readonly slug: string
    readonly path: string
    readonly absolute: string
}

const KiB = 1024
const MiB = 1024 * KiB

export const SizeLimits = {
    script: 256 * KiB,
    meta: 16 * KiB,
    wclapSource: 20 * MiB
} as const

const SLUG = /^[a-z0-9]+(?:-[a-z0-9]+)*$/
const MAX_SLUG_LENGTH = 64
const IGNORED = new Set([".gitkeep", ".DS_Store"])

type FileRule = { readonly name: string, readonly required: boolean, readonly limit: number }

const filesOf = (item: Item): ReadonlyArray<FileRule> => {
    switch (item.group) {
        case "scripts":
            return [{name: "meta.json", required: true, limit: SizeLimits.meta}]
        case "wclaps":
            return [{name: "meta.json", required: true, limit: SizeLimits.meta}]
    }
}

export const isSlug = (name: string): boolean => name.length <= MAX_SLUG_LENGTH && SLUG.test(name)

export const listEntries = (directory: string): ReadonlyArray<fs.Dirent> =>
    fs.readdirSync(directory, {withFileTypes: true}).filter(entry => !IGNORED.has(entry.name))

export const sizeOfTree = (directory: string): number => listEntries(directory)
    .reduce((sum, entry) => {
        const absolute = path.join(directory, entry.name)
        return sum + (entry.isDirectory() ? sizeOfTree(absolute) : fs.statSync(absolute).size)
    }, 0)

export const formatBytes = (bytes: number): string => bytes >= MiB
    ? `${(bytes / MiB).toFixed(1)} MB`
    : bytes >= KiB ? `${(bytes / KiB).toFixed(1)} KB` : `${bytes} B`

export const scriptFileOf = (item: Item): Optional<string> =>
    ["script.ts", "script.js"].find(name => fs.existsSync(path.join(item.absolute, name)))

const collectFolder = (root: string, relative: string, group: Group, target: Optional<ScriptTarget>,
                       report: Report): ReadonlyArray<Item> => {
    const absolute = path.join(root, relative)
    if (!fs.existsSync(absolute)) {return []}
    const items: Array<Item> = []
    for (const entry of listEntries(absolute)) {
        const entryPath = `${relative}/${entry.name}`
        if (!entry.isDirectory()) {
            report.error(entryPath, "Only item folders belong here.")
        } else if (!isSlug(entry.name)) {
            report.error(entryPath, `"${entry.name}" is not a valid slug. Use lowercase letters, digits and single hyphens, at most ${MAX_SLUG_LENGTH} characters.`)
        } else {
            items.push({group, target, slug: entry.name, path: entryPath, absolute: path.join(root, entryPath)})
        }
    }
    return items
}

export const discover = (root: string, report: Report): ReadonlyArray<Item> => {
    const items: Array<Item> = []
    for (const group of Groups) {
        if (group === "scripts") {
            const scripts = path.join(root, group)
            if (!fs.existsSync(scripts)) {continue}
            for (const entry of listEntries(scripts)) {
                const target = ScriptTargets.find(name => name === entry.name)
                if (!entry.isDirectory() || !isDefined(target)) {
                    report.error(`${group}/${entry.name}`, `Unknown script target. Use one of ${ScriptTargets.join(", ")}.`)
                    continue
                }
                items.push(...collectFolder(root, `${group}/${target}`, group, target, report))
            }
        } else {
            items.push(...collectFolder(root, group, group, undefined, report))
        }
    }
    return items
}

export const checkFiles = (item: Item, report: Report): void => {
    const rules = filesOf(item)
    const allowed = new Set(rules.map(rule => rule.name))
    if (item.group === "scripts") {
        const names = listEntries(item.absolute).map(entry => entry.name).filter(name => name.startsWith("script."))
        const permitted = item.target === "project" ? ["script.ts", "script.js"] : ["script.js"]
        const present = names.filter(name => permitted.includes(name))
        if (present.length !== 1) {
            report.error(item.path, `Needs exactly one of ${permitted.join(" or ")}.`)
        }
        present.forEach(name => allowed.add(name))
        present.forEach(name => {
            const size = fs.statSync(path.join(item.absolute, name)).size
            if (size > SizeLimits.script) {
                report.error(`${item.path}/${name}`, `${formatBytes(size)} exceeds the limit of ${formatBytes(SizeLimits.script)}.`)
            }
        })
    }
    if (item.group === "wclaps") {
        allowed.add("source")
        const source = path.join(item.absolute, "source")
        if (!fs.existsSync(source) || !fs.statSync(source).isDirectory()) {
            report.error(item.path, "Needs a source/ folder.")
        } else {
            const size = sizeOfTree(source)
            if (size === 0) {report.error(`${item.path}/source`, "The source folder is empty.")}
            if (size > SizeLimits.wclapSource) {
                report.error(`${item.path}/source`, `${formatBytes(size)} exceeds the limit of ${formatBytes(SizeLimits.wclapSource)}.`)
            }
        }
    }
    for (const rule of rules) {
        const absolute = path.join(item.absolute, rule.name)
        if (!fs.existsSync(absolute)) {
            if (rule.required) {report.error(item.path, `Missing ${rule.name}.`)}
            continue
        }
        const size = fs.statSync(absolute).size
        if (size > rule.limit) {
            report.error(`${item.path}/${rule.name}`, `${formatBytes(size)} exceeds the limit of ${formatBytes(rule.limit)}.`)
        }
    }
    for (const entry of listEntries(item.absolute)) {
        if (!allowed.has(entry.name)) {report.error(`${item.path}/${entry.name}`, "Unexpected file, see CONTRIBUTING.md.")}
    }
}
