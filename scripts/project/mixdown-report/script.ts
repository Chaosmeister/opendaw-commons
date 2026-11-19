import {InaccessibleProperty} from "@opendaw/lib-std"
import {Api} from "@opendaw/studio-scripting"
import {WavFile} from "@opendaw/lib-dsp"

const openDAW: Api = InaccessibleProperty("Not to be executed.")

// Mixdown Report: renders the current project, measures the rendered audio, shows a loudness report
// and saves the untouched mixdown as a 32-bit float wav file. It measures only and never changes the audio.
// Loudness: ITU-R BS.1770-4 (K-weighting, 400 ms blocks, absolute gate -70 LUFS, relative gate -10 LU).
// True peak: 4x oversampling with a windowed sinc (24 taps per phase). Mono and stereo only.

// ---- measure:start
const SHELF_B = [1.53512485958697, -2.69169618940638, 1.19839281085285]
const SHELF_A = [-1.69065929318241, 0.73248077421585]
const HIGHPASS_A = [-1.99004745483398, 0.99007225036621]
const BLOCK = 19200 // 400 ms at 48 kHz
const HOP = 4800 // 100 ms, 75 % overlap
const TAPS = 24 // per interpolation phase; the loop below costs about 1 s per 40 s of stereo audio
const BEFORE = TAPS / 2 - 1 // taps left of the interpolated point's left neighbour
const AFTER = TAPS / 2 // taps right of it

const lufs = (energy: number): number => -0.691 + 10 * Math.log10(energy)
const db = (linear: number): number => 20 * Math.log10(linear)
const range = (length: number, value: (index: number) => number): number[] => {
    const list: number[] = []
    for (let i = 0; i < length; i++) list.push(value(i))
    return list
}
const mean = (list: number[]): number => list.reduce((a, b) => a + b, 0) / list.length
const bessel0 = (x: number): number => {
    let sum = 1, term = 1
    for (let k = 1; k < 30; k++) {
        term *= (x / (2 * k)) ** 2
        sum += term
    }
    return sum
}
// Interpolation filters for the points 1/4, 2/4 and 3/4 between two samples (the 0/4 point is the sample itself).
const PHASES = [0.25, 0.5, 0.75].map(fraction => {
    const taps = range(TAPS, n => {
        const t = n - BEFORE - fraction // distance from the tap to the interpolated point
        return Math.sin(Math.PI * t) / (Math.PI * t) * bessel0(5 * Math.sqrt(1 - (t / AFTER) ** 2)) / bessel0(5) // Kaiser window
    })
    const gain = taps.reduce((a, b) => a + b, 0)
    return taps.map(value => value / gain)
})

const integratedLoudness = (frames: ReadonlyArray<Float32Array>): number => {
    const hops = Math.floor(frames[0].length / HOP)
    if (hops < 4) return NaN
    const energy = new Float64Array(hops) // K-weighted energy per 100 ms, summed over channels (weight 1)
    for (const x of frames) {
        let x1 = 0, x2 = 0, y1 = 0, y2 = 0, u1 = 0, u2 = 0, v1 = 0, v2 = 0
        for (let h = 0; h < hops; h++) {
            let sum = 0
            for (let i = h * HOP, end = i + HOP; i < end; i++) {
                const s = x[i]
                const y = SHELF_B[0] * s + SHELF_B[1] * x1 + SHELF_B[2] * x2 - SHELF_A[0] * y1 - SHELF_A[1] * y2
                x2 = x1
                x1 = s
                y2 = y1
                y1 = y
                const v = y - 2 * u1 + u2 - HIGHPASS_A[0] * v1 - HIGHPASS_A[1] * v2
                u2 = u1
                u1 = y
                v2 = v1
                v1 = v
                sum += v * v
            }
            energy[h] += sum
        }
    }
    const blocks = range(hops - 3, j => (energy[j] + energy[j + 1] + energy[j + 2] + energy[j + 3]) / BLOCK)
    const loud = blocks.filter(e => lufs(e) > -70)
    if (loud.length === 0) return -Infinity
    const threshold = lufs(mean(loud)) - 10
    return lufs(mean(loud.filter(e => lufs(e) > threshold)))
}

// Largest interpolated value between the samples i and i + 1, for i in [from, to).
const interpolatedPeak = (x: Float32Array, from: number, to: number): number => {
    let peak = 0
    for (let i = from; i < to; i++) {
        for (const h of PHASES) {
            let y = 0
            for (let n = 0; n < TAPS; n++) y += x[i + n - BEFORE] * h[n]
            if (Math.abs(y) > peak) peak = Math.abs(y)
        }
    }
    return peak
}

const peaks = (x: Float32Array): { truePeak: number, samplePeak: number, over: number } => {
    let samplePeak = 0, over = 0
    for (let i = 0; i < x.length; i++) {
        const a = Math.abs(x[i])
        if (a > samplePeak) samplePeak = a
        if (a >= 1) over++
    }
    // The ends are interpolated on a copy padded with silence (needs at least 2 * TAPS samples).
    const head = new Float32Array(3 * TAPS)
    head.set(x.subarray(0, 2 * TAPS), TAPS)
    const tail = new Float32Array(3 * TAPS)
    tail.set(x.subarray(x.length - 2 * TAPS))
    const truePeak = Math.max(samplePeak,
        interpolatedPeak(x, BEFORE, x.length - AFTER),
        interpolatedPeak(head, TAPS - 1, TAPS + BEFORE + 1),
        interpolatedPeak(tail, 2 * TAPS - AFTER, 2 * TAPS))
    return {truePeak, samplePeak, over}
}

const measure = (frames: ReadonlyArray<Float32Array>) => {
    const all = frames.map(peaks)
    return {
        integrated: integratedLoudness(frames),
        truePeak: db(Math.max(...all.map(p => p.truePeak))),
        samplePeak: db(Math.max(...all.map(p => p.samplePeak))),
        over: all.reduce((sum, p) => sum + p.over, 0)
    }
}
// ---- measure:end

const TARGETS: ReadonlyArray<[number, string]> = [[-23, "broadcast, EBU R128"], [-16, "podcasts"], [-14, "music streaming"]]
const fix = (value: number): string => Number.isFinite(value) ? value.toFixed(1) : "-inf"
const signed = (value: number): string => (value >= 0 ? "+" : "") + value.toFixed(1)

if (!await openDAW.hasProject()) {
    await openDAW.showInfo("Mixdown Report", "No project is open. Create or load one first.")
} else {
    const project = await openDAW.getProject()
    const audio = await project.mixdown({sampleRate: 48000})
    if (audio.frames.length < 1 || audio.frames.length > 2 || audio.numberOfFrames < BLOCK) {
        await openDAW.showInfo("Mixdown Report", "Nothing to measure: the mixdown needs one or two channels and at least 0.4 seconds.")
    } else {
        const {integrated, truePeak, samplePeak, over} = measure(audio.frames)
        const lines = [
            `Integrated loudness: ${fix(integrated)} LUFS`,
            `True peak: ${fix(truePeak)} dBTP`,
            `Sample peak: ${fix(samplePeak)} dBFS`,
            `Samples at or over full scale: ${over}`,
            ""
        ]
        if (Number.isFinite(integrated)) {
            TARGETS.forEach(([target, name]) => {
                const gain = target - integrated
                const limit = truePeak + gain > -1 ? ` (true peak would reach ${fix(truePeak + gain)} dBTP, limit first)` : ""
                lines.push(`To reach ${target} LUFS (${name}): ${signed(gain)} dB${limit}`)
            })
        } else {
            lines.push("No signal above -70 LUFS.")
        }
        lines.push("", "Measured on the rendered 48 kHz mixdown, after all effects (ITU-R BS.1770-4). The saved file is not changed.")
        await openDAW.showInfo("Mixdown Report", lines.join("\n"))
    }
    await openDAW.saveFile(WavFile.encodeFloats(audio), `${project.name}.wav`, "audio/wav")
}
