import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import zlib from "node:zlib"
import {spawnSync} from "node:child_process"
import {isAbsent, panic, UUID} from "@opendaw/lib-std"
import {Item} from "./Layout.ts"
import {Checked} from "./Report.ts"

export type WclapPlugin = {
    readonly clapId: string
    readonly name: string
    readonly vendor: string
    readonly features: ReadonlyArray<string>
}

export type BuiltWclap = {
    readonly uuid: string
    readonly bytes: Uint8Array
    readonly plugins: ReadonlyArray<WclapPlugin>
}

type BundleFile = { readonly path: string, readonly bytes: Uint8Array }

const BUILD_TIMEOUT_MS = 10 * 60 * 1000

const listFiles = (directory: string, prefix: string = ""): ReadonlyArray<BundleFile> =>
    fs.readdirSync(directory, {withFileTypes: true})
        .filter(entry => !entry.name.startsWith("."))
        .toSorted((left, right) => left.name < right.name ? -1 : left.name > right.name ? 1 : 0)
        .flatMap(entry => {
            const absolute = path.join(directory, entry.name)
            const relative = `${prefix}${entry.name}`
            return entry.isDirectory()
                ? listFiles(absolute, `${relative}/`)
                : [{path: relative, bytes: new Uint8Array(fs.readFileSync(absolute))}]
        })

const octal = (value: number, width: number): string => value.toString(8).padStart(width - 1, "0") + "\0"

// plain ustar, fixed times and owners, the same files always give the same bytes and so the same id
const tar = (root: string, files: ReadonlyArray<BundleFile>): Uint8Array => {
    const blocks: Array<Uint8Array> = []
    for (const file of files) {
        const header = new Uint8Array(512)
        const write = (text: string, offset: number) => header.set(new TextEncoder().encode(text), offset)
        const name = `${root}/${file.path}`
        if (new TextEncoder().encode(name).length > 100) {return panic(`${file.path}: path longer than 100 bytes`)}
        write(name, 0)
        write(octal(0o644, 8), 100)
        write(octal(0, 8), 108)
        write(octal(0, 8), 116)
        write(octal(file.bytes.length, 12), 124)
        write(octal(0, 12), 136)
        write("        ", 148)
        write("0", 156)
        write("ustar\u000000", 257)
        const checksum = header.reduce((sum, byte) => sum + byte, 0)
        write(octal(checksum, 7) + " ", 148)
        blocks.push(header, file.bytes, new Uint8Array((512 - file.bytes.length % 512) % 512))
    }
    blocks.push(new Uint8Array(1024))
    return Buffer.concat(blocks)
}

// core-wasm pulls in studio-core, which references AudioWorkletNode at module load
const describe = async (files: ReadonlyArray<BundleFile>): Promise<ReadonlyArray<WclapPlugin>> => {
    if (isAbsent(Reflect.get(globalThis, "AudioWorkletNode"))) {Reflect.set(globalThis, "AudioWorkletNode", class {})}
    const {createWclapDescriber} = await import("@opendaw/studio-core-wasm")
    return createWclapDescriber(async () => ({files: [...files]}))("commons:describe")
}

export namespace Wclaps {
    export const uuidOf = async (bytes: Uint8Array): Promise<string> =>
        UUID.toString(await UUID.sha256(bytes.slice().buffer))

    // runs the item's source/build.sh with OUT and CLAP_INCLUDE, packs, loads and describes the result
    export const build = async (item: Item, clapInclude: string): Promise<Checked<BuiltWclap>> => {
        const out = fs.mkdtempSync(path.join(os.tmpdir(), `wclap-${item.slug}-`))
        const result = spawnSync("bash", [path.join(item.absolute, "source", "build.sh")], {
            env: {...process.env, OUT: out, CLAP_INCLUDE: clapInclude},
            encoding: "utf8", timeout: BUILD_TIMEOUT_MS, maxBuffer: 64 * 1024 * 1024
        })
        if (result.status !== 0) {
            const tail = `${result.stdout ?? ""}${result.stderr ?? ""}`.trim().split("\n").slice(-20).join("\n")
            return {ok: false, error: `build.sh failed (${result.status ?? result.signal}):\n${tail}`}
        }
        const files = listFiles(out)
        if (!files.some(file => file.path === "module.wasm")) {return {ok: false, error: "build.sh wrote no module.wasm into $OUT."}}
        const bytes = files.length === 1
            ? files[0].bytes
            : new Uint8Array(zlib.gzipSync(tar(`${item.slug}.wclap`, files), {level: 9}))
        const described = await describe(files).then(
            plugins => ({ok: true as const, plugins}),
            (error: unknown) => ({ok: false as const, error: String(error)}))
        if (!described.ok) {return {ok: false, error: `The bundle does not load: ${described.error}`}}
        if (described.plugins.length === 0) {return {ok: false, error: "The bundle holds no CLAP plugin."}}
        const plugins = described.plugins.map(({clapId, name, vendor, features}) => ({clapId, name, vendor, features: [...features]}))
        return {ok: true, value: {uuid: await uuidOf(bytes), bytes, plugins}}
    }

    // the extensions the Studio's import dialog offers, a bare module or a packed bundle
    export const extensionOf = (bytes: Uint8Array): string =>
        bytes[0] === 0x00 && bytes[1] === 0x61 && bytes[2] === 0x73 && bytes[3] === 0x6D ? ".wasm" : ".wclap.tar.gz"

    export const clapIncludeFromEnv = (): string => {
        const include = process.env.CLAP_INCLUDE
        if (isAbsent(include) || !fs.existsSync(path.join(include, "clap", "clap.h"))) {
            return panic("CLAP_INCLUDE must point at the CLAP headers (the folder holding clap/clap.h).")
        }
        return include
    }
}
