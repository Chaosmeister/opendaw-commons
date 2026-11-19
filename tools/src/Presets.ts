import fs from "node:fs"
import path from "node:path"
import {ByteArrayInput, isRecord, Option, panic, tryCatch, UUID} from "@opendaw/lib-std"
import {BoxGraph} from "@opendaw/lib-box"
import {BoxIO} from "@opendaw/studio-boxes"
import {PresetHeader} from "@opendaw/studio-adapters"
import {Item} from "./Layout.ts"
import {Checked, Report} from "./Report.ts"

export type DecodedPreset = {
    readonly boxNames: ReadonlySet<string>
    readonly samples: ReadonlyArray<string>
    readonly soundfonts: ReadonlyArray<string>
    readonly hasTimeline: boolean
}

export type PresetAssets = {
    readonly samples: ReadonlyArray<string>
    readonly soundfonts: ReadonlyArray<string>
}

export interface CloudAssets {
    hasSample(uuid: string): Promise<boolean>
    hasSoundfont(uuid: string): Promise<boolean>
    // bytes of the file, 0 if unknown
    sizeOf(kind: "samples" | "soundfonts", uuid: string): Promise<number>
}

const Headers = {Origin: "https://opendaw.studio"}

const uuidsOf = async (url: string): Promise<ReadonlySet<string>> => {
    const response = await fetch(`${url}?t=${Date.now()}`, {headers: Headers})
    if (!response.ok) {return panic(`Could not read ${url}: ${response.status}`)}
    const text = await response.text()
    return new Set(Array.from(text.matchAll(/"uuid"\s*:\s*"([0-9a-f-]{36})"/g), match => match[1]))
}

const toBuffer = (bytes: Uint8Array): ArrayBuffer =>
    bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer

export namespace Presets {
    export const fileOf = (item: Item): string => path.join(item.absolute, "preset.odp")

    export const decode = (bytes: Uint8Array): Checked<DecodedPreset> => {
        if (bytes.byteLength < 8) {return {ok: false, error: "preset.odp is too short to be a preset."}}
        const buffer = toBuffer(bytes)
        const header = new ByteArrayInput(buffer.slice(0, 8))
        if (header.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {return {ok: false, error: "preset.odp is not an openDAW preset."}}
        const version = header.readInt()
        if (version !== PresetHeader.FORMAT_VERSION) {return {ok: false, error: `Unsupported preset version ${version}.`}}
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const result = tryCatch(() => graph.fromArrayBuffer(buffer.slice(8), false))
        if (result.status === "failure") {return {ok: false, error: `preset.odp does not decode: ${String(result.error)}`}}
        const boxes = graph.boxes()
        const uuidsNamed = (name: string) => boxes.filter(box => box.name === name).map(box => UUID.toString(box.address.uuid))
        return {
            ok: true, value: {
                boxNames: new Set(boxes.map(box => box.name)),
                samples: uuidsNamed("AudioFileBox"),
                soundfonts: uuidsNamed("SoundfontFileBox"),
                hasTimeline: boxes.some(box => box.name === "TrackBox")
            }
        }
    }

    // reads only the name and uuid in front of every box, so it works for boxes this SDK does not know yet
    export const scan = (bytes: Uint8Array): Checked<PresetAssets> => {
        if (bytes.byteLength < 12) {return {ok: false, error: "preset.odp is too short to be a preset."}}
        const input = new ByteArrayInput(toBuffer(bytes))
        if (input.readInt() !== PresetHeader.MAGIC_HEADER_OPEN) {return {ok: false, error: "preset.odp is not an openDAW preset."}}
        if (input.readInt() !== PresetHeader.FORMAT_VERSION) {return {ok: false, error: "Unsupported preset version."}}
        const result = tryCatch(() => {
            const samples: Array<string> = []
            const soundfonts: Array<string> = []
            const count = input.readInt()
            for (let index = 0; index < count; index++) {
                const length = input.readInt()
                const box = new Int8Array(length)
                input.readBytes(box)
                const stream = new ByteArrayInput(box.buffer)
                stream.readInt()
                const name = stream.readString()
                const uuid = UUID.toString(UUID.fromDataInput(stream))
                if (name === "AudioFileBox") {samples.push(uuid)}
                if (name === "SoundfontFileBox") {soundfonts.push(uuid)}
            }
            return {samples, soundfonts}
        })
        if (result.status === "failure") {return {ok: false, error: `preset.odp does not decode: ${String(result.error)}`}}
        return {ok: true, value: result.value}
    }

    export const hasDevice = (decoded: DecodedPreset, device: string): boolean =>
        decoded.boxNames.has(`${device}DeviceBox`) || decoded.boxNames.has(`${device}Box`)

    export const read = (item: Item): Checked<DecodedPreset> => {
        const file = fileOf(item)
        if (!fs.existsSync(file)) {return {ok: false, error: "Missing preset.odp."}}
        return decode(new Uint8Array(fs.readFileSync(file)))
    }

    // samples not listed in the index still load by uuid through get.php
    export const cloudAssets = (): CloudAssets => {
        let samples: Option<Promise<ReadonlySet<string>>> = Option.None
        let soundfonts: Option<Promise<ReadonlySet<string>>> = Option.None
        return {
            hasSample: async uuid => {
                if (samples.isEmpty()) {samples = Option.wrap(uuidsOf("https://assets.opendaw.studio/samples/index.json"))}
                if ((await samples.unwrap()).has(uuid)) {return true}
                const response = await fetch(`https://api.opendaw.studio/samples/get.php?uuid=${uuid}`, {headers: Headers})
                if (!response.ok) {return false}
                const json: unknown = await response.json()
                return isRecord(json) && json.uuid === uuid
            },
            hasSoundfont: async uuid => {
                if (soundfonts.isEmpty()) {soundfonts = Option.wrap(uuidsOf("https://assets.opendaw.studio/soundfonts/index.json"))}
                return (await soundfonts.unwrap()).has(uuid)
            },
            sizeOf: async (kind, uuid) => {
                const response = await fetch(`https://assets.opendaw.studio/${kind}/${uuid}`, {method: "HEAD", headers: Headers})
                const size = Number(response.headers.get("Content-Length") ?? 0)
                return response.ok && Number.isFinite(size) ? size : 0
            }
        }
    }

    // every distinct cloud file of all presets once, the build sums them per preset
    export const sizes = async (items: ReadonlyArray<Item>, assets: CloudAssets): Promise<ReadonlyMap<string, number>> => {
        const sizes = new Map<string, number>()
        for (const item of items) {
            if (item.group !== "presets" || !fs.existsSync(fileOf(item))) {continue}
            const scanned = scan(new Uint8Array(fs.readFileSync(fileOf(item))))
            if (!scanned.ok) {continue}
            for (const [kind, uuids] of [["samples", scanned.value.samples], ["soundfonts", scanned.value.soundfonts]] as const) {
                for (const uuid of uuids) {
                    if (!sizes.has(uuid)) {sizes.set(uuid, await assets.sizeOf(kind, uuid))}
                }
            }
        }
        return sizes
    }

    export const checkAssets = async (items: ReadonlyArray<Item>, report: Report, assets: CloudAssets): Promise<void> => {
        for (const item of items) {
            if (item.group !== "presets" || item.dev === true || report.errorsOf(item.path).length > 0) {continue}
            const decoded = read(item)
            if (!decoded.ok) {continue}
            const where = `${item.path}/preset.odp`
            for (const uuid of decoded.value.samples) {
                if (!await assets.hasSample(uuid)) {
                    report.error(where, `Sample ${uuid} is not a cloud sample. Presets can only use samples from the openDAW cloud, local samples are not available to other users.`)
                }
            }
            for (const uuid of decoded.value.soundfonts) {
                if (!await assets.hasSoundfont(uuid)) {
                    report.error(where, `Soundfont ${uuid} is not a cloud soundfont. Presets can only use soundfonts from the openDAW cloud.`)
                }
            }
        }
    }
}
