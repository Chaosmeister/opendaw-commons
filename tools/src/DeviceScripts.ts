import vm from "node:vm"
import {tryCatch} from "@opendaw/lib-std"
import {ScriptCompiler, ScriptDeclaration, ScriptTopLevel} from "@opendaw/studio-adapters"
import {Checked} from "./Report.ts"

export type DeviceTarget = "werkstatt" | "apparat" | "spielwerk"

export type DeviceScriptInfo = {
    readonly label: string
    readonly params: number
    readonly samples: number
    readonly sidechains: number
    readonly view: boolean
}

const Configs: Record<DeviceTarget, ScriptCompiler.Config> = {
    werkstatt: {headerTag: "werkstatt", registryName: "werkstattProcessors", functionName: "werkstatt"},
    apparat: {headerTag: "apparat", registryName: "apparatProcessors", functionName: "apparat"},
    spielwerk: {headerTag: "spielwerk", registryName: "spielwerkProcessors", functionName: "spielwerk"}
}

const REGISTRY_ID = "00000000-0000-4000-8000-000000000000"
const TIMEOUT_MS = 2000

type Registry = Record<string, Record<string, { readonly create: unknown }>>

const describe = (error: unknown): string => error instanceof Error ? error.message : String(error)

export namespace DeviceScripts {
    export const stripHeader = (target: DeviceTarget, code: string): string =>
        ScriptCompiler.create(Configs[target]).stripHeader(code)

    export const check = (target: DeviceTarget, code: string, filename: string): Checked<DeviceScriptInfo> => {
        const config = Configs[target]
        const wrapped = tryCatch(() => ScriptCompiler.wrap(config, REGISTRY_ID, 1, code, true))
        if (wrapped.status === "failure") {return {ok: false, error: describe(wrapped.error)}}
        const context = vm.createContext({sampleRate: 48000, currentFrame: 0, currentTime: 0})
        const executed = tryCatch(() => new vm.Script(wrapped.value, {filename}).runInContext(context, {timeout: TIMEOUT_MS}))
        if (executed.status === "failure") {return {ok: false, error: describe(executed.error)}}
        const registry = (context as { openDAW?: Registry }).openDAW?.[config.registryName]
        if (typeof registry?.[REGISTRY_ID]?.create !== "function") {
            return {ok: false, error: "The script must declare a class named Processor."}
        }
        const view = ScriptTopLevel.applies(code)
        if (view) {
            const compiled = tryCatch(() => new vm.Script(ScriptCompiler.wrapView(code), {filename}))
            if (compiled.status === "failure") {return {ok: false, error: `View: ${describe(compiled.error)}`}}
        }
        return {
            ok: true,
            value: {
                label: ScriptDeclaration.parseLabel(code).unwrapOrElse(""),
                params: ScriptDeclaration.parseParams(code).length,
                samples: ScriptDeclaration.parseSamples(code).length,
                sidechains: ScriptDeclaration.parseSidechains(code).length,
                view
            }
        }
    }
}
