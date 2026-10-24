import fs from "node:fs"
import os from "node:os"
import path from "node:path"
import {parseArgs} from "node:util"
import SftpClient from "ssh2-sftp-client"
import {asDefined, isDefined, panic} from "@opendaw/lib-std"
import {Build, CommunityWclap} from "./Build.ts"
import {discover} from "./Layout.ts"
import {Report} from "./Report.ts"
import {Screenshots} from "./Screenshots.ts"
import {sftpRemote, Upload} from "./Upload.ts"
import {Validator} from "./Validator.ts"
import {Wclaps} from "./Wclaps.ts"

// --build validates, builds the WebCLAPs and writes the indices into --out, --upload sends --out to the server.
// --screenshots <studio> renders every device script on that Studio's preview page into the scripts index.
// The CI runs them in separate jobs, contributor build scripts never see the upload credentials.
const {values} = parseArgs({
    options: {
        root: {type: "string", default: ".."},
        out: {type: "string"},
        remote: {type: "string", default: "/community"},
        build: {type: "boolean", default: false},
        upload: {type: "boolean", default: false},
        screenshots: {type: "string"}
    }
})

const PreviousWclaps = "https://assets.opendaw.studio/community/wclaps/index.json"

const previousWclaps = async (): Promise<ReadonlyArray<CommunityWclap>> => {
    const response = await fetch(`${PreviousWclaps}?t=${Date.now()}`, {headers: {Origin: "https://opendaw.studio"}})
    if (response.status === 404) {return []}
    if (!response.ok) {return panic(`Could not read ${PreviousWclaps}: ${response.status}`)}
    const index = await response.json() as { folders?: ReadonlyArray<{ wclaps?: ReadonlyArray<CommunityWclap> }> }
    return (index.folders ?? []).flatMap(folder => folder.wclaps ?? [])
}

const root = path.resolve(values.root)
const out = isDefined(values.out) ? path.resolve(values.out) : fs.mkdtempSync(path.join(os.tmpdir(), "community-"))
if (values.build) {
    const report = Validator.run(root)
    const items = discover(root, new Report())
    const hasWclaps = items.some(item => item.group === "wclaps")
    const wclaps = hasWclaps && report.ok
        ? await Validator.buildWclaps(root, report, Wclaps.clapIncludeFromEnv())
        : new Map()
    if (!report.ok) {
        report.errors.forEach(({path: where, message}) => console.error(`✗ ${where}: ${message}`))
        console.error(`${report.errors.length} errors, nothing was deployed.`)
        process.exit(1)
    }
    fs.rmSync(out, {recursive: true, force: true})
    Build.run(items, report, {
        root, out, repository: process.env.GITHUB_REPOSITORY ?? "andremichelle/opendaw-commons", now: new Date(),
        wclaps, previousWclaps: hasWclaps ? await previousWclaps() : []
    })
    console.log(`built ${report.items.length} items into ${out}`)
    if (isDefined(values.screenshots)) {
        const {rendered, failures} = await Screenshots.run(out, values.screenshots)
        failures.forEach(failure => console.warn(`⚠ no screenshot for ${failure}`))
        console.log(`rendered ${rendered} screenshots on ${values.screenshots}`)
    }
}
if (values.upload) {
    const host = asDefined(process.env.SFTP_HOST, "SFTP_HOST missing")
    const problem = host.includes("://") ? "a scheme like sftp://" : /\s/.test(host) ? "whitespace"
        : host.includes(":") ? "a port" : host.includes("/") ? "a path" : !/^[A-Za-z0-9.-]+$/.test(host) ? "invalid characters" : ""
    if (problem !== "") {panic(`SFTP_HOST must be a bare host name like ssh.strato.de, it contains ${problem} (${host.length} characters).`)}
    const client = new SftpClient()
    await client.connect({
        host,
        port: Number(process.env.SFTP_PORT ?? 22),
        username: asDefined(process.env.SFTP_USERNAME, "SFTP_USERNAME missing"),
        password: asDefined(process.env.SFTP_PASSWORD, "SFTP_PASSWORD missing")
    })
    const result = await Upload.run(out, values.remote, sftpRemote(client)).finally(() => client.end())
    result.uploaded.forEach(file => console.log(`↑ ${file}`))
    console.log(`uploaded ${result.uploaded.length} files, ${result.skipped} unchanged`)
}
