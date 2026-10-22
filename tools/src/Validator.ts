import fs from "node:fs"
import path from "node:path"
import {isDefined, Optional} from "@opendaw/lib-std"
import {CloudIndex} from "./CloudIndex.ts"
import {DeviceScripts} from "./DeviceScripts.ts"
import {checkFiles, discover, formatBytes, Item, scriptFileOf, sizeOfTree} from "./Layout.ts"
import {Meta, MetaValidator} from "./Meta.ts"
import {Presets} from "./Presets.ts"
import {ProjectScripts} from "./ProjectScripts.ts"
import {ItemDetails, Report} from "./Report.ts"

const checkDeviceScript = (item: Item, report: Report): ItemDetails => {
    const name = scriptFileOf(item)
    if (!isDefined(name) || item.target === "project" || !isDefined(item.target)) {return {}}
    const where = `${item.path}/${name}`
    const result = DeviceScripts.check(item.target, fs.readFileSync(path.join(item.absolute, name), "utf8"), where)
    if (!result.ok) {
        report.error(where, result.error)
        return {}
    }
    const {label, params, samples, sidechains, view} = result.value
    return {label, params, samples, sidechains, view}
}

const checkProjectScripts = (items: ReadonlyArray<Item>, report: Report): void => {
    const scripts = items.flatMap(item => {
        const name = scriptFileOf(item)
        if (!isDefined(name)) {return []}
        return [{
            path: `${item.path}/${name}`,
            source: fs.readFileSync(path.join(item.absolute, name), "utf8"),
            typescript: name.endsWith(".ts")
        }]
    })
    ProjectScripts.check(scripts).forEach((messages, where) => messages.forEach(message => report.error(where, message)))
}

const checkItem = async (item: Item, cloud: CloudIndex, report: Report): Promise<ItemDetails> => {
    switch (item.group) {
        case "presets":
            return Presets.check(item, cloud, report)
        case "scripts":
            return item.target === "project" ? {} : checkDeviceScript(item, report)
        case "wclaps": {
            const source = path.join(item.absolute, "source")
            return fs.existsSync(source) ? {source: formatBytes(sizeOfTree(source))} : {}
        }
    }
}

export namespace Validator {
    export const run = async (root: string, cloud: CloudIndex): Promise<Report> => {
        const report = new Report()
        const metas = new MetaValidator(root)
        const items = discover(root, report)
        for (const item of items) {
            checkFiles(item, report)
            const meta: Optional<Meta> = metas.check(item, report)
            const details = await checkItem(item, cloud, report)
            report.item({
                path: item.path,
                group: isDefined(item.target) ? `${item.group}/${item.target}` : item.group,
                name: meta?.name ?? item.slug,
                details
            })
        }
        checkProjectScripts(items.filter(item => item.target === "project"), report)
        return report
    }
}
