import fs from "node:fs"
import path from "node:path"
import SftpClient from "ssh2-sftp-client"

export interface Remote {
    list(directory: string): Promise<ReadonlyArray<string>>
    mkdir(directory: string): Promise<void>
    put(local: string, remote: string): Promise<void>
}

export type UploadResult = { readonly uploaded: ReadonlyArray<string>, readonly skipped: number }

const INDEX = "index.json"

export const sftpRemote = (client: SftpClient): Remote => ({
    list: async directory => await client.exists(directory) === "d"
        ? (await client.list(directory)).map(entry => entry.name) : [],
    mkdir: async directory => {await client.mkdir(directory, true)},
    put: async (local, remote) => {await client.put(local, remote)}
})

export namespace Upload {
    // payload names carry their content hash, so an existing file never changes and is skipped.
    // Indices go last, an index never points at a file that is not uploaded yet.
    export const run = async (from: string, to: string, remote: Remote): Promise<UploadResult> => {
        const uploaded: Array<string> = []
        const skipped: Array<string> = []
        const groups = fs.readdirSync(from, {withFileTypes: true}).filter(entry => entry.isDirectory()).map(entry => entry.name)
        for (const group of groups) {
            const target = `${to}/${group}`
            await remote.mkdir(target)
            const existing = new Set(await remote.list(target))
            for (const name of fs.readdirSync(path.join(from, group)).filter(name => name !== INDEX)) {
                if (existing.has(name)) {
                    skipped.push(name)
                    continue
                }
                await remote.put(path.join(from, group, name), `${target}/${name}`)
                uploaded.push(`${group}/${name}`)
            }
        }
        for (const group of groups) {
            if (!fs.existsSync(path.join(from, group, INDEX))) {continue}
            await remote.put(path.join(from, group, INDEX), `${to}/${group}/${INDEX}`)
            uploaded.push(`${group}/${INDEX}`)
        }
        return {uploaded, skipped: skipped.length}
    }
}
