import fs from "node:fs"
import path from "node:path"
import {parseArgs} from "node:util"
import {listEntries, PresetFolders} from "./Layout.ts"
import {Presets} from "./Presets.ts"
import {Validator} from "./Validator.ts"

// launch day, after the Studio deploy: dev/presets moves into presets, the result is reviewed as a pull request
const {values} = parseArgs({options: {root: {type: "string", default: ".."}}})

const root = path.resolve(values.root)
const from = path.join(root, PresetFolders.dev)
const into = path.join(root, PresetFolders.release)
const devices = fs.existsSync(from) ? fs.readdirSync(from).filter(name => fs.statSync(path.join(from, name)).isDirectory()) : []
const moves = devices.flatMap(device => fs.readdirSync(path.join(from, device))
    .filter(slug => fs.statSync(path.join(from, device, slug)).isDirectory())
    .map(slug => ({source: path.join(from, device, slug), target: path.join(into, device, slug), name: `${device}/${slug}`})))
const taken = moves.filter(move => fs.existsSync(move.target))
if (taken.length > 0) {
    taken.forEach(move => console.error(`✗ presets/${move.name} exists already, rename the slug in dev/presets first.`))
    process.exit(1)
}
for (const move of moves) {
    fs.mkdirSync(path.dirname(move.target), {recursive: true})
    fs.renameSync(move.source, move.target)
    console.log(`→ presets/${move.name}`)
}
const removeIfEmpty = (directory: string): void => {
    if (fs.existsSync(directory) && listEntries(directory).length === 0) {fs.rmSync(directory, {recursive: true})}
}
devices.forEach(device => removeIfEmpty(path.join(from, device)))
removeIfEmpty(from)
removeIfEmpty(path.join(root, "dev"))
const report = Validator.run(root)
await Validator.checkPresetAssets(root, report, Presets.cloudAssets())
report.errors.forEach(({path: where, message}) => console.error(`✗ ${where}: ${message}`))
console.log(`${moves.length} presets moved, ${report.errors.length} errors`)
process.exitCode = report.ok ? 0 : 1
