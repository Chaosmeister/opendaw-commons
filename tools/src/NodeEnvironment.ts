import {isAbsent} from "@opendaw/lib-std"

// studio-core references AudioWorkletNode at module load
if (isAbsent(Reflect.get(globalThis, "AudioWorkletNode"))) {
    Reflect.set(globalThis, "AudioWorkletNode", class {})
}
