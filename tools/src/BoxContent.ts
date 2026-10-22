import {asDefined, isDefined, isInstanceOf, Optional, UUID} from "@opendaw/lib-std"
import {Box, BoxGraph} from "@opendaw/lib-box"
import {
    ApparatDeviceBox,
    AudioFileBox,
    SoundfontFileBox,
    SpielwerkDeviceBox,
    WclapDeviceBox,
    WclapInstrumentBox,
    WerkstattDeviceBox
} from "@opendaw/studio-boxes"
import {WclapStorage} from "@opendaw/studio-core"
import {CloudIndex} from "./CloudIndex.ts"
import {DeviceScripts, DeviceTarget} from "./DeviceScripts.ts"
import {ItemDetails, Report} from "./Report.ts"

type ScriptDeviceBox = WerkstattDeviceBox | ApparatDeviceBox | SpielwerkDeviceBox

const scriptTargetOf = (box: Box): Optional<DeviceTarget> => isInstanceOf(box, WerkstattDeviceBox) ? "werkstatt"
    : isInstanceOf(box, ApparatDeviceBox) ? "apparat"
        : isInstanceOf(box, SpielwerkDeviceBox) ? "spielwerk" : undefined

const isScriptDeviceBox = (box: Box): box is ScriptDeviceBox => isDefined(scriptTargetOf(box))

// a WebCLAP from the cloud is stored under its index uuid, the Studio fetches it when it is missing
const isCloudWclap = (url: string, cloud: CloudIndex): boolean =>
    WclapStorage.isLocal(url) && cloud.wclaps.has(WclapStorage.idOf(url).toLowerCase())

const uuidOf = (box: Box): string => UUID.toString(box.address.uuid)

export namespace BoxContent {
    // every asset a shared file references must be loadable by anyone: cloud samples, soundfonts and WebCLAPs only
    export const check = (graph: BoxGraph, where: string, cloud: CloudIndex, report: Report): ItemDetails => {
        const boxes = graph.boxes()
        const samples = boxes.filter(box => isInstanceOf(box, AudioFileBox))
        const soundfonts = boxes.filter(box => isInstanceOf(box, SoundfontFileBox))
        const wclaps = boxes.filter(box => isInstanceOf(box, WclapDeviceBox) || isInstanceOf(box, WclapInstrumentBox))
        const scripts = boxes.filter(isScriptDeviceBox)
        samples
            .filter(box => !cloud.samples.has(uuidOf(box)))
            .forEach(box => report.error(where,
                `AudioFileBox ${uuidOf(box)} ("${box.fileName.getValue()}") is not an openDAW cloud sample.`))
        soundfonts
            .filter(box => !cloud.soundfonts.has(uuidOf(box)))
            .forEach(box => report.error(where,
                `SoundfontFileBox ${uuidOf(box)} ("${box.fileName.getValue()}") is not an openDAW cloud soundfont.`))
        wclaps
            .filter(box => !isCloudWclap(box.url.getValue(), cloud))
            .forEach(box => report.error(where,
                `${box.name} ${uuidOf(box)} uses the WebCLAP "${box.url.getValue()}", which is not in the openDAW cloud.`))
        scripts.forEach(box => {
            const target = asDefined(scriptTargetOf(box))
            const code = DeviceScripts.stripHeader(target, box.code.getValue())
            const result = DeviceScripts.check(target, code, `${where}#${uuidOf(box)}`)
            if (!result.ok) {report.error(where, `${box.name} ${uuidOf(box)} script: ${result.error}`)}
        })
        return {samples: samples.length, soundfonts: soundfonts.length, wclaps: wclaps.length, scripts: scripts.length}
    }
}
