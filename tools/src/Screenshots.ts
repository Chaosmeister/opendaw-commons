import crypto from "node:crypto"
import fs from "node:fs"
import path from "node:path"
import {Browser, chromium} from "playwright"

type ScriptEntry = { uuid: string, name: string, url: string, target: string, screenshot?: string }

type Preview = { readonly status: "ready", readonly selector: string } | { readonly status: "error", readonly message: string }

type Rendered = { readonly status: "ready", readonly webp: Uint8Array } | { readonly status: "error", readonly message: string }

export type ScreenshotResult = { readonly rendered: number, readonly failures: ReadonlyArray<string> }

const DeviceTargets: ReadonlyArray<string> = ["apparat", "werkstatt", "spielwerk"]

const toWebp = (base64: string): string => `(async () => {
    const image = new Image()
    image.src = "data:image/png;base64,${base64}"
    await image.decode()
    const canvas = document.createElement("canvas")
    canvas.width = image.naturalWidth
    canvas.height = image.naturalHeight
    canvas.getContext("2d").drawImage(image, 0, 0)
    return canvas.toDataURL("image/webp", 0.9).split(",")[1]
})()`

// the Studio's /device-preview page renders one script device, the shot is re-encoded to webp by the same browser
const render = async (browser: Browser, studio: string, target: string, source: string): Promise<Rendered> => {
    const context = await browser.newContext({
        viewport: {width: 1600, height: 900}, deviceScaleFactor: 2,
        ignoreHTTPSErrors: new URL(studio).hostname === "localhost"
    })
    try {
        const page = await context.newPage()
        await page.goto(`${studio}/device-preview`)
        await page.waitForFunction(`typeof window.openDAWDevicePreview === "function"`, null, {timeout: 30000})
        const result = await page.evaluate(`window.openDAWDevicePreview(${JSON.stringify(target)}, ${JSON.stringify(source)})`) as Preview
        if (result.status === "error") {return result}
        const png = await page.locator(result.selector).first().screenshot()
        const webp = await page.evaluate(toWebp(png.toString("base64"))) as string
        return {status: "ready", webp: Buffer.from(webp, "base64")}
    } catch (error) {
        return {status: "error", message: String(error).split("\n")[0]}
    } finally {
        await context.close()
    }
}

export namespace Screenshots {
    // adds a screenshot to every device script of a built scripts index, an item that fails keeps none
    export const run = async (out: string, studio: string): Promise<ScreenshotResult> => {
        const indexPath = path.join(out, "scripts", "index.json")
        const index = JSON.parse(fs.readFileSync(indexPath, "utf8")) as { scripts: Array<ScriptEntry> }
        const failures: Array<string> = []
        const browser = await chromium.launch({args: ["--autoplay-policy=no-user-gesture-required"]})
        let rendered = 0
        try {
            for (const entry of index.scripts) {
                if (!DeviceTargets.includes(entry.target)) {continue}
                const source = fs.readFileSync(path.join(out, "scripts", entry.url), "utf8")
                const result = await render(browser, studio, entry.target, source)
                if (result.status === "error") {
                    failures.push(`${entry.name}: ${result.message}`)
                    continue
                }
                const hash = crypto.createHash("sha256").update(result.webp).digest("hex").slice(0, 12)
                entry.screenshot = `${entry.uuid}-${hash}.webp`
                fs.writeFileSync(path.join(out, "scripts", entry.screenshot), result.webp)
                rendered++
            }
        } finally {
            await browser.close()
        }
        fs.writeFileSync(indexPath, JSON.stringify(index, null, 2) + "\n")
        return {rendered, failures}
    }
}
