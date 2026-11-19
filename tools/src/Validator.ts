import fs from "node:fs"
import path from "node:path"
import {isDefined, Optional} from "@opendaw/lib-std"
import {DeviceScripts} from "./DeviceScripts.ts"
import {checkFiles, deviceFolderOf, discover, formatBytes, Item, scriptFileOf, sizeOfTree} from "./Layout.ts"
import {Meta, MetaValidator, PresetMeta} from "./Meta.ts"
import {uuidOf} from "./Build.ts"
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

const checkPresetDevice = (item: Item, device: Optional<string>, where: string, report: Report): void => {
    if (item.kind === "audio-effect-chain" || item.kind === "midi-effect-chain") {
        if (isDefined(device)) {report.error(where, "A chain has no device, remove the device field.")}
        return
    }
    if (!isDefined(device)) {
        report.error(where, item.kind === "rack" ? "A rack needs its instrument as device." : "device is missing.")
    } else if (item.kind === "device" && deviceFolderOf(device) !== item.folder) {
        report.error(where, `device ${device} belongs into the ${deviceFolderOf(device)} folder, not into ${item.folder}.`)
    }
}

const checkPreset = (item: Item, meta: Optional<Meta>, report: Report): ItemDetails => {
    if (!isDefined(meta)) {return {}}
    const {device} = meta as PresetMeta
    checkPresetDevice(item, device, `${item.path}/meta.json`, report)
    const details: ItemDetails = {id: uuidOf(item), kind: item.kind ?? "", ...(isDefined(device) ? {device} : {})}
    if (item.dev === true) {return {...details, stage: "dev"}}
    const decoded = Presets.read(item)
    if (!decoded.ok) {
        report.error(`${item.path}/preset.odp`, decoded.error)
        return details
    }
    if (isDefined(device) && !Presets.hasDevice(decoded.value, device)) {
        report.error(`${item.path}/preset.odp`, `The preset holds no ${device} device.`)
    }
    return {...details, timeline: decoded.value.hasTimeline}
}

// a dev preset moves into presets on launch day, the same path there would give two presets one id
const checkPresetPaths = (items: ReadonlyArray<Item>, report: Report): void => {
    const released = new Set(items.filter(item => item.group === "presets" && item.dev !== true).map(item => item.path))
    items.filter(item => item.group === "presets" && item.dev === true)
        .filter(item => released.has(item.path.replace(/^dev\//, "")))
        .forEach(item => report.error(item.path, `${item.path.replace(/^dev\//, "")} exists already, choose another folder name.`))
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
    if (item.group === "presets") {return `${item.dev === true ? "dev/" : ""}presets/${item.folder}`}
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
        checkPresetPaths(items, report)
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
