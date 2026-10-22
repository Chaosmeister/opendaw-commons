import "./NodeEnvironment.ts"
import fs from "node:fs"
import path from "node:path"
import {parseArgs} from "node:util"
import {isDefined} from "@opendaw/lib-std"
import {CloudIndex, DefaultCloudSources} from "./CloudIndex.ts"
import {Summary} from "./Summary.ts"
import {Validator} from "./Validator.ts"

const {values} = parseArgs({
    options: {
        root: {type: "string", default: "."},
        summary: {type: "string"},
        changed: {type: "string"},
        samples: {type: "string", default: DefaultCloudSources.samples},
        soundfonts: {type: "string", default: DefaultCloudSources.soundfonts},
        wclaps: {type: "string", default: DefaultCloudSources.wclaps}
    }
})

const root = path.resolve(values.root)
const cloud = await CloudIndex.fetchAll({samples: values.samples, soundfonts: values.soundfonts, wclaps: values.wclaps})
const report = await Validator.run(root, cloud)
const annotate = process.env.GITHUB_ACTIONS === "true"
for (const {path: where, message} of report.errors) {
    console.log(annotate ? `::error file=${where}::${message.replaceAll("\n", " ")}` : `✗ ${where}: ${message}`)
}
console.log(`${report.items.length} items, ${report.errors.length} errors`)
if (isDefined(values.summary)) {
    const changed = !isDefined(values.changed) ? report.items.map(item => `${item.path}/`)
        : fs.readFileSync(values.changed, "utf8").split("\n").map(line => line.trim()).filter(line => line.length > 0)
    fs.writeFileSync(values.summary, Summary.markdown(report, changed))
}
process.exitCode = report.ok ? 0 : 1
