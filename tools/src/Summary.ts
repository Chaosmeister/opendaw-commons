import {Report} from "./Report.ts"

const escape = (text: string): string => text.replaceAll("|", "\\|").replaceAll("\n", " ")

const itemOf = (file: string): string => {
    const parts = file.split("/")
    return (parts[0] === "scripts" ? parts.slice(0, 3) : parts.slice(0, 2)).join("/")
}

const isContent = (file: string): boolean => /^(presets|scripts|wclaps)\/[^/]+\//.test(file)

export namespace Summary {
    export const MARKER = "<!-- opendaw-commons-check -->"

    // changed is the list of files the pull request touches, relative to the repo root
    export const markdown = (report: Report, changed: ReadonlyArray<string>): string => {
        const touched = new Set(changed.filter(isContent).map(itemOf))
        const items = report.items.filter(item => touched.has(item.path))
        const removed = Array.from(touched).filter(path => !report.items.some(item => item.path === path))
        const lines: Array<string> = [MARKER]
        lines.push(report.ok ? "## ✅ openDAW Commons check passed" : "## ❌ openDAW Commons check failed")
        if (items.length > 0) {
            lines.push("", "### Goes live on merge", "", "| Item | Name | Computed | Status |", "| --- | --- | --- | --- |")
            for (const item of items) {
                const details = Object.entries(item.details).map(([key, value]) => `${key}: ${value}`).join(", ")
                const errors = report.errorsOf(item.path).length
                lines.push(`| \`${item.path}\` | ${escape(item.name)} | ${escape(details)} | ${errors === 0 ? "✅" : `❌ ${errors}`} |`)
            }
        }
        if (removed.length > 0) {
            lines.push("", "### Removed", "", ...removed.map(path => `- \`${path}\``))
        }
        if (!report.ok) {
            lines.push("", "### Errors", "", ...report.errors.map(({path, message}) => `- \`${path}\` ${message}`))
        }
        if (items.length === 0 && removed.length === 0 && report.ok) {
            lines.push("", "No community content changed.")
        }
        return lines.join("\n") + "\n"
    }
}
