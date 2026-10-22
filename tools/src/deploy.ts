import "./NodeEnvironment.ts"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {parseArgs} from "node:util"
import SftpClient from "ssh2-sftp-client"
import {asDefined, isDefined} from "@opendaw/lib-std"
import {Build} from "./Build.ts"
import {CloudIndex, DefaultCloudSources} from "./CloudIndex.ts"
import {discover} from "./Layout.ts"
import {Report} from "./Report.ts"
import {sftpRemote, Upload} from "./Upload.ts"
import {Validator} from "./Validator.ts"

const {values} = parseArgs({
    options: {
        root: {type: "string", default: ".."},
        out: {type: "string"},
        remote: {type: "string", default: "/community"},
        upload: {type: "boolean", default: false}
    }
})

const root = path.resolve(values.root)
const out = isDefined(values.out) ? path.resolve(values.out) : fs.mkdtempSync(path.join(os.tmpdir(), "community-"))
const cloud = await CloudIndex.fetchAll(DefaultCloudSources)
const report = await Validator.run(root, cloud)
if (!report.ok) {
    report.errors.forEach(({path: where, message}) => console.error(`✗ ${where}: ${message}`))
    console.error(`${report.errors.length} errors, nothing was deployed.`)
    process.exit(1)
}
fs.rmSync(out, {recursive: true, force: true})
Build.run(discover(root, new Report()), report, {
    root, out, repository: process.env.GITHUB_REPOSITORY ?? "andremichelle/opendaw-commons", now: new Date()
})
console.log(`built ${report.items.length} items into ${out}`)
if (values.upload) {
    const client = new SftpClient()
    await client.connect({
        host: asDefined(process.env.SFTP_HOST, "SFTP_HOST missing"),
        port: Number(process.env.SFTP_PORT ?? 22),
        username: asDefined(process.env.SFTP_USERNAME, "SFTP_USERNAME missing"),
        password: asDefined(process.env.SFTP_PASSWORD, "SFTP_PASSWORD missing")
    })
    const result = await Upload.run(out, values.remote, sftpRemote(client)).finally(() => client.end())
    result.uploaded.forEach(file => console.log(`↑ ${file}`))
    console.log(`uploaded ${result.uploaded.length} files, ${result.skipped} unchanged`)
}
