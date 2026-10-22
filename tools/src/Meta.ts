import fs from "node:fs"
import path from "node:path"
import {Ajv2020} from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import {isAbsent, Optional, tryCatch} from "@opendaw/lib-std"
import {Group, Item} from "./Layout.ts"
import {Report} from "./Report.ts"

export type Author = { readonly name: string, readonly github?: string, readonly url?: string }

export type Meta = {
    readonly name: string
    readonly description: string
    readonly author: Author
    readonly tags: ReadonlyArray<string>
    readonly license: string
    readonly credits?: string
}

const SchemaIds: Record<Group, string> = {
    presets: "preset",
    scripts: "script",
    wclaps: "wclap"
}

const schemaUrl = (name: string): string => `https://assets.opendaw.studio/community/schemas/${name}.meta.json`

export class MetaValidator {
    readonly #ajv: Ajv2020

    constructor(root: string) {
        this.#ajv = new Ajv2020({allErrors: true})
        addFormats.default(this.#ajv)
        const directory = path.join(root, "schemas")
        fs.readdirSync(directory)
            .filter(name => name.endsWith(".json"))
            .forEach(name => this.#ajv.addSchema(JSON.parse(fs.readFileSync(path.join(directory, name), "utf8"))))
    }

    check(item: Item, report: Report): Optional<Meta> {
        const file = path.join(item.absolute, "meta.json")
        if (!fs.existsSync(file)) {return undefined}
        const where = `${item.path}/meta.json`
        const parsed = tryCatch(() => JSON.parse(fs.readFileSync(file, "utf8")) as unknown)
        if (parsed.status === "failure") {
            report.error(where, `Not valid JSON: ${String(parsed.error)}`)
            return undefined
        }
        const validate = this.#ajv.getSchema(schemaUrl(SchemaIds[item.group]))
        if (isAbsent(validate)) {
            report.error(where, `No schema for ${item.group}.`)
            return undefined
        }
        if (validate(parsed.value)) {return parsed.value as Meta}
        for (const error of validate.errors ?? []) {
            const field = error.instancePath === "" ? "meta.json" : error.instancePath.slice(1).replaceAll("/", ".")
            const extra = error.keyword === "unevaluatedProperties"
                ? ` (${String(error.params.unevaluatedProperty)} is computed by the CI or unknown)` : ""
            report.error(where, `${field} ${error.message ?? "is invalid"}${extra}`)
        }
        return undefined
    }
}
