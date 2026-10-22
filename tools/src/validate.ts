import fs from "node:fs"
import path from "node:path"
import {parseArgs} from "node:util"
import {isDefined} from "@opendaw/lib-std"
import {Summary} from "./Summary.ts"
import {Validator} from "./Validator.ts"
import {Wclaps} from "./Wclaps.ts"

const {values} = parseArgs({
    options: {
        root: {type: "string", default: "."},
        summary: {type: "string"},
        changed: {type: "string"},
        "build-wclaps": {type: "boolean", default: false},
        "wclap-out": {type: "string"}
    }
})

const root = path.resolve(values.root)
const report = Validator.run(root)
if (values["build-wclaps"]) {
    const built = await Validator.buildWclaps(root, report, Wclaps.clapIncludeFromEnv())
    const wclapOut = values["wclap-out"]
    if (isDefined(wclapOut)) {
        fs.mkdirSync(wclapOut, {recursive: true})
        built.forEach(({uuid, bytes}, itemPath) =>
            fs.writeFileSync(path.join(wclapOut, `${path.basename(itemPath)}-${uuid}${Wclaps.extensionOf(bytes)}`), bytes))
    }
}
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
