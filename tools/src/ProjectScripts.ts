import fs from "node:fs"
import path from "node:path"
import vm from "node:vm"
import {createRequire} from "node:module"
import ts from "typescript"
import {isAbsent, panic, tryCatch} from "@opendaw/lib-std"

export type ProjectScript = { readonly path: string, readonly source: string, readonly typescript: boolean }

const TOP_LEVEL_RETURN = 1108

const require = createRequire(import.meta.url)

const declarationsOf = (name: string): string => {
    const resolved = tryCatch(() => require.resolve(`@opendaw/studio-scripting/${name}`))
    if (resolved.status === "failure") {
        return panic(`@opendaw/studio-scripting does not ship ./${name}, the script type check needs it.`)
    }
    return fs.readFileSync(resolved.value, "utf8")
}

// mirrors the Studio code editor (monaco-setup.ts)
const CompilerOptions: ts.CompilerOptions = {
    target: ts.ScriptTarget.ES2020,
    module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Node10,
    allowJs: true,
    noLib: true,
    checkJs: false,
    strict: true,
    noEmit: true,
    skipLibCheck: true,
    esModuleInterop: true,
    allowSyntheticDefaultImports: true,
    moduleDetection: ts.ModuleDetectionKind.Force,
    types: []
}

export namespace ProjectScripts {
    // the part the Studio runs: a leading import preamble (for type checks in a local editor) is dropped up to the first comment
    export const bodyOf = (source: string): string => {
        if (!/^\s*import\s/.test(source)) {return source}
        const start = source.indexOf("//")
        return start === -1 ? "" : source.substring(start)
    }

    export const check = (scripts: ReadonlyArray<ProjectScript>): Map<string, ReadonlyArray<string>> => {
        const problems = new Map<string, Array<string>>()
        const add = (file: string, message: string): void => {
            const list = problems.get(file) ?? []
            list.push(message)
            problems.set(file, list)
        }
        const virtual = new Map<string, string>([
            ["/opendaw/library.d.ts", declarationsOf("library")],
            ["/opendaw/opendaw.d.ts", declarationsOf("api.declaration")]
        ])
        const owners = new Map<string, { readonly path: string, readonly lineOffset: number }>()
        scripts.forEach((script, index) => {
            const body = bodyOf(script.source)
            if (body.trim().length === 0) {
                add(script.path, "The script is empty after its import preamble. Start the code with a comment line.")
                return
            }
            if (/^\s*import\s/m.test(body)) {add(script.path, "Imports only work in the preamble before the first comment.")}
            if (script.typescript) {
                const file = `/scripts/${index}.ts`
                virtual.set(file, body)
                owners.set(file, {path: script.path, lineOffset: script.source.slice(0, script.source.length - body.length).split("\n").length - 1})
            } else {
                const compiled = tryCatch(() => new vm.Script(`(async function () {\n${body}\n})`, {filename: script.path}))
                if (compiled.status === "failure") {add(script.path, String(compiled.error))}
            }
        })
        if (owners.size === 0) {return problems}
        const host = ts.createCompilerHost(CompilerOptions)
        const fallbackGetSourceFile = host.getSourceFile
        host.getSourceFile = (fileName, languageVersion, onError, shouldCreate) => {
            const text = virtual.get(fileName)
            return isAbsent(text)
                ? fallbackGetSourceFile(fileName, languageVersion, onError, shouldCreate)
                : ts.createSourceFile(fileName, text, languageVersion, true)
        }
        const fallbackFileExists = host.fileExists
        host.fileExists = fileName => virtual.has(fileName) || fallbackFileExists(fileName)
        const fallbackReadFile = host.readFile
        host.readFile = fileName => virtual.get(fileName) ?? fallbackReadFile(fileName)
        const program = ts.createProgram(Array.from(virtual.keys()), CompilerOptions, host)
        for (const diagnostic of ts.getPreEmitDiagnostics(program)) {
            if (diagnostic.code === TOP_LEVEL_RETURN) {continue}
            const fileName = diagnostic.file?.fileName
            const owner = isAbsent(fileName) ? undefined : owners.get(fileName)
            const message = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n")
            if (isAbsent(owner) || isAbsent(diagnostic.file) || isAbsent(diagnostic.start)) {
                add(isAbsent(fileName) ? "scripts" : path.basename(fileName), message)
                continue
            }
            const {line, character} = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            add(owner.path, `line ${line + owner.lineOffset + 1}:${character + 1} ${message}`)
        }
        return problems
    }
}
