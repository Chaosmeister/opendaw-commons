// studio-core references AudioWorkletNode at module load
if (typeof globalThis.AudioWorkletNode === "undefined") {
    Object.assign(globalThis, {AudioWorkletNode: class {}})
}
