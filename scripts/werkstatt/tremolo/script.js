// @label Tremolo
// @param rate 4 0.1 20 exp Hz
// @param depth 0.5 0 1 linear

class Processor {
    phase = 0
    rate = 4
    depth = 0.5
    paramChanged(label, value) {
        if (label === "rate") this.rate = value
        if (label === "depth") this.depth = value
    }
    process({src, out}, {s0, s1}) {
        const [srcL, srcR] = src
        const [outL, outR] = out
        const inc = this.rate / sampleRate
        for (let i = s0; i < s1; i++) {
            const gain = 1 - this.depth * (0.5 - 0.5 * Math.cos(this.phase * Math.PI * 2))
            this.phase += inc
            if (this.phase >= 1) this.phase -= 1
            outL[i] = srcL[i] * gain
            outR[i] = srcR[i] * gain
        }
    }
}
