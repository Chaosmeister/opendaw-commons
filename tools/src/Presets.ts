import fs from "node:fs"
import path from "node:path"
import {ByteArrayInput, isInstanceOf, Option, tryCatch} from "@opendaw/lib-std"
import {BoxGraph, IndexedBox} from "@opendaw/lib-box"
import {AudioUnitBox, BoxIO, TrackBox} from "@opendaw/studio-boxes"
import {AudioUnitType} from "@opendaw/studio-enums"
import {PresetHeader} from "@opendaw/studio-adapters"
import {PresetInspection, PresetInspector} from "@opendaw/studio-core"
import {BoxContent} from "./BoxContent.ts"
import {CloudIndex} from "./CloudIndex.ts"
import {Item} from "./Layout.ts"
import {ItemDetails, Report} from "./Report.ts"

const HEADER_SIZE = 8

export namespace Presets {
    export const check = (item: Item, cloud: CloudIndex, report: Report): ItemDetails => {
        const file = path.join(item.absolute, "preset.odp")
        if (!fs.existsSync(file)) {return {}}
        const where = `${item.path}/preset.odp`
        const bytes = new Uint8Array(fs.readFileSync(file))
        if (!PresetInspector.isPresetBinary(bytes)) {
            report.error(where, "Not an openDAW preset (.odp).")
            return {}
        }
        const header = new ByteArrayInput(bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + HEADER_SIZE))
        header.readInt()
        const version = header.readInt()
        if (version !== PresetHeader.FORMAT_VERSION) {
            report.error(where, `Unsupported preset format version ${version}.`)
            return {}
        }
        const graph = new BoxGraph<BoxIO.TypeMap>(Option.wrap(BoxIO.create))
        const decoded = tryCatch(() => graph.fromArrayBuffer(
            bytes.buffer.slice(bytes.byteOffset + HEADER_SIZE, bytes.byteOffset + bytes.byteLength), false))
        if (decoded.status === "failure") {
            report.error(where, `Could not decode the preset: ${String(decoded.error)}`)
            return {}
        }
        const inspection = PresetInspector.inspect(bytes)
        if (inspection.isEmpty()) {
            report.error(where, "The preset holds no instrument, effect or chain the Studio recognises.")
            return {}
        }
        return {
            ...describe(inspection.unwrap(), graph),
            hasTimeline: graph.boxes().some(box => isInstanceOf(box, TrackBox)),
            ...BoxContent.check(graph, where, cloud, report)
        }
    }
}

// the binary does not say whether it was saved as an instrument or as a rack, a unit without effects loads as an instrument
const hasEffects = (graph: BoxGraph): boolean => graph.boxes()
    .filter(box => isInstanceOf(box, AudioUnitBox))
    .filter(box => box.type.getValue() !== AudioUnitType.Output)
    .some(box => IndexedBox.collectIndexedBoxes(box.audioEffects).length + IndexedBox.collectIndexedBoxes(box.midiEffects).length > 0)

const describe = (inspection: PresetInspection, graph: BoxGraph): ItemDetails => {
    switch (inspection.category) {
        case "audio-unit":
            return hasEffects(graph)
                ? {category: "audio-unit", instrument: inspection.instrument}
                : {category: "instrument", device: inspection.instrument}
        case "audio-effect":
        case "midi-effect":
            return {category: inspection.category, device: inspection.device}
        case "audio-effect-chain":
        case "midi-effect-chain":
            return {category: inspection.category}
    }
}
