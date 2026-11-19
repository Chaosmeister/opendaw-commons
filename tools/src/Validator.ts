import fs from "node:fs"
import path from "node:path"
import {isDefined, Optional} from "@opendaw/lib-std"
import {DeviceScripts} from "./DeviceScripts.ts"
import {checkFiles, discover, formatBytes, Item, scriptFileOf, sizeOfTree} from "./Layout.ts"
import {Meta, MetaValidator, PresetMeta} from "./Meta.ts"
import {CloudAssets, Presets} from "./Presets.ts"
import {ProjectScripts} from "./ProjectScripts.ts"
import {ItemDetails, Report} from "./Report.ts"
import {BuiltWclap, Wclaps} from "./Wclaps.ts"

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

const checkPreset = (item: Item, meta: Optional<Meta>, report: Report): ItemDetails => {
    if (!isDefined(meta)) {return {}}
    const {uuid, device} = meta as PresetMeta
    const where = `${item.path}/meta.json`
    if (device !== item.device) {report.error(where, `device is ${device} but the preset lies in the ${item.device} folder.`)}
    if (item.dev === true) {return {uuid, device, stage: "dev"}}
    const decoded = Presets.read(item)
    if (!decoded.ok) {
        report.error(`${item.path}/preset.odp`, decoded.error)
        return {uuid, device}
    }
    if (!Presets.hasDevice(decoded.value, device)) {
        report.error(`${item.path}/preset.odp`, `The preset holds no ${device} device.`)
    }
    return {uuid, device, timeline: decoded.value.hasTimeline}
}

const checkPresetUuids = (items: ReadonlyArray<Item>, metas: ReadonlyMap<string, Meta>, report: Report): void => {
    const owners = new Map<string, string>()
    for (const item of items.filter(item => item.group === "presets")) {
        const meta = metas.get(item.path)
        if (!isDefined(meta)) {continue}
        const {uuid} = meta as PresetMeta
        const owner = owners.get(uuid)
        if (isDefined(owner)) {
            report.error(`${item.path}/meta.json`, `uuid ${uuid} is already used by ${owner}. Every preset needs its own uuid.`)
        } else {
            owners.set(uuid, item.path)
        }
    }
}

const checkItem = (item: Item, meta: Optional<Meta>, report: Report): ItemDetails => {
    switch (item.group) {
        case "presets":
            return checkPreset(item, meta, report)
        case "scripts":
            return item.target === "project" ? {} : checkDeviceScript(item, report)
        case "wclaps": {
            const source = path.join(item.absolute, "source")
            return fs.existsSync(source) ? {source: formatBytes(sizeOfTree(source))} : {}
        }
    }
}

const groupOf = (item: Item): string => {
    if (item.group === "presets") {return `${item.dev === true ? "dev/" : ""}presets/${item.device}`}
    return isDefined(item.target) ? `${item.group}/${item.target}` : item.group
}

export namespace Validator {
    export const run = (root: string): Report => {
        const report = new Report()
        const metas = new MetaValidator(root)
        const items = discover(root, report)
        const checked = new Map<string, Meta>()
        for (const item of items) {
            checkFiles(item, report)
            const meta: Optional<Meta> = metas.check(item, report)
            if (isDefined(meta)) {checked.set(item.path, meta)}
            const details = checkItem(item, meta, report)
            report.item({
                path: item.path,
                group: groupOf(item),
                name: meta?.name ?? item.slug,
                details
            })
        }
        checkProjectScripts(items.filter(item => item.target === "project"), report)
        checkPresetUuids(items, checked, report)
        return report
    }

    // needs the network, the samples and soundfonts of every preset must be in the openDAW cloud
    export const checkPresetAssets = async (root: string, report: Report, assets: CloudAssets): Promise<void> =>
        Presets.checkAssets(discover(root, new Report()), report, assets)

    // needs emcc and the CLAP headers, the CI runs it, a local check without them skips it
    export const buildWclaps = async (root: string, report: Report, clapInclude: string): Promise<ReadonlyMap<string, BuiltWclap>> => {
        const built = new Map<string, BuiltWclap>()
        const items = discover(root, new Report()).filter(item => item.group === "wclaps")
        for (const item of items) {
            if (report.errorsOf(item.path).length > 0) {continue}
            const result = await Wclaps.build(item, clapInclude)
            if (!result.ok) {
                report.error(`${item.path}/source`, result.error)
                continue
            }
            const {uuid, bytes, plugins} = result.value
            built.set(item.path, result.value)
            report.addDetails(item.path, {
                id: uuid, bundle: formatBytes(bytes.byteLength), plugins: plugins.map(({clapId}) => clapId).join(" ")
            })
        }
        return built
    }
}
